import { type Command, InvalidArgumentError } from "commander";
import {
	launchApp,
	NativeDriver,
	NativeDriverError,
	type NativeDriverLike,
	type NativeTreeNode,
	type TrustResult,
} from "../lib/nativeDriver.js";
import { NativeHelperMissingError, resolveNativeDriverPath } from "../lib/nativeHelpers.js";
import { checkScreenCaptureCapability } from "../lib/screenCapturePreflight.js";

/**
 * `native doctor` and `native tree` (CR-LENSMITH-A010-9, design note §7).
 * Both are read-only: no input events, no permission prompt (trust is a preflight,
 * and the tree is read through the AX API without touching secure-field values).
 */

export type NativeCheckId =
	| "native_helper_built"
	| "accessibility_permission"
	| "screen_recording_capability"
	| "secure_input_off";

/** Same shape as the engine `doctor` check. */
export interface NativeCheck {
	id: NativeCheckId;
	required: boolean;
	ok: boolean;
	code: string;
	detail: string;
	fix: string | null;
}

export interface NativeReport {
	ok: boolean;
	version: string;
	checks: NativeCheck[];
}

export interface ReadinessDeps {
	version: string;
	/** Throws NativeHelperMissingError when the helper binary is absent. */
	assertHelperBuilt: () => void;
	/** Preflight only (no prompt). */
	trust: () => Promise<TrustResult>;
	/** Returns a detail string, throws when capture is not possible. */
	checkScreenCapture: () => string;
}

const ACCESSIBILITY_FIX =
	"Open System Settings, Privacy & Security, Accessibility, and switch on the terminal app you run this from. Then run `native doctor` again.";
const SCREEN_FIX =
	"Open System Settings, Privacy & Security, Screen Recording, and switch on the terminal app you run this from. Quit and reopen the terminal, then run `native doctor` again.";
const BUILD_FIX = "Run `npm run build:native:mac` (macOS, needs Apple's Command Line Tools).";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function checkNativeReadiness(deps: ReadinessDeps): Promise<NativeReport> {
	const checks: NativeCheck[] = [];

	let helperBuilt = true;
	try {
		deps.assertHelperBuilt();
		checks.push({
			id: "native_helper_built",
			required: true,
			ok: true,
			code: "ok",
			detail: "lensmith-native-driver is built.",
			fix: null,
		});
	} catch (error) {
		helperBuilt = false;
		checks.push({
			id: "native_helper_built",
			required: true,
			ok: false,
			code: "native_helper_missing",
			detail: errorText(error),
			fix: BUILD_FIX,
		});
	}

	let trust: TrustResult | undefined;
	if (helperBuilt) {
		try {
			trust = await deps.trust();
		} catch (error) {
			checks.push({
				id: "accessibility_permission",
				required: true,
				ok: false,
				code: "check_error",
				detail: `Could not ask the native driver: ${errorText(error)}`,
				fix: BUILD_FIX,
			});
		}
	} else {
		checks.push({
			id: "accessibility_permission",
			required: true,
			ok: false,
			code: "check_error",
			detail: "Skipped: the native driver is not built.",
			fix: BUILD_FIX,
		});
	}
	if (trust) {
		checks.push(
			trust.accessibility
				? {
						id: "accessibility_permission",
						required: true,
						ok: true,
						code: "ok",
						detail: "Accessibility is granted to this terminal.",
						fix: null,
					}
				: {
						id: "accessibility_permission",
						required: true,
						ok: false,
						code: "ax_not_trusted",
						detail: "Accessibility is not granted: the driver cannot read apps or post input.",
						fix: ACCESSIBILITY_FIX,
					},
		);
	}

	try {
		checks.push({
			id: "screen_recording_capability",
			required: true,
			ok: true,
			code: "ok",
			detail: deps.checkScreenCapture(),
			fix: null,
		});
	} catch (error) {
		checks.push({
			id: "screen_recording_capability",
			required: true,
			ok: false,
			code: "screen_recording_denied",
			detail: errorText(error),
			fix: SCREEN_FIX,
		});
	}

	if (trust) {
		checks.push(
			trust.secureInput
				? {
						id: "secure_input_off",
						required: false,
						ok: false,
						code: "secure_input_on",
						detail:
							"An app holds secure input (a password field is focused); global hotkeys will not fire.",
						fix: "Close or leave the password field, then run again.",
					}
				: {
						id: "secure_input_off",
						required: false,
						ok: true,
						code: "ok",
						detail: "No app holds secure input.",
						fix: null,
					},
		);
	}

	return {
		ok: checks.every((check) => !check.required || check.ok),
		version: deps.version,
		checks,
	};
}

export function formatReport(report: NativeReport): string {
	const lines: string[] = [];
	for (const check of report.checks) {
		const mark = check.ok ? "ok  " : check.required ? "FAIL" : "warn";
		lines.push(`${mark} ${check.id}: ${check.detail}`);
		if (!check.ok && check.fix) lines.push(`     fix: ${check.fix}`);
	}
	return `${lines.join("\n")}\n`;
}

export const TREE_SCOPES = ["app", "window", "menubar", "statusbar"] as const;
type TreeScope = (typeof TREE_SCOPES)[number];

export function formatTreeNode(node: NativeTreeNode): string {
	const frame = node.frame
		? ` ${node.frame.x},${node.frame.y} ${node.frame.width}x${node.frame.height}`
		: "";
	return `[${node.path.join(",")}] ${node.role} title=${JSON.stringify(node.title)} label=${JSON.stringify(node.label)} id=${JSON.stringify(node.identifier)}${frame}`;
}

export interface NativeCommandDeps {
	driverFactory?: () => NativeDriverLike & { start(): Promise<void> };
	launchApp?: (bundleId: string) => Promise<number>;
	checkReadiness?: (version: string) => Promise<NativeReport>;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	exit?: (code: number) => void;
}

async function defaultReadiness(version: string): Promise<NativeReport> {
	const driver = new NativeDriver();
	let started = false;
	return checkNativeReadiness({
		version,
		assertHelperBuilt: () => {
			resolveNativeDriverPath();
		},
		trust: async () => {
			await driver.start();
			started = true;
			return driver.trust();
		},
		checkScreenCapture: () => checkScreenCaptureCapability(),
	}).finally(() => {
		if (started) driver.stop();
	});
}

function parseDepth(raw: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new InvalidArgumentError(`--depth must be a positive whole number (got "${raw}").`);
	}
	return value;
}

function parseScope(raw: string): TreeScope {
	if ((TREE_SCOPES as readonly string[]).includes(raw)) return raw as TreeScope;
	throw new InvalidArgumentError(`--in must be one of ${TREE_SCOPES.join(", ")} (got "${raw}").`);
}

export function registerNativeCommand(program: Command, deps: NativeCommandDeps = {}): void {
	const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
	const err = deps.stderr ?? ((text: string) => process.stderr.write(text));
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	const version = () => program.version() ?? "unknown";

	const native = program
		.command("native")
		.description("check this Mac for native app driving, and read an app's Accessibility tree");

	native
		.command("doctor")
		.description("check that this Mac can drive native apps (read-only, never prompts)")
		.option("--json", "print the report as JSON")
		.action(async (options: { json?: boolean }) => {
			const check = deps.checkReadiness ?? defaultReadiness;
			const report = await check(version());
			out(options.json === true ? `${JSON.stringify(report)}\n` : formatReport(report));
			if (!report.ok) exit(1);
		});

	native
		.command("tree")
		.description("print an app's Accessibility tree, to pick locators (read-only)")
		.requiredOption("--app <bundleId>", "bundle id of the app, e.g. com.apple.calculator")
		.option("--in <scope>", "app, window, menubar or statusbar", parseScope)
		.option("--depth <n>", "maximum depth", parseDepth)
		.option("--json", "print the raw nodes as JSON")
		.action(async (options: { app: string; in?: TreeScope; depth?: number; json?: boolean }) => {
			const launch = deps.launchApp ?? ((id: string) => launchApp(id));
			const driver = deps.driverFactory?.() ?? new NativeDriver();
			let started = false;
			try {
				const pid = await launch(options.app);
				await driver.start();
				started = true;
				const nodes = await driver.tree(pid, { in: options.in, depth: options.depth });
				out(
					options.json === true
						? `${JSON.stringify(nodes)}\n`
						: nodes.map((node) => formatTreeNode(node)).join("\n") + (nodes.length ? "\n" : ""),
				);
			} catch (error) {
				if (error instanceof NativeDriverError) {
					err(`${error.code}: ${error.message}\n`);
					exit(1);
					return;
				}
				if (error instanceof NativeHelperMissingError) {
					err(`${error.message}\n`);
					exit(1);
					return;
				}
				throw error;
			} finally {
				if (started) driver.stop();
			}
		});
}

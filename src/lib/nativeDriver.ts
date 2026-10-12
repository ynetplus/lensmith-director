import { type ChildProcess, execFile as execFileCb, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { resolveNativeDriverPath } from "./nativeHelpers.js";
import type { AxLocator, Chord } from "./stepList.js";

/**
 * TypeScript client for `lensmith-native-driver serve` (CR-LENSMITH-A010-5,
 * design note RN-lensmith-director-native-mode §3).
 *
 * Same shape as {@link CursorChoreographer}: spawn `serve`, wait for `ready`,
 * one NDJSON request per line, replies matched FIFO with a per-command timer.
 *
 * NO ECHO: a `type` request's text never appears in an error message, a log
 * line or a timeout message. Only its length is ever mentioned.
 */

export const NATIVE_DRIVER_ERROR_CODES = [
	// Helper codes (design note §3).
	"ax_not_trusted",
	"bad_request",
	"no_app",
	"no_window",
	"not_found",
	"stale_ref",
	"occluded",
	"offscreen",
	"secure_input",
	"cannot_complete",
	// Client-side codes.
	"app_not_installed",
	"timeout",
	"helper_exited",
] as const;

export type NativeDriverErrorCode = (typeof NATIVE_DRIVER_ERROR_CODES)[number];

export interface NativeFrame {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface NativeElement {
	ref: string;
	pid: number | null;
	role: string;
	title: string;
	label: string;
	identifier: string;
	enabled: boolean;
	frame: NativeFrame | null;
}

export interface NativeTreeNode {
	path: number[];
	role: string;
	title: string;
	label: string;
	identifier: string;
	frame: NativeFrame | null;
	[extra: string]: unknown;
}

export class NativeDriverError extends Error {
	readonly code: NativeDriverErrorCode | string;
	readonly candidates: NativeElement[] | undefined;
	/** The reply's extra fields (e.g. `pid`, `axError`, `ownerPid`), never request text. */
	readonly details: Record<string, unknown>;

	constructor(
		code: NativeDriverErrorCode | string,
		message: string,
		extra: { candidates?: NativeElement[]; details?: Record<string, unknown> } = {},
	) {
		super(message);
		this.name = "NativeDriverError";
		this.code = code;
		this.candidates = extra.candidates;
		this.details = extra.details ?? {};
	}
}

export interface TrustResult {
	accessibility: boolean;
	secureInput: boolean;
}

export interface HitResult {
	element: NativeElement;
	/** The pid that owns the element at that point. */
	pid: number | null;
}

export interface SettleOptions {
	quietMs: number;
	capMs: number;
	expect?: AxLocator;
}

export interface SettleResult {
	settleMs: number;
	reason: "quiet" | "expect" | "cap" | string;
}

export interface TreeOptions {
	in?: AxLocator["in"];
	depth?: number;
}

export interface NativeDriverLike {
	trust(): Promise<TrustResult>;
	prepare(pid: number, frame?: NativeFrame): Promise<NativeFrame | null>;
	find(pid: number, locator: AxLocator, timeoutMs: number): Promise<NativeElement>;
	hit(x: number, y: number): Promise<HitResult>;
	focus(ref: string): Promise<void>;
	press(ref: string): Promise<void>;
	key(chords: Chord[]): Promise<number>;
	type(text: string, charDelayMs: number): Promise<number>;
	settle(pid: number, options: SettleOptions): Promise<SettleResult>;
	tree(pid: number, options?: TreeOptions): Promise<NativeTreeNode[]>;
	stop(): void;
}

export interface NativeDriverOptions {
	helperPath?: string;
	spawnFn?: typeof spawn;
}

type HelperMessage = Record<string, unknown> & { type?: string; cmd?: string };

interface Pending {
	resolve: (message: HelperMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	/** Timed out: the helper may still answer, and that late reply must be dropped, not handed to the next caller. */
	dead: boolean;
}

export const NATIVE_READY_TIMEOUT_MS = 10_000;
export const NATIVE_DEFAULT_TIMEOUT_MS = 5_000;

export class NativeDriver implements NativeDriverLike {
	#child: ChildProcess | undefined;
	#reader: Interface | undefined;
	#queue: Pending[] = [];
	#exitError: Error | undefined;
	#rejectReady: ((error: Error) => void) | undefined;
	readonly #helperPath: string;
	readonly #spawnFn: typeof spawn;

	constructor(options: NativeDriverOptions = {}) {
		this.#helperPath = options.helperPath ?? resolveNativeDriverPath();
		this.#spawnFn = options.spawnFn ?? spawn;
	}

	get isRunning(): boolean {
		return this.#child !== undefined;
	}

	async start(): Promise<void> {
		if (this.#child) return;

		const child = this.#spawnFn(this.#helperPath, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
		this.#child = child;
		this.#exitError = undefined;

		// Every throw from here on must kill the spawned process first.
		if (!child.stdout || !child.stdin) {
			child.kill();
			this.#child = undefined;
			throw new NativeDriverError("helper_exited", "Failed to open a pipe to the native driver.");
		}

		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new NativeDriverError(
						"timeout",
						`Native driver did not report ready within ${NATIVE_READY_TIMEOUT_MS}ms.`,
					),
				);
			}, NATIVE_READY_TIMEOUT_MS);
			this.#rejectReady = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};

			const reader = createInterface({ input: child.stdout as NodeJS.ReadableStream });
			this.#reader = reader;

			let seenReady = false;
			reader.on("line", (line) => {
				const trimmed = line.trim();
				if (trimmed === "") return;
				let message: HelperMessage;
				try {
					message = JSON.parse(trimmed) as HelperMessage;
				} catch {
					return;
				}
				if (!seenReady && message.type === "ready") {
					seenReady = true;
					clearTimeout(timer);
					this.#rejectReady = undefined;
					resolve();
					return;
				}
				this.#deliver(message);
			});
		});

		child.on("error", (error) => {
			this.#fail(
				new NativeDriverError("helper_exited", `Native driver failed to start: ${error.message}`),
			);
		});

		child.on("exit", (code, signal) => {
			this.#child = undefined;
			const detail = stderr.trim() ? ` — ${stderr.trim()}` : "";
			this.#fail(
				new NativeDriverError(
					"helper_exited",
					`Native driver exited (code ${code ?? "null"}, signal ${signal ?? "null"})${detail}`,
				),
			);
		});

		try {
			await ready;
		} catch (error) {
			this.stop();
			throw error;
		}
	}

	stop(): void {
		this.#reader?.close();
		this.#reader = undefined;
		const child = this.#child;
		this.#child = undefined;
		if (child) {
			child.stdin?.end();
			child.kill();
		}
		this.#fail(new NativeDriverError("helper_exited", "Native driver was stopped."));
		this.#exitError = undefined;
	}

	#deliver(message: HelperMessage): void {
		const pending = this.#queue.shift();
		if (!pending || pending.dead) return;
		clearTimeout(pending.timer);
		if (message.type === "error") {
			pending.reject(toNativeError(message));
			return;
		}
		pending.resolve(message);
	}

	#fail(error: Error): void {
		this.#exitError = error;
		const rejectReady = this.#rejectReady;
		this.#rejectReady = undefined;
		rejectReady?.(error);
		const queued = this.#queue;
		this.#queue = [];
		for (const pending of queued) {
			clearTimeout(pending.timer);
			if (!pending.dead) pending.reject(error);
		}
	}

	async #send(command: Record<string, unknown>, timeoutMs: number): Promise<HelperMessage> {
		if (!this.#child?.stdin) {
			throw (
				this.#exitError ?? new NativeDriverError("helper_exited", "Native driver is not running.")
			);
		}
		const stdin = this.#child.stdin;
		const cmd = String(command.cmd);
		return await new Promise<HelperMessage>((resolve, reject) => {
			const entry: Pending = {
				resolve,
				reject,
				dead: false,
				timer: setTimeout(() => {
					entry.dead = true;
					// Only the command name and the timeout; never a request field (no echo).
					reject(
						new NativeDriverError(
							"timeout",
							`Native driver did not answer "${cmd}" within ${timeoutMs}ms.`,
						),
					);
				}, timeoutMs),
			};
			this.#queue.push(entry);
			stdin.write(`${JSON.stringify(command)}\n`);
		});
	}

	async trust(): Promise<TrustResult> {
		const reply = await this.#send({ cmd: "trust" }, NATIVE_DEFAULT_TIMEOUT_MS);
		return { accessibility: reply.accessibility === true, secureInput: reply.secureInput === true };
	}

	async prepare(pid: number, frame?: NativeFrame): Promise<NativeFrame | null> {
		const command: Record<string, unknown> = { cmd: "prepare", pid };
		if (frame) command.frame = frame;
		const reply = await this.#send(command, NATIVE_DEFAULT_TIMEOUT_MS);
		return (reply.frame as NativeFrame | undefined) ?? null;
	}

	async find(pid: number, locator: AxLocator, timeoutMs: number): Promise<NativeElement> {
		const reply = await this.#send({ cmd: "find", pid, locator, timeoutMs }, timeoutMs + 1000);
		return reply.element as NativeElement;
	}

	async hit(x: number, y: number): Promise<HitResult> {
		const reply = await this.#send({ cmd: "hit", x, y }, NATIVE_DEFAULT_TIMEOUT_MS);
		const element = reply.element as NativeElement;
		const pid = typeof reply.pid === "number" ? reply.pid : (element?.pid ?? null);
		return { element, pid };
	}

	async focus(ref: string): Promise<void> {
		await this.#send({ cmd: "focus", ref }, NATIVE_DEFAULT_TIMEOUT_MS);
	}

	async press(ref: string): Promise<void> {
		await this.#send({ cmd: "press", ref }, NATIVE_DEFAULT_TIMEOUT_MS);
	}

	/** Posts the chords; resolves with the helper's `posted` count. */
	async key(chords: Chord[]): Promise<number> {
		const reply = await this.#send({ cmd: "key", chords }, NATIVE_DEFAULT_TIMEOUT_MS);
		return Number(reply.posted ?? chords.length);
	}

	/** Types literal text; resolves with the helper's `count`. The text is never echoed anywhere. */
	async type(text: string, charDelayMs: number): Promise<number> {
		const timeoutMs = text.length * charDelayMs + 2000;
		const reply = await this.#send({ cmd: "type", text, charDelayMs }, timeoutMs);
		return Number(reply.count ?? text.length);
	}

	async settle(pid: number, options: SettleOptions): Promise<SettleResult> {
		const command: Record<string, unknown> = {
			cmd: "settle",
			pid,
			quietMs: options.quietMs,
			capMs: options.capMs,
		};
		if (options.expect) command.expect = options.expect;
		const reply = await this.#send(command, options.capMs + 1000);
		return { settleMs: Number(reply.settleMs), reason: String(reply.reason) };
	}

	async tree(pid: number, options: TreeOptions = {}): Promise<NativeTreeNode[]> {
		const command: Record<string, unknown> = { cmd: "tree", pid };
		if (options.in !== undefined) command.in = options.in;
		if (options.depth !== undefined) command.depth = options.depth;
		const reply = await this.#send(command, NATIVE_DEFAULT_TIMEOUT_MS);
		return Array.isArray(reply.nodes) ? (reply.nodes as NativeTreeNode[]) : [];
	}
}

function toNativeError(message: HelperMessage): NativeDriverError {
	const code = typeof message.code === "string" ? message.code : "cannot_complete";
	const { type: _type, cmd, code: _code, message: text, candidates, ...rest } = message;
	const readable =
		typeof text === "string" && text !== ""
			? text
			: `Native driver reported "${code}" for "${String(cmd ?? "?")}".`;
	return new NativeDriverError(code, readable, {
		candidates: Array.isArray(candidates) ? (candidates as NativeElement[]) : undefined,
		details: { cmd, ...rest },
	});
}

/* ------------------------------------------------------------------------------------------- */
/* launchApp                                                                                   */
/* ------------------------------------------------------------------------------------------- */

export type ExecFileFn = (
	file: string,
	args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface LaunchAppDeps {
	execFile?: ExecFileFn;
	sleep?: (ms: number) => Promise<void>;
}

export const LAUNCH_POLL_ATTEMPTS = 10;
export const LAUNCH_POLL_INTERVAL_MS = 300;

const defaultExecFile: ExecFileFn = (file, args) =>
	new Promise((resolve, reject) => {
		execFileCb(file, args, { timeout: 10_000 }, (error, stdout, stderr) =>
			error ? reject(error) : resolve({ stdout: String(stdout), stderr: String(stderr) }),
		);
	});

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Launches (or activates) an app by bundle id with `/usr/bin/open -b`, then reads its pid
 * through the JXA AppKit bridge (`NSRunningApplication`). Public mechanisms only.
 */
export async function launchApp(bundleId: string, deps: LaunchAppDeps = {}): Promise<number> {
	const execFile = deps.execFile ?? defaultExecFile;
	const sleep = deps.sleep ?? defaultSleep;

	try {
		await execFile("/usr/bin/open", ["-b", bundleId]);
	} catch {
		throw new NativeDriverError(
			"app_not_installed",
			`No app with bundle id ${JSON.stringify(bundleId)} could be opened (open -b failed).`,
			{ details: { bundleId } },
		);
	}

	const script = `ObjC.import('AppKit');
const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(bundleId)});
apps.count > 0 ? String(apps.objectAtIndex(0).processIdentifier) : ''`;

	for (let attempt = 0; attempt < LAUNCH_POLL_ATTEMPTS; attempt++) {
		try {
			const { stdout } = await execFile("osascript", ["-l", "JavaScript", "-e", script]);
			const pid = Number(stdout.trim());
			if (stdout.trim() !== "" && Number.isInteger(pid) && pid > 0) return pid;
		} catch {
			// A failed bridge call counts as "not running yet"; the poll decides.
		}
		if (attempt < LAUNCH_POLL_ATTEMPTS - 1) await sleep(LAUNCH_POLL_INTERVAL_MS);
	}
	throw new NativeDriverError(
		"no_app",
		`${JSON.stringify(bundleId)} opened but no running process appeared within ${
			LAUNCH_POLL_ATTEMPTS * LAUNCH_POLL_INTERVAL_MS
		}ms.`,
		{ details: { bundleId } },
	);
}

/* ------------------------------------------------------------------------------------------- */
/* Resolver                                                                                    */
/* ------------------------------------------------------------------------------------------- */

/**
 * A readable, stable form of a locator for logs and the action log's `selector`,
 * e.g. `ax:AXButton[title=Save]` or `ax:statusbar/AXMenuBarItem[label~permission]`.
 */
export function describeLocator(ax: AxLocator): string {
	const op = ax.match === "contains" ? "~" : "=";
	const scope = ax.in && ax.in !== "app" ? `${ax.in}/` : "";
	let out = `ax:${scope}${ax.role ?? "*"}`;
	if (ax.identifier !== undefined) out += `[identifier=${ax.identifier}]`;
	if (ax.title !== undefined) out += `[title${op}${ax.title}]`;
	if (ax.label !== undefined) out += `[label${op}${ax.label}]`;
	if (ax.value !== undefined) out += `[value${op}${ax.value}]`;
	if (ax.index !== undefined) out += `[index=${ax.index}]`;
	if (ax.path !== undefined) out += `[path=${ax.path.join(".")}]`;
	if (ax.point !== undefined) out += `@(${ax.point.x},${ax.point.y})`;
	return out;
}

export interface ResolvedTarget {
	element: NativeElement;
	center: { x: number; y: number };
}

/**
 * `find` the element, then `hit` its frame centre: when another process owns that point
 * (a notification banner, a sheet from another app), throw `occluded` naming the owner pid.
 */
export async function resolveTarget(
	driver: Pick<NativeDriverLike, "find" | "hit">,
	pid: number,
	locator: AxLocator,
	timeoutMs: number,
): Promise<ResolvedTarget> {
	const element = await driver.find(pid, locator, timeoutMs);
	const frame = element.frame;
	if (!frame) {
		throw new NativeDriverError(
			"offscreen",
			`${describeLocator(locator)} has no frame, so it has no point to click.`,
		);
	}
	const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
	const hit = await driver.hit(center.x, center.y);
	if (hit.pid !== pid) {
		throw new NativeDriverError(
			"occluded",
			`${describeLocator(locator)} is covered at (${center.x}, ${center.y}) by pid ${
				hit.pid ?? "unknown"
			}, not the target pid ${pid}.`,
			{ details: { ownerPid: hit.pid, pid, center } },
		);
	}
	return { element, center };
}

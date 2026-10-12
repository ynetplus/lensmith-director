import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
	checkNativeReadiness,
	formatTreeNode,
	type NativeReport,
	registerNativeCommand,
} from "../src/commands/native.js";
import { NativeDriver, NativeDriverError } from "../src/lib/nativeDriver.js";
import { NativeHelperMissingError } from "../src/lib/nativeHelpers.js";
import { validateDriveStepList } from "../src/lib/stepList.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fixtures", "fake-native-driver.mjs");

const okDeps = {
	version: "9.9.9",
	assertHelperBuilt: () => undefined,
	trust: async () => ({ accessibility: true, secureInput: false }),
	checkScreenCapture: () => "capture works",
};

function report(overrides: Partial<NativeReport> = {}): NativeReport {
	return { ok: true, version: "9.9.9", checks: [], ...overrides };
}

async function run(args: string[], deps: Parameters<typeof registerNativeCommand>[1]) {
	const out: string[] = [];
	const err: string[] = [];
	let exitCode = 0;
	const program = new Command().version("9.9.9").exitOverride();
	registerNativeCommand(program, {
		...deps,
		stdout: (t) => out.push(t),
		stderr: (t) => err.push(t),
		exit: (c) => {
			exitCode = c;
		},
	});
	await program.parseAsync(["node", "x", "native", ...args]);
	return { out: out.join(""), err: err.join(""), exitCode };
}

describe("checkNativeReadiness", () => {
	it("passes with four ok rows", async () => {
		const r = await checkNativeReadiness(okDeps);
		expect(r.ok).toBe(true);
		expect(r.checks.map((c) => c.id)).toEqual([
			"native_helper_built",
			"accessibility_permission",
			"screen_recording_capability",
			"secure_input_off",
		]);
		expect(r.checks.every((c) => c.ok)).toBe(true);
	});

	it("fails on missing accessibility with the System Settings path", async () => {
		const r = await checkNativeReadiness({
			...okDeps,
			trust: async () => ({ accessibility: false, secureInput: false }),
		});
		expect(r.ok).toBe(false);
		const row = r.checks.find((c) => c.id === "accessibility_permission");
		expect(row?.code).toBe("ax_not_trusted");
		expect(row?.fix).toContain("System Settings");
	});

	it("secure input warns but never fails", async () => {
		const r = await checkNativeReadiness({
			...okDeps,
			trust: async () => ({ accessibility: true, secureInput: true }),
		});
		expect(r.ok).toBe(true);
		const row = r.checks.find((c) => c.id === "secure_input_off");
		expect(row).toMatchObject({ required: false, ok: false });
	});

	it("a missing helper fails and does not ask trust", async () => {
		let asked = false;
		const r = await checkNativeReadiness({
			...okDeps,
			assertHelperBuilt: () => {
				throw new NativeHelperMissingError("not built");
			},
			trust: async () => {
				asked = true;
				return { accessibility: true, secureInput: false };
			},
		});
		expect(asked).toBe(false);
		expect(r.ok).toBe(false);
		expect(r.checks[0]).toMatchObject({ id: "native_helper_built", ok: false });
	});

	it("a failing screen capture check fails the report", async () => {
		const r = await checkNativeReadiness({
			...okDeps,
			checkScreenCapture: () => {
				throw new Error("no titles visible");
			},
		});
		expect(r.ok).toBe(false);
		expect(r.checks.find((c) => c.id === "screen_recording_capability")?.ok).toBe(false);
	});
});

describe("native doctor", () => {
	it("prints ok rows and exits 0 when all pass", async () => {
		const ok = await checkNativeReadiness(okDeps);
		const { out, exitCode } = await run(["doctor"], { checkReadiness: async () => ok });
		expect(out).toContain("ok   accessibility_permission");
		expect(exitCode).toBe(0);
	});

	it("exits 1 and prints FAIL with the fix when a required row fails", async () => {
		const bad = await checkNativeReadiness({
			...okDeps,
			trust: async () => ({ accessibility: false, secureInput: false }),
		});
		const { out, exitCode } = await run(["doctor"], { checkReadiness: async () => bad });
		expect(out).toContain("FAIL accessibility_permission");
		expect(out).toContain("fix:");
		expect(exitCode).toBe(1);
	});

	it("--json prints the report shape", async () => {
		const ok = await checkNativeReadiness(okDeps);
		const { out } = await run(["doctor", "--json"], { checkReadiness: async () => ok });
		const parsed = JSON.parse(out);
		expect(parsed.ok).toBe(true);
		expect(parsed.version).toBe("9.9.9");
		expect(parsed.checks[0]).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				required: expect.any(Boolean),
				ok: expect.any(Boolean),
				code: expect.any(String),
				detail: expect.any(String),
			}),
		);
	});

	it("passes the program version to the readiness check", async () => {
		let seen = "";
		await run(["doctor"], {
			checkReadiness: async (v) => {
				seen = v;
				return report();
			},
		});
		expect(seen).toBe("9.9.9");
	});
});

describe("native tree (against the fake helper)", () => {
	const factory = () => new NativeDriver({ helperPath: FAKE });
	const launch = async () => 412;

	it("prints one indented line per node, in order", async () => {
		const { out, exitCode } = await run(["tree", "--app", "com.example.demo"], {
			driverFactory: factory,
			launchApp: launch,
		});
		expect(exitCode).toBe(0);
		expect(out).toBe('[0] AXWindow title="Doc" label="" id=""\n');
	});

	it("--json passes the nodes through", async () => {
		const { out } = await run(["tree", "--app", "com.example.demo", "--json"], {
			driverFactory: factory,
			launchApp: launch,
		});
		expect(JSON.parse(out)).toEqual([
			{ path: [0], role: "AXWindow", title: "Doc", label: "", identifier: "", frame: null },
		]);
	});

	it("app_not_installed exits 1 with the code in the message", async () => {
		const { err, exitCode } = await run(["tree", "--app", "com.example.missing"], {
			driverFactory: factory,
			launchApp: async () => {
				throw new NativeDriverError("app_not_installed", "No app with that bundle id.");
			},
		});
		expect(exitCode).toBe(1);
		expect(err).toContain("app_not_installed");
	});

	it("formats a node with its frame", () => {
		expect(
			formatTreeNode({
				path: [0, 2, 1],
				role: "AXButton",
				title: "Save",
				label: "",
				identifier: "save",
				frame: { x: 812, y: 430, width: 64, height: 24 },
			}),
		).toBe('[0,2,1] AXButton title="Save" label="" id="save" 812,430 64x24');
	});
});

describe("README worked example", () => {
	it("passes validateDriveStepList", () => {
		const readme = readFileSync(path.join(here, "..", "README.md"), "utf8");
		const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] as string);
		const example = blocks.find((b) => b.includes('"apps"'));
		expect(example).toBeDefined();
		expect(() => validateDriveStepList(JSON.parse(example as string))).not.toThrow();
	});
});

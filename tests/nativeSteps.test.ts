import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ChoreographerLike, DriveError, runDrive } from "../src/commands/drive.js";
import {
	NativeDriverError,
	type NativeDriverLike,
	type NativeElement,
	type SettleOptions,
} from "../src/lib/nativeDriver.js";
import { driveNativeStep, type NativeStepDeps, toCaptureSpace } from "../src/lib/nativeSteps.js";
import type { DriveStepList, NativeStep } from "../src/lib/stepList.js";
import { SETTLE_PACING } from "../src/lib/timing.js";

const APP = "com.example.notes";
const PID = 4242;
const SECRET = "hunter2-very-secret";

function element(overrides: Partial<NativeElement> = {}): NativeElement {
	return {
		ref: "e1",
		pid: PID,
		role: "AXButton",
		title: "Save",
		label: "",
		identifier: "",
		enabled: true,
		frame: { x: 1700, y: 300, width: 64, height: 24 },
		...overrides,
	};
}

function fakes(
	opts: {
		el?: NativeElement;
		hitPid?: number | null;
		secureInput?: boolean;
		findFails?: boolean;
	} = {},
) {
	const calls: string[] = [];
	const settles: SettleOptions[] = [];
	const typed: string[] = [];
	const el = opts.el ?? element();
	const driver: NativeDriverLike = {
		trust: async () => {
			calls.push("trust");
			return { accessibility: true, secureInput: opts.secureInput ?? false };
		},
		prepare: async () => null,
		find: async () => {
			calls.push("find");
			if (opts.findFails) throw new NativeDriverError("not_found", "no such element");
			return el;
		},
		hit: async () => {
			calls.push("hit");
			return { element: el, pid: opts.hitPid === undefined ? PID : opts.hitPid };
		},
		focus: async () => {},
		press: async () => {},
		key: async (chords) => {
			calls.push(`key:${chords.length}`);
			return chords.length;
		},
		type: async (text) => {
			calls.push("type");
			typed.push(text);
			return text.length;
		},
		settle: async (_pid, options) => {
			calls.push("settle");
			settles.push(options);
			return { settleMs: 120, reason: options.expect ? "expect" : "quiet" };
		},
		tree: async () => [],
		stop: () => {},
	};
	const choreographer: ChoreographerLike = {
		start: async () => {},
		stop: () => {},
		moveTo: async (x, y) => {
			calls.push("moveTo");
			return { elapsedMs: 1, to: { x, y } };
		},
		dwell: async () => {
			calls.push("dwell");
		},
		click: async () => {
			calls.push("click");
			return { x: 1732, y: 312 };
		},
	};
	const activated: number[] = [];
	let clock = 0;
	const deps: NativeStepDeps = {
		driver,
		choreographer,
		now: () => {
			clock += 10;
			return clock;
		},
		sleep: async () => {},
		activate: async (pid) => {
			calls.push("activate");
			activated.push(pid);
		},
	};
	return { calls, settles, typed, activated, deps, driver, choreographer };
}

const ctx = () => ({
	pids: new Map([[APP, PID]]),
	capture: { x: 1600, y: 0, width: 1280, height: 800 },
	t0: 0,
	lastPoint: undefined,
});

describe("toCaptureSpace", () => {
	it("subtracts the capture origin and keeps the size", () => {
		expect(
			toCaptureSpace(
				{ x: 1700, y: 300, width: 64, height: 24 },
				{ x: 1600, y: 0, width: 1, height: 1 },
			),
		).toEqual({ x: 100, y: 300, width: 64, height: 24 });
	});
});

describe("driveNativeStep", () => {
	it("click: find, hit, travel, dwell, click, settle with SETTLE_PACING; capture-space box", async () => {
		const f = fakes();
		const step: NativeStep = { type: "click", app: APP, ax: { role: "AXButton", title: "Save" } };
		const entry = await driveNativeStep(step, 0, f.deps, ctx());
		expect(f.calls).toEqual(["find", "hit", "moveTo", "dwell", "click", "settle"]);
		expect(f.settles[0]).toEqual({
			quietMs: SETTLE_PACING.settleQuietMs,
			capMs: SETTLE_PACING.settleCapMs,
		});
		expect(entry).toMatchObject({
			type: "click",
			app: APP,
			selector: "ax:AXButton[title=Save]",
			boundingBox: { x: 100, y: 300, width: 64, height: 24 },
			screenX: 1732,
			settleReason: "quiet",
		});
	});

	it("hover: the same without the click, and logs settleReason from expect", async () => {
		const f = fakes();
		const step: NativeStep = {
			type: "hover",
			app: APP,
			ax: { role: "AXButton" },
			expect: { role: "AXMenu" },
		};
		const entry = await driveNativeStep(step, 1, f.deps, ctx());
		expect(f.calls).toEqual(["find", "hit", "moveTo", "dwell", "settle"]);
		expect(entry).toMatchObject({ type: "hover", settleReason: "expect", screenX: 1732 });
	});

	it("type: focuses, types with typeCharDelayMs, logs characterCount only", async () => {
		const f = fakes({ el: element({ role: "AXTextField" }) });
		const step: NativeStep = { type: "type", app: APP, ax: { role: "AXTextField" }, text: SECRET };
		const entry = await driveNativeStep(step, 2, f.deps, ctx());
		expect(f.calls).toEqual(["find", "hit", "moveTo", "dwell", "click", "type", "settle"]);
		expect(f.typed).toEqual([SECRET]);
		expect(entry).toMatchObject({ type: "type", characterCount: SECRET.length });
		expect(JSON.stringify(entry)).not.toContain(SECRET);
	});

	it("type: literal text into AXSecureTextField throws secret_requires_keychain before any type call", async () => {
		const f = fakes({ el: element({ role: "AXSecureTextField" }) });
		const step: NativeStep = {
			type: "type",
			app: APP,
			ax: { role: "AXSecureTextField" },
			text: SECRET,
		};
		const error = await driveNativeStep(step, 3, f.deps, ctx()).catch((e) => e);
		expect(error).toBeInstanceOf(NativeDriverError);
		expect(error.code).toBe("secret_requires_keychain");
		expect(error.message).toContain("index 3");
		expect(error.message).not.toContain(SECRET);
		expect(f.calls).not.toContain("type");
	});

	it("type: textFrom.keychain resolves via execFile and the secret stays out of the entry", async () => {
		const f = fakes({ el: element({ role: "AXSecureTextField" }) });
		f.deps.execFile = async () => ({ stdout: `${SECRET}\n`, stderr: "" });
		const step: NativeStep = {
			type: "type",
			app: APP,
			ax: { role: "AXSecureTextField" },
			textFrom: { keychain: { service: "s", account: "a" } },
		};
		const entry = await driveNativeStep(step, 4, f.deps, ctx());
		expect(f.typed).toEqual([SECRET]);
		expect(JSON.stringify(entry)).not.toContain(SECRET);
	});

	it("key: trust, key, settle, zoom box; keys are normalised chord names", async () => {
		const f = fakes();
		const step: NativeStep = {
			type: "key",
			app: APP,
			keys: "cmd+shift+v",
			zoom: { role: "AXButton" },
		};
		const entry = await driveNativeStep(step, 5, f.deps, ctx());
		expect(f.calls).toEqual(["trust", "key:1", "settle", "find"]);
		expect(entry).toMatchObject({
			type: "key",
			keys: ["cmd+shift+v"],
			boundingBox: { x: 100, y: 300, width: 64, height: 24 },
			settleReason: "quiet",
		});
	});

	it("key: Secure Input on throws secure_input and posts no key", async () => {
		const f = fakes({ secureInput: true });
		const step: NativeStep = { type: "key", app: APP, keys: "cmd+v" };
		const error = await driveNativeStep(step, 6, f.deps, ctx()).catch((e) => e);
		expect(error.code).toBe("secure_input");
		expect(f.calls).toEqual(["trust"]);
	});

	it("click: occluded passes through with its code and the index named", async () => {
		const f = fakes({ hitPid: 999 });
		const step: NativeStep = { type: "click", app: APP, ax: { role: "AXButton" } };
		const error = await driveNativeStep(step, 7, f.deps, ctx()).catch((e) => e);
		expect(error.code).toBe("occluded");
		expect(error.message).toContain("index 7");
		expect(f.calls).not.toContain("click");
	});

	it("activate calls deps.activate with the app's pid", async () => {
		const f = fakes();
		const entry = await driveNativeStep({ type: "activate", app: APP }, 8, f.deps, ctx());
		expect(f.activated).toEqual([PID]);
		expect(entry).toMatchObject({ type: "activate", app: APP });
	});

	it("wait.until: a miss is a step failure naming the index", async () => {
		const f = fakes({ findFails: true });
		const step: NativeStep = { type: "wait", app: APP, until: { role: "AXSheet" }, timeoutMs: 500 };
		const error = await driveNativeStep(step, 9, f.deps, ctx()).catch((e) => e);
		expect(error.code).toBe("not_found");
		expect(error.message).toContain("index 9");
	});
});

describe("runDrive with a native-only list", () => {
	const list: DriveStepList = {
		apps: [{ bundleId: APP }],
		steps: [
			{ type: "activate", app: APP },
			{ type: "click", app: APP, ax: { role: "AXButton", title: "Save" } },
			{ type: "hover", app: APP, ax: { role: "AXButton" } },
			{ type: "type", app: APP, ax: { role: "AXTextField" }, text: SECRET },
			{ type: "key", app: APP, keys: "cmd+s" },
			{ type: "wait", app: APP, until: { role: "AXSheet" }, timeoutMs: 500 },
		],
	};

	it("runs with no page and no goto; one typed entry per step; capture-space boxes; no typed text", async () => {
		const f = fakes({ el: element({ role: "AXTextField" }) });
		const result = await runDrive(list, {
			choreographer: f.choreographer,
			now: f.deps.now,
			sleep: async () => {},
			native: {
				driver: f.driver,
				pids: new Map([[APP, PID]]),
				capture: { x: 1600, y: 0, width: 1280, height: 800 },
				activate: f.deps.activate,
			},
		});
		expect(result.actionLog.map((e) => e.type)).toEqual([
			"activate",
			"click",
			"hover",
			"type",
			"key",
			"wait",
		]);
		expect(result.viewport).toEqual({ width: 1280, height: 800 });
		const click = result.actionLog[1];
		expect(click && "boundingBox" in click ? click.boundingBox : undefined).toEqual({
			x: 100,
			y: 300,
			width: 64,
			height: 24,
		});
		expect(JSON.stringify(result.actionLog)).not.toContain(SECRET);
	});

	it("a native step with no deps.native throws a DriveError naming the step", async () => {
		const f = fakes();
		const error = await runDrive(list, {
			choreographer: f.choreographer,
			sleep: async () => {},
		}).catch((e) => e);
		expect(error).toBeInstanceOf(DriveError);
		expect(error.message).toContain("index 0");
	});
});

describe("drive command refuses a url-less list", () => {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const cli = path.join(repo, "dist", "cli.js");

	it.skipIf(!existsSync(cli))("exits 1 naming demo and writes no output", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "native-only-"));
		try {
			const steps = path.join(dir, "native-only.json");
			writeFileSync(
				steps,
				JSON.stringify({ apps: [{ bundleId: APP }], steps: [{ type: "activate", app: APP }] }),
			);
			const out = path.join(dir, "log.json");
			const zooms = path.join(dir, "zooms.json");
			const res = spawnSync(
				process.execPath,
				[cli, "drive", "--steps", steps, "--out", out, "--zooms", zooms],
				{ encoding: "utf-8", timeout: 20_000 },
			);
			expect(res.status).toBe(1);
			expect(res.stderr).toContain("demo");
			expect(existsSync(out)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

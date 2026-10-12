import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeLocator,
	type ExecFileFn,
	launchApp,
	NativeDriver,
	NativeDriverError,
	type NativeDriverLike,
	type NativeElement,
	resolveTarget,
} from "../src/lib/nativeDriver.js";
import { NATIVE_DRIVER_NAME, resolveNativeDriverPath } from "../src/lib/nativeHelpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fixtures", "fake-native-driver.mjs");
const REAL_BINARY = path.join(here, "..", "bin", NATIVE_DRIVER_NAME);

function element(overrides: Partial<NativeElement> = {}): NativeElement {
	return {
		ref: "e1",
		pid: 412,
		role: "AXButton",
		title: "Save",
		label: "",
		identifier: "save",
		enabled: true,
		frame: { x: 800, y: 430, width: 64, height: 24 },
		...overrides,
	};
}

describe("NativeDriver (against the fake helper — no real events)", () => {
	let dir: string;
	let logPath: string;
	let driver: NativeDriver | undefined;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-native-driver-"));
		logPath = path.join(dir, "commands.log");
	});

	afterEach(() => {
		driver?.stop();
		driver = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	async function startFake(script: Record<string, unknown> = {}): Promise<NativeDriver> {
		const scriptPath = path.join(dir, "script.json");
		writeFileSync(scriptPath, JSON.stringify(script));
		const env = { ...process.env, FAKE_NATIVE_SCRIPT: scriptPath, FAKE_NATIVE_LOG: logPath };
		const spawnFn = ((file: string, args: string[], options: object) =>
			spawn(process.execPath, [file, ...args], { ...options, env })) as unknown as typeof spawn;
		const instance = new NativeDriver({ helperPath: FAKE, spawnFn });
		await instance.start();
		driver = instance;
		return instance;
	}

	function loggedCommands(): Record<string, unknown>[] {
		return readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("starts and waits for ready", async () => {
		const instance = await startFake();
		expect(instance.isRunning).toBe(true);
	});

	it("round-trips every protocol command", async () => {
		const instance = await startFake();
		await expect(instance.trust()).resolves.toEqual({ accessibility: true, secureInput: false });
		await expect(instance.prepare(412, { x: 0, y: 25, width: 1000, height: 700 })).resolves.toEqual(
			{
				x: 0,
				y: 25,
				width: 1000,
				height: 700,
			},
		);
		await expect(instance.find(412, { role: "AXButton", title: "Save" }, 500)).resolves.toEqual(
			element(),
		);
		await expect(instance.hit(832, 442)).resolves.toEqual({ element: element(), pid: 412 });
		await expect(instance.focus("e1")).resolves.toBeUndefined();
		await expect(instance.press("e1")).resolves.toBeUndefined();
		await expect(
			instance.key([
				{ key: "v", mods: ["cmd", "shift"] },
				{ key: "return", mods: [] },
			] as never),
		).resolves.toBe(2);
		await expect(instance.type("hello", 1)).resolves.toBe(5);
		await expect(instance.settle(412, { quietMs: 250, capMs: 2000 })).resolves.toEqual({
			settleMs: 250,
			reason: "quiet",
		});
		const nodes = await instance.tree(412, { in: "window", depth: 3 });
		expect(nodes[0]?.role).toBe("AXWindow");

		const cmds = loggedCommands();
		expect(cmds.map((c) => c.cmd)).toEqual([
			"trust",
			"prepare",
			"find",
			"hit",
			"focus",
			"press",
			"key",
			"type",
			"settle",
			"tree",
		]);
		expect(cmds[2]).toMatchObject({ pid: 412, timeoutMs: 500, locator: { title: "Save" } });
		expect(cmds[9]).toMatchObject({ in: "window", depth: 3 });
	});

	it("records a type command with its text replaced by its length", async () => {
		const instance = await startFake();
		await instance.type("hunter2-secret", 1);
		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain("hunter2");
		expect(loggedCommands()[0]).toMatchObject({ cmd: "type", text: 14, charDelayMs: 1 });
	});

	it("turns an error reply into a NativeDriverError with its code, and stays usable", async () => {
		const instance = await startFake({
			press: {
				type: "error",
				code: "stale_ref",
				message: "Unknown or expired ref; refs last until the next find.",
			},
		});
		const error = await instance.press("e9").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NativeDriverError);
		expect((error as NativeDriverError).code).toBe("stale_ref");
		await expect(instance.trust()).resolves.toMatchObject({ accessibility: true });
	});

	it("carries the candidates of a not_found reply", async () => {
		const candidates = [1, 2, 3, 4, 5].map((n) => element({ ref: `e${n}`, title: `Save ${n}` }));
		const instance = await startFake({
			find: {
				type: "error",
				code: "not_found",
				message: "No element matched the locator.",
				candidates,
			},
		});
		const error = (await instance
			.find(412, { title: "Save" }, 100)
			.catch((e: unknown) => e)) as NativeDriverError;
		expect(error).toBeInstanceOf(NativeDriverError);
		expect(error.code).toBe("not_found");
		expect(error.candidates).toHaveLength(5);
		expect(error.candidates?.[4]?.title).toBe("Save 5");
	});

	it("times out a command the helper never answers, and drops its late reply", async () => {
		// find's timeout is timeoutMs + 1000, so a 0 ms budget times out in about 1 s.
		const findDriver = await startFake({
			find: [
				{ delayMs: 1500, element: element({ ref: "late" }) },
				{ element: element({ ref: "e2" }) },
			],
		});
		const began = Date.now();
		const error = (await findDriver
			.find(412, { title: "Save" }, 0)
			.catch((e: unknown) => e)) as NativeDriverError;
		expect(error).toBeInstanceOf(NativeDriverError);
		expect(error.code).toBe("timeout");
		expect(Date.now() - began).toBeLessThan(4000);
		// The next call gets its own reply, not a stale one.
		await expect(findDriver.find(412, { title: "Save" }, 0)).resolves.toMatchObject({ ref: "e2" });
	});

	it("never puts typed text in a timeout error", async () => {
		const instance = await startFake({ type: "silent" });
		// 14 chars x 0 ms + 2000 ms.
		const error = (await instance
			.type("hunter2-secret", 0)
			.catch((e: unknown) => e)) as NativeDriverError;
		expect(error).toBeInstanceOf(NativeDriverError);
		expect(error.code).toBe("timeout");
		expect(error.message).not.toContain("hunter2");
		expect(JSON.stringify(error.details)).not.toContain("hunter2");
		expect(String(error.stack)).not.toContain("hunter2");
	});

	it("rejects pending calls when the helper exits", async () => {
		const instance = await startFake({ settle: "exit" });
		const error = (await instance
			.settle(412, { quietMs: 100, capMs: 3000 })
			.catch((e: unknown) => e)) as NativeDriverError;
		expect(error).toBeInstanceOf(NativeDriverError);
		expect(error.code).toBe("helper_exited");
		expect(instance.isRunning).toBe(false);
		await expect(instance.trust()).rejects.toThrow(NativeDriverError);
	});

	it("refuses commands once stopped", async () => {
		const instance = await startFake();
		instance.stop();
		await expect(instance.trust()).rejects.toMatchObject({ code: "helper_exited" });
	});
});

describe("launchApp", () => {
	const noSleep = () => Promise.resolve();

	it("throws app_not_installed when open -b exits non-zero", async () => {
		const calls: string[][] = [];
		const execFile: ExecFileFn = async (file, args) => {
			calls.push([file, ...args]);
			throw Object.assign(new Error("exit 1"), { code: 1 });
		};
		const error = (await launchApp("com.example.missing", { execFile, sleep: noSleep }).catch(
			(e: unknown) => e,
		)) as NativeDriverError;
		expect(error).toBeInstanceOf(NativeDriverError);
		expect(error.code).toBe("app_not_installed");
		expect(calls).toEqual([["/usr/bin/open", "-b", "com.example.missing"]]);
	});

	it("polls the JXA bridge until a pid appears", async () => {
		let polls = 0;
		const execFile: ExecFileFn = async (file, args) => {
			if (file === "/usr/bin/open") return { stdout: "", stderr: "" };
			expect(file).toBe("osascript");
			expect(args.slice(0, 2)).toEqual(["-l", "JavaScript"]);
			expect(args[3]).toContain("runningApplicationsWithBundleIdentifier");
			polls++;
			return { stdout: polls < 3 ? "\n" : "4242\n", stderr: "" };
		};
		await expect(launchApp("com.apple.TextEdit", { execFile, sleep: noSleep })).resolves.toBe(4242);
		expect(polls).toBe(3);
	});

	it("throws no_app after 10 polls with no pid", async () => {
		let polls = 0;
		const execFile: ExecFileFn = async (file) => {
			if (file !== "/usr/bin/open") polls++;
			return { stdout: "", stderr: "" };
		};
		await expect(
			launchApp("com.example.ghost", { execFile, sleep: noSleep }),
		).rejects.toMatchObject({ code: "no_app" });
		expect(polls).toBe(10);
	});
});

describe("resolver", () => {
	it("describes locators readably", () => {
		expect(describeLocator({ role: "AXButton", title: "Save" })).toBe("ax:AXButton[title=Save]");
		expect(
			describeLocator({
				in: "statusbar",
				role: "AXMenuBarItem",
				label: "permission",
				match: "contains",
			}),
		).toBe("ax:statusbar/AXMenuBarItem[label~permission]");
		expect(describeLocator({ identifier: "save", index: 1 })).toBe(
			"ax:*[identifier=save][index=1]",
		);
	});

	function fakeDriver(hitPid: number | null): Pick<NativeDriverLike, "find" | "hit"> & {
		hits: Array<[number, number]>;
	} {
		const hits: Array<[number, number]> = [];
		return {
			hits,
			find: async (pid) => element({ pid }),
			hit: async (x, y) => {
				hits.push([x, y]);
				return { element: element({ pid: hitPid }), pid: hitPid };
			},
		};
	}

	it("returns the element and its frame centre when the target owns the point", async () => {
		const driver = fakeDriver(412);
		const resolved = await resolveTarget(driver, 412, { title: "Save" }, 1000);
		expect(resolved.center).toEqual({ x: 832, y: 442 });
		expect(driver.hits).toEqual([[832, 442]]);
	});

	it("throws occluded naming the owner pid when another process covers the centre", async () => {
		const error = (await resolveTarget(fakeDriver(999), 412, { title: "Save" }, 1000).catch(
			(e: unknown) => e,
		)) as NativeDriverError;
		expect(error).toBeInstanceOf(NativeDriverError);
		expect(error.code).toBe("occluded");
		expect(error.message).toContain("999");
		expect(error.details.ownerPid).toBe(999);
	});
});

const realBinaryPresent = (() => {
	try {
		accessSync(REAL_BINARY, constants.X_OK);
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!realBinaryPresent)("NativeDriver real-binary smoke (trust only)", () => {
	it("starts the built helper and answers trust", async () => {
		const instance = new NativeDriver({ helperPath: resolveNativeDriverPath() });
		try {
			await instance.start();
			const trust = await instance.trust();
			expect(typeof trust.accessibility).toBe("boolean");
			expect(typeof trust.secureInput).toBe("boolean");
		} finally {
			instance.stop();
		}
	});
});

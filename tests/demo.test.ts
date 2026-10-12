import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	chooseCapture,
	DemoError,
	type DriveHooks,
	type NativeDemoDeps,
	OLD_ENGINE_REGION_MESSAGE,
	runDemo,
} from "../src/commands/demo.js";
import { DriveError, type NarrationTimings } from "../src/commands/drive.js";
import type { ActionLogEntry } from "../src/lib/actionLog.js";

// These tests exercise `runDemo` — the stage sequencing `demo`'s CLI action
// calls — against a FAKE `spawnFn` (no real `lensmith record`/`compose`/
// `process` subprocess) and a FAKE `performDrive` (no real browser, no real
// OS cursor event; `runDrive` itself is already exhaustively covered by
// `tests/drive.test.ts`). What this file verifies is `demo`'s own
// contribution: the order, the always-stop-the-recorder guarantee, and the
// named-stage failure reporting.
//
// FakeChild mirrors the sibling engine repo's own `tests/recordSession.test.ts`
// convention: a real child_process has stdout/stderr Readable streams,
// EventEmitter-style error/exit events, and kill()/killed — a PassThrough
// gives us that exact interface without spawning any real process.
class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	killSignals: string[] = [];
	onKill?: (signal: string) => void;

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		this.killed = true;
		this.killSignals.push(String(signal));
		this.onKill?.(String(signal));
		return true;
	}

	emitExit(code: number | null): void {
		this.exitCode = code;
		this.emit("exit", code, null);
	}
}

interface SpawnedCommand {
	child: FakeChild;
	subcommand: string;
	args: string[];
}

interface SpawnHandlers {
	record?: (child: FakeChild, args: string[]) => void;
	compose?: (child: FakeChild, args: string[]) => void;
	process?: (child: FakeChild, args: string[]) => void;
	narrate?: (child: FakeChild, args: string[]) => void;
	voiceover?: (child: FakeChild, args: string[]) => void;
}

function buildSpawnFn(handlers: SpawnHandlers): {
	spawnFn: (cmd: string, args: string[]) => FakeChild;
	calls: SpawnedCommand[];
} {
	const calls: SpawnedCommand[] = [];
	const spawnFn = ((_cmd: string, spawnArgs: string[]) => {
		const [, subcommand, ...rest] = spawnArgs;
		const child = new FakeChild();
		calls.push({ child, subcommand: subcommand as string, args: rest });
		queueMicrotask(() => {
			if (subcommand === "record") handlers.record?.(child, rest);
			if (subcommand === "compose") handlers.compose?.(child, rest);
			if (subcommand === "process") handlers.process?.(child, rest);
			if (subcommand === "narrate") handlers.narrate?.(child, rest);
			if (subcommand === "voiceover") handlers.voiceover?.(child, rest);
		});
		return child;
		// biome-ignore lint/suspicious/noExplicitAny: FakeChild deliberately duck-types child_process's shape
	}) as any;
	return { spawnFn, calls };
}

function argAfter(args: string[], flag: string): string {
	const index = args.indexOf(flag);
	if (index === -1 || index + 1 >= args.length) {
		throw new Error(`${flag} not found in ${JSON.stringify(args)}`);
	}
	return args[index + 1] as string;
}

const FAKE_ACTION_LOG: ActionLogEntry[] = [
	{
		index: 0,
		type: "click",
		selector: "#btn-one",
		startedAtMs: 0,
		clickedAtMs: 100,
		settleMs: 0,
		screenX: 10,
		screenY: 10,
		boundingBox: { x: 0, y: 0, width: 20, height: 20 },
	},
	{
		index: 1,
		type: "click",
		selector: "#btn-two",
		startedAtMs: 200,
		clickedAtMs: 300,
		settleMs: 0,
		screenX: 40,
		screenY: 40,
		boundingBox: { x: 30, y: 30, width: 20, height: 20 },
	},
];

/** BF-15: the real drive calls `onWindowReady` once Chrome's window exists; the fake does the same. */
function fakePerformDrive(windowId: number | null = 4242) {
	return async (_stepList: unknown, hooks: DriveHooks) => {
		await hooks.onWindowReady(windowId);
		return {
			actionLog: FAKE_ACTION_LOG,
			viewport: { width: 800, height: 600 },
		};
	};
}

/**
 * Fakes `RunDemoDeps.onTerminationSignal` — mirrors `drive.ts`'s own
 * `onInterrupt` dependency (`tests/drive.test.ts`): tests trigger the same
 * code path a real SIGINT/SIGTERM would, without ever touching the real
 * global `process` object (which is shared across every test file in this
 * vitest worker).
 */
function fakeOnTerminationSignal() {
	const state: { callback?: (signal: NodeJS.Signals) => void; unregisterCalls: number } = {
		unregisterCalls: 0,
	};
	const onTerminationSignal = (callback: (signal: NodeJS.Signals) => void) => {
		state.callback = callback;
		return () => {
			state.unregisterCalls += 1;
		};
	};
	const trigger = (signal: NodeJS.Signals) => state.callback?.(signal);
	return { onTerminationSignal, trigger, state };
}

/** Standard record/compose/process handlers that actually write the files `demo` expects to find. */
function happyPathHandlers(): SpawnHandlers {
	return {
		record: (child, args) => {
			const rawPath = argAfter(args, "--out");
			child.stdout.write(`${"[lensmith] Recording ready."}\n`);
			child.onKill = () => {
				writeFileSync(rawPath, "fake-raw-video-bytes");
				writeFileSync(`${rawPath}.cursor.json`, JSON.stringify({ samples: [] }));
				writeFileSync(rawPath.replace(/\.mp4$/, ".session.json"), JSON.stringify({ ok: true }));
				child.emitExit(0);
			};
		},
		compose: (child, args) => {
			const outPath = argAfter(args, "--out");
			writeFileSync(outPath, JSON.stringify({ version: 2, editor: {} }));
			child.emitExit(0);
		},
		process: (child, args) => {
			const outPath = argAfter(args, "--out");
			writeFileSync(outPath, "fake-rendered-video-bytes");
			child.emitExit(0);
		},
	};
}

describe("runDemo", () => {
	let outDir: string;
	let stepsPath: string;

	beforeEach(() => {
		outDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-demo-out-"));
		const stepsDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-demo-steps-"));
		stepsPath = path.join(stepsDir, "steps.json");
		writeFileSync(
			stepsPath,
			JSON.stringify({
				url: "http://localhost:4173/drive-test-page.html",
				steps: [
					{ type: "click", selector: "#btn-one" },
					{ type: "click", selector: "#btn-two" },
				],
			}),
		);
	});

	afterEach(() => {
		rmSync(outDir, { recursive: true, force: true });
		rmSync(path.dirname(stepsPath), { recursive: true, force: true });
	});

	it("runs record, drive, compose and process in one call and writes a manifest naming every artifact", async () => {
		const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());

		const result = await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				nodeBinPath: "node",
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
				probeDurationMs: () => 4321,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		);

		expect(calls.map((c) => c.subcommand)).toEqual(["record", "compose", "process"]);

		expect(result.artifacts).toHaveLength(7);
		for (const artifact of result.artifacts) {
			expect(existsSync(artifact.path)).toBe(true);
			expect(artifact.sizeBytes).toBeGreaterThan(0);
		}

		const mediaArtifacts = result.artifacts.filter(
			(a) => a.name === "raw-recording" || a.name === "rendered-video",
		);
		expect(mediaArtifacts).toHaveLength(2);
		for (const artifact of mediaArtifacts) expect(artifact.durationMs).toBe(4321);

		const nonMediaArtifacts = result.artifacts.filter(
			(a) => a.name !== "raw-recording" && a.name !== "rendered-video",
		);
		for (const artifact of nonMediaArtifacts) expect(artifact.durationMs).toBeNull();

		const manifestOnDisk = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
		expect(manifestOnDisk.artifacts).toHaveLength(7);

		// Invariant: "the manifest lists every file the run actually wrote,
		// verified by comparing it against a directory listing."
		const filesWritten = readdirSync(outDir).filter((f) => f !== "demo-manifest.json");
		const namedInManifest = result.artifacts.map((a) => path.basename(a.path)).sort();
		expect(filesWritten.sort()).toEqual(namedInManifest);
	});

	it("passes the recorded action log's zoom fragment straight to compose, unchanged", async () => {
		const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());

		await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				nodeBinPath: "node",
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
				probeDurationMs: () => null,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		);

		const composeCall = calls.find((c) => c.subcommand === "compose");
		expect(composeCall).toBeDefined();
		const zoomsPath = argAfter(composeCall?.args ?? [], "--zooms");
		const fragment = JSON.parse(readFileSync(zoomsPath, "utf-8"));
		expect(fragment.zoomRegions).toHaveLength(2);
	});

	it("BF-15: records the driven window with --source window:<id> when the id is known, and starts the recorder before any step runs", async () => {
		const order: string[] = [];
		const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());
		await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: async (stepList, hooks) => {
					order.push(`before-hook:${calls.filter((c) => c.subcommand === "record").length}`);
					await hooks.onWindowReady(4242);
					order.push(`after-hook:${calls.filter((c) => c.subcommand === "record").length}`);
					return fakePerformDrive()(stepList, { onWindowReady: async () => undefined });
				},
				probeDurationMs: () => 1000,
			},
		);
		const record = calls.find((c) => c.subcommand === "record");
		expect(argAfter(record?.args ?? [], "--source")).toBe("window:4242");
		expect(order).toEqual(["before-hook:0", "after-hook:1"]);
	});

	it("BF-16: the recorder is stopped by onDriveFinished, i.e. before the driven window (Chrome) is closed", async () => {
		const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());
		let killedBeforeWindowClosed = false;
		await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: async (stepList, hooks) => {
					await hooks.onWindowReady(4242);
					await hooks.onDriveFinished?.();
					// the real withLaunchedChrome closes Chrome right after this point
					killedBeforeWindowClosed =
						calls.find((c) => c.subcommand === "record")?.child.killed === true;
					return fakePerformDrive()(stepList, { onWindowReady: async () => undefined });
				},
				probeDurationMs: () => 1000,
			},
		);
		expect(killedBeforeWindowClosed).toBe(true);
	});

	it("BF-15: falls back to screen capture (no --source) and warns when the window id is unknown", async () => {
		const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());
		const warnings: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			warnings.push(args.join(" "));
		};
		try {
			await runDemo(
				{ stepsPath, outDir },
				{
					spawnFn,
					resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
					performDrive: fakePerformDrive(null),
					probeDurationMs: () => 1000,
				},
			);
		} finally {
			console.error = originalError;
		}
		const record = calls.find((c) => c.subcommand === "record");
		expect(record?.args).not.toContain("--source");
		expect(warnings.some((w) => w.includes("recording the whole screen"))).toBe(true);
	});

	it("names 'engine' and starts nothing when the engine binary is not resolvable — immediate clear error, no silent run", async () => {
		const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());

		await expect(
			runDemo(
				{ stepsPath, outDir },
				{
					spawnFn,
					resolveEngineBinaryPath: () => {
						throw new Error("engine CLI not found at /fake/dist/cli.js");
					},
				},
			),
		).rejects.toMatchObject({ stage: "engine" });

		expect(calls).toHaveLength(0);
	});

	it("names 'steps' and starts nothing when the step list is invalid — no recorder spawned", async () => {
		const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());
		const badStepsPath = path.join(path.dirname(stepsPath), "bad-steps.json");
		writeFileSync(badStepsPath, "{not valid json");

		const error = await runDemo(
			{ stepsPath: badStepsPath, outDir },
			{ spawnFn, resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js" },
		).catch((e) => e);

		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("steps");
		expect(calls).toHaveLength(0);
	});

	it(
		"a driver failure (bad selector) names 'drive', always stops the recorder, and renders nothing " +
			"— fault injection, not a read of the code",
		async () => {
			let recordChild: FakeChild | undefined;
			const { spawnFn, calls } = buildSpawnFn({
				record: (child, args) => {
					const rawPath = argAfter(args, "--out");
					recordChild = child;
					child.stdout.write(`${"[lensmith] Recording ready."}\n`);
					child.onKill = () => {
						// A real recorder still writes whatever it captured before the
						// stop signal — Technical Spec item 2: "leaves the artifacts
						// produced so far in place for inspection."
						writeFileSync(rawPath, "partial-raw-video-bytes");
						child.emitExit(0);
					};
				},
				compose: (child) => child.emitExit(0),
				process: (child) => child.emitExit(0),
			});

			const driveFailure = new DriveError(
				'step at index 0: selector "#this-id-does-not-exist" was not found — timeout',
			);

			const error = await runDemo(
				{ stepsPath, outDir },
				{
					spawnFn,
					resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
					performDrive: async (_steps, hooks) => {
						await hooks.onWindowReady(4242);
						throw driveFailure;
					},
					readyTimeoutMs: 2000,
					stopTimeoutMs: 2000,
				},
			).catch((e) => e);

			expect(error).toBeInstanceOf(DemoError);
			expect((error as DemoError).stage).toBe("drive");
			expect((error as DemoError).message).toContain("was not found");

			// Invariant: "the recorder is always stopped, including when the
			// driver throws — proven by a fault-injection run."
			expect(recordChild?.killSignals).toContain("SIGINT");

			// Invariant: "a driver failure leaves no rendered output."
			expect(calls.some((c) => c.subcommand === "compose")).toBe(false);
			expect(calls.some((c) => c.subcommand === "process")).toBe(false);
			expect(existsSync(path.join(outDir, "final.mp4"))).toBe(false);
			expect(existsSync(path.join(outDir, "project.openscreen"))).toBe(false);
		},
	);

	it("names 'compose' when compose exits non-zero, and never renders", async () => {
		const { spawnFn, calls } = buildSpawnFn({
			record: (child, args) => {
				const rawPath = argAfter(args, "--out");
				child.stdout.write(`${"[lensmith] Recording ready."}\n`);
				child.onKill = () => {
					writeFileSync(rawPath, "fake-raw-video-bytes");
					writeFileSync(`${rawPath}.cursor.json`, "{}");
					writeFileSync(rawPath.replace(/\.mp4$/, ".session.json"), "{}");
					child.emitExit(0);
				};
			},
			compose: (child) => child.emitExit(1),
			process: (child) => child.emitExit(0),
		});

		const error = await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		).catch((e) => e);

		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("compose");
		expect(calls.some((c) => c.subcommand === "process")).toBe(false);
	});

	// CR-LENSMITH-A002-7 round 2 (proof rejection): the recorder's own
	// hang/timeout path orphaned a still-running child because the
	// `try/finally` boundary only covered the drive stage, not the ready-wait
	// itself. Each test below is named for the exit path from `runDemo` it
	// covers, per the round-2 dispatch's enumeration.

	it(
		"exit path: recorder hangs and never reports ready (proof's own finding) — the " +
			"recorder is stopped anyway, not left orphaned. RED against the pre-fix code: " +
			"stopRecorder was only ever called after a successful `await recorder.ready`, so " +
			"this exact scenario left `recordChild.killSignals` empty and the process running.",
		async () => {
			let recordChild: FakeChild | undefined;
			const { spawnFn } = buildSpawnFn({
				record: (child) => {
					recordChild = child;
					// Deliberately never writes the ready marker and never exits — a
					// stuck permission dialog or a ScreenCaptureKit session that never
					// resolves, the exact shape proof's fault injection used.
					child.onKill = () => child.emitExit(0);
				},
			});

			const error = await runDemo(
				{ stepsPath, outDir },
				{
					spawnFn,
					resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
					performDrive: fakePerformDrive(),
					readyTimeoutMs: 50,
					stopTimeoutMs: 2000,
				},
			).catch((e) => e);

			expect(error).toBeInstanceOf(DemoError);
			expect((error as DemoError).stage).toBe("record");
			expect((error as DemoError).message).toContain(
				"timed out waiting for the recorder to report ready",
			);
			expect(recordChild?.killSignals).toContain("SIGINT");
		},
	);

	it("exit path: recorder exits before ever reporting ready (a genuine crash) — nothing to kill, reported as stage 'record'", async () => {
		let recordChild: FakeChild | undefined;
		const { spawnFn } = buildSpawnFn({
			record: (child) => {
				recordChild = child;
				child.emitExit(1);
			},
		});

		const error = await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		).catch((e) => e);

		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("record");
		expect((error as DemoError).message).toContain("exited before becoming ready");
		// Already dead — `stopRecorder` must not attempt to signal it.
		expect(recordChild?.killSignals).toHaveLength(0);
	});

	it("exit path: the recorder's 'error' event (e.g. spawn failure surfacing async) is reported as stage 'record', and stopRecorder gives up rather than hanging forever on a child that never emits 'exit'", async () => {
		let recordChild: FakeChild | undefined;
		const { spawnFn } = buildSpawnFn({
			record: (child) => {
				recordChild = child;
				// A real spawn-ENOENT failure means no OS process ever existed —
				// this fake models that by never emitting "exit" no matter what
				// is sent to it, which is exactly the shape `stopRecorder`'s
				// `giveUp` fallback exists to not hang on.
				child.emit("error", new Error("spawn lensmith ENOENT"));
			},
		});

		const error = await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
				readyTimeoutMs: 2000,
				stopTimeoutMs: 100,
			},
		).catch((e) => e);

		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("record");
		expect((error as DemoError).message).toContain("ENOENT");
		// stopRecorder still attempts SIGINT (it cannot distinguish "no real
		// process" from "a process that just hasn't exited yet" up front) —
		// what matters is that it gives up instead of hanging.
		expect(recordChild?.killSignals).toContain("SIGINT");
	});

	it("exit path: spawning the recorder throws synchronously — reported as stage 'record', nothing else runs", async () => {
		const throwingSpawnFn = (() => {
			throw new Error("spawn EMFILE, too many open files");
			// biome-ignore lint/suspicious/noExplicitAny: matches buildSpawnFn's own duck-typed cast
		}) as any;

		const error = await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn: throwingSpawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
			},
		).catch((e) => e);

		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("record");
		expect((error as DemoError).message).toContain("EMFILE");
	});

	it(
		"exit path: onTerminationSignal() itself throws — CR-LENSMITH-A002-9 round 2 audit finding: " +
			"registration now happens BEFORE the recorder is spawned, so this throw never finds an " +
			"already-spawned recorder with nothing left to stop it. RED against spawn-then-register: " +
			"that order leaves a real child process running with `calls` already non-empty here.",
		async () => {
			const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());
			const boom = new Error("onTerminationSignal registration failed");

			const error = await runDemo(
				{ stepsPath, outDir },
				{
					spawnFn,
					resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
					performDrive: fakePerformDrive(),
					onTerminationSignal: () => {
						throw boom;
					},
				},
			).catch((e) => e);

			expect(error).toBe(boom);
			// The structural proof: the recorder was never spawned, so there is
			// nothing this failure could have orphaned.
			expect(calls).toHaveLength(0);
		},
	);

	it("exit path: a termination signal (SIGINT) delivered to the parent while waiting for the recorder to become ready stops the recorder and reports stage 'record'", async () => {
		let recordChild: FakeChild | undefined;
		const { spawnFn } = buildSpawnFn({
			record: (child) => {
				recordChild = child;
				// Never becomes ready in this test — the signal must win the race,
				// not the (generous) ready timeout.
				child.onKill = () => child.emitExit(0);
			},
		});
		const { onTerminationSignal, trigger } = fakeOnTerminationSignal();

		const runPromise = runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
				readyTimeoutMs: 5000,
				stopTimeoutMs: 2000,
				onTerminationSignal,
			},
		);

		// Let the fake spawn's queued record handler register the child first.
		await Promise.resolve();
		await Promise.resolve();
		trigger("SIGINT");

		const error = await runPromise.catch((e) => e);
		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("record");
		expect((error as DemoError).message).toContain("SIGINT");
		expect(recordChild?.killSignals).toContain("SIGINT");
	});

	it("exit path: a termination signal (SIGTERM) delivered to the parent during the drive stage stops the recorder and reports stage 'drive'", async () => {
		let recordChild: FakeChild | undefined;
		const { spawnFn, calls } = buildSpawnFn({
			record: (child, args) => {
				const rawPath = argAfter(args, "--out");
				recordChild = child;
				child.stdout.write(`${"[lensmith] Recording ready."}\n`);
				child.onKill = () => {
					writeFileSync(rawPath, "partial-raw-video-bytes");
					child.emitExit(0);
				};
			},
		});
		const { onTerminationSignal, trigger } = fakeOnTerminationSignal();

		const runPromise = runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				// Never resolves in this test — the signal, not the driver, must end the run.
				performDrive: async (_steps, hooks) => {
					await hooks.onWindowReady(4242);
					return new Promise<RunDriveResult>(() => {
						// deliberately never settles
					});
				},
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
				onTerminationSignal,
			},
		);

		// Let the recorder actually report ready (moving into the drive stage)
		// before the signal arrives.
		await new Promise((resolve) => setTimeout(resolve, 20));
		trigger("SIGTERM");

		const error = await runPromise.catch((e) => e);
		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("drive");
		expect((error as DemoError).message).toContain("SIGTERM");
		expect(recordChild?.killSignals).toContain("SIGINT");
		expect(calls.some((c) => c.subcommand === "compose")).toBe(false);
	});

	it("unregisters the termination-signal listener once the recorder's fate is sealed, on the happy path (no leak into later stages)", async () => {
		const { spawnFn } = buildSpawnFn(happyPathHandlers());
		const { onTerminationSignal, state } = fakeOnTerminationSignal();

		await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
				probeDurationMs: () => 1000,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
				onTerminationSignal,
			},
		);

		expect(state.unregisterCalls).toBeGreaterThanOrEqual(1);
	});
});

describe("the dwell-suggestion path is unreachable from demo.ts by construction", () => {
	it('contains neither "suggestZooms" nor "zoomSuggestion"', () => {
		const source = readFileSync(
			path.join(import.meta.dirname, "..", "src", "commands", "demo.ts"),
			"utf-8",
		);
		expect(source).not.toMatch(/suggestZooms|zoomSuggestion/);
	});
});

// CR-LENSMITH-A008-5: `demo` generates the narration (engine `narrate`) and drives to it.
describe("runDemo: narrate stage (CR-LENSMITH-A008-5)", () => {
	let outDir: string;
	let stepsPath: string;

	const SAY_STEPS = {
		url: "http://localhost:4173/drive-test-page.html",
		steps: [
			{ type: "click", selector: "#btn-one", say: "Open the [[story]] Buildr story" },
			{ type: "click", selector: "#btn-two" },
			{ type: "wait", ms: 300, say: "And that is the whole flow" },
		],
	};

	/** What the engine's `narrate` writes: one audio file per line plus timings.json. */
	function fakeNarrate(child: FakeChild, args: string[]): void {
		const outPath = argAfter(args, "--out");
		mkdirSync(outPath, { recursive: true });
		writeFileSync(path.join(outPath, "s0.wav"), "fake-audio-s0");
		writeFileSync(path.join(outPath, "s2.wav"), "fake-audio-s2");
		const timings = {
			lines: {
				s0: { file: "s0.wav", durationMs: 2400, marks: { story: 600 }, words: [], cues: [] },
				s2: { file: "s2.wav", durationMs: 1800, marks: {}, words: [], cues: [] },
			},
		};
		writeFileSync(path.join(outPath, "timings.json"), JSON.stringify(timings));
		child.emitExit(0);
	}

	/** The action log a narrated drive records: s0 and s2 carry the voice start times (CR-LENSMITH-A008-2). */
	const NARRATED_LOG: ActionLogEntry[] = [
		{ ...(FAKE_ACTION_LOG[0] as ActionLogEntry), voiceLineId: "s0", voiceStartMs: 1234.6 },
		FAKE_ACTION_LOG[1] as ActionLogEntry,
		{ index: 2, type: "wait", atMs: 5000, ms: 300, voiceLineId: "s2", voiceStartMs: 5000 },
	];
	const narratedDrive = async (_stepList: unknown, hooks: DriveHooks) => {
		await hooks.onWindowReady(4242);
		return { actionLog: NARRATED_LOG, viewport: { width: 800, height: 600 } };
	};
	/** What the engine's `voiceover` writes: the voiced film at --out. */
	function fakeVoiceover(child: FakeChild, args: string[]): void {
		writeFileSync(argAfter(args, "--out"), "fake-voiced-video-bytes");
		child.emitExit(0);
	}
	const narratedHandlers = (): SpawnHandlers => ({
		...happyPathHandlers(),
		narrate: fakeNarrate,
		voiceover: fakeVoiceover,
	});

	beforeEach(() => {
		outDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-demo-narr-out-"));
		const stepsDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-demo-narr-steps-"));
		stepsPath = path.join(stepsDir, "steps.json");
		writeFileSync(stepsPath, JSON.stringify(SAY_STEPS));
	});

	afterEach(() => {
		rmSync(outDir, { recursive: true, force: true });
		rmSync(path.dirname(stepsPath), { recursive: true, force: true });
	});

	it("writes narration-script.json from the say lines, runs narrate before record, drives with its timings and lists the narration files", async () => {
		const { spawnFn, calls } = buildSpawnFn(narratedHandlers());
		let seenNarration: NarrationTimings | undefined;
		let recordsWhenDriveStarted = -1;

		const result = await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				nodeBinPath: "node",
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: async (stepList, hooks, narration) => {
					seenNarration = narration;
					recordsWhenDriveStarted = calls.filter((c) => c.subcommand === "record").length;
					return narratedDrive(stepList, hooks);
				},
				probeDurationMs: () => 1000,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		);

		expect(calls.map((c) => c.subcommand)).toEqual([
			"narrate",
			"record",
			"compose",
			"process",
			"voiceover",
		]);
		expect(recordsWhenDriveStarted).toBe(0);

		const scriptPath = path.join(outDir, "narration-script.json");
		expect(JSON.parse(readFileSync(scriptPath, "utf-8"))).toEqual({
			lines: [
				{ id: "s0", text: "Open the [[story]] Buildr story" },
				{ id: "s2", text: "And that is the whole flow" },
			],
		});

		const narrateArgs = calls[0]?.args ?? [];
		expect(argAfter(narrateArgs, "--script")).toBe(scriptPath);
		expect(argAfter(narrateArgs, "--out")).toBe(path.join(outDir, "narration"));
		expect(narrateArgs).toContain("--json");
		expect(narrateArgs).not.toContain("--voice");
		expect(narrateArgs).not.toContain("--engine");

		expect(seenNarration?.lines.s0?.marks.story).toBe(600);
		expect(seenNarration?.lines.s2?.durationMs).toBe(1800);

		const byName = new Map(result.artifacts.map((a) => [a.name, a]));
		expect(byName.get("narration-script")?.path).toBe(scriptPath);
		expect(byName.get("narration-timings")?.path).toBe(
			path.join(outDir, "narration", "timings.json"),
		);
		expect(byName.get("narration-audio-s0")?.path).toBe(path.join(outDir, "narration", "s0.wav"));
		expect(byName.get("narration-audio-s0")?.durationMs).toBe(1000);
		expect(byName.get("narration-audio-s2")?.path).toBe(path.join(outDir, "narration", "s2.wav"));
		expect(byName.get("narration-timings")?.durationMs).toBeNull();
		expect(result.artifacts).toHaveLength(13);

		const manifestOnDisk = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
		expect(manifestOnDisk.artifacts.map((a: { name: string }) => a.name)).toContain(
			"narration-audio-s2",
		);
	});

	it("passes --voice and --engine through to narrate", async () => {
		const { spawnFn, calls } = buildSpawnFn(narratedHandlers());
		await runDemo(
			{ stepsPath, outDir, voice: "af_heart", narrateEngine: "kokoro" },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: narratedDrive,
				probeDurationMs: () => null,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		);
		const narrateArgs = calls.find((c) => c.subcommand === "narrate")?.args ?? [];
		expect(argAfter(narrateArgs, "--voice")).toBe("af_heart");
		expect(argAfter(narrateArgs, "--engine")).toBe("kokoro");
	});

	it("without say lines: no narrate call, no narration files, drive gets no narration", async () => {
		writeFileSync(
			stepsPath,
			JSON.stringify({ url: SAY_STEPS.url, steps: [{ type: "click", selector: "#btn-one" }] }),
		);
		const { spawnFn, calls } = buildSpawnFn({ ...happyPathHandlers(), narrate: fakeNarrate });
		let driveArgCount = -1;
		let seenNarration: NarrationTimings | undefined;
		const result = await runDemo(
			{ stepsPath, outDir, voice: "af_heart" },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: async (...args) => {
					driveArgCount = args.length;
					seenNarration = args[2];
					return fakePerformDrive()(args[0], args[1]);
				},
				probeDurationMs: () => null,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		);
		expect(calls.map((c) => c.subcommand)).toEqual(["record", "compose", "process"]);
		expect(driveArgCount).toBe(2);
		expect(seenNarration).toBeUndefined();
		expect(existsSync(path.join(outDir, "narration-script.json"))).toBe(false);
		expect(existsSync(path.join(outDir, "narration"))).toBe(false);
		expect(result.artifacts).toHaveLength(7);
	});

	it("an engine narrate failure stops the demo at stage 'narrate' before anything is recorded", async () => {
		const { spawnFn, calls } = buildSpawnFn({
			...happyPathHandlers(),
			narrate: (child) => child.emitExit(3),
		});
		let driveCalled = false;
		const error = await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: async (stepList, hooks) => {
					driveCalled = true;
					return fakePerformDrive()(stepList, hooks);
				},
				probeDurationMs: () => null,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("narrate");
		expect((error as DemoError).message).toMatch(/narrate exited with code 3/);
		expect(calls.map((c) => c.subcommand)).toEqual(["narrate"]);
		expect(driveCalled).toBe(false);
	});

	it("timings.json missing a step's mark stops the demo at stage 'narrate'", async () => {
		const { spawnFn, calls } = buildSpawnFn({
			...happyPathHandlers(),
			narrate: (child, args) => {
				const outPath = argAfter(args, "--out");
				mkdirSync(outPath, { recursive: true });
				writeFileSync(
					path.join(outPath, "timings.json"),
					JSON.stringify({
						lines: {
							s0: { file: "s0.wav", durationMs: 2400, marks: {} },
							s2: { file: "s2.wav", durationMs: 1800, marks: {} },
						},
					}),
				);
				child.emitExit(0);
			},
		});
		const error = await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
				probeDurationMs: () => null,
			},
		).catch((e: unknown) => e);
		expect((error as DemoError).stage).toBe("narrate");
		expect((error as DemoError).message).toMatch(/marks \[\[story\]\]/);
		expect(calls.map((c) => c.subcommand)).toEqual(["narrate"]);
	});
	it("voice: writes voice-starts.json on the zoom time base, runs voiceover with the right files and delivers the voiced film", async () => {
		const { spawnFn, calls } = buildSpawnFn(narratedHandlers());
		const result = await runDemo(
			{ stepsPath, outDir, captions: "srt" },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: narratedDrive,
				probeDurationMs: () => 1000,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		);
		const startsPath = path.join(outDir, "voice-starts.json");
		const starts = JSON.parse(readFileSync(startsPath, "utf-8"));
		expect(starts).toEqual({ s0: 1235, s2: 5000 });

		// Same mapping as the zoom regions: an action-log time is the film time.
		const zooms = JSON.parse(readFileSync(path.join(outDir, "zooms.json"), "utf-8"));
		expect(zooms.zoomRegions[0].startMs).toBe(0); // step 0 startedAtMs 0 -> film 0 (identity, as for voice)
		expect(starts.s2).toBe(5000); // voiceStartMs 5000 -> 5000

		const call = calls.find((c) => c.subcommand === "voiceover");
		const args = call?.args ?? [];
		expect(argAfter(args, "--video")).toBe(path.join(outDir, "final.mp4"));
		expect(argAfter(args, "--narration")).toBe(path.join(outDir, "narration", "timings.json"));
		expect(argAfter(args, "--starts")).toBe(startsPath);
		expect(argAfter(args, "--out")).toBe(path.join(outDir, "final-voiced.mp4"));
		expect(argAfter(args, "--captions")).toBe("srt");

		const byName = new Map(result.artifacts.map((a) => [a.name, a]));
		expect(byName.get("rendered-video")?.path).toBe(path.join(outDir, "final-voiced.mp4"));
		expect(byName.get("rendered-video-silent")?.path).toBe(path.join(outDir, "final.mp4"));
		expect(byName.get("voice-starts")?.path).toBe(startsPath);
	});

	it("voice: omits --captions when none was asked for (engine default burns)", async () => {
		const { spawnFn, calls } = buildSpawnFn(narratedHandlers());
		await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: narratedDrive,
				probeDurationMs: () => null,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		);
		expect(calls.find((c) => c.subcommand === "voiceover")?.args).not.toContain("--captions");
	});

	it("voice: a voiceover failure (e.g. ffmpeg without libass) fails the demo at stage 'voiceover'", async () => {
		const { spawnFn } = buildSpawnFn({
			...narratedHandlers(),
			voiceover: (child) => child.emitExit(1),
		});
		const error = await runDemo(
			{ stepsPath, outDir },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: narratedDrive,
				probeDurationMs: () => null,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("voiceover");
		expect((error as DemoError).message).toMatch(/voiceover exited with code 1.*libass/);
		expect(existsSync(path.join(outDir, "final.mp4"))).toBe(true);
		expect(existsSync(path.join(outDir, "demo-manifest.json"))).toBe(false);
	});

	it("voice: no say lines means no voiceover stage and the usual single rendered-video", async () => {
		writeFileSync(
			stepsPath,
			JSON.stringify({ url: SAY_STEPS.url, steps: [{ type: "click", selector: "#btn-one" }] }),
		);
		const { spawnFn, calls } = buildSpawnFn(narratedHandlers());
		const result = await runDemo(
			{ stepsPath, outDir, captions: "none" },
			{
				spawnFn,
				resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
				performDrive: fakePerformDrive(),
				probeDurationMs: () => null,
				readyTimeoutMs: 2000,
				stopTimeoutMs: 2000,
			},
		);
		expect(calls.map((c) => c.subcommand)).toEqual(["record", "compose", "process"]);
		const names = result.artifacts.map((a) => a.name);
		expect(names).not.toContain("rendered-video-silent");
		expect(names).not.toContain("voice-starts");
		expect(existsSync(path.join(outDir, "voice-starts.json"))).toBe(false);
		expect(result.artifacts.find((a) => a.name === "rendered-video")?.path).toBe(
			path.join(outDir, "final.mp4"),
		);
	});
});

/* ------------------------------------------------------------------------------------------ */
/* CR-LENSMITH-A010-8: native lists — capture choice, preflight, pre-roll, native zoom.      */
/* Fakes only: no app is launched, no screen is driven, nothing is recorded.                  */
/* ------------------------------------------------------------------------------------------ */

const DISPLAY = { x: 0, y: 0, width: 3200, height: 1800 };
const WINDOW = { id: 77, ownerPid: 501, x: 0, y: 25, width: 1600, height: 900 };
const LAUNCHER = "com.example.launcher";
const MONITOR = "com.example.monitor";

describe("chooseCapture (design note §6)", () => {
	const click = { type: "click", app: LAUNCHER, ax: { role: "AXButton" } } as const;
	const rows: Array<{
		name: string;
		list: Record<string, unknown>;
		window: typeof WINDOW | null;
		mode: "window" | "region" | "screen";
		source: string | undefined;
		warns?: boolean;
	}> = [
		{
			name: "a declared region records that rectangle",
			list: { capture: { region: { x: 800, y: 150, width: 1600, height: 900 } } },
			window: WINDOW,
			mode: "region",
			source: "region:800,150,1600,900",
		},
		{
			name: '"window" with a window found records the window',
			list: { capture: "window" },
			window: WINDOW,
			mode: "window",
			source: "window:77",
		},
		{
			name: '"window" with no window falls back to the screen with a warning',
			list: { capture: "window" },
			window: null,
			mode: "screen",
			source: undefined,
			warns: true,
		},
		{
			name: '"window" with a url falls back to the screen with a warning',
			list: { capture: "window", url: "http://localhost:4173/x.html" },
			window: WINDOW,
			mode: "screen",
			source: undefined,
			warns: true,
		},
		{
			name: '"auto" with one app and a window records the window',
			list: {},
			window: WINDOW,
			mode: "window",
			source: "window:77",
		},
		{
			name: '"auto" with two apps records the screen',
			list: { apps: [{ bundleId: LAUNCHER }, { bundleId: MONITOR }] },
			window: WINDOW,
			mode: "screen",
			source: undefined,
		},
		{
			name: '"auto" with an activate step records the screen',
			list: { steps: [click, { type: "activate", app: LAUNCHER }] },
			window: WINDOW,
			mode: "screen",
			source: undefined,
		},
		{
			name: '"auto" with a statusbar locator records the screen',
			list: {
				steps: [{ type: "hover", app: LAUNCHER, ax: { in: "statusbar", role: "AXMenuBarItem" } }],
			},
			window: WINDOW,
			mode: "screen",
			source: undefined,
		},
		{
			name: '"auto" with a menubar locator records the screen',
			list: { steps: [{ type: "click", app: LAUNCHER, ax: { in: "menubar", title: "File" } }] },
			window: WINDOW,
			mode: "screen",
			source: undefined,
		},
		{
			name: '"auto" with no window found records the screen',
			list: {},
			window: null,
			mode: "screen",
			source: undefined,
		},
		{
			name: '"screen" records the screen',
			list: { capture: "screen" },
			window: WINDOW,
			mode: "screen",
			source: undefined,
		},
	];
	for (const row of rows) {
		it(row.name, () => {
			const list = { apps: [{ bundleId: LAUNCHER }], steps: [click], ...row.list };
			// biome-ignore lint/suspicious/noExplicitAny: table rows are partial step lists
			const choice = chooseCapture(list as any, { window: row.window, display: DISPLAY });
			expect(choice.mode).toBe(row.mode);
			expect(choice.source).toBe(row.source);
			expect(choice.warning !== undefined).toBe(row.warns === true);
			if (row.mode === "screen") expect(choice.capture).toEqual(DISPLAY);
		});
	}
});

const NATIVE_ACTION_LOG: ActionLogEntry[] = [
	{
		index: 0,
		type: "key",
		app: LAUNCHER,
		keys: ["opt+space"],
		atMs: 100,
		settleMs: 100,
		settleReason: "quiet",
		boundingBox: { x: 100, y: 100, width: 200, height: 40 },
	},
	{
		index: 1,
		type: "type",
		app: LAUNCHER,
		selector: "ax:AXTextField",
		startedAtMs: 4000,
		endedAtMs: 4600,
		screenX: 0,
		screenY: 0,
		boundingBox: { x: 1300, y: 700, width: 200, height: 40 },
		characterCount: 17,
		settleMs: 100,
	},
	{
		index: 2,
		type: "key",
		app: LAUNCHER,
		keys: ["return"],
		atMs: 8000,
		settleMs: 100,
		settleReason: "quiet",
	},
	{ index: 3, type: "activate", app: MONITOR, atMs: 8300 },
	{
		index: 4,
		type: "hover",
		app: MONITOR,
		selector: "ax:AXRow",
		ax: { role: "AXRow" },
		startedAtMs: 9000,
		hoveredAtMs: 9800,
		screenX: 0,
		screenY: 0,
		boundingBox: { x: 100, y: 700, width: 300, height: 30 },
		settleMs: 100,
		settleReason: "quiet",
	},
	{
		index: 5,
		type: "click",
		app: MONITOR,
		selector: "ax:AXButton",
		startedAtMs: 13000,
		clickedAtMs: 13600,
		screenX: 0,
		screenY: 0,
		boundingBox: { x: 1300, y: 100, width: 80, height: 30 },
		settleMs: 100,
	},
];

interface NativeFakes {
	deps: NativeDemoDeps;
	events: string[];
	driveArgs: Array<Record<string, unknown>>;
}

function nativeFakes(overrides: Partial<NativeDemoDeps> = {}): NativeFakes {
	const events: string[] = [];
	const driveArgs: Array<Record<string, unknown>> = [];
	let nextPid = 500;
	const deps: NativeDemoDeps = {
		resolveNativeDriverPath: () => "/fake/bin/lensmith-native-driver",
		trust: async () => ({ accessibility: true, secureInput: false }),
		checkScreenCapture: () => "screen capture available",
		createDriver: () =>
			({
				start: async () => {
					events.push("driver.start");
				},
				prepare: async (pid: number, frame?: unknown) => {
					events.push(`prepare ${pid} ${JSON.stringify(frame ?? null)}`);
					return null;
				},
				stop: () => {
					events.push("driver.stop");
				},
			}) as unknown as ReturnType<NonNullable<NativeDemoDeps["createDriver"]>>,
		launchApp: async (bundleId) => {
			nextPid += 1;
			events.push(`launch ${bundleId} -> ${nextPid}`);
			return nextPid;
		},
		activate: async (pid) => {
			events.push(`activate ${pid}`);
		},
		listWindows: async () => [{ ...WINDOW, ownerPid: 501 }],
		mainDisplayBounds: async () => DISPLAY,
		createChoreographer: () => ({
			start: async () => {
				events.push("choreographer.start");
			},
			stop: () => {
				events.push("choreographer.stop");
			},
			moveTo: async () => ({ requested: { x: 0, y: 0 }, achieved: { x: 0, y: 0 } }),
			dwell: async () => undefined,
			click: async () => ({ x: 0, y: 0 }),
		}),
		sleep: async () => undefined,
		log: () => undefined,
		drive: (async (_list: unknown, driveDeps: Record<string, unknown>) => {
			events.push("drive");
			driveArgs.push(driveDeps);
			return { actionLog: NATIVE_ACTION_LOG, viewport: { width: 1600, height: 900 } };
			// biome-ignore lint/suspicious/noExplicitAny: fake runDrive
		}) as any,
		...overrides,
	};
	return { deps, events, driveArgs };
}

describe("runDemo — native lists (CR-LENSMITH-A010-8)", () => {
	let outDir: string;
	let stepsDir: string;

	const writeSteps = (list: Record<string, unknown>): string => {
		const p = path.join(stepsDir, "native.json");
		writeFileSync(p, JSON.stringify(list));
		return p;
	};

	const regionList = {
		apps: [{ bundleId: LAUNCHER }, { bundleId: MONITOR }],
		capture: { region: { x: 800, y: 150, width: 1600, height: 900 } },
		steps: [
			{ type: "key", app: LAUNCHER, keys: "opt+space", zoom: { role: "AXTextField" } },
			{ type: "type", app: LAUNCHER, text: "clipboard history" },
			{ type: "key", app: LAUNCHER, keys: "return" },
			{ type: "activate", app: MONITOR },
			{ type: "hover", app: MONITOR, ax: { role: "AXRow" } },
			{ type: "click", app: MONITOR, ax: { role: "AXButton" } },
		],
	};

	beforeEach(() => {
		outDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-demo-native-out-"));
		stepsDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-demo-native-steps-"));
	});

	afterEach(() => {
		rmSync(outDir, { recursive: true, force: true });
		rmSync(stepsDir, { recursive: true, force: true });
	});

	const baseDeps = (spawnFn: unknown) => ({
		// biome-ignore lint/suspicious/noExplicitAny: FakeChild spawn
		spawnFn: spawnFn as any,
		nodeBinPath: "node",
		resolveEngineBinaryPath: () => "/fake/lensmith/dist/cli.js",
		probeDurationMs: () => null,
		readyTimeoutMs: 2000,
		stopTimeoutMs: 2000,
	});

	it("acceptance: preflight, apps launched and framed in order, --source region, one zoom per click/type/hover/zoomed key", async () => {
		const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());
		const fakes = nativeFakes();
		await runDemo(
			{ stepsPath: writeSteps(regionList), outDir },
			{ ...baseDeps(spawnFn), native: fakes.deps },
		);

		expect(fakes.events.slice(0, 6)).toEqual([
			"driver.start",
			`launch ${LAUNCHER} -> 501`,
			'prepare 501 {"width":1600,"height":900,"x":0,"y":25}',
			`launch ${MONITOR} -> 502`,
			"prepare 502 null",
			"activate 501",
		]);
		expect(fakes.events.indexOf("drive")).toBeGreaterThan(fakes.events.indexOf("activate 501"));
		expect(fakes.events.slice(-2)).toEqual(["choreographer.stop", "driver.stop"]);

		const record = calls.find((c) => c.subcommand === "record");
		expect(argAfter(record?.args ?? [], "--source")).toBe("region:800,150,1600,900");

		const native = fakes.driveArgs[0]?.native as { capture: unknown; pids: Map<string, number> };
		expect(native.capture).toEqual({ x: 800, y: 150, width: 1600, height: 900 });
		expect([...native.pids.entries()]).toEqual([
			[LAUNCHER, 501],
			[MONITOR, 502],
		]);

		const compose = calls.find((c) => c.subcommand === "compose");
		const fragment = JSON.parse(readFileSync(argAfter(compose?.args ?? [], "--zooms"), "utf-8"));
		expect(fragment.zoomRegions.map((r: { id: string }) => r.id)).toEqual([
			"zoom-0",
			"zoom-1",
			"zoom-4",
			"zoom-5",
		]);
	});

	it("QA: Accessibility not granted stops at preflight with the fix — no app launched, no recorder spawned", async () => {
		const { spawnFn, calls } = buildSpawnFn(happyPathHandlers());
		const fakes = nativeFakes({
			trust: async () => ({ accessibility: false, secureInput: false }),
		});
		const error = await runDemo(
			{ stepsPath: writeSteps(regionList), outDir },
			{ ...baseDeps(spawnFn), native: fakes.deps },
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(DemoError);
		expect((error as DemoError).stage).toBe("preflight");
		expect((error as DemoError).message).toMatch(/accessibility_permission/);
		expect((error as DemoError).message).toMatch(/Privacy & Security > Accessibility/);
		expect(fakes.events.some((e) => e.startsWith("launch"))).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("preflight refusal order: helper, then accessibility, then screen recording; secure input only warns", async () => {
		const { spawnFn } = buildSpawnFn(happyPathHandlers());
		const fakes = nativeFakes({
			resolveNativeDriverPath: () => {
				throw new Error("helper not built");
			},
			checkScreenCapture: () => {
				throw new Error("no screen recording");
			},
		});
		const error = (await runDemo(
			{ stepsPath: writeSteps(regionList), outDir },
			{ ...baseDeps(spawnFn), native: fakes.deps },
		).catch((e: unknown) => e)) as DemoError;
		expect(error.stage).toBe("preflight");
		const ids = [...error.message.matchAll(/(\w+_\w+(?:_\w+)?): /g)].map((m) => m[1]);
		expect(ids).toEqual([
			"native_helper_built",
			"accessibility_permission",
			"screen_recording_capability",
		]);

		const { spawnFn: okSpawn } = buildSpawnFn(happyPathHandlers());
		const secure = nativeFakes({ trust: async () => ({ accessibility: true, secureInput: true }) });
		await expect(
			runDemo(
				{ stepsPath: writeSteps(regionList), outDir },
				{ ...baseDeps(okSpawn), native: secure.deps },
			),
		).resolves.toBeDefined();
	});

	it("names the old engine when it refuses region capture", async () => {
		const { spawnFn } = buildSpawnFn({
			record: (child) => {
				child.stderr.write(
					'Invalid --source "region:800,150,1600,900". Expected "screen" or "window:<numeric-window-id>".\n',
				);
				child.emitExit(2);
			},
		});
		const fakes = nativeFakes();
		const error = (await runDemo(
			{ stepsPath: writeSteps(regionList), outDir },
			{ ...baseDeps(spawnFn), native: fakes.deps },
		).catch((e: unknown) => e)) as DemoError;
		expect(error).toBeInstanceOf(DemoError);
		expect(error.stage).toBe("record");
		expect(error.message).toBe(OLD_ENGINE_REGION_MESSAGE);
	});

	it("QA: one app with auto capture records window:<id>; a statusbar locator falls back to the screen", async () => {
		const oneApp = {
			apps: [{ bundleId: LAUNCHER }],
			steps: [{ type: "click", app: LAUNCHER, ax: { role: "AXButton" } }],
		};
		const first = buildSpawnFn(happyPathHandlers());
		await runDemo(
			{ stepsPath: writeSteps(oneApp), outDir },
			{ ...baseDeps(first.spawnFn), native: nativeFakes().deps },
		);
		const record = first.calls.find((c) => c.subcommand === "record");
		expect(argAfter(record?.args ?? [], "--source")).toBe("window:77");

		const withBar = {
			...oneApp,
			steps: [
				...oneApp.steps,
				{ type: "hover", app: LAUNCHER, ax: { in: "statusbar", role: "AXMenuBarItem" } },
			],
		};
		const second = buildSpawnFn(happyPathHandlers());
		const fakes = nativeFakes();
		await runDemo(
			{ stepsPath: writeSteps(withBar), outDir },
			{ ...baseDeps(second.spawnFn), native: fakes.deps },
		);
		const record2 = second.calls.find((c) => c.subcommand === "record");
		expect(record2?.args).not.toContain("--source");
		const native = fakes.driveArgs[0]?.native as { capture: unknown };
		expect(native.capture).toEqual(DISPLAY);
	});

	it("a web-only list never runs the native preflight", async () => {
		const webSteps = writeSteps({
			url: "http://localhost:4173/drive-test-page.html",
			steps: [{ type: "click", selector: "#btn-one" }],
		});
		const { spawnFn } = buildSpawnFn(happyPathHandlers());
		let asked = false;
		await runDemo(
			{ stepsPath: webSteps, outDir },
			{
				...baseDeps(spawnFn),
				performDrive: fakePerformDrive(),
				native: {
					resolveNativeDriverPath: () => {
						asked = true;
						throw new Error("must not be called");
					},
				},
			},
		);
		expect(asked).toBe(false);
	});
});

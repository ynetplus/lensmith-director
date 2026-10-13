/**
 * `lensmith-director demo` — sequences all four pipeline commands (the
 * engine's `record`, this repo's own `drive`, then the engine's `compose`
 * and `process`) into one invocation, so producing a clip is not four
 * hand-run commands with a human as the joint between them. CR-LENSMITH-A002-7.
 *
 * CR-LENSMITH-A008-5: when any step carries a `say` line, a `narrate` stage runs first —
 * the engine's `lensmith narrate` turns the say lines into audio plus `timings.json`, and the
 * drive is paced to it (the click lands on the line's `[[mark]]`, the hold covers the voice).
 * Without say lines nothing below changes.
 *
 * Order (Technical Spec item 2): start the recorder and wait for its own
 * ready line, run the driver, always stop the recorder next (whether the
 * driver succeeded or not), then compose and process. A failure at any stage
 * throws a {@link DemoError} naming that stage and leaves whatever was
 * already written in `--out-dir` in place — nothing here deletes a partial
 * artifact.
 *
 * `runDemo` takes every external effect (spawning the recorder/compose/
 * process children, performing the drive stage, probing a media file's
 * duration) as injectable `RunDemoDeps`, the same split `runDrive`
 * (`drive.ts`) and `runRecord` (the sibling engine repo's `recordSession.ts`)
 * already use — so the full stage sequencing, the stage-failure reporting,
 * and the always-stop-the-recorder guarantee are unit-testable against
 * fakes that launch no browser, spawn no real process, and post no OS
 * cursor event. Only `registerDemoCommand`'s CLI action uses the real
 * implementations, exercised only in an announced, attended machine window
 * (this repo's standing rule — see `CLAUDE.md`).
 *
 * **Invariant (CR-LENSMITH-A002-7 round 2, [[BF-6]]): once the recorder child
 * exists, it is owned for the rest of this function's lifetime, structurally
 * — not by inspection of each branch that follows.** The recorder is created
 * and immediately entered into a `try/finally` whose `finally` stops it
 * unconditionally (`stopRecorder` is idempotent: a no-op against a child that
 * already exited). This covers every way control can leave that region: the
 * ready-wait timing out or the child erroring/exiting before ever reporting
 * ready, the driver throwing, a thrown error from any step afterward, and a
 * SIGINT/SIGTERM delivered to this process itself (raced against whichever
 * stage is in flight via `onTerminationSignal`). A `SIGKILL` to this process
 * is the one exit path no code here can observe or react to — the recorder
 * is left running in that case, and no amount of `try/finally` changes that.
 * Do not re-derive this by reading the branches; if you add a stage between
 * spawn and the `finally`, it inherits this guarantee for free — only a
 * change that spawns the recorder somewhere else, or returns before the
 * `try` begins, can reopen it.
 */

import { type ChildProcess, execFile as execFileCb, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { ActionLogEntry } from "../lib/actionLog.js";
import { CursorChoreographer } from "../lib/cursorChoreographer.js";
import { resolveEngineBinaryPath as resolveRealEngineBinaryPath } from "../lib/engineBinary.js";
import {
	launchApp as launchRealApp,
	NativeDriver,
	type NativeDriverLike,
	type NativeFrame,
} from "../lib/nativeDriver.js";
import { resolveNativeDriverPath as resolveRealNativeDriverPath } from "../lib/nativeHelpers.js";
import type { CaptureRegion } from "../lib/nativeSteps.js";
import { checkScreenCaptureCapability } from "../lib/screenCapturePreflight.js";
import {
	type AxLocator,
	type DriveStepList,
	isNativeStep,
	readDriveStepList,
	resolveShots,
	type ShotName,
	type StepList,
	stepListWarnings,
} from "../lib/stepList.js";
import { emitZoomRegions, logMsToFilmMs } from "../lib/zoomEmission.js";
import {
	type ActivateProcess,
	acquirePage,
	activateProcessMac,
	type ChoreographerLike,
	type ChromeWindowInfo,
	continuousNarrationLists,
	continuousZoomFragment,
	DEFAULT_BROWSER_CHANNEL,
	DRIVEN_WINDOW,
	defaultProfileDir,
	discoverDrivenWindowId,
	type ListChromeWindows,
	listChromeWindowsMac,
	type NarrationMode,
	type NarrationTimings,
	narrationLineId,
	narrationModeFrom,
	type RunDriveResult,
	readNarrationTimings,
	runDrive,
	sizeDrivenViewport,
	validateContinuousSteps,
	withLaunchedChrome,
} from "./drive.js";

export type DemoStage =
	| "engine"
	| "steps"
	| "preflight"
	| "narrate"
	| "record"
	| "drive"
	| "compose"
	| "process"
	| "voiceover";

export class DemoError extends Error {
	constructor(
		public readonly stage: DemoStage,
		message: string,
	) {
		super(message);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface DemoRunOptions {
	stepsPath: string;
	outDir: string;
	/** Defaults to {@link defaultProfileDir} — CR-LENSMITH-A002-9. */
	profileDir?: string;
	/** Defaults to {@link DEFAULT_BROWSER_CHANNEL} — CR-LENSMITH-A002-9. */
	browserChannel?: string;
	/** CR-LENSMITH-A008-5: passed through to the engine's `narrate --voice`; omitted = engine default. */
	voice?: string;
	/** CR-LENSMITH-A008-5: passed through to the engine's `narrate --engine`; omitted = engine default (kokoro). */
	narrateEngine?: string;
	/** CR-LENSMITH-A008-6: passed through to the engine's `voiceover --captions`; omitted = the engine default (burn). */
	captions?: "burn" | "srt" | "none";
	/**
	 * CR-LENSMITH-A011-6: `continuous` = the voice never stops (Settle LOCK v1.1); omitted = the
	 * step list's `"narration"` field, else `settle` (unchanged).
	 */
	narrationMode?: NarrationMode;
}

interface DemoPaths {
	rawVideo: string;
	cursorTelemetry: string;
	sessionInfo: string;
	actionLog: string;
	zoomFragment: string;
	projectFile: string;
	renderedVideo: string;
	voiceStarts: string;
	voicedVideo: string;
	manifest: string;
	narrationScript: string;
	narrationDir: string;
	narrationTimings: string;
}

/**
 * Fixed filenames inside `--out-dir` — `rawVideo`'s basename drives the
 * other two (`cursorTelemetry`, `sessionInfo`), matching the exact naming
 * convention `lensmith record` itself applies (`recordPaths.ts` in the
 * sibling engine repo: `<out>.cursor.json` appended, `<out>` extension
 * SWAPPED for `.session.json`). Duplicated here as two literal strings
 * rather than imported — the two repos share no source (see this repo's
 * `CLAUDE.md`) — and kept this simple because `demo` always names the raw
 * recording `raw.mp4` itself, so there is no general extension to swap.
 */
function buildOutputPaths(outDir: string): DemoPaths {
	return {
		rawVideo: path.join(outDir, "raw.mp4"),
		cursorTelemetry: path.join(outDir, "raw.mp4.cursor.json"),
		sessionInfo: path.join(outDir, "raw.session.json"),
		actionLog: path.join(outDir, "action-log.json"),
		zoomFragment: path.join(outDir, "zooms.json"),
		projectFile: path.join(outDir, "project.openscreen"),
		renderedVideo: path.join(outDir, "final.mp4"),
		voiceStarts: path.join(outDir, "voice-starts.json"),
		voicedVideo: path.join(outDir, "final-voiced.mp4"),
		manifest: path.join(outDir, "demo-manifest.json"),
		narrationScript: path.join(outDir, "narration-script.json"),
		narrationDir: path.join(outDir, "narration"),
		narrationTimings: path.join(outDir, "narration", "timings.json"),
	};
}

const RECORD_READY_MARKER = "Recording ready.";
const RECORD_READY_TIMEOUT_MS = 15_000;
const RECORD_STOP_TIMEOUT_MS = 30_000;
const STDERR_KEEP_CHARS = 4_096;
/** The engine's refusal of a `--source` it cannot parse (`recordingRequest.ts`). */
const ENGINE_INVALID_SOURCE = "Invalid --source";
export const OLD_ENGINE_REGION_MESSAGE =
	"this lensmith engine predates region capture; update lensmith";

export interface SpawnedRecorder {
	child: ChildProcess;
	/** Resolves once the recorder's own ready line has been seen on its stdout. */
	ready: Promise<void>;
	/** CR-LENSMITH-A010-8: the recorder's stderr so far (bounded), to recognise an old engine's refusal. */
	stderrText: () => string;
}

/**
 * Starts the engine's `record` command as a child process and resolves
 * `ready` the moment its stdout carries the literal ready line
 * `recordSession.ts` logs (`"[lensmith] Recording ready."`) — Technical Spec
 * item 2: "wait for its own ready line before the driver launches." Every
 * line of the child's stdout/stderr is forwarded to this process's own
 * stdout/stderr as it arrives (not buffered), the same "surface the child's
 * own output live" mechanism `runEngineCommand` below uses for compose/process.
 */
export function spawnRecorder(
	spawnFn: typeof spawn,
	nodeBinPath: string,
	engineBinPath: string,
	outPath: string,
	readyTimeoutMs: number,
	/**
	 * BF-15: `window:<id>` records only the driven Chrome window; omitted records the whole screen.
	 * CR-LENSMITH-A010-8: `region:x,y,w,h` records a screen rectangle (engines that support it).
	 */
	source?: string,
): SpawnedRecorder {
	const recordArgs = [engineBinPath, "record", "--out", outPath];
	if (source !== undefined) recordArgs.push("--source", source);
	const child = spawnFn(nodeBinPath, recordArgs, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stderr = "";
	const ready = new Promise<void>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error("timed out waiting for the recorder to report ready"));
		}, readyTimeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(chunk);
			if (!settled && chunk.toString("utf-8").includes(RECORD_READY_MARKER)) {
				settled = true;
				clearTimeout(timer);
				resolve();
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			stderr = (stderr + chunk.toString("utf-8")).slice(-STDERR_KEEP_CHARS);
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`recorder exited before becoming ready (code=${code}, signal=${signal})`));
		});
	});

	return { child, ready, stderrText: () => stderr };
}

/**
 * CR-LENSMITH-A010-8: true when the recorder's stderr carries the engine's "Invalid --source"
 * refusal — an engine older than region capture. stderr can trail the exit event, so this waits
 * briefly (bounded) for the stream to close before reading it.
 */
async function recorderRefusedSource(recorder: SpawnedRecorder): Promise<boolean> {
	if (!recorder.stderrText().includes(ENGINE_INVALID_SOURCE)) {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 250);
			recorder.child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
	return recorder.stderrText().includes(ENGINE_INVALID_SOURCE);
}

/**
 * Stops a still-running recorder with SIGINT (the same signal
 * `recordSession.ts` listens for to trigger its own clean shutdown —
 * writing the telemetry/session files — before it exits) and waits for it
 * to actually exit, escalating to SIGKILL only if it never does. Resolves
 * with the exit code rather than rejecting — this always runs from a
 * `finally` block and must never mask whatever error is already in flight.
 *
 * Round 2 (CR-LENSMITH-A002-7): this is now reachable from `runDemo` even
 * when the recorder never became ready — including the case where it never
 * started as a real process at all (its `error` event fired instead of
 * `ready`). `SIGKILL` cannot be caught, but the OS still owns exactly when a
 * genuinely-running process is reaped and Node observes it; and a child that
 * was never a real process may never emit `exit` no matter what is sent to
 * it. Without the `giveUp` fallback below, either case would hang this
 * promise — and therefore `runDemo`'s `finally` — forever, which would
 * silently defeat the very guarantee this function exists to provide.
 */
export function stopRecorder(child: ChildProcess, timeoutMs: number): Promise<number | null> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve(child.exitCode);
			return;
		}
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(escalate);
			clearTimeout(giveUp);
			resolve(child.exitCode);
		};
		const escalate = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, timeoutMs);
		const giveUp = setTimeout(settle, timeoutMs + 1_000);
		child.once("exit", settle);
		child.kill("SIGINT");
	});
}

/** Runs an engine subcommand to completion, its stdout/stderr inherited live — Technical Spec item 4. */
export function runEngineCommand(
	spawnFn: typeof spawn,
	nodeBinPath: string,
	engineBinPath: string,
	args: string[],
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawnFn(nodeBinPath, [engineBinPath, ...args], { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

/**
 * Launches a real Chrome (persistent profile) + choreographer and runs the
 * driver against them — the exact same acquire-then-own lifecycle
 * `registerDriveCommand`'s own CLI action uses in `drive.ts`
 * (`withLaunchedChrome` / `acquirePage`, CR-LENSMITH-A002-9 round 2: shared by
 * both call sites precisely so this ordering cannot drift between them again).
 * `runDrive` itself (the orchestration this delegates to) is exhaustively
 * unit-tested in `tests/drive.test.ts` against a fake page and choreographer;
 * `demo`'s own tests inject a whole replacement for this function
 * (`RunDemoDeps.performDrive`) rather than re-building those fakes here —
 * what `demo` adds is the stage SEQUENCING around this step, not the driving
 * logic itself.
 */
async function defaultPerformDrive(
	stepList: StepList,
	options: { profileDir: string; browserChannel: string },
	hooks: DriveHooks,
	narration: NarrationTimings | undefined,
	nativeDeps?: NativeDemoDeps,
): Promise<RunDriveResult> {
	const list = stepList as DriveStepList;
	// CR-LENSMITH-A010-8: a web list with native steps also pre-rolls its apps and records the
	// capture `chooseCapture` picks; a web-only list takes exactly the path it always did.
	const withNative = nativeDeps !== undefined && hasNativeSteps(list);
	const driver = withNative ? (nativeDeps.createDriver ?? (() => new NativeDriver()))() : undefined;
	try {
		return await withLaunchedChrome(
			{ ...options, discoverWindow: !withNative, activate: true },
			async (ctx, choreographer, windowId) => {
				const page = await acquirePage(ctx);
				let native: Parameters<typeof runDrive>[1]["native"];
				let viewportRect: CaptureRegion | undefined;
				if (withNative && driver) {
					await driver.start?.();
					const activate = nativeDeps.activate ?? activateProcessMac;
					const roll = await preRollApps(list, driver, {
						launchApp: nativeDeps.launchApp ?? ((b) => launchRealApp(b)),
						activate,
					});
					const display = await (nativeDeps.mainDisplayBounds ?? mainDisplayBoundsMac)();
					const choice = chooseCapture(list, { window: null, display });
					if (choice.warning !== undefined) console.error(`demo: warning: ${choice.warning}`);
					native = { driver, pids: roll.pids, capture: choice.capture, activate };
					await hooks.onWindowReady({ source: choice.source });
				} else {
					const declared = list.capture ?? "auto";
					const display =
						declared === "window"
							? undefined
							: await (nativeDeps?.mainDisplayBounds ?? mainDisplayBoundsMac)();
					if (declared === "auto" && display !== undefined) {
						// CR-LENSMITH-A011-7: size the page viewport to 1920x1096 points and record its top 1920x1080.
						viewportRect =
							(await sizeDrivenViewport({
								context: ctx,
								page,
								display,
								sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
								log: (line) => console.error(line),
							})) ?? undefined;
					}
					// BF-15: the window exists now, so the recorder can start — before any step runs.
					await hooks.onWindowReady(webCaptureTarget(list, windowId, display, viewportRect));
				}
				try {
					await choreographer.start();
					const result = await runDrive(stepList, {
						page,
						choreographer,
						...(native !== undefined ? { native } : {}),
						...(narration !== undefined ? { narration } : {}),
					});
					// Boxes are in capture space when native: the zoom frame is the capture.
					return native?.capture === undefined
						? viewportRect === undefined
							? result
							: withViewportCapture(result, viewportRect)
						: {
								...result,
								viewport: { width: native.capture.width, height: native.capture.height },
							};
				} finally {
					choreographer.stop();
					// BF-16: stop the recorder while the window still exists — a window-source stream
					// dies when Chrome closes, and `withLaunchedChrome` closes it as soon as this returns.
					await hooks.onDriveFinished?.();
				}
			},
		);
	} finally {
		driver?.stop();
	}
}

/* -------------------------------------------------------------------------------------------- */
/* CR-LENSMITH-A010-8: native lists — readiness, pre-roll, capture choice, native drive.        */
/* Design note §2 (pre-roll), §6 (capture), §7 (preflight rows). Web-only lists never reach it. */
/* -------------------------------------------------------------------------------------------- */

/** One readiness row, in the engine `doctor` report shape. */
export interface NativeReadinessCheck {
	id:
		| "native_helper_built"
		| "accessibility_permission"
		| "screen_recording_capability"
		| "secure_input_off";
	required: boolean;
	ok: boolean;
	code: string;
	detail: string;
	fix: string | null;
}

export interface NativeReadiness {
	ok: boolean;
	checks: NativeReadinessCheck[];
}

export interface NativeReadinessDeps {
	resolveNativeDriverPath?: () => string;
	/** The helper's `trust` answer. Called only when the helper is built. */
	trust?: () => Promise<{ accessibility: boolean; secureInput: boolean }>;
	checkScreenCapture?: () => string;
}

/**
 * The four readiness rows a native list needs (design note §7): the helper, Accessibility,
 * Screen Recording (required) and Secure Input (warn only). Never throws: each row reports.
 */
export async function checkNativeReadiness(
	deps: NativeReadinessDeps = {},
): Promise<NativeReadiness> {
	const resolveHelper = deps.resolveNativeDriverPath ?? (() => resolveRealNativeDriverPath());
	const checkCapture = deps.checkScreenCapture ?? (() => checkScreenCaptureCapability());
	const checks: NativeReadinessCheck[] = [];

	let helperPath: string | undefined;
	try {
		helperPath = resolveHelper();
		checks.push({
			id: "native_helper_built",
			required: true,
			ok: true,
			code: "ok",
			detail: helperPath,
			fix: null,
		});
	} catch (error) {
		checks.push({
			id: "native_helper_built",
			required: true,
			ok: false,
			code: "helper_missing",
			detail: messageOf(error),
			fix: "Build the native helpers: npm run build:native",
		});
	}

	let trust: { accessibility: boolean; secureInput: boolean } | undefined;
	let trustError: string | undefined;
	if (helperPath !== undefined) {
		try {
			const ask =
				deps.trust ??
				(async () => {
					const driver = new NativeDriver({ helperPath });
					try {
						await driver.start();
						return await driver.trust();
					} finally {
						driver.stop();
					}
				});
			trust = await ask();
		} catch (error) {
			trustError = messageOf(error);
		}
	} else {
		trustError = "the native helper is not built, so trust could not be asked";
	}

	const accessibilityFix =
		"System Settings > Privacy & Security > Accessibility: allow the app that runs this " +
		"command (Terminal), then run it again";
	checks.push(
		trust === undefined
			? {
					id: "accessibility_permission",
					required: true,
					ok: false,
					code: "unknown",
					detail: trustError ?? "trust unavailable",
					fix: accessibilityFix,
				}
			: {
					id: "accessibility_permission",
					required: true,
					ok: trust.accessibility,
					code: trust.accessibility ? "ok" : "not_granted",
					detail: trust.accessibility
						? "Accessibility is granted"
						: "Accessibility is not granted to the responsible app",
					fix: trust.accessibility ? null : accessibilityFix,
				},
	);

	try {
		const detail = checkCapture();
		checks.push({
			id: "screen_recording_capability",
			required: true,
			ok: true,
			code: "ok",
			detail: detail || "screen capture is available",
			fix: null,
		});
	} catch (error) {
		checks.push({
			id: "screen_recording_capability",
			required: true,
			ok: false,
			code: "not_available",
			detail: messageOf(error),
			fix:
				"System Settings > Privacy & Security > Screen Recording: allow the app that runs " +
				"this command (Terminal), then run it again",
		});
	}

	const secureInputOn = trust?.secureInput === true;
	checks.push({
		id: "secure_input_off",
		required: false,
		ok: trust !== undefined && !secureInputOn,
		code: trust === undefined ? "unknown" : secureInputOn ? "secure_input_on" : "ok",
		detail:
			trust === undefined
				? "could not be checked"
				: secureInputOn
					? "Secure Input is on: typed keys may not reach the target app"
					: "Secure Input is off",
		fix: secureInputOn ? "Close the password field or app that holds Secure Input" : null,
	});

	return { ok: checks.every((c) => c.ok || !c.required), checks };
}

/** What `chooseCapture` decided: the engine `--source` (undefined = whole screen) and the capture rect. */
export interface CaptureChoice {
	mode: "window" | "region" | "screen" | "viewport";
	source?: string;
	capture: CaptureRegion;
	/** Set when a declared or preferred choice had to fall back (printed to stderr). */
	warning?: string;
}

export interface ChooseCaptureContext {
	/** The first app's window after pre-roll (id and frame), or null when none was found. */
	window: ChromeWindowInfo | null;
	/** The main display's bounds in screen points. */
	display: CaptureRegion;
	/** CR-LENSMITH-A011-7: the driven page viewport's screen rect, for a web list (no native steps). */
	viewportRect?: CaptureRegion;
}

function locatorsInStep(step: DriveStepList["steps"][number]): AxLocator[] {
	const s = step as { ax?: AxLocator; expect?: AxLocator; zoom?: AxLocator; until?: AxLocator };
	return [s.ax, s.expect, s.zoom, s.until].filter((l): l is AxLocator => l !== undefined);
}

/**
 * Picks the capture for a native list (design note §6). Pure. A declared region wins; `window`
 * (or `auto` with one app, no `activate` step, no menu bar or status bar locator, and a window
 * found) records that window; everything else records the main display. A web list (a `url`, no
 * native steps) under `auto` with a sized viewport records that viewport (CR-LENSMITH-A011-7). A
 * list with a `url` and native steps never records a window: the browser and the native app share the frame, so a window choice
 * falls back to the screen.
 */
export function chooseCapture(list: DriveStepList, ctx: ChooseCaptureContext): CaptureChoice {
	const declared = list.capture ?? "auto";
	const screen = (warning?: string): CaptureChoice => ({
		mode: "screen",
		capture: { ...ctx.display },
		...(warning !== undefined ? { warning } : {}),
	});

	if (typeof declared === "object") {
		const r = declared.region;
		return {
			mode: "region",
			source: `region:${r.x},${r.y},${r.width},${r.height}`,
			capture: { x: r.x, y: r.y, width: r.width, height: r.height },
		};
	}
	if (declared === "screen") return screen();

	// CR-LENSMITH-A011-7: a web list under `auto` records the page viewport only.
	if (
		declared === "auto" &&
		ctx.viewportRect !== undefined &&
		list.url !== undefined &&
		!hasNativeSteps(list)
	) {
		const r = ctx.viewportRect;
		return {
			mode: "viewport",
			source: `region:${r.x},${r.y},${r.width},${r.height}`,
			capture: { ...r },
		};
	}

	const webAndNative = list.url !== undefined;
	if (declared === "window") {
		if (webAndNative) {
			return screen(
				'capture "window" is not possible with a "url" (the browser and the app share the frame) — recording the screen',
			);
		}
		if (ctx.window === null) {
			return screen('capture "window": no window was found for the app — recording the screen');
		}
		return windowChoice(ctx.window);
	}

	// auto
	const oneApp = (list.apps?.length ?? 0) === 1;
	const hasActivate = list.steps.some((s) => s.type === "activate" && isNativeStep(s));
	const hasBarLocator = list.steps.some((s) =>
		locatorsInStep(s).some((l) => l.in === "menubar" || l.in === "statusbar"),
	);
	if (!webAndNative && oneApp && !hasActivate && !hasBarLocator && ctx.window !== null) {
		return windowChoice(ctx.window);
	}
	return screen();
}

/**
 * CR-LENSMITH-A011-7: a viewport run's drive result. Pure. The recorded region is the top of the
 * page viewport (same origin), so page points are capture points and `viewport` becomes the capture
 * size (1920x1080, not the 1920x1096 page area) — the zoom and cursor normalisation stay unchanged.
 */
export function withViewportCapture<T extends { viewport: { width: number; height: number } }>(
	result: T,
	viewportRect: CaptureRegion,
): T & { viewportRect: CaptureRegion } {
	return {
		...result,
		viewport: { width: viewportRect.width, height: viewportRect.height },
		viewportRect,
	};
}

/**
 * CR-LENSMITH-A011-7: what a web list (a `url`, no native steps) records — the `onWindowReady`
 * target. Pure. A declared `"window"` (or no sized viewport) records the driven window by id, as
 * before; `auto` with a sized viewport records `region:<viewport>`; a declared `"screen"` or
 * `{region}` wins as {@link chooseCapture} decides.
 */
export function webCaptureTarget(
	list: DriveStepList,
	windowId: number | null,
	display: CaptureRegion | undefined,
	viewportRect: CaptureRegion | undefined,
): number | null | { source: string | undefined } {
	const declared = list.capture ?? "auto";
	if (declared === "window" || display === undefined) return windowId;
	if (declared === "auto" && viewportRect === undefined) return windowId;
	return {
		source: chooseCapture(list, {
			window: null,
			display,
			...(viewportRect !== undefined ? { viewportRect } : {}),
		}).source,
	};
}

function windowChoice(w: ChromeWindowInfo): CaptureChoice {
	return {
		mode: "window",
		source: `window:${w.id}`,
		capture: { x: w.x, y: w.y, width: w.width, height: w.height },
	};
}

const MAIN_DISPLAY_JXA = `ObjC.import('AppKit');
const f = $.NSScreen.mainScreen.frame;
JSON.stringify({ x: 0, y: 0, width: f.size.width, height: f.size.height })`;

/** The main display's bounds in points (macOS, through the JXA AppKit bridge). */
export function mainDisplayBoundsMac(): Promise<CaptureRegion> {
	return new Promise((resolve, reject) => {
		execFileCb(
			"osascript",
			["-l", "JavaScript", "-e", MAIN_DISPLAY_JXA],
			{ timeout: 10_000 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				try {
					resolve(JSON.parse(String(stdout).trim()) as CaptureRegion);
				} catch (parseError) {
					reject(parseError);
				}
			},
		);
	});
}

/** Everything the native path touches outside this process — all injectable, so tests use fakes. */
export interface NativeDemoDeps extends NativeReadinessDeps {
	createDriver?: () => NativeDriverLike & { start?: () => Promise<void> };
	launchApp?: (bundleId: string) => Promise<number>;
	activate?: ActivateProcess;
	listWindows?: ListChromeWindows;
	mainDisplayBounds?: () => Promise<CaptureRegion>;
	createChoreographer?: () => ChoreographerLike;
	sleep?: (ms: number) => Promise<void>;
	/** Injectable for tests only — production runs the real `runDrive`. */
	drive?: typeof runDrive;
	log?: (line: string) => void;
}

/** True when the list has at least one native step (a step that names an `app`). */
export function hasNativeSteps(list: DriveStepList): boolean {
	return list.steps.some(isNativeStep);
}

export interface PreRollResult {
	pids: Map<string, number>;
	firstPid: number | undefined;
	firstFrame: NativeFrame | null;
}

/**
 * Pre-roll (design note §2), before the recorder starts: launch each app, `prepare` it (the
 * first app's frame defaults to `DRIVEN_WINDOW`), then bring the first app to the front.
 */
export async function preRollApps(
	list: DriveStepList,
	driver: NativeDriverLike,
	deps: { launchApp: (bundleId: string) => Promise<number>; activate: ActivateProcess },
): Promise<PreRollResult> {
	const pids = new Map<string, number>();
	let firstPid: number | undefined;
	let firstFrame: NativeFrame | null = null;
	for (const [i, app] of (list.apps ?? []).entries()) {
		const pid = await deps.launchApp(app.bundleId);
		pids.set(app.bundleId, pid);
		if (i === 0) {
			firstPid = pid;
			firstFrame = await driver.prepare(pid, app.frame ?? { ...DRIVEN_WINDOW });
		} else {
			await driver.prepare(pid, app.frame);
		}
	}
	if (firstPid !== undefined) await deps.activate(firstPid);
	return { pids, firstPid, firstFrame };
}

async function findWindowByPid(
	pid: number,
	list: ListChromeWindows,
	sleep: (ms: number) => Promise<void>,
	log: (line: string) => void,
): Promise<ChromeWindowInfo | null> {
	const id = await discoverDrivenWindowId({ pid, list, sleep, log });
	if (id === null) return null;
	try {
		return (await list()).find((w) => w.id === id) ?? null;
	} catch {
		return null;
	}
}

/**
 * The drive stage for a list without a `url`: pre-roll, choose the capture, start the recorder
 * on it (`hooks.onWindowReady`), then run the native steps with a `NativeDriver` and the
 * choreographer, and stop both (and the recorder) in `finally`.
 */
export async function defaultPerformNativeDrive(
	stepList: DriveStepList,
	hooks: DriveHooks,
	narration: NarrationTimings | undefined,
	deps: NativeDemoDeps = {},
): Promise<RunDriveResult> {
	const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const activate = deps.activate ?? activateProcessMac;
	const drive = deps.drive ?? runDrive;
	const choreographer = (deps.createChoreographer ?? (() => new CursorChoreographer()))();
	const driver = (deps.createDriver ?? (() => new NativeDriver()))();
	try {
		await driver.start?.();
		const roll = await preRollApps(stepList, driver, {
			launchApp: deps.launchApp ?? ((b) => launchRealApp(b)),
			activate,
		});
		const window =
			roll.firstPid === undefined
				? null
				: await findWindowByPid(
						roll.firstPid,
						deps.listWindows ?? listChromeWindowsMac,
						sleep,
						log,
					);
		const display = await (deps.mainDisplayBounds ?? mainDisplayBoundsMac)();
		const choice = chooseCapture(stepList, { window, display });
		if (choice.warning !== undefined) log(`demo: warning: ${choice.warning}`);
		await hooks.onWindowReady({ source: choice.source });
		try {
			await choreographer.start();
			const native = { driver, pids: roll.pids, capture: choice.capture, activate };
			return await drive(
				stepList,
				narration === undefined ? { choreographer, native } : { choreographer, native, narration },
			);
		} finally {
			choreographer.stop();
			await hooks.onDriveFinished?.();
		}
	} finally {
		driver.stop();
	}
}

/** `ffprobe`'s real output on failure/absence is never guessed at — `null` means genuinely unknown. */
function defaultProbeDurationMs(filePath: string): number | null {
	const result = spawnSync(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
		{ encoding: "utf-8" },
	);
	if (result.error || result.status !== 0) return null;
	const seconds = Number.parseFloat((result.stdout ?? "").trim());
	return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

/**
 * Registers a callback for the process-termination signals (SIGINT,
 * SIGTERM) that would otherwise kill this process immediately with no
 * cleanup — the same mechanism [[BF-6]] already documented for the
 * recorder's own process, here aimed at the *director* process instead.
 * Returns an unregister function. Mirrors `drive.ts`'s own `onInterrupt`
 * dependency (`(cb) => process.once("SIGINT", cb)`) so tests can trigger the
 * same code path deterministically without sending a real OS signal.
 */
function defaultOnTerminationSignal(callback: (signal: NodeJS.Signals) => void): () => void {
	const handler = (signal: NodeJS.Signals) => callback(signal);
	process.once("SIGINT", handler);
	process.once("SIGTERM", handler);
	return () => {
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
	};
}

/** Callbacks `performDrive` makes while it runs (BF-15: the recorder can only start once the window exists). */
export interface DriveHooks {
	/**
	 * Called once, after the driven Chrome window is open and BEFORE the first step. `windowId` is
	 * the window's CGWindowID, or null when it could not be found (the recorder then falls back to
	 * the whole screen). CR-LENSMITH-A010-8: `{ source }` passes the engine `--source` chosen by
	 * {@link chooseCapture} (undefined = the whole screen, with no warning).
	 */
	onWindowReady(target: number | null | { source: string | undefined }): Promise<void>;
	/**
	 * BF-16: called once the steps are done (or failed) and BEFORE Chrome is closed, so a
	 * window-source recording is stopped while its window still exists.
	 */
	onDriveFinished?(): Promise<void>;
}

export interface RunDemoDeps {
	spawnFn?: typeof spawn;
	nodeBinPath?: string;
	resolveEngineBinaryPath?: () => string;
	/**
	 * `narration` (CR-LENSMITH-A008-5) is the validated engine `timings.json` when the steps carry
	 * `say` lines — the same value `drive --narration` reads — and undefined otherwise.
	 */
	performDrive?: (
		stepList: StepList,
		hooks: DriveHooks,
		narration?: NarrationTimings,
	) => Promise<RunDriveResult>;
	/**
	 * CR-LENSMITH-A010-8: replaces the drive stage for a list without a `url` (native-only).
	 * Defaults to {@link defaultPerformNativeDrive} with `native`.
	 */
	performNativeDrive?: (
		stepList: DriveStepList,
		hooks: DriveHooks,
		narration?: NarrationTimings,
	) => Promise<RunDriveResult>;
	/** CR-LENSMITH-A010-8: the native readiness, pre-roll and driver effects (fakes in tests). */
	native?: NativeDemoDeps;
	probeDurationMs?: (filePath: string) => number | null;
	readyTimeoutMs?: number;
	stopTimeoutMs?: number;
	onTerminationSignal?: (callback: (signal: NodeJS.Signals) => void) => () => void;
}

interface ManifestArtifact {
	name: string;
	path: string;
	sizeBytes: number;
	durationMs: number | null;
}

interface Manifest {
	generatedAt: string;
	stepsPath: string;
	/** CR-LENSMITH-A011-9: the shot each step was filmed in (explicit, or by the default rule). */
	steps: { index: number; type: string; shot: ShotName }[];
	artifacts: ManifestArtifact[];
}

export interface DemoResult {
	manifestPath: string;
	artifacts: ManifestArtifact[];
}

/**
 * Runs the full pipeline. Throws {@link DemoError} naming the failing stage
 * on the first failure; on success writes the manifest and returns its path
 * plus every artifact entry. See this file's header for the stage order and
 * the always-stop-the-recorder guarantee.
 */
export async function runDemo(opts: DemoRunOptions, deps: RunDemoDeps = {}): Promise<DemoResult> {
	const spawnFn = deps.spawnFn ?? spawn;
	const nodeBinPath = deps.nodeBinPath ?? process.execPath;
	const resolveEngineBinaryPath = deps.resolveEngineBinaryPath ?? resolveRealEngineBinaryPath;
	const profileDir = opts.profileDir ?? defaultProfileDir();
	const browserChannel = opts.browserChannel ?? DEFAULT_BROWSER_CHANNEL;
	const nativeDeps = deps.native ?? {};
	const performWebDrive =
		deps.performDrive ??
		((stepList: StepList, hooks: DriveHooks, narration?: NarrationTimings) =>
			defaultPerformDrive(stepList, { profileDir, browserChannel }, hooks, narration, nativeDeps));
	const performNativeDrive =
		deps.performNativeDrive ??
		((stepList: DriveStepList, hooks: DriveHooks, narration?: NarrationTimings) =>
			defaultPerformNativeDrive(stepList, hooks, narration, nativeDeps));
	const probeDurationMs = deps.probeDurationMs ?? defaultProbeDurationMs;
	const readyTimeoutMs = deps.readyTimeoutMs ?? RECORD_READY_TIMEOUT_MS;
	const stopTimeoutMs = deps.stopTimeoutMs ?? RECORD_STOP_TIMEOUT_MS;
	const onTerminationSignal = deps.onTerminationSignal ?? defaultOnTerminationSignal;

	// Invariant: "engine binary not resolvable -> immediate clear error, not a
	// silent empty run." Checked first, before anything else — nothing has
	// started yet, so there is nothing to unwind.
	let engineBinPath: string;
	try {
		engineBinPath = resolveEngineBinaryPath();
	} catch (error) {
		throw new DemoError("engine", messageOf(error));
	}

	let driveList: DriveStepList;
	try {
		const raw = readFileSync(opts.stepsPath, "utf-8");
		driveList = readDriveStepList(raw, opts.stepsPath);
		// CR-LENSMITH-A011-6: continuous narration refuses a silent step before anything launches.
		if (narrationModeFrom(raw, opts.narrationMode) === "continuous") {
			validateContinuousSteps(driveList);
			continuousNarrationLists.add(driveList);
		}
	} catch (error) {
		throw new DemoError("steps", messageOf(error));
	}
	for (const warning of stepListWarnings(driveList)) console.error(`demo: warning: ${warning}`);
	const stepList = driveList as StepList;
	const nativeList = driveList.url === undefined;
	const performDrive = nativeList
		? (list: StepList, hooks: DriveHooks, narration?: NarrationTimings) =>
				performNativeDrive(list as DriveStepList, hooks, narration)
		: performWebDrive;

	// CR-LENSMITH-A010-8: a list with any native step is checked for readiness before anything
	// launches or records; a failing required row stops the run here with its fix.
	if (hasNativeSteps(driveList)) {
		const readiness = await checkNativeReadiness(nativeDeps);
		for (const check of readiness.checks) {
			if (!check.ok && !check.required) {
				console.error(`demo: warning: ${check.id}: ${check.detail}`);
			}
		}
		if (!readiness.ok) {
			const failing = readiness.checks.filter((c) => c.required && !c.ok);
			throw new DemoError(
				"preflight",
				failing.map((c) => `${c.id}: ${c.detail}${c.fix ? ` — fix: ${c.fix}` : ""}`).join("; "),
			);
		}
	}

	mkdirSync(opts.outDir, { recursive: true });
	const paths = buildOutputPaths(opts.outDir);

	// CR-LENSMITH-A008-5: the narrate stage, before anything is recorded — the drive needs the
	// voice timings up front to place each click on its line's [[mark]]. Steps without any `say`
	// line skip it entirely and run exactly as before.
	const narration = await runNarrateStage(stepList, opts, paths, {
		spawnFn,
		nodeBinPath,
		engineBinPath,
	});

	// CR-LENSMITH-A002-9 round 2 audit: registered BEFORE the recorder is
	// spawned, not after — `onTerminationSignal` is an injectable dependency
	// (a call to arbitrary code), and a throw from it must never find an
	// already-spawned recorder with no owner yet. Registering a signal
	// handler before anything exists for it to protect is free; the reverse
	// order is the one that can leak.
	//
	// A signal delivered to this process (SIGINT/SIGTERM) would otherwise
	// terminate it immediately with no chance for the `finally` below to run
	// — see [[BF-6]]. Racing it against whichever stage is in flight turns it
	// into an ordinary rejection this function already knows how to unwind
	// through. `.catch(() => {})` only suppresses an "unhandled rejection"
	// warning if the signal fires after both races below have settled (e.g.
	// during compose/process, once the recorder is already stopped and
	// `unregisterSignal` has run) — it does not affect which value either
	// race observes.
	let currentStage: DemoStage = "record";
	let rejectOnSignal: (error: DemoError) => void = () => {
		// Replaced synchronously below, before any await; only ever called if
		// a signal somehow arrived before that — a no-op is the right default.
	};
	const signal = new Promise<never>((_resolve, reject) => {
		rejectOnSignal = reject;
	});
	signal.catch(() => {
		// Suppresses "unhandled rejection" only for a signal that arrives
		// after both races below have settled — see the comment above.
	});
	const unregisterSignal = onTerminationSignal((receivedSignal) => {
		rejectOnSignal(
			new DemoError(
				currentStage,
				`interrupted by ${receivedSignal} before the ${currentStage} stage finished — stopping the recorder`,
			),
		);
	});

	// Ownership of the recorder's lifetime begins at the spawn call itself — not after
	// `recorder.ready` resolves. BF-15: the spawn now happens inside `onWindowReady`, which
	// `performDrive` calls once the driven Chrome window exists (a window-source recording needs
	// the window first). The `try`/`finally` below wraps `performDrive`, so every path out —
	// including a failure before the hook ran — still reaches the stop.
	let recorder: SpawnedRecorder | undefined;
	let recorderStopped = false;
	let recorderExitCode: number | null = null;
	const ensureRecorderStopped = async (): Promise<number | null> => {
		if (recorder && !recorderStopped) {
			recorderStopped = true;
			recorderExitCode = await stopRecorder(recorder.child, stopTimeoutMs);
		}
		return recorderExitCode;
	};

	const hooks: DriveHooks = {
		async onWindowReady(target) {
			currentStage = "record";
			let source: string | undefined;
			if (typeof target === "object" && target !== null) {
				source = target.source;
			} else if (target === null) {
				console.error(
					"demo: warning: could not find the driven Chrome window id — recording the whole " +
						"screen instead of the window",
				);
			} else {
				source = `window:${target}`;
			}
			try {
				recorder = spawnRecorder(
					spawnFn,
					nodeBinPath,
					engineBinPath,
					paths.rawVideo,
					readyTimeoutMs,
					source,
				);
			} catch (error) {
				throw new DemoError("record", messageOf(error));
			}
			try {
				await Promise.race([recorder.ready, signal]);
			} catch (error) {
				if (error instanceof DemoError) throw error;
				if (source?.startsWith("region:") && (await recorderRefusedSource(recorder))) {
					throw new DemoError("record", OLD_ENGINE_REGION_MESSAGE);
				}
				throw new DemoError("record", messageOf(error));
			}
			currentStage = "drive";
		},
		async onDriveFinished() {
			if (recorder) await ensureRecorderStopped();
		},
	};

	try {
		currentStage = "drive";
		let driveResult: RunDriveResult | undefined;
		let driveError: unknown;
		try {
			driveResult = await Promise.race([
				narration === undefined
					? performDrive(stepList, hooks)
					: performDrive(stepList, hooks, narration.timings),
				signal,
			]);
		} catch (error) {
			if (error instanceof DemoError) throw error;
			driveError = error;
		}

		// Always stop the recorder next, whether the driver succeeded or
		// threw — Invariant: "the recorder is always stopped, including when
		// the driver throws." Compose depends on the raw file being fully
		// flushed, so this explicit stop (not just the `finally` below) is
		// what makes that ordering true, in addition to being covered
		// structurally either way.
		const exitCode = await ensureRecorderStopped();
		// The recorder's fate is sealed from here on — a later signal (during
		// compose/process, or after this function returns) needs no special
		// handling, so stop listening for one now rather than leaving a
		// listener that outlives its purpose.
		unregisterSignal();

		if (driveError !== undefined) {
			throw new DemoError("drive", messageOf(driveError));
		}
		if (!recorder) {
			throw new DemoError("record", "the recorder was never started (no driven window reported)");
		}
		if (exitCode !== 0) {
			throw new DemoError("record", `recorder exited with code ${exitCode} while stopping`);
		}
		const drivenResult = driveResult as RunDriveResult;

		// CR-LENSMITH-A011-9: the shot grammar decides each step's camera.
		const shots = resolveShots(driveList);
		const emitted = emitZoomRegions(drivenResult.actionLog, drivenResult.viewport, shots);
		const { warnings } = emitted;
		// CR-LENSMITH-A011-6: continuous regions end where the next travel starts, zoom-out under voice.
		const fragment = drivenResult.plan
			? continuousZoomFragment(
					emitted.fragment,
					drivenResult.actionLog,
					drivenResult.plan.endMs,
					emitted.closedAtMs,
				)
			: emitted.fragment;
		for (const warning of warnings) console.error(`demo: warning: ${warning}`);
		const loggedActions = drivenResult.actionLog.map((entry) => ({
			...entry,
			shot: shots[entry.index],
		}));
		writeFileSync(paths.actionLog, `${JSON.stringify(loggedActions, null, 2)}\n`, "utf-8");
		writeFileSync(paths.zoomFragment, `${JSON.stringify(fragment, null, 2)}\n`, "utf-8");

		try {
			const code = await runEngineCommand(spawnFn, nodeBinPath, engineBinPath, [
				"compose",
				"--zooms",
				paths.zoomFragment,
				"--raw",
				paths.rawVideo,
				"--out",
				paths.projectFile,
				// CR-LENSMITH-A011-7: a viewport recording fills the film; no wallpaper border.
				...(drivenResult.viewportRect !== undefined ? ["--padding", "0"] : []),
			]);
			if (code !== 0) throw new Error(`compose exited with code ${code}`);
		} catch (error) {
			throw new DemoError("compose", messageOf(error));
		}

		try {
			const code = await runEngineCommand(spawnFn, nodeBinPath, engineBinPath, [
				"process",
				"--project",
				paths.projectFile,
				"--raw",
				paths.rawVideo,
				"--cursor",
				paths.cursorTelemetry,
				"--out",
				paths.renderedVideo,
			]);
			if (code !== 0) throw new Error(`process exited with code ${code}`);
		} catch (error) {
			throw new DemoError("process", messageOf(error));
		}

		// CR-LENSMITH-A008-6: voice the finished film when narration ran.
		if (narration !== undefined) {
			await runVoiceoverStage(drivenResult.actionLog, opts, paths, {
				spawnFn,
				nodeBinPath,
				engineBinPath,
			});
		}
		const voiced = narration !== undefined;

		// Every file this run actually wrote, per the Invariant — the manifest
		// itself is deliberately not one of its own entries (it cannot record
		// its own final size while still being written).
		const artifactSpecs: Array<{ name: string; path: string; isMedia: boolean }> = [
			{ name: "raw-recording", path: paths.rawVideo, isMedia: true },
			{ name: "cursor-telemetry", path: paths.cursorTelemetry, isMedia: false },
			{ name: "recording-session", path: paths.sessionInfo, isMedia: false },
			{ name: "action-log", path: paths.actionLog, isMedia: false },
			{ name: "zoom-fragment", path: paths.zoomFragment, isMedia: false },
			{ name: "project-file", path: paths.projectFile, isMedia: false },
			...(voiced
				? [
						{ name: "rendered-video", path: paths.voicedVideo, isMedia: true },
						{ name: "rendered-video-silent", path: paths.renderedVideo, isMedia: true },
						{ name: "voice-starts", path: paths.voiceStarts, isMedia: false },
					]
				: [{ name: "rendered-video", path: paths.renderedVideo, isMedia: true }]),
			...(narration?.artifacts ?? []),
		];
		const artifacts: ManifestArtifact[] = artifactSpecs.map((spec) => ({
			name: spec.name,
			path: spec.path,
			sizeBytes: statSync(spec.path).size,
			durationMs: spec.isMedia ? probeDurationMs(spec.path) : null,
		}));

		const manifest: Manifest = {
			generatedAt: new Date().toISOString(),
			stepsPath: opts.stepsPath,
			steps: driveList.steps.map((step, index) => ({
				index,
				type: step.type,
				shot: shots[index] as ShotName,
			})),
			artifacts,
		};
		writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

		return { manifestPath: paths.manifest, artifacts };
	} finally {
		// The structural guarantee: whatever path got here — normal return, a
		// thrown DemoError from any stage above, an exception this function
		// didn't anticipate — the recorder is stopped before `runDemo` is
		// truly done. A no-op if `ensureRecorderStopped` already ran above.
		unregisterSignal();
		await ensureRecorderStopped();
	}
}

interface NarrateStageResult {
	timings: NarrationTimings;
	artifacts: Array<{ name: string; path: string; isMedia: boolean }>;
}

/**
 * CR-LENSMITH-A008-5: writes `<out>/narration-script.json` from the steps' `say` lines (line id
 * `s<step index>`, the id `drive` looks up), runs the engine's
 * `narrate --script <that> --out <out>/narration --json [--engine] [--voice]`, then reads and
 * validates `<out>/narration/timings.json` against the step list. Returns undefined — and spawns
 * nothing — when no step has `say`. Any failure is a {@link DemoError} for stage "narrate".
 */
async function runNarrateStage(
	stepList: StepList,
	opts: DemoRunOptions,
	paths: DemoPaths,
	engine: { spawnFn: typeof spawn; nodeBinPath: string; engineBinPath: string },
): Promise<NarrateStageResult | undefined> {
	const lines: Array<{ id: string; text: string }> = [];
	stepList.steps.forEach((step, index) => {
		if (step.say !== undefined) lines.push({ id: narrationLineId(index), text: step.say });
	});
	if (lines.length === 0) return undefined;

	try {
		writeFileSync(paths.narrationScript, `${JSON.stringify({ lines }, null, 2)}\n`, "utf-8");
		const args = [
			"narrate",
			"--script",
			paths.narrationScript,
			"--out",
			paths.narrationDir,
			"--json",
		];
		if (opts.narrateEngine !== undefined) args.push("--engine", opts.narrateEngine);
		if (opts.voice !== undefined) args.push("--voice", opts.voice);
		const code = await runEngineCommand(
			engine.spawnFn,
			engine.nodeBinPath,
			engine.engineBinPath,
			args,
		);
		if (code !== 0) throw new Error(`narrate exited with code ${code}`);
		const timings = readNarrationTimings(
			readFileSync(paths.narrationTimings, "utf-8"),
			paths.narrationTimings,
			stepList,
		);
		const artifacts: NarrateStageResult["artifacts"] = [
			{ name: "narration-script", path: paths.narrationScript, isMedia: false },
			{ name: "narration-timings", path: paths.narrationTimings, isMedia: false },
		];
		for (const { id } of lines) {
			const file = timings.lines[id]?.file;
			if (file === undefined) throw new Error(`timings.json line "${id}" names no audio file`);
			artifacts.push({
				name: `narration-audio-${id}`,
				path: path.join(paths.narrationDir, file),
				isMedia: true,
			});
		}
		return { timings, artifacts };
	} catch (error) {
		throw new DemoError("narrate", messageOf(error));
	}
}

/**
 * CR-LENSMITH-A008-6: collects `{voiceLineId: voiceStartMs}` from the action log, converts each to
 * film time with {@link logMsToFilmMs} (the same mapping the zoom regions use), writes
 * `<out>/voice-starts.json` and runs the engine's
 * `voiceover --video final.mp4 --narration narration/timings.json --starts voice-starts.json
 * --out final-voiced.mp4 [--captions]`. Any failure is a {@link DemoError} for stage "voiceover".
 * The engine's own stderr (e.g. ffmpeg built without libass) is inherited and shown live.
 */
async function runVoiceoverStage(
	actionLog: ActionLogEntry[],
	opts: DemoRunOptions,
	paths: DemoPaths,
	engine: { spawnFn: typeof spawn; nodeBinPath: string; engineBinPath: string },
): Promise<void> {
	try {
		const starts: Record<string, number> = {};
		for (const entry of actionLog) {
			if (entry.voiceLineId !== undefined && entry.voiceStartMs !== undefined) {
				starts[entry.voiceLineId] = Math.round(logMsToFilmMs(entry.voiceStartMs));
			}
		}
		if (Object.keys(starts).length === 0) {
			throw new Error("the action log recorded no narration start times");
		}
		writeFileSync(paths.voiceStarts, `${JSON.stringify(starts, null, 2)}\n`, "utf-8");
		const args = [
			"voiceover",
			"--video",
			paths.renderedVideo,
			"--narration",
			paths.narrationTimings,
			"--starts",
			paths.voiceStarts,
			"--out",
			paths.voicedVideo,
		];
		if (opts.captions !== undefined) args.push("--captions", opts.captions);
		const code = await runEngineCommand(
			engine.spawnFn,
			engine.nodeBinPath,
			engine.engineBinPath,
			args,
		);
		if (code !== 0) {
			throw new Error(
				`voiceover exited with code ${code} (burning captions needs an ffmpeg with libass; see the engine's message above, or pass --captions srt|none)`,
			);
		}
	} catch (error) {
		throw new DemoError("voiceover", messageOf(error));
	}
}

const EXCLUSIVE_MACHINE_NOTICE =
	"Recording the screen and driving a real browser with real input events — the machine is " +
	"exclusive for the whole run. Do not touch it.";

/**
 * `runDemo` wraps every failure it can reach into a {@link DemoError} naming
 * the stage before it ever escapes — the fallback branch here is for a
 * genuinely unforeseen error (e.g. the filesystem itself failing), not a
 * recognized failure mode this command already names.
 */
function reportDemoFailure(error: unknown): void {
	if (error instanceof DemoError) {
		console.error(`demo: stage "${error.stage}" failed — ${error.message}`);
		return;
	}
	console.error(`demo: ${messageOf(error)}`);
}

export function registerDemoCommand(program: Command): void {
	program
		.command("demo")
		.description(
			"record, drive, compose and process one clip in a single run: narrate the steps' say lines " +
				"(when any), start the recorder, run " +
				"the driver, stop the recorder, then compose and render — writing a manifest of every " +
				"artifact produced",
		)
		.requiredOption("--steps <path>", "path to the step-list JSON ({ url, steps: [...] })")
		.requiredOption("--out-dir <dir>", "directory to write every artifact and the manifest into")
		.option(
			"--profile-dir <path>",
			"Chrome profile directory — created and reused; never inside this repository, never committed",
			defaultProfileDir(),
		)
		.option(
			"--browser-channel <name>",
			"Chrome channel to launch — never Playwright's bundled Chromium",
			DEFAULT_BROWSER_CHANNEL,
		)
		.option(
			"--voice <name>",
			"narration voice, passed to the engine's `narrate --voice` (default: the engine's, Kokoro am_michael)",
		)
		.option(
			"--engine <name>",
			"narration engine, passed to the engine's `narrate --engine` (kokoro default, or edge)",
		)
		.option(
			"--narration <mode>",
			"settle (default: Settle pacing, unchanged) or continuous (the voice never stops: every step needs a say line, lines at most 300 ms apart)",
		)
		.option(
			"--captions <mode>",
			"captions on the narrated film, passed to the engine's `voiceover --captions`: burn (default), srt or none",
		)
		.addHelpText(
			"after",
			"\nOne-time warm-up: --profile-dir is expected to already be signed in — see " +
				"`lensmith-director drive --help` for the warm-up command a human runs once.",
		)
		.action(
			async (opts: {
				steps: string;
				outDir: string;
				profileDir: string;
				browserChannel: string;
				voice?: string;
				engine?: string;
				captions?: string;
				narration?: string;
			}) => {
				console.error(EXCLUSIVE_MACHINE_NOTICE);
				if (opts.narration !== undefined && !["settle", "continuous"].includes(opts.narration)) {
					console.error(`demo: --narration must be settle or continuous (got '${opts.narration}')`);
					process.exitCode = 1;
					return;
				}
				if (opts.captions !== undefined && !["burn", "srt", "none"].includes(opts.captions)) {
					console.error(`demo: --captions must be burn, srt or none (got '${opts.captions}')`);
					process.exitCode = 1;
					return;
				}
				try {
					const result = await runDemo({
						stepsPath: opts.steps,
						outDir: opts.outDir,
						profileDir: opts.profileDir,
						browserChannel: opts.browserChannel,
						...(opts.voice !== undefined ? { voice: opts.voice } : {}),
						...(opts.engine !== undefined ? { narrateEngine: opts.engine } : {}),
						...(opts.captions !== undefined
							? { captions: opts.captions as "burn" | "srt" | "none" }
							: {}),
						...(opts.narration !== undefined
							? { narrationMode: opts.narration as NarrationMode }
							: {}),
					});
					console.log(
						`demo: wrote ${result.artifacts.length} artifact(s), manifest at ${result.manifestPath}`,
					);
				} catch (error) {
					reportDemoFailure(error);
					process.exitCode = 1;
				}
			},
		);
}

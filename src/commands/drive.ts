/// <reference lib="dom" />
/**
 * `lensmith-director drive` — launches Chromium via Playwright, drives it
 * through a hand-authored step list, and emits an action log plus a
 * `compose`-ready zoom-regions fragment.
 *
 * The triple-slash reference above is scoped to this file only (see
 * `calibration.ts`'s header for why it's not in `tsconfig.json`'s `lib`) — the
 * single `window.innerWidth`/`innerHeight` read inside the viewport
 * `page.evaluate()` callback below needs it.
 *
 * This is the middle stage of the pipeline: the caller (out of scope here)
 * produces the step list; this command drives the app and records what
 * happened; `lensmith compose` (the sibling engine repo) turns the zoom
 * fragment into a project file.
 *
 * `runDrive` takes its `page` and `choreographer` as injected dependencies
 * (`RunDriveDeps`) rather than constructing them itself, so the orchestration
 * — the calibrate-then-loop control flow, the error paths, the "no partial
 * output on failure" guarantee — is fully unit-testable against fakes that
 * touch neither a real browser nor the real OS cursor. Only
 * `registerDriveCommand`'s CLI action constructs the real Playwright browser
 * and the real `CursorChoreographer`; that path is exercised only in an
 * announced, attended machine window (this repo's standing rule — see
 * `CLAUDE.md` and `tests/cli.test.ts`'s own header comment).
 */

import { execFile as execFileCb } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Command } from "commander";
import { chromium } from "playwright";
import type { ActionLogEntry } from "../lib/actionLog.js";
import {
	CalibrationError,
	type CalibrationPageLike,
	calibrateOffset,
	computeScreenPoint,
} from "../lib/calibration.js";
import { CursorChoreographer, CursorChoreographerError } from "../lib/cursorChoreographer.js";
import { type ExecFileFn, KeychainTextError, resolveKeychainText } from "../lib/keychainText.js";
import type { NativeDriverLike } from "../lib/nativeDriver.js";
import { NativeHelperMissingError } from "../lib/nativeHelpers.js";
import {
	type CaptureRegion,
	chordName,
	driveNativeStep,
	toCaptureSpace,
} from "../lib/nativeSteps.js";
import {
	type Chord,
	type DriveStep,
	type DriveStepList,
	isNativeStep,
	parseWebKeys,
	readDriveStepList,
	type Step,
	type StepList,
	StepListError,
	sayMark,
} from "../lib/stepList.js";
import {
	type ContinuousAction,
	type ContinuousLine,
	type ContinuousPlan,
	distancePx,
	pauseBeforeNextStepMs,
	planContinuousNarration,
	SETTLE_PACING,
	travelMs,
} from "../lib/timing.js";
import {
	emitZoomRegions,
	logMsToFilmMs,
	type ViewportSize,
	type ZoomFragment,
	type ZoomRegion,
} from "../lib/zoomEmission.js";

export class DriveError extends Error {}

/**
 * Nothing in this file used to call `context.setDefaultTimeout` /
 * `setDefaultNavigationTimeout`, and Playwright's own installed default for
 * every locator action and navigation is "0 — no timeout." A missing
 * element or a page that never reaches `load` therefore hung `drive`
 * forever instead of failing it. Measured 2026-09-12 designing the
 * flag-free Turnstile test for CR-BUILDR-A001-38: the slowest legitimate
 * wait observed was a Cloudflare Turnstile token issuing 12-18s after a
 * fixed 5s settle — roughly 25s with margin — so this action bound clears
 * it with headroom.
 */
export const DEFAULT_ACTION_TIMEOUT_MS = 45_000;

/**
 * A full page load is slower than a single action, so this carries more
 * margin than {@link DEFAULT_ACTION_TIMEOUT_MS} above it. Same measurement
 * basis.
 */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;

export interface BoundingBoxLike {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LocatorLike {
	waitFor(options?: { state?: "visible"; timeout?: number }): Promise<void>;
	boundingBox(options?: { timeout?: number }): Promise<BoundingBoxLike | null>;
	/**
	 * Playwright's own method — visible does not imply in-viewport. Called
	 * unconditionally for every `click` step, after `waitFor` and before
	 * `boundingBox()`, so a `boundingBox()` read (and everything computed from
	 * it) always reflects the element's POST-scroll position.
	 * Closes a near-miss: an off-screen target far down a long page (page-Y
	 * 2700 on an 841px viewport) computed a screen point at the literal edge
	 * of the display, because nothing had scrolled it into view first. Playwright's
	 * real implementation is a no-op (beyond its own actionability wait) for
	 * an element already fully in view, so calling this unconditionally does
	 * not change behavior for the common, already-on-screen case.
	 */
	scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
	/**
	 * Playwright's own real-input-event method (the maintained replacement for
	 * the deprecated `type()`): dispatches a genuine keydown/input/keyup
	 * sequence per character, `delay` ms apart, into the already-focused
	 * element. Called only after
	 * the choreographer's own `moveTo`/`dwell`/`click` has already focused the
	 * field through the real cursor, so the render shows a click landing on
	 * the field followed by characters appearing one at a time, not a value
	 * materialising at once.
	 */
	pressSequentially(text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
	/** CR-LENSMITH-A011-5: focuses the element before a web `key` step that names a `selector`. */
	focus?(options?: { timeout?: number }): Promise<void>;
}

/** The minimal `Page` surface `runDrive` needs — satisfied structurally by a real Playwright `Page`. */
export interface PageLike extends CalibrationPageLike {
	goto(
		url: string,
		options?: {
			waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
			timeout?: number;
		},
	): Promise<unknown>;
	locator(selector: string): LocatorLike;
	bringToFront(): Promise<void>;
	/** Waits for the (possibly new) document to reach a load state — used after a click navigated (BF-14). */
	waitForLoadState(
		state?: "load" | "domcontentloaded" | "networkidle",
		options?: { timeout?: number },
	): Promise<void>;
	/** The page's current URL — `--keep-open` prints this so a separate process/devtools session can reconnect. */
	url(): string;
	/**
	 * CR-LENSMITH-A011-5: Playwright's own mouse. Calibration uses its left click; a right-click
	 * step posts `{ button: "right" }` here after the real cursor has travelled to the point (the
	 * cursor helper posts left clicks only).
	 */
	mouse: { click(x: number, y: number, options?: { button?: "left" | "right" }): Promise<void> };
	/** CR-LENSMITH-A011-5: Playwright's keyboard — a web `key` step presses its chords here. */
	keyboard?: { press(key: string): Promise<void> };
}

export interface MoveResultLike {
	elapsedMs: number;
	/**
	 * Where the OS reports the cursor actually landed. REQUIRED, not
	 * optional: any fake
	 * satisfying {@link ChoreographerLike} must supply an achieved position,
	 * the same shape the real `CursorChoreographer.moveTo()` (see
	 * `cursorChoreographer.ts`'s `MoveResult.to`) already returns, verified
	 * within `POSITION_TOLERANCE_PX` of what was requested before it
	 * resolves at all (`CursorDeliveryError` otherwise — see
	 * `cursorChoreographer.ts`).
	 */
	to: PointLike;
}

export interface PointLike {
	x: number;
	y: number;
}

/** The minimal `CursorChoreographer` surface `runDrive` needs — a real instance satisfies this. */
export interface ChoreographerLike {
	start(): Promise<void>;
	stop(): void;
	moveTo(x: number, y: number, durationMs?: number): Promise<MoveResultLike>;
	dwell(ms?: number): Promise<void>;
	click(): Promise<PointLike>;
}

export interface RunDriveDeps {
	/** Required when the step list has a `url` (web mode); a native-only list runs without one. */
	page?: PageLike;
	/**
	 * CR-LENSMITH-A010-6: native mode. `pids` maps bundle id → launched pid; `capture` is the
	 * capture region in screen points (every logged box is moved into it); `activate` brings a
	 * pid to the front.
	 */
	native?: {
		driver: NativeDriverLike;
		pids: Map<string, number>;
		capture?: CaptureRegion;
		activate: ActivateProcess;
	};
	choreographer: ChoreographerLike;
	/** Injectable clock (ms). Production uses a real monotonic clock; tests want determinism. */
	now?: () => number;
	/** Injectable sleep. Production waits for real; tests skip the real delay. */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Injectable for tests only — production resolves a
	 * `type` step's `textFrom` via the real `/usr/bin/security`. Unused by any
	 * step with a literal `text`.
	 */
	execFile?: ExecFileFn;
	/**
	 * Injectable for tests only — production navigates with
	 * {@link DEFAULT_NAVIGATION_TIMEOUT_MS}, the same bound `withLaunchedChrome`
	 * sets as the context's own default; passed explicitly here too (not just
	 * relied on via the context) so a fault-injection test can exercise a
	 * short bound against a never-resolving fake `page.goto` without waiting
	 * out the real one.
	 */
	navigationTimeoutMs?: number;
	/**
	 * CR-LENSMITH-A008-2: the `lensmith narrate` timings (`drive --narration`). When set, every
	 * step with a `say` line is timed to its voice line `s<index>`; steps without `say`, and runs
	 * without narration, drive exactly as before.
	 */
	narration?: NarrationTimings;
	/**
	 * CR-LENSMITH-A011-6: `continuous` drives to {@link continuousPlanFor} (Settle LOCK v1.1):
	 * every step needs `say` and `narration`; no hold to line end + 600 and no breath. Omitted or
	 * `settle`: exactly as before.
	 */
	narrationMode?: NarrationMode;
}

/**
 * CR-LENSMITH-A008-2: the part of the engine's `timings.json` (`lensmith narrate`,
 * `src/commands/narrate.ts` `Timings`) the director reads. `words`/`cues`/`file` are the
 * engine's business (captions, mixing) and are carried through untouched.
 */
export interface NarrationLine {
	file?: string;
	durationMs: number;
	marks: Record<string, number>;
	/** BF-23: first and last speech sample (ms from the file start); both or neither, absent from older engines. */
	speechStartMs?: number;
	speechEndMs?: number;
}

export interface NarrationTimings {
	lines: Record<string, NarrationLine>;
}

/** The pacing LOCK's narration stretch: the step lasts at least the voice + this tail. */
export const NARRATION_TAIL_MS = 600;

/** The timings.json line id for the step at `index`: `s0`, `s1`, … (one line per step index). */
export function narrationLineId(index: number): string {
	return `s${index}`;
}

/**
 * The narration timing rule (pacing LOCK, "Narration stretch"), as a pure function. The line
 * starts with the step's travel. With a mark at `markMs` into the line:
 * - markMs > travel + dwell: the dwell is extended by the difference, the voice starts with the travel;
 * - markMs < travel + dwell: the voice start is delayed by the difference, the dwell is unchanged.
 * Either way the click lands at voiceStart + markMs. Without a mark nothing moves.
 */
export function narrationDwell(
	travelMsValue: number,
	markMs: number | undefined,
	dwellMs: number = SETTLE_PACING.dwellMs,
): { dwellMs: number; voiceDelayMs: number } {
	if (markMs === undefined) return { dwellMs, voiceDelayMs: 0 };
	const actionMs = travelMsValue + dwellMs;
	if (markMs > actionMs) return { dwellMs: dwellMs + (markMs - actionMs), voiceDelayMs: 0 };
	return { dwellMs, voiceDelayMs: actionMs - markMs };
}

/**
 * Checks the timings against the step list: every step with `say` needs its line `s<index>`
 * with a positive durationMs, and a `say` mark must exist in that line's marks, within the line.
 * Throws {@link DriveError} naming the first problem, before anything launches.
 */
export function validateNarration(
	timings: unknown,
	stepList: StepList,
	sourcePath = "timings.json",
): NarrationTimings {
	if (typeof timings !== "object" || timings === null || Array.isArray(timings)) {
		throw new DriveError(`"${sourcePath}" must be an object with a "lines" object`);
	}
	const { lines } = timings as { lines?: unknown };
	if (typeof lines !== "object" || lines === null || Array.isArray(lines)) {
		throw new DriveError(`"${sourcePath}" has no "lines" object`);
	}
	const byId = lines as Record<string, unknown>;
	stepList.steps.forEach((step, index) => {
		if (step.say === undefined) return;
		const id = narrationLineId(index);
		const where = `step at index ${index} (type "${step.type}")`;
		const line = byId[id];
		if (typeof line !== "object" || line === null || Array.isArray(line)) {
			throw new DriveError(`${where} has a "say" line but "${sourcePath}" has no line "${id}"`);
		}
		const { durationMs, marks, speechStartMs, speechEndMs } = line as {
			durationMs?: unknown;
			marks?: unknown;
			speechStartMs?: unknown;
			speechEndMs?: unknown;
		};
		if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
			throw new DriveError(`"${sourcePath}" line "${id}": durationMs must be a positive number`);
		}
		if ((speechStartMs === undefined) !== (speechEndMs === undefined)) {
			throw new DriveError(
				`"${sourcePath}" line "${id}": speechStartMs and speechEndMs come together (only one is present)`,
			);
		}
		if (
			speechStartMs !== undefined &&
			!(
				Number.isInteger(speechStartMs) &&
				Number.isInteger(speechEndMs) &&
				(speechStartMs as number) >= 0 &&
				(speechStartMs as number) < (speechEndMs as number) &&
				(speechEndMs as number) <= durationMs
			)
		) {
			throw new DriveError(
				`"${sourcePath}" line "${id}": speech bounds must be integers with 0 <= speechStartMs < speechEndMs <= durationMs`,
			);
		}
		const mark = sayMark(step.say);
		if (mark === undefined) return;
		const markMs =
			typeof marks === "object" && marks !== null
				? (marks as Record<string, unknown>)[mark]
				: undefined;
		if (
			typeof markMs !== "number" ||
			!Number.isFinite(markMs) ||
			markMs < 0 ||
			markMs > durationMs
		) {
			throw new DriveError(
				`${where} marks [[${mark}]] but "${sourcePath}" line "${id}" has no such mark within the line`,
			);
		}
	});
	return timings as NarrationTimings;
}

/** Reads and validates `--narration`. Throws {@link DriveError} for bad JSON or a bad shape. */
export function readNarrationTimings(
	rawJson: string,
	sourcePath: string,
	stepList: StepList,
): NarrationTimings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(`"${sourcePath}" is not valid JSON: ${message}`);
	}
	return validateNarration(parsed, stepList, sourcePath);
}

/** What a narrated step needs to know about its line. */
interface VoicePlan {
	lineId: string;
	durationMs: number;
	markMs?: number;
}

function voicePlanFor(
	step: DriveStep,
	index: number,
	narration: NarrationTimings | undefined,
): VoicePlan | undefined {
	if (narration === undefined || step.say === undefined) return undefined;
	const lineId = narrationLineId(index);
	const line = narration.lines[lineId];
	if (!line) return undefined; // unreachable after validateNarration
	const mark = sayMark(step.say);
	const plan: VoicePlan = { lineId, durationMs: line.durationMs };
	if (mark !== undefined) plan.markMs = line.marks[mark];
	return plan;
}

/** The voice start for a step whose click was posted at `clickedAtMs` (the click sits on the mark). */
function voiceStartFor(voice: VoicePlan, startedAtMs: number, clickedAtMs: number): number {
	return voice.markMs === undefined ? startedAtMs : clickedAtMs - voice.markMs;
}

/**
 * CR-LENSMITH-A011-6: how narration paces the film. `settle` (default) is the Settle LOCK v1.0
 * narration stretch; `continuous` (Settle LOCK v1.1) makes the voice the clock.
 */
export type NarrationMode = "settle" | "continuous";

/**
 * Continuous narration refuses a silent step: every step needs a `say` line. Throws
 * {@link DriveError} naming the first silent step, before anything launches.
 */
export function validateContinuousSteps(stepList: { steps: readonly DriveStep[] }): void {
	stepList.steps.forEach((step, index) => {
		if (step.say === undefined) {
			throw new DriveError(
				`step at index ${index} (type "${step.type}") has no "say" line — continuous narration ` +
					"refuses silent steps (Settle LOCK v1.1): give every step a line",
			);
		}
	});
}

/**
 * The continuous plan for a step list and its voice timings. Travel is planned at the Settle
 * maximum (the real distance is known only while driving; a shorter travel waits the difference
 * so the click still lands on the mark). A typed step keeps the cursor busy for its characters.
 */
export function continuousPlanFor(
	stepList: { steps: readonly DriveStep[] },
	narration: NarrationTimings,
): ContinuousPlan {
	validateContinuousSteps(stepList);
	const lines = stepList.steps.map((step, index) => {
		const line = narration.lines[narrationLineId(index)];
		if (!line) {
			throw new DriveError(
				`step at index ${index} has a "say" line but no voice line "${narrationLineId(index)}"`,
			);
		}
		const mark = step.say === undefined ? undefined : sayMark(step.say);
		const markMs = mark === undefined ? undefined : line.marks[mark];
		const planned: ContinuousLine = { durationMs: line.durationMs };
		if (markMs !== undefined) planned.markMs = markMs;
		if (line.speechStartMs !== undefined && line.speechEndMs !== undefined) {
			planned.speechStartMs = line.speechStartMs;
			planned.speechEndMs = line.speechEndMs;
		}
		return planned;
	});
	const actions = stepList.steps.map((step): ContinuousAction | undefined => {
		if (step.type === "wait") return undefined;
		const action: ContinuousAction = { travelMs: SETTLE_PACING.travelMaxMs };
		const text = (step as { text?: unknown }).text;
		if (step.type === "type" && typeof text === "string") {
			action.busyMs = text.length * SETTLE_PACING.typeCharDelayMs + SETTLE_PACING.settleQuietMs;
		}
		return action;
	});
	return planContinuousNarration(lines, actions);
}

export interface RunDriveResult {
	actionLog: ActionLogEntry[];
	viewport: ViewportSize;
	/** CR-LENSMITH-A011-6: the continuous plan the run followed; absent in settle mode. */
	plan?: ContinuousPlan;
	/** CR-LENSMITH-A011-7: the recorded page viewport's screen rect (points), when one was sized. */
	viewportRect?: CaptureRegion;
}

/**
 * CR-LENSMITH-A011-6: step lists a caller marked for continuous narration (`demo --narration
 * continuous`, or `"narration": "continuous"` in the step list). A set, not a field, so the list
 * object and everything serialised from it stay byte-identical.
 */
export const continuousNarrationLists = new WeakSet<object>();

/**
 * The narration mode: the flag when given, else the step list's top-level `"narration"` field,
 * else `settle`. Throws {@link DriveError} for any other value.
 */
export function narrationModeFrom(rawStepList: string, flag?: string): NarrationMode {
	let value: unknown = flag;
	if (value === undefined) {
		try {
			const parsed: unknown = JSON.parse(rawStepList);
			if (typeof parsed === "object" && parsed !== null) {
				value = (parsed as { narration?: unknown }).narration;
			}
		} catch {
			value = undefined; // the step-list reader reports bad JSON by name
		}
	}
	if (value === undefined || value === "settle") return "settle";
	if (value === "continuous") return "continuous";
	throw new DriveError(
		`narration mode must be "settle" or "continuous" (got ${JSON.stringify(value)})`,
	);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The minimal `BrowserContext` surface a persistent-context launch needs
 * — satisfied structurally by Playwright's real
 * `BrowserContext`, and by a plain fake in tests.
 */
export interface PersistentContextLike {
	pages(): PageLike[];
	newPage(): Promise<PageLike>;
	close(): Promise<void>;
	/**
	 * Applied exactly once, in `withLaunchedChrome`,
	 * immediately after the context is obtained and before any page is used —
	 * every locator action and navigation in the run inherits a finite bound
	 * instead of Playwright's own "0, no timeout" default.
	 */
	setDefaultTimeout(timeoutMs: number): void;
	setDefaultNavigationTimeout(timeoutMs: number): void;
	/** BF-16: a CDP session on a page — used only to pin the window bounds. Optional so fakes may omit it. */
	newCDPSession?(page: PageLike): Promise<CdpSessionLike>;
}

/** The slice of a Playwright `CDPSession` the director uses (BF-16). */
export interface CdpSessionLike {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	detach?(): Promise<void>;
}

export type LaunchPersistentContext = (
	profileDir: string,
	options: {
		headless: false;
		channel: string;
		viewport: null;
		chromiumSandbox: true;
		args: string[];
	},
) => Promise<PersistentContextLike>;

/**
 * The real launcher: Playwright's own `chromium.launchPersistentContext`.
 * Exported so `demo.ts`'s `defaultPerformDrive` uses the exact same launch
 * call `drive`'s own CLI action does, rather than a second hand-copy of it.
 */
export const realLaunchPersistentContext: LaunchPersistentContext = (profileDir, options) =>
	chromium.launchPersistentContext(
		profileDir,
		options,
	) as unknown as Promise<PersistentContextLike>;

export const DEFAULT_BROWSER_CHANNEL = "chrome";

/**
 * BF-15: the driven Chrome window is always 16:9 at a fixed size and position, so a window-source
 * recording of it is the same frame every run. y = 25 sits just under the macOS menu bar.
 */
export const DRIVEN_WINDOW = { width: 1600, height: 900, x: 0, y: 25 } as const;

/** Chrome arguments that apply {@link DRIVEN_WINDOW} (the launch keeps `viewport: null`). */
export const DRIVEN_WINDOW_ARGS: readonly string[] = [
	`--window-size=${DRIVEN_WINDOW.width},${DRIVEN_WINDOW.height}`,
	`--window-position=${DRIVEN_WINDOW.x},${DRIVEN_WINDOW.y}`,
];

/** One on-screen Chrome window as the OS reports it. `id` is the CGWindowID the engine's `--source window:<id>` takes. */
export interface ChromeWindowInfo {
	id: number;
	/** BF-16: the PID of the process that owns the window (kCGWindowOwnerPID). */
	ownerPid: number;
	/** BF-16: the owning application's name, for the candidate log only. */
	ownerName?: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export type ListChromeWindows = () => Promise<ChromeWindowInfo[]>;

/**
 * JXA run by `osascript`: lists every on-screen layer-0 window (with its owner PID and name; the caller filters by PID, BF-16) through
 * CoreGraphics' `CGWindowListCopyWindowInfo` — the same CGWindowID space ScreenCaptureKit's
 * `SCWindow.windowID` uses. The engine itself has no window-listing command (BF-15), so the
 * director enumerates the window here. Needs no extra permission (ids and bounds, not titles).
 */
const LIST_WINDOWS_JXA = `
ObjC.import('CoreGraphics');
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
const list = ObjC.deepUnwrap(ObjC.castRefToObject(raw));
JSON.stringify(list
  .filter(w => w.kCGWindowLayer === 0)
  .map(w => ({ id: w.kCGWindowNumber, ownerPid: w.kCGWindowOwnerPID, ownerName: w.kCGWindowOwnerName || '', x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height })));
`;

export const listChromeWindowsMac: ListChromeWindows = () =>
	new Promise((resolve, reject) => {
		if (process.platform !== "darwin") {
			reject(new Error("Chrome window listing is only available on macOS"));
			return;
		}
		execFileCb(
			"osascript",
			["-l", "JavaScript", "-e", LIST_WINDOWS_JXA],
			{ timeout: 10_000 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				try {
					resolve(JSON.parse(String(stdout).trim()) as ChromeWindowInfo[]);
				} catch (parseError) {
					reject(parseError);
				}
			},
		);
	});

export interface DiscoverWindowOptions {
	/** BF-16: PID of the browser process this run launched — the only thing that identifies its window. */
	pid: number;
	list: ListChromeWindows;
	sleep: (ms: number) => Promise<void>;
	attempts?: number;
	intervalMs?: number;
	/** Receives the candidate windows seen when nothing was found (stderr in production). */
	log?: (line: string) => void;
}

/**
 * BF-16: finds the driven window by the launched browser's owner PID — the largest on-screen
 * layer-0 window that process owns. No geometry match: a restored profile or the menu-bar inset can
 * place the window anywhere. Polls briefly because the window appears a moment after the launch call
 * returns. Returns null (never throws) when it cannot be found, after logging the windows it saw.
 */
export async function discoverDrivenWindowId(
	options: DiscoverWindowOptions,
): Promise<number | null> {
	const attempts = options.attempts ?? 10;
	const intervalMs = options.intervalMs ?? 300;
	let lastSeen: ChromeWindowInfo[] = [];
	for (let i = 0; i < attempts; i++) {
		try {
			lastSeen = await options.list();
			const owned = lastSeen.filter((w) => w.ownerPid === options.pid);
			let best: ChromeWindowInfo | null = null;
			for (const w of owned) {
				if (best === null || w.width * w.height > best.width * best.height) best = w;
			}
			if (best) return best.id;
		} catch (error) {
			options.log?.(
				`demo: window listing failed — ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
		if (i < attempts - 1) await options.sleep(intervalMs);
	}
	options.log?.(
		`demo: no on-screen layer-0 window owned by pid ${options.pid}; windows seen: ` +
			(lastSeen.length === 0
				? "none"
				: lastSeen
						.map(
							(w) =>
								`#${w.id} pid=${w.ownerPid} owner="${w.ownerName ?? ""}" ${w.width}x${w.height}@${w.x},${w.y}`,
						)
						.join("; ")),
	);
	return null;
}

/** Finds the PID of the browser (main) process launched with this profile directory, via `ps`. */
export type FindBrowserPid = (profileDir: string) => Promise<number | null>;

export const findBrowserPidByProfile: FindBrowserPid = (profileDir) =>
	new Promise((resolve) => {
		execFileCb(
			"ps",
			["-axo", "pid=,command="],
			{ maxBuffer: 16 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					resolve(null);
					return;
				}
				const needle = `--user-data-dir=${profileDir}`;
				for (const line of String(stdout).split("\n")) {
					const m = /^\s*(\d+)\s+(.*)$/.exec(line);
					if (!m) continue;
					const command = m[2] ?? "";
					// the browser process has the profile flag and no --type= (helpers/renderers all have one)
					if (command.includes(needle) && !/\s--type=/.test(command)) {
						resolve(Number(m[1]));
						return;
					}
				}
				resolve(null);
			},
		);
	});

/**
 * BF-16: pins the driven window to {@link DRIVEN_WINDOW} through CDP so a size or position restored
 * from the persistent profile cannot win over the launch flags. Never throws — a failure is logged.
 */
export async function pinWindowBounds(
	context: PersistentContextLike,
	page: PageLike,
	log: (line: string) => void,
): Promise<boolean> {
	if (!context.newCDPSession) return false;
	try {
		const session = await context.newCDPSession(page);
		try {
			const win = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
			await session.send("Browser.setWindowBounds", {
				windowId: win.windowId,
				bounds: {
					windowState: "normal",
					left: DRIVEN_WINDOW.x,
					top: DRIVEN_WINDOW.y,
					width: DRIVEN_WINDOW.width,
					height: DRIVEN_WINDOW.height,
				},
			});
			return true;
		} finally {
			await session.detach?.().catch(() => undefined);
		}
	} catch (error) {
		log(
			`demo: warning: could not pin the window bounds through CDP — ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * CR-LENSMITH-A011-7: the page viewport a web `demo` sizes, in points. macOS rounds the window's
 * bottom corners (about 14 pt), so the page area is {@link VIEWPORT_CORNER_ALLOWANCE} taller than
 * the frame and only its top 1920x1080 is recorded (no tab strip, no address bar, no window frame,
 * no desktop; 3840x2160 at 2x). The page's bottom 16 pt are off-frame by design.
 */
export const DRIVEN_VIEWPORT = { width: 1920, height: 1096 } as const;

/** CR-LENSMITH-A011-7: the page rows below the recorded frame that keep the rounded corners out. */
export const VIEWPORT_CORNER_ALLOWANCE = 16;

/** The six window measurements one `page.evaluate` reads (CSS px = points at 100% zoom). */
export interface WindowMetrics {
	screenX: number;
	screenY: number;
	outerWidth: number;
	outerHeight: number;
	innerWidth: number;
	innerHeight: number;
}

/**
 * CR-LENSMITH-A011-7: where the page viewport sits on screen, in points. Pure. The browser frame
 * is split evenly left and right; everything above the viewport (tab strip, address bar) is on top.
 */
export function viewportScreenRect(m: WindowMetrics): CaptureRegion {
	return {
		x: Math.round(m.screenX + (m.outerWidth - m.innerWidth) / 2),
		y: Math.round(m.screenY + (m.outerHeight - m.innerHeight)),
		width: Math.round(m.innerWidth),
		height: Math.round(m.innerHeight),
	};
}

/**
 * CR-LENSMITH-A011-7: the viewport size to ask for. {@link DRIVEN_VIEWPORT} when the window (that
 * viewport plus the browser frame, placed at {@link DRIVEN_WINDOW}'s position) fits the display;
 * otherwise the largest 16:9 frame with a width that is a multiple of 16 that does, plus the
 * {@link VIEWPORT_CORNER_ALLOWANCE} rows below it. Pure.
 */
export function fitDrivenViewport(
	display: { width: number; height: number },
	frame: { width: number; height: number },
): { width: number; height: number } {
	const k = Math.max(
		1,
		Math.min(
			DRIVEN_VIEWPORT.width / 16,
			Math.floor((display.width - DRIVEN_WINDOW.x - frame.width) / 16),
			Math.floor((display.height - DRIVEN_WINDOW.y - frame.height - VIEWPORT_CORNER_ALLOWANCE) / 9),
		),
	);
	return { width: 16 * k, height: 9 * k + VIEWPORT_CORNER_ALLOWANCE };
}

const readWindowMetrics = (): WindowMetrics => ({
	screenX: window.screenX,
	screenY: window.screenY,
	outerWidth: window.outerWidth,
	outerHeight: window.outerHeight,
	innerWidth: window.innerWidth,
	innerHeight: window.innerHeight,
});

/** How long the resized window gets to report its new inner size before the run is refused. */
const VIEWPORT_RESIZE_ATTEMPTS = 20;
const VIEWPORT_RESIZE_INTERVAL_MS = 100;

/**
 * CR-LENSMITH-A011-7: sizes the driven window through CDP so its page viewport is exactly
 * {@link DRIVEN_VIEWPORT} (or the shrunk size {@link fitDrivenViewport} picks on a small display,
 * said once on `log`), then returns the recorded rect: the TOP 16:9 part of the viewport's screen
 * rect, so the rounded bottom corners stay outside the frame. Returns null when the context has
 * no CDP session (the caller keeps the window capture). Throws {@link DriveError} naming the actual
 * inner size when the resize does not land exactly, so no recording starts on a wrong frame.
 */
export async function sizeDrivenViewport(options: {
	context: PersistentContextLike;
	page: PageLike;
	display: { width: number; height: number };
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}): Promise<CaptureRegion | null> {
	const { context, page, display, sleep, log } = options;
	if (!context.newCDPSession) return null;
	const before = await page.evaluate<WindowMetrics, undefined>(readWindowMetrics, undefined);
	const frame = {
		width: before.outerWidth - before.innerWidth,
		height: before.outerHeight - before.innerHeight,
	};
	const target = fitDrivenViewport(display, frame);
	const recordedHeight = target.height - VIEWPORT_CORNER_ALLOWANCE;
	if (target.width !== DRIVEN_VIEWPORT.width) {
		log(
			`drive: the display (${display.width}x${display.height} points) cannot fit a ` +
				`${DRIVEN_VIEWPORT.width}x${DRIVEN_VIEWPORT.height} viewport — recording ${target.width}x${recordedHeight}`,
		);
	}
	const session = await context.newCDPSession(page);
	try {
		const win = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
		await session.send("Browser.setWindowBounds", {
			windowId: win.windowId,
			bounds: {
				windowState: "normal",
				left: DRIVEN_WINDOW.x,
				top: DRIVEN_WINDOW.y,
				width: target.width + frame.width,
				height: target.height + frame.height,
			},
		});
	} finally {
		await session.detach?.().catch(() => undefined);
	}
	let after = before;
	for (let i = 0; i < VIEWPORT_RESIZE_ATTEMPTS; i++) {
		after = await page.evaluate<WindowMetrics, undefined>(readWindowMetrics, undefined);
		if (after.innerWidth === target.width && after.innerHeight === target.height) {
			return { ...viewportScreenRect(after), height: recordedHeight };
		}
		if (i < VIEWPORT_RESIZE_ATTEMPTS - 1) await sleep(VIEWPORT_RESIZE_INTERVAL_MS);
	}
	throw new DriveError(
		`could not size the browser viewport to ${target.width}x${target.height} — it is ` +
			`${after.innerWidth}x${after.innerHeight} after the resize`,
	);
}

/** BF-17: makes the process with this PID the frontmost application. */
export type ActivateProcess = (pid: number) => Promise<void>;
/** BF-17: the PID of the frontmost application, or null when it cannot be read. */
export type FrontmostPid = () => Promise<number | null>;

/** How long the driven Chrome gets to become frontmost before the title-bar fallback (BF-17). */
export const ACTIVATION_CONFIRM_TIMEOUT_MS = 2_000;
const ACTIVATION_POLL_INTERVAL_MS = 100;

function runJxa(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		if (process.platform !== "darwin") {
			reject(new Error("Chrome activation is only available on macOS"));
			return;
		}
		execFileCb(
			"osascript",
			["-l", "JavaScript", "-e", script],
			{ timeout: 10_000 },
			(error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())),
		);
	});
}

export const activateProcessMac: ActivateProcess = async (pid) => {
	await runJxa(
		`ObjC.import('AppKit');
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Math.trunc(pid)});
if (app.isNil()) { throw new Error('no running application with pid ${Math.trunc(pid)}'); }
app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
'ok'`,
	);
};

export const frontmostPidMac: FrontmostPid = async () => {
	const out = await runJxa(
		`ObjC.import('AppKit');
String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)`,
	);
	const n = Number(out);
	return Number.isFinite(n) ? n : null;
};

/**
 * BF-17: brings the driven Chrome to the front — `page.bringToFront()` plus making its process
 * frontmost by PID — then waits (bounded {@link ACTIVATION_CONFIRM_TIMEOUT_MS}) until it is the
 * frontmost app. Only if that cannot be confirmed does it make ONE harmless click on the window's
 * title-bar strip (never page content). Sends no input to the page otherwise. Never throws.
 */
export async function activateDrivenChrome(options: {
	page: PageLike;
	pid: number;
	choreographer: ChoreographerLike;
	activate: ActivateProcess;
	frontmost: FrontmostPid;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}): Promise<boolean> {
	const { page, pid, choreographer, activate, frontmost, sleep, log } = options;
	const confirm = async (): Promise<boolean> => {
		const attempts = Math.ceil(ACTIVATION_CONFIRM_TIMEOUT_MS / ACTIVATION_POLL_INTERVAL_MS);
		for (let i = 0; i <= attempts; i++) {
			try {
				if ((await frontmost()) === pid) return true;
			} catch {
				// unreadable this poll — keep polling until the bound
			}
			if (i < attempts) await sleep(ACTIVATION_POLL_INTERVAL_MS);
		}
		return false;
	};
	try {
		await page.bringToFront();
		await activate(pid);
	} catch (error) {
		log(
			`drive: warning: could not activate Chrome (pid ${pid}) — ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (await confirm()) {
		log(`drive: Chrome (pid ${pid}) is frontmost`);
		return true;
	}
	// Fallback: one click on the empty tab-strip area of the window title bar. Never page content.
	const x = DRIVEN_WINDOW.x + Math.round(DRIVEN_WINDOW.width * 0.75);
	const y = DRIVEN_WINDOW.y + 10;
	try {
		await choreographer.start();
		try {
			await choreographer.moveTo(x, y);
			await choreographer.click();
		} finally {
			choreographer.stop();
		}
		log(
			`drive: Chrome (pid ${pid}) was not confirmed frontmost within ${ACTIVATION_CONFIRM_TIMEOUT_MS}ms — clicked the window title bar at ${x},${y} to activate it`,
		);
	} catch (error) {
		log(
			`drive: warning: Chrome (pid ${pid}) is not confirmed frontmost and the title-bar click failed — ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return false;
}

/**
 * Per-user, outside the repository, never a hardcoded path — computed from
 * the OS home directory so the same
 * default works on any operator's machine. Not created here: a human
 * warms it once in a real Chrome session (see `drive --help`), and every run
 * after that reuses it.
 */
export function defaultProfileDir(): string {
	return path.join(homedir(), ".lensmith-director", "chrome-profile");
}

export interface LaunchChromeOptions {
	profileDir: string;
	browserChannel: string;
	/** BF-15: also find the driven window's id (see {@link discoverDrivenWindowId}); `withLaunchedChrome` passes it to `fn`. */
	discoverWindow?: boolean;
	/**
	 * BF-17: bring the launched Chrome to the front (page + process, by PID) and confirm it is the
	 * frontmost app before `fn` runs, so the first step's click is not spent activating the window.
	 */
	activate?: boolean;
}

/**
 * Launches Chrome — never Playwright's bundled Chromium — with a persistent,
 * caller-named profile. If the
 * requested channel is not installed, Playwright's `launch` rejects before
 * any process or window is created; this re-throws that failure as a
 * {@link DriveError} naming the channel and the profile directory, so a
 * missing channel is always a loud, named error and never a silent fall
 * back to a different browser.
 */
export async function launchChrome(
	launch: LaunchPersistentContext,
	options: LaunchChromeOptions,
): Promise<PersistentContextLike> {
	try {
		return await launch(options.profileDir, {
			headless: false,
			channel: options.browserChannel,
			viewport: null,
			// playwright-core 1.62.1 documents chromiumSandbox as defaulting
			// to false on every launch shape — left unset, Chrome runs unsandboxed
			// and shows the "unsupported command-line flag: --no-sandbox" infobar
			// on camera. This restores Chrome's own default security posture.
			chromiumSandbox: true,
			args: [...DRIVEN_WINDOW_ARGS],
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(
			`could not launch Chrome (channel "${options.browserChannel}") with profile directory ` +
				`"${options.profileDir}" — ${message}. Install Google Chrome for channel ` +
				`"${options.browserChannel}", or pass a different --browser-channel. This tool never ` +
				"falls back to Playwright's bundled Chromium.",
		);
	}
}

/**
 * The page to drive: the context's existing first page when Chrome opened
 * with one (the normal case for a persistent, non-headless launch), or a
 * freshly created page otherwise.
 */
export async function acquirePage(context: PersistentContextLike): Promise<PageLike> {
	const [existing] = context.pages();
	return existing ?? context.newPage();
}

/**
 * Owns a launched context's lifetime: runs `fn`, then closes the context
 * exactly once regardless of how `fn` settles — success, or a failure
 * injected mid-run. `launchPersistentContext` returns a `BrowserContext`,
 * not a `Browser`; its own `close()` is the only teardown call needed (it
 * closes every page and the underlying browser process with it), unlike the
 * two-object `page.close()` + `browser.close()` pair this replaces.
 */
export async function withChromeContext<T>(
	context: PersistentContextLike,
	fn: (context: PersistentContextLike) => Promise<T>,
): Promise<T> {
	try {
		return await fn(context);
	} finally {
		await context.close();
	}
}

export interface WithLaunchedChromeDeps {
	/** Injectable for tests only — production launches the real `chromium.launchPersistentContext`. */
	launch?: LaunchPersistentContext;
	/** Injectable for tests only — production constructs the real native-helper-backed choreographer. */
	createChoreographer?: () => ChoreographerLike;
	/** Injectable for tests only — production lists Chrome windows through `osascript` (macOS). */
	listChromeWindows?: ListChromeWindows;
	/** Injectable for tests only — production finds the launched browser's PID through `ps`. */
	findBrowserPid?: FindBrowserPid;
	/** Injectable for tests only — BF-17: makes the process with this PID the frontmost app (macOS). */
	activateProcess?: ActivateProcess;
	/** Injectable for tests only — BF-17: the PID of the frontmost app, or null when unknown. */
	frontmostPid?: FrontmostPid;
	/** Injectable for tests only — warnings and the candidate-window log; stderr in production. */
	log?: (line: string) => void;
	/** Injectable for tests only — the poll sleep while the driven window appears. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Acquires a real Chrome persistent context AND a cursor choreographer for a
 * single run, and guarantees the context is closed on every exit path.
 *
 * A real Chrome process must
 * never exist without something already responsible for closing it.
 * `createChoreographer()` runs BEFORE `launchChrome()` for exactly that
 * reason — its most common failure, `NativeHelperMissingError` (the native
 * helper isn't built, the default state of any fresh checkout), must never
 * fire after Chrome is already open. There is structurally no statement
 * between "Chrome is launched" and "`withChromeContext` owns it" for
 * anything to throw from — do not insert one; if a future precondition can
 * throw, resolve it before this function acquires anything, the same way
 * this one was moved here rather than checked after the fact.
 *
 * Also the one place a finite default action and
 * navigation timeout are set on the context, before `fn` (and therefore
 * `acquirePage` and every step) ever touches a page — see
 * {@link DEFAULT_ACTION_TIMEOUT_MS} / {@link DEFAULT_NAVIGATION_TIMEOUT_MS}.
 */
export async function withLaunchedChrome<T>(
	options: LaunchChromeOptions,
	fn: (
		context: PersistentContextLike,
		choreographer: ChoreographerLike,
		windowId: number | null,
	) => Promise<T>,
	deps: WithLaunchedChromeDeps = {},
): Promise<T> {
	const createChoreographer = deps.createChoreographer ?? (() => new CursorChoreographer());
	const launch = deps.launch ?? realLaunchPersistentContext;
	const list = deps.listChromeWindows ?? listChromeWindowsMac;
	const findPid = deps.findBrowserPid ?? findBrowserPidByProfile;
	const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const choreographer = createChoreographer();

	const context = await launchChrome(launch, options);
	context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);
	context.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);
	return withChromeContext(context, async (ctx) => {
		let windowId: number | null = null;
		const sleep = deps.sleep ?? realSleep;
		if (options.discoverWindow || options.activate) {
			// BF-16: pin the bounds through CDP first, then find the window by the browser's PID.
			try {
				const page = await acquirePage(ctx);
				await pinWindowBounds(ctx, page, log);
				const pid = await findPid(options.profileDir);
				if (pid === null) {
					log(`demo: could not find the browser process for profile ${options.profileDir}`);
				} else {
					if (options.activate) {
						// BF-17: once per drive, after launch + pinning, before the first step.
						await activateDrivenChrome({
							page,
							pid,
							choreographer,
							activate: deps.activateProcess ?? activateProcessMac,
							frontmost: deps.frontmostPid ?? frontmostPidMac,
							sleep,
							log,
						});
					}
					if (options.discoverWindow) {
						windowId = await discoverDrivenWindowId({ pid, list, sleep, log });
					}
				}
			} catch (error) {
				log(
					`demo: window discovery failed — ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return fn(ctx, choreographer, windowId);
	});
}

/**
 * Per-character delay for a `type` step's `pressSequentially` call. An
 * editorial choice, not a measurement like `timing.ts`'s recipe (that file's
 * own header states its constants ARE measurements; this one governs only how
 * the event stream reads to a viewer). Lives in `SETTLE_PACING`.
 */
const TYPE_CHARACTER_DELAY_MS = SETTLE_PACING.typeCharDelayMs;

export interface SettleArgs {
	/** When set, the page has settled as soon as this selector matches a visible element. */
	expectSelector?: string;
	/** Otherwise: this many ms without any DOM mutation. */
	quietMs: number;
	/** Never wait longer than this. */
	capMs: number;
}

/**
 * Runs INSIDE the page (via `page.evaluate`) — so it must be self-contained.
 * Resolves when the `expect` selector is visible, else after `quietMs` without a
 * DOM mutation, and in every case no later than `capMs`. CR-LENSMITH-A007-2.
 */
export function settleInPage(args: SettleArgs): Promise<void> {
	return new Promise<void>((resolve) => {
		const visible = (): boolean => {
			if (args.expectSelector === undefined) return false;
			const el = document.querySelector(args.expectSelector);
			return el !== null && el.getClientRects().length > 0;
		};
		let quietTimer: ReturnType<typeof setTimeout> | undefined;
		let observer: MutationObserver | undefined;
		const finish = (): void => {
			clearTimeout(quietTimer);
			clearTimeout(capTimer);
			observer?.disconnect();
			resolve();
		};
		const capTimer = setTimeout(finish, args.capMs);
		if (visible()) {
			finish();
			return;
		}
		const arm = (): void => {
			clearTimeout(quietTimer);
			if (args.expectSelector === undefined) quietTimer = setTimeout(finish, args.quietMs);
		};
		observer = new MutationObserver(() => {
			if (visible()) finish();
			else arm();
		});
		observer.observe(document, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		arm();
	});
}

/** True when Playwright reports the evaluated context vanished because the page navigated. */
function isContextDestroyedError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /execution context was destroyed|navigation/i.test(message);
}

/** Waits for the result of the action just taken to settle; resolves with the measured ms. */
async function waitForSettle(
	page: PageLike,
	now: () => number,
	expectSelector?: string,
): Promise<number> {
	const startedAt = now();
	const args: SettleArgs = {
		quietMs: SETTLE_PACING.settleQuietMs,
		capMs: SETTLE_PACING.settleCapMs,
	};
	if (expectSelector !== undefined) args.expectSelector = expectSelector;
	// BF-14: the click may navigate, which destroys the page context mid-wait. Wait for the new
	// document (bounded by the settle cap), then settle once more on it. The navigation can commit
	// late (the first wait may see the OLD document as already loaded), so a destroyed context on
	// the retry is retried too, until the settle cap measured from the click has passed.
	// settleMs stays counted from the click.
	for (;;) {
		try {
			await page.evaluate<Promise<void>, SettleArgs>(settleInPage, args);
			break;
		} catch (error) {
			const remaining = SETTLE_PACING.settleCapMs - (now() - startedAt);
			if (!isContextDestroyedError(error) || remaining <= 0) throw error;
			await page.waitForLoadState("domcontentloaded", { timeout: remaining });
		}
	}
	return Math.round(now() - startedAt);
}

/**
 * Builds a `click` action-log entry from the ACHIEVED position only —
 * `target` (the computed/requested screen point `driveClickStep` sent to
 * `moveTo()`) is deliberately not a parameter here, so this function is
 * structurally incapable of recording an unverified position: the only
 * `{x, y}` it can see is whatever `choreographer.click()` actually resolved
 * with. Measured: recording the requested coordinate as though it were achieved
 * produces a complete, plausible, WRONG action log when delivery silently
 * fails; `cursorChoreographer.ts`'s `CursorDeliveryError` guarantees `click()` never resolves with a position that diverged
 * from what was expected past tolerance, so anything reaching this function
 * is verified by construction, not by convention.
 */
function buildClickEntry(args: {
	index: number;
	step: Extract<Step, { type: "click" }>;
	box: BoundingBoxLike;
	startedAtMs: number;
	clickedAtMs: number;
	achieved: PointLike;
	settleMs: number;
}): ActionLogEntry {
	const { index, step, box, startedAtMs, clickedAtMs, achieved, settleMs } = args;
	const entry: ActionLogEntry = {
		index,
		type: "click",
		selector: step.selector,
		startedAtMs,
		clickedAtMs,
		screenX: achieved.x,
		screenY: achieved.y,
		boundingBox: box,
		settleMs,
	};
	if (step.label !== undefined) entry.label = step.label;
	if (step.button === "right" && entry.type === "click") entry.button = "right";
	return entry;
}

/**
 * Travel time by distance, in screen points from the cursor's last known position
 * to the target. The first step has no known origin, so it takes the longest
 * allowed travel (the spec's cap for 1000 points or more).
 */
export function travelFor(lastPoint: PointLike | undefined, target: PointLike): number {
	return lastPoint === undefined
		? SETTLE_PACING.travelMaxMs
		: travelMs(distancePx(lastPoint, target));
}

async function driveClickStep(
	step: Extract<Step, { type: "click" }>,
	index: number,
	deps: Required<Pick<RunDriveDeps, "page" | "choreographer" | "now">>,
	offset: PointLike,
	viewport: ViewportSize,
	t0: number,
	lastPoint: PointLike | undefined,
	voice?: VoicePlan,
): Promise<ActionLogEntry> {
	const { page, choreographer, now } = deps;
	const locator = page.locator(step.selector);
	// This step's own override, or the context-wide default set once in
	// `withLaunchedChrome` — either way, every wait below carries a finite
	// bound, and the same number is quoted back in the failure so the
	// operator sees exactly what expired.
	const timeout = step.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

	try {
		await locator.waitFor({ state: "visible", timeout });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(
			`step at index ${index} (type "click"): selector "${step.selector}" was not found ` +
				`within ${timeout}ms — ${message}`,
		);
	}

	// Scroll BEFORE reading the bounding box, so the
	// box (and everything computed from it below) reflects where the element
	// actually ends up, not where it started. "Visible" (the waitFor above)
	// only means "not display:none/hidden" — it says nothing about whether
	// the element is within the current scroll position.
	try {
		await locator.scrollIntoViewIfNeeded({ timeout });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(
			`step at index ${index} (type "click"): selector "${step.selector}" could not be ` +
				`scrolled into view within ${timeout}ms — ${message}`,
		);
	}

	let box: BoundingBoxLike | null;
	try {
		box = await locator.boundingBox({ timeout });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(
			`step at index ${index} (type "click"): selector "${step.selector}" could not be read ` +
				`within ${timeout}ms — ${message}`,
		);
	}
	if (!box) {
		throw new DriveError(
			`step at index ${index} (type "click"): selector "${step.selector}" resolved but is not visible (no bounding box)`,
		);
	}

	const target = computeScreenPoint(offset, box, viewport);
	const startedAtMs = now() - t0;
	const travel = travelFor(lastPoint, target);
	const moved = await choreographer.moveTo(target.x, target.y, travel);
	await choreographer.dwell(narrationDwell(travel, voice?.markMs).dwellMs);
	let achieved: PointLike;
	if (step.button === "right") {
		// CR-LENSMITH-A011-5: the cursor helper posts left clicks only. The real cursor has
		// travelled and dwelt on the point (the film shows it there); Playwright then posts the
		// right button at the same element centre, so the page gets its `contextmenu`.
		try {
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new DriveError(
				`step at index ${index} (type "click"): selector "${step.selector}" could not be ` +
					`right-clicked — ${message}`,
			);
		}
		achieved = moved.to;
	} else {
		achieved = await choreographer.click();
	}
	const clickedAtMs = now() - t0;
	const settleMs = await waitForSettle(page, now);

	const entry = buildClickEntry({ index, step, box, startedAtMs, clickedAtMs, achieved, settleMs });
	if (voice) {
		entry.voiceLineId = voice.lineId;
		entry.voiceStartMs = voiceStartFor(voice, startedAtMs, clickedAtMs);
	}
	return entry;
}

/**
 * Builds a `type` action-log entry. Like {@link buildClickEntry}, `target`
 * is not a parameter — only `achieved` (what `choreographer.click()` actually
 * resolved with, focusing the field) can reach this function — and the typed
 * value itself is not a parameter either: only `characterCount` (computed by
 * the caller from whichever source — literal `text` or a keychain-resolved
 * value — produced it) is ever read here, so this function is structurally
 * incapable of recording the typed value regardless of its source. That is
 * the invariant this design rests on, not a convention a future edit
 * could quietly break.
 */
function buildTypeEntry(args: {
	index: number;
	step: Extract<Step, { type: "type" }>;
	box: BoundingBoxLike;
	startedAtMs: number;
	endedAtMs: number;
	achieved: PointLike;
	characterCount: number;
	settleMs: number;
}): ActionLogEntry {
	const { index, step, box, startedAtMs, endedAtMs, achieved, characterCount, settleMs } = args;
	const entry: ActionLogEntry = {
		index,
		type: "type",
		selector: step.selector,
		startedAtMs,
		endedAtMs,
		screenX: achieved.x,
		screenY: achieved.y,
		boundingBox: box,
		characterCount,
		settleMs,
	};
	if (step.label !== undefined) entry.label = step.label;
	return entry;
}

async function driveTypeStep(
	step: Extract<Step, { type: "type" }>,
	index: number,
	deps: Required<Pick<RunDriveDeps, "page" | "choreographer" | "now">> &
		Pick<RunDriveDeps, "execFile">,
	offset: PointLike,
	viewport: ViewportSize,
	t0: number,
	lastPoint: PointLike | undefined,
	voice?: VoicePlan,
): Promise<ActionLogEntry> {
	const { page, choreographer, now, execFile } = deps;
	const locator = page.locator(step.selector);
	// See `driveClickStep`'s identical comment — this step's own
	// override, or the context-wide default, either way a finite bound.
	const timeout = step.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

	try {
		await locator.waitFor({ state: "visible", timeout });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(
			`step at index ${index} (type "type"): selector "${step.selector}" was not found ` +
				`within ${timeout}ms — ${message}`,
		);
	}

	// Same reasoning as `driveClickStep`: scroll BEFORE reading the bounding
	// box, so the box (and the computed screen point below) reflects where
	// the field actually ends up.
	try {
		await locator.scrollIntoViewIfNeeded({ timeout });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(
			`step at index ${index} (type "type"): selector "${step.selector}" could not be ` +
				`scrolled into view within ${timeout}ms — ${message}`,
		);
	}

	let box: BoundingBoxLike | null;
	try {
		box = await locator.boundingBox({ timeout });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(
			`step at index ${index} (type "type"): selector "${step.selector}" could not be read ` +
				`within ${timeout}ms — ${message}`,
		);
	}
	if (!box) {
		throw new DriveError(
			`step at index ${index} (type "type"): selector "${step.selector}" resolved but is not visible (no bounding box)`,
		);
	}

	const target = computeScreenPoint(offset, box, viewport);
	const startedAtMs = now() - t0;
	// Drive it like a human: move the real cursor to the field's centre and
	// click it — the same choreographer primitives `driveClickStep` uses,
	// reused unchanged — before entering any text.
	const travel = travelFor(lastPoint, target);
	await choreographer.moveTo(target.x, target.y, travel);
	await choreographer.dwell(narrationDwell(travel, voice?.markMs).dwellMs);
	const achieved = await choreographer.click();
	// The focus click is the moment a `say` mark lands on (CR-LENSMITH-A008-2).
	const clickedAtMs = now() - t0;

	// Resolved immediately before
	// typing, held only in this local, and let go out of scope right after —
	// never stored on the step, the action-log entry, or any object that
	// outlives this function. `resolveKeychainText` bounds its own
	// external wait (`keychainText.ts`'s `KEYCHAIN_TIMEOUT_MS`) — the context
	// default set in `withLaunchedChrome` never reaches this call, since it
	// is not a Playwright action.
	let text: string;
	if ("text" in step) {
		text = step.text;
	} else {
		try {
			text = await resolveKeychainText(step.textFrom.keychain, { execFile });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new DriveError(
				`step at index ${index} (type "type"): selector "${step.selector}" could not resolve ` +
					`its keychain text — ${message}`,
			);
		}
	}

	try {
		await locator.pressSequentially(text, { delay: TYPE_CHARACTER_DELAY_MS, timeout });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(
			`step at index ${index} (type "type"): selector "${step.selector}" could not receive ` +
				`typed input within ${timeout}ms — ${message}`,
		);
	}
	const endedAtMs = now() - t0;
	const settleMs = await waitForSettle(page, now);

	const entry = buildTypeEntry({
		index,
		step,
		box,
		startedAtMs,
		endedAtMs,
		achieved,
		characterCount: text.length,
		settleMs,
	});
	if (voice) {
		entry.voiceLineId = voice.lineId;
		entry.voiceStartMs = voiceStartFor(voice, startedAtMs, clickedAtMs);
	}
	return entry;
}

/** Playwright's name for each chord key (`stepList.ts`'s KEY_NAMES); letters and digits pass through. */
const PLAYWRIGHT_KEY: Record<string, string> = {
	return: "Enter",
	tab: "Tab",
	space: "Space",
	escape: "Escape",
	delete: "Backspace",
	forwarddelete: "Delete",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
	minus: "-",
	equal: "=",
	comma: ",",
	period: ".",
	slash: "/",
	semicolon: ";",
	quote: "'",
	backslash: "\\",
	leftbracket: "[",
	rightbracket: "]",
	grave: "`",
};

const PLAYWRIGHT_MODIFIER: Record<string, string> = {
	cmd: "Meta",
	shift: "Shift",
	opt: "Alt",
	ctrl: "Control",
};

/** CR-LENSMITH-A011-5: a parsed chord as Playwright's `keyboard.press` string, e.g. `Meta+Enter`. */
export function playwrightChord(chord: Chord): string {
	const key =
		PLAYWRIGHT_KEY[chord.key] ?? (/^f\d+$/.test(chord.key) ? chord.key.toUpperCase() : chord.key);
	return [...chord.mods.map((m) => PLAYWRIGHT_MODIFIER[m] ?? m), key].join("+");
}

/** The focused element's viewport box, or null when nothing but the page itself has focus. */
function focusedBoxInPage(_arg: { focused: true }): BoundingBoxLike | null {
	const el = document.activeElement;
	if (!el || el === document.body || el === document.documentElement) return null;
	const r = el.getBoundingClientRect();
	if (r.width <= 0 || r.height <= 0) return null;
	return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/**
 * CR-LENSMITH-A011-5: a web `key` step. Brings the page to the front, focuses `selector` when given,
 * then presses each chord through Playwright's keyboard. The zoom frames the focused element.
 */
async function driveWebKeyStep(
	step: Extract<Step, { type: "key" }>,
	index: number,
	deps: Required<Pick<RunDriveDeps, "page" | "now">>,
	t0: number,
	voice?: VoicePlan,
): Promise<ActionLogEntry> {
	const { page, now } = deps;
	const where = `step at index ${index} (type "key")`;
	const keyboard = page.keyboard;
	if (!keyboard) throw new DriveError(`${where}: this page has no keyboard to press keys on`);
	const chords = parseWebKeys(step.keys);
	const timeout = step.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

	await page.bringToFront();
	let box: BoundingBoxLike | null = null;
	if (step.selector !== undefined) {
		const locator = page.locator(step.selector);
		try {
			await locator.waitFor({ state: "visible", timeout });
			await locator.scrollIntoViewIfNeeded({ timeout });
			if (!locator.focus) throw new Error("this locator cannot focus");
			await locator.focus({ timeout });
			box = await locator.boundingBox({ timeout });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new DriveError(
				`${where}: selector "${step.selector}" could not be focused within ${timeout}ms — ${message}`,
			);
		}
	} else {
		box = await page.evaluate<BoundingBoxLike | null, { focused: true }>(focusedBoxInPage, {
			focused: true,
		});
	}

	const atMs = now() - t0;
	for (const chord of chords) {
		try {
			await keyboard.press(playwrightChord(chord));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new DriveError(`${where}: "${chordName(chord)}" could not be pressed — ${message}`);
		}
	}
	const settleMs = await waitForSettle(page, now);

	const entry: ActionLogEntry = {
		index,
		type: "key",
		keys: chords.map(chordName),
		atMs,
		settleMs,
	};
	if (step.selector !== undefined) entry.selector = step.selector;
	if (box) entry.boundingBox = box;
	if (step.label !== undefined) entry.label = step.label;
	if (voice) {
		entry.voiceLineId = voice.lineId;
		entry.voiceStartMs = voiceStartFor(voice, atMs, atMs);
	}
	return entry;
}

/**
 * Drives the full step list against an already-navigated page. Calibrates
 * once at the start, then per `click` step: locates,
 * computes the screen point, drives the (real or fake) choreographer's
 * `moveTo` → `dwell` → `click`, and records the step. Per `wait` step: pauses
 * and records a marker entry (see `actionLog.ts`'s header comment for why).
 *
 * Throws on the first failure (bad selector, Playwright timeout) and records
 * nothing further — the caller (`registerDriveCommand`) writes neither output
 * file unless this resolves, which is the "a failed run writes no partial
 * output" invariant satisfied structurally, not by an extra flag to forget.
 */
export async function runDrive(
	stepList: DriveStepList,
	deps: RunDriveDeps,
): Promise<RunDriveResult> {
	const now = deps.now ?? (() => performance.now());
	const sleep = deps.sleep ?? realSleep;
	const narration =
		deps.narration === undefined
			? undefined
			: validateNarration(deps.narration, stepList as StepList);
	let plan: ContinuousPlan | undefined;
	const mode =
		deps.narrationMode ?? (continuousNarrationLists.has(stepList) ? "continuous" : "settle");
	if (mode === "continuous") {
		if (narration === undefined) {
			throw new DriveError(
				"continuous narration needs the voice timings (narration) to plan against",
			);
		}
		plan = continuousPlanFor(stepList, narration);
	}

	// CR-LENSMITH-A010-6: no `url` → a native-only run: no goto, no bring-to-front, no
	// calibration; the result viewport is the capture size.
	if (stepList.url === undefined) {
		const capture = deps.native?.capture;
		const t0 = now();
		const actionLog = await runSteps(stepList, deps, {
			now,
			sleep,
			narration,
			plan,
			t0,
			offset: { x: 0, y: 0 },
			viewport: { width: capture?.width ?? 0, height: capture?.height ?? 0 },
		});
		const nativeViewport = { width: capture?.width ?? 0, height: capture?.height ?? 0 };
		return plan
			? { actionLog, viewport: nativeViewport, plan }
			: { actionLog, viewport: nativeViewport };
	}

	const navigationTimeoutMs = deps.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
	const page = deps.page;
	if (!page) throw new DriveError(`step list has a "url" but no page was given to drive it`);

	// `context.setDefaultNavigationTimeout` (set once in
	// `withLaunchedChrome`) bounds this already; passed explicitly here too so
	// a fault-injection test can exercise a short bound directly, and so the
	// failure message below can name the bound rather than assume it.
	try {
		await page.goto(stepList.url, { waitUntil: "load", timeout: navigationTimeoutMs });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new DriveError(
			`could not navigate to "${stepList.url}" within ${navigationTimeoutMs}ms — ${message}`,
		);
	}
	const t0 = now();

	// OS-level "did the window actually win the foreground" is not verifiable
	// headless or against a fake page — it can only be confirmed by an
	// announced, attended run on a real machine, not assumed here. The call
	// itself always happens.
	await page.bringToFront();

	const offset = await calibrateOffset(page);
	console.error(`drive: calibrated window offset x=${offset.x} y=${offset.y}`);

	const viewport = await page.evaluate<ViewportSize, undefined>(
		() => ({ width: window.innerWidth, height: window.innerHeight }),
		undefined,
	);

	// A target UI can hide elements behind a responsive breakpoint (for
	// example a sidebar that is `hidden lg:flex`, invisible below Tailwind's
	// 1024px `lg` breakpoint),
	// and `drive` always launches with `viewport: null` (the real OS window
	// size) — so a narrow window silently turns into a generic 30s `waitFor`
	// timeout on whichever step needs that element, with nothing pointing at
	// the real cause. Checked ONCE here, before any step runs (the whole run
	// shares one window, not a per-step concern), so a too-narrow window
	// fails immediately and by name instead of via Playwright's own timeout.
	if (stepList.minViewportWidth !== undefined && viewport.width < stepList.minViewportWidth) {
		throw new DriveError(
			`driven window is ${viewport.width}px wide, narrower than this step list's required ` +
				`minimum of ${stepList.minViewportWidth}px. Below that width the target UI may hide ` +
				`elements behind a responsive breakpoint (display:none), which would otherwise fail as ` +
				`Playwright's generic 30s "waitFor" timeout on some later step instead of this specific ` +
				"reason. Resize the browser window wider and retry.",
		);
	}

	const actionLog = await runSteps(stepList, deps, {
		now,
		sleep,
		narration,
		plan,
		t0,
		offset,
		viewport,
	});
	return plan ? { actionLog, viewport, plan } : { actionLog, viewport };
}

/** Moves a web step's viewport box into capture space (screen = viewport + calibration offset). */
function webBoxToCapture(
	entry: ActionLogEntry,
	offset: PointLike,
	capture: CaptureRegion | undefined,
): ActionLogEntry {
	if (!capture) return entry;
	if (entry.type !== "click" && entry.type !== "type" && entry.type !== "key") return entry;
	const b = entry.boundingBox;
	if (!b) return entry;
	entry.boundingBox = toCaptureSpace(
		{ x: b.x + offset.x, y: b.y + offset.y, width: b.width, height: b.height },
		capture,
	);
	return entry;
}

/** The step loop shared by web and native runs (CR-LENSMITH-A010-6 split it out of `runDrive`). */
async function runSteps(
	stepList: DriveStepList,
	deps: RunDriveDeps,
	run: {
		now: () => number;
		sleep: (ms: number) => Promise<void>;
		narration: NarrationTimings | undefined;
		plan?: ContinuousPlan | undefined;
		t0: number;
		offset: PointLike;
		viewport: ViewportSize;
	},
): Promise<ActionLogEntry[]> {
	const { now, sleep, narration, plan, t0, offset, viewport } = run;
	const { choreographer } = deps;
	const actionLog: ActionLogEntry[] = [];
	let lastPoint: PointLike | undefined;
	// Continuous mode: how far the run has fallen behind the plan (a settle that outlasted the
	// planned busy time). Every later planned time shifts by it, so marks keep landing on clicks.
	let driftMs = 0;

	for (let index = 0; index < stepList.steps.length; index += 1) {
		const step = stepList.steps[index];
		if (!step) continue; // unreachable — steps.length bounds the loop; satisfies noUncheckedIndexedAccess

		let voice = voicePlanFor(step, index, narration);
		const planned = plan?.steps[index];
		if (plan && planned && voice) {
			// Wait for this step's moment in the plan: the travel start, or the line start for a wait
			// and for a web key step (no cursor travel: it presses on the mark).
			const webKey = step.type === "key" && !isNativeStep(step);
			const webWait = step.type === "wait" && !isNativeStep(step);
			const plannedAtMs =
				step.type === "wait"
					? planned.lineStartMs
					: webKey
						? (planned.actionMs ?? planned.lineStartMs)
						: (planned.travelStartMs ?? planned.lineStartMs);
			const behindMs = now() - t0 - (plannedAtMs + driftMs);
			if (behindMs > 0) driftMs += behindMs;
			else await sleep(-behindMs);
			const lineStartMs = planned.lineStartMs + driftMs;
			if (webWait && "ms" in step) {
				// A narrated web wait is just its line: the next step waits for its own planned moment.
				const entry: ActionLogEntry = {
					index,
					type: "wait",
					atMs: now() - t0,
					ms: step.ms,
					voiceLineId: voice.lineId,
					voiceStartMs: lineStartMs,
				};
				actionLog.push(entry);
				continue;
			}
			// The click functions extend the dwell so the action lands `markMs` after the travel starts:
			// here that is the planned action time, measured from now (always >= travel + dwell).
			if (planned.actionMs !== undefined && !webKey) {
				voice = { ...voice, markMs: planned.actionMs + driftMs - (now() - t0) };
			}
		}

		if (isNativeStep(step)) {
			const native = deps.native;
			if (!native) {
				throw new DriveError(
					`step at index ${index} (type "${step.type}", app "${step.app}") is a native step, ` +
						"but this run has no native driver",
				);
			}
			const entry = await driveNativeStep(
				step,
				index,
				{
					driver: native.driver,
					choreographer,
					now,
					sleep,
					execFile: deps.execFile,
					activate: native.activate,
				},
				{
					pids: native.pids,
					capture: native.capture ?? { x: 0, y: 0, width: 0, height: 0 },
					t0,
					lastPoint,
					voice,
				},
			);
			actionLog.push(entry);
			if (entry.type === "wait") continue;
		} else {
			const page = deps.page;
			if (!page) {
				throw new DriveError(
					`step at index ${index} (type "${step.type}") is a web step, but this run has no page`,
				);
			}
			if (step.type === "wait") {
				const atMs = now() - t0;
				// A narrated wait lasts max(ms, voice + tail); its line starts with the wait.
				await sleep(voice ? Math.max(step.ms, voice.durationMs + NARRATION_TAIL_MS) : step.ms);
				const entry: ActionLogEntry = { index, type: "wait", atMs, ms: step.ms };
				if (voice) {
					entry.voiceLineId = voice.lineId;
					entry.voiceStartMs = atMs;
				}
				actionLog.push(entry);
				continue;
			}

			if (step.type === "key") {
				actionLog.push(
					webBoxToCapture(
						await driveWebKeyStep(step, index, { page, now }, t0, voice),
						offset,
						deps.native?.capture,
					),
				);
			} else if (step.type === "type") {
				actionLog.push(
					webBoxToCapture(
						await driveTypeStep(
							step,
							index,
							{ page, choreographer, now, execFile: deps.execFile },
							offset,
							viewport,
							t0,
							lastPoint,
							voice,
						),
						offset,
						deps.native?.capture,
					),
				);
			} else {
				actionLog.push(
					webBoxToCapture(
						await driveClickStep(
							step,
							index,
							{ page, choreographer, now },
							offset,
							viewport,
							t0,
							lastPoint,
							voice,
						),
						offset,
						deps.native?.capture,
					),
				);
			}
		}

		// Settle pacing: hold the result at full zoom, then zoom out and breathe at 1x before the next
		// step (no breath after the last step: nothing follows it).
		const driven = actionLog[actionLog.length - 1];
		if (driven && "screenX" in driven) lastPoint = { x: driven.screenX, y: driven.screenY };
		if (plan && planned) {
			// Continuous: the voice starts are the plan's line starts; no hold, no breath — the next
			// step waits for its own planned moment (Settle LOCK v1.1).
			if (driven) {
				driven.voiceLineId = narrationLineId(index);
				driven.voiceStartMs = planned.lineStartMs + driftMs;
			}
			continue;
		}
		// Narrated: hold until max(settle + result hold, voice end + tail) — the camera never zooms out
		// over the voice (pacing LOCK, CR-LENSMITH-A008-2).
		let holdMs: number = SETTLE_PACING.resultHoldMs;
		if (voice && driven && driven.type !== "wait" && driven.voiceStartMs !== undefined) {
			const voiceTailEndMs = driven.voiceStartMs + voice.durationMs + NARRATION_TAIL_MS;
			holdMs = Math.max(holdMs, voiceTailEndMs - (now() - t0));
		}
		await sleep(holdMs);
		// Whether this step's region connects to the next is not known here (the next target is
		// not resolved, and its box can move when it scrolls into view), so assume NOT connected:
		// the full zoom-out + breath. A connected pair therefore gets the longer pause.
		if (index < stepList.steps.length - 1) await sleep(pauseBeforeNextStepMs(false));
	}

	// Continuous: hold after the last word (payoff), then the film ends.
	if (plan) {
		const remainingMs = plan.endMs + driftMs - (now() - t0);
		if (remainingMs > 0) await sleep(remainingMs);
	}
	return actionLog;
}

/**
 * CR-LENSMITH-A011-6, continuous mode: each zoom region starts with its travel and ends when the
 * next action's travel starts (the zoom-out may run under the voice, `underVoice: true`, a field
 * the engine ignores); the last region ends at the film's end (`endMs`, the payoff hold).
 */
export function continuousZoomFragment(
	fragment: ZoomFragment,
	actionLog: readonly ActionLogEntry[],
	endMs: number,
): ZoomFragment {
	const travelStartOf = (region: ZoomRegion): number => {
		const entry = actionLog.find((e) => `zoom-${e.index}` === region.id);
		if (!entry) return region.startMs;
		return logMsToFilmMs("startedAtMs" in entry ? entry.startedAtMs : entry.atMs);
	};
	const starts = fragment.zoomRegions.map(travelStartOf);
	return {
		zoomRegions: fragment.zoomRegions.map((region, i) => {
			const startMs = starts[i] ?? region.startMs;
			const nextStartMs = starts[i + 1];
			return {
				...region,
				startMs,
				endMs: Math.max(startMs, nextStartMs ?? logMsToFilmMs(endMs)),
				underVoice: true,
			};
		}),
	};
}

const EXCLUSIVE_MACHINE_NOTICE =
	"Driving a real browser and posting real input events — the browser window will come to the " +
	"front and events go to whatever window is under the cursor. Do not touch the machine.";

function reportDriveFailure(error: unknown): void {
	if (
		error instanceof DriveError ||
		error instanceof StepListError ||
		error instanceof CursorChoreographerError ||
		error instanceof NativeHelperMissingError ||
		error instanceof CalibrationError ||
		error instanceof KeychainTextError
	) {
		console.error(`drive: ${error.message}`);
	} else {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`drive: ${message}`);
	}
	// Not `process.exit()`: this command holds a browser and a choreographer
	// subprocess open, and both need their `finally`-block cleanup to run
	// before the process actually exits. `process.exit()` from inside a catch
	// would terminate before that cleanup executes.
	process.exitCode = 1;
}

export interface KeepOpenDeps {
	/** Prints the access-instructions line. Production: `console.log`. */
	log: (message: string) => void;
	/**
	 * Registers a ONE-SHOT interrupt callback; production:
	 * `(cb) => process.once("SIGINT", cb)`. Injectable so tests can trigger
	 * the same code path deterministically, without sending a real OS signal.
	 */
	onInterrupt: (callback: () => void) => void;
}

/**
 * After the step sequence completes,
 * hold the run open — don't close the browser or exit — until the operator
 * sends SIGINT, printing how to reach the driven page first.
 *
 * Without this, `drive`'s own per-click effect could not be observed within a
 * single run: the browser closes before the driven page's client-side click
 * log can be read. With the browser (and this promise) still alive, a SEPARATE
 * process or a devtools session opened on the still-visible window can read
 * the driven page's own client-side log (e.g. `window.__lensmithClickLog`,
 * the pattern `tests/fixtures/drive-test-page.html` uses) while `drive` is
 * still running — not only after it already exited.
 *
 * Deliberately NOT `process.exit()` here either: resolving (rather than
 * exiting) lets `registerDriveCommand`'s own `finally` block run its
 * choreographer/page/browser cleanup exactly once, in exactly one place,
 * regardless of whether `--keep-open` was set.
 */
export function holdOpen(pageUrl: string, deps: KeepOpenDeps): Promise<void> {
	return new Promise((resolve) => {
		deps.log(
			`drive: --keep-open set — holding the run open. The driven page is at ${pageUrl}; its ` +
				"client-side click log (if the page defines one) can be read from a separate process or " +
				"a devtools session on the still-open window while this run keeps waiting here. Press " +
				"Ctrl+C (SIGINT) to close and exit.",
		);
		deps.onInterrupt(() => resolve());
	});
}

export function registerDriveCommand(program: Command): void {
	program
		.command("drive")
		.description(
			"drive a running app via Playwright + the real cursor, emitting an action log and a zoom-regions fragment",
		)
		.requiredOption("--steps <path>", "path to the step-list JSON ({ url, steps: [...] })")
		.requiredOption("--out <path>", "path to write the action log JSON")
		.requiredOption("--zooms <path>", "path to write the zoom-regions fragment JSON")
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
			"--narration <path>",
			"timings.json from `lensmith narrate`: each step with a `say` line is timed to line s<index> (s0, s1, …)",
		)
		.option(
			"--keep-open",
			"after the run completes, hold the page open (and its click log readable) until SIGINT",
		)
		.addHelpText(
			"after",
			"\nOne-time warm-up: this command never creates or signs into a profile. Before the first " +
				"real run, a human opens the profile directory in a real Chrome session once and clears " +
				"whatever the target app's own sign-in/bot check needs cleared:\n\n" +
				'  open -na "Google Chrome" --args --user-data-dir="<profile-dir>"\n\n' +
				"Sign in normally, then quit that Chrome window. Every later `drive`/`demo` run against " +
				"the same --profile-dir reuses the cleared, signed-in profile.",
		)
		.action(
			async (opts: {
				steps: string;
				out: string;
				zooms: string;
				keepOpen?: boolean;
				profileDir: string;
				browserChannel: string;
				narration?: string;
			}) => {
				let stepList: DriveStepList;
				let narration: NarrationTimings | undefined;
				try {
					const raw = readFileSync(opts.steps, "utf-8");
					stepList = readDriveStepList(raw, opts.steps);
					if (narrationModeFrom(raw) === "continuous") {
						validateContinuousSteps(stepList);
						if (opts.narration === undefined) {
							throw new DriveError(
								`"${opts.steps}" asks for continuous narration but no --narration timings were given`,
							);
						}
						continuousNarrationLists.add(stepList);
					}
					if (stepList.url === undefined) {
						throw new DriveError(
							`"${opts.steps}" has no "url", so it is a native step list; native lists run ` +
								"through `lensmith-director demo`, not `drive`",
						);
					}
					if (opts.narration !== undefined) {
						narration = readNarrationTimings(
							readFileSync(opts.narration, "utf-8"),
							opts.narration,
							stepList as StepList,
						);
					}
				} catch (error) {
					reportDriveFailure(error);
					return;
				}

				console.error(EXCLUSIVE_MACHINE_NOTICE);

				// headless: false is unconditional — a real OS
				// window for OS-level cursor events to land on; there is no headless
				// mode for a real run of this command.
				try {
					await withLaunchedChrome(
						{ profileDir: opts.profileDir, browserChannel: opts.browserChannel, activate: true },
						async (ctx, choreographer) => {
							const page = await acquirePage(ctx);
							try {
								await choreographer.start();
								const { actionLog, viewport, plan } = await runDrive(stepList, {
									page,
									choreographer,
									narration,
								});
								const emitted = emitZoomRegions(actionLog, viewport);
								const { warnings } = emitted;
								const fragment = plan
									? continuousZoomFragment(emitted.fragment, actionLog, plan.endMs)
									: emitted.fragment;
								for (const warning of warnings) console.error(`warning: ${warning}`);

								writeFileSync(opts.out, `${JSON.stringify(actionLog, null, 2)}\n`, "utf-8");
								writeFileSync(opts.zooms, `${JSON.stringify(fragment, null, 2)}\n`, "utf-8");
								console.log(
									`drive: wrote ${opts.out} (${actionLog.length} action(s)) and ${opts.zooms} ` +
										`(${fragment.zoomRegions.length} zoom region(s))`,
								);

								if (opts.keepOpen === true) {
									await holdOpen(page.url(), {
										log: console.log,
										onInterrupt: (callback) => process.once("SIGINT", callback),
									});
								}
							} finally {
								choreographer.stop();
							}
						},
					);
				} catch (error) {
					reportDriveFailure(error);
				}
			},
		);
}

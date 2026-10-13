import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	BoundingBoxLike,
	ChoreographerLike,
	LaunchPersistentContext,
	LocatorLike,
	MoveResultLike,
	PageLike,
	PersistentContextLike,
	PointLike,
} from "../src/commands/drive.js";
import {
	acquirePage,
	activateDrivenChrome,
	DEFAULT_ACTION_TIMEOUT_MS,
	DEFAULT_NAVIGATION_TIMEOUT_MS,
	DRIVEN_WINDOW,
	DRIVEN_WINDOW_ARGS,
	DriveError,
	defaultProfileDir,
	discoverDrivenWindowId,
	holdOpen,
	launchChrome,
	narrationDwell,
	pinWindowBounds,
	playwrightChord,
	readNarrationTimings,
	runDrive as runDriveReal,
	withChromeContext,
	withLaunchedChrome,
} from "../src/commands/drive.js";
import { TargetOutOfBoundsError } from "../src/lib/calibration.js";
import { CursorChoreographer, CursorDeliveryError } from "../src/lib/cursorChoreographer.js";
import type { ExecFileFn } from "../src/lib/keychainText.js";
import type { StepList } from "../src/lib/stepList.js";
import { emitZoomRegions } from "../src/lib/zoomEmission.js";

// These tests drive `runDrive` — the orchestration `drive`'s CLI action calls
// — against a FAKE `PageLike` (plain JS, no real browser, no Playwright).
// Most cases use a lightweight in-memory `fakeChoreographer` (instant, no
// real delay); one dedicated test additionally exercises a REAL
// `CursorChoreographer` backed by a FAKE helper subprocess that speaks the
// same NDJSON protocol as the Swift binary but posts ZERO real input events
// (the same discipline as `tests/cursorChoreographer.test.ts`), to prove the
// `ChoreographerLike` interface `drive.ts` depends on is genuinely satisfied
// by the class production code constructs. This machine's real OS cursor is
// never touched by this file, and no browser window is ever opened — see the
// CR-LENSMITH-A002-2 forge report for why the automated suite stops there and
// defers the real-browser, real-cursor run to an announced machine window.

// The Settle pacing (CR-LENSMITH-A007-2) sleeps 1200 + 800 ms after every step; tests that do
// not inject their own `sleep` get an instant one so the suite does not spend real seconds.
const runDrive: typeof runDriveReal = (list, deps) =>
	runDriveReal(list, { sleep: noSleep, ...deps });

const FAKE_HELPER = `#!/usr/bin/env node
"use strict";
let x = 0;
let y = 0;
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    switch (message.cmd) {
      case "position": send({ type: "ok", cmd: "position", x, y }); break;
      case "warm": send({ type: "ok", cmd: "warm", warm: true }); break;
      case "move": {
        const fromX = x, fromY = y;
        x = message.x; y = message.y;
        send({ type: "ok", cmd: "move", steps: 60, elapsedMs: message.durationMs, fromX, fromY, x, y });
        break;
      }
      case "click": send({ type: "ok", cmd: "click", x, y }); break;
      case "quit": send({ type: "ok", cmd: "quit" }); process.exit(0); break;
      default: send({ type: "error", cmd: message.cmd, message: "unknown command" });
    }
  }
});
`;

interface FakePageOptions {
	elements: Record<string, BoundingBoxLike>;
	viewport: { width: number; height: number };
	windowOffset: { x: number; y: number };
	/**
	 * Optional per-selector override: the bounding box BEFORE
	 * `scrollIntoViewIfNeeded` has been called for that selector vs AFTER.
	 * Selectors not listed here just return `elements[selector]`
	 * unconditionally — "already in view, scrolling changes nothing" — which
	 * is every pre-CR-LENSMITH-A002-4 test's behavior, unchanged.
	 * [[CR-LENSMITH-A002-4]] Technical Spec item 1.
	 */
	scrollBehavior?: Record<string, { before: BoundingBoxLike; after: BoundingBoxLike }>;
	/** Called once per `scrollIntoViewIfNeeded()` invocation, with the selector — lets a test assert call count/order. */
	onScrollIntoView?: (selector: string) => void;
	/**
	 * Called once per `pressSequentially()` invocation, with the selector, the
	 * text, and the delay option — lets a `type`-step test assert `runDrive`
	 * wired the right selector/delay through WITHOUT the fake itself being the
	 * thing that proves the text never reaches a file (that is the E2E grep,
	 * not this fake).
	 */
	onType?: (selector: string, text: string, delayMs: number | undefined) => void;
	/** A selector whose `pressSequentially()` call rejects, simulating a field that refuses input. */
	typeFailureSelectors?: Set<string>;
	url?: string;
}

/** No real browser, no Playwright — a plain object satisfying `PageLike` structurally. */
function fakePage(options: FakePageOptions): PageLike {
	let calibrationMeasurement: { screenX: number; screenY: number } | null = null;

	return {
		async goto() {
			return null;
		},
		async bringToFront() {
			// no-op — this fake has no real window to bring forward
		},
		url() {
			return options.url ?? "http://localhost:4173/drive-test-page.html";
		},
		locator(selector: string): LocatorLike {
			let scrolled = false;
			return {
				async waitFor() {
					if (!(selector in options.elements) && !options.scrollBehavior?.[selector]) {
						throw new Error(
							`locator.waitFor: Timeout 30000ms exceeded waiting for locator("${selector}") to be visible`,
						);
					}
				},
				async scrollIntoViewIfNeeded() {
					options.onScrollIntoView?.(selector);
					scrolled = true;
				},
				async boundingBox() {
					const behavior = options.scrollBehavior?.[selector];
					if (behavior) {
						return scrolled ? behavior.after : behavior.before;
					}
					return options.elements[selector] ?? null;
				},
				async pressSequentially(text: string, opts?: { delay?: number }) {
					if (options.typeFailureSelectors?.has(selector)) {
						throw new Error(`locator.pressSequentially: element for "${selector}" is not editable`);
					}
					options.onType?.(selector, text, opts?.delay);
				},
			};
		},
		mouse: {
			async click(x: number, y: number) {
				calibrationMeasurement = {
					screenX: x + options.windowOffset.x,
					screenY: y + options.windowOffset.y,
				};
			},
		},
		async evaluate<T, Arg>(_fn: (arg: Arg) => T, arg: Arg): Promise<T> {
			if (arg === undefined) {
				// The viewport-size read: `page.evaluate(() => ({width, height}), undefined)`.
				return { width: options.viewport.width, height: options.viewport.height } as unknown as T;
			}
			const asArg = arg as unknown as { x?: unknown; y?: unknown };
			if (typeof asArg.x === "number" && typeof asArg.y === "number") {
				return undefined as T; // calibration "inject" call
			}
			return calibrationMeasurement as unknown as T; // calibration "read" call
		},
	};
}

/** In-memory, instant — no real subprocess, no real delay. Used where interop with the real class is not the point. */
function fakeChoreographer(): ChoreographerLike {
	let position: PointLike = { x: 0, y: 0 };
	return {
		async start() {
			// no-op — no real subprocess to spawn
		},
		stop() {
			// no-op — nothing to tear down
		},
		async moveTo(x: number, y: number): Promise<MoveResultLike> {
			position = { x, y };
			return { elapsedMs: 0, to: { x, y } };
		},
		async dwell() {
			// no-op — instant, no real hold-still delay
		},
		async click(): Promise<PointLike> {
			return position;
		},
	};
}

/**
 * Like {@link fakeChoreographer}, but `click()` reports a position OFFSET
 * from wherever `moveTo()` was last told to go — simulating [[BF-2]]'s
 * measured failure (the OS-reported achieved position differing from the
 * requested one) at the `ChoreographerLike` interface level, independent of
 * `cursorChoreographer.ts`'s own divergence-throwing (tested separately in
 * `cursorChoreographer.test.ts`). Used to prove `runDrive`'s WIRING: does the
 * action log record what `click()` actually returned, or the computed
 * target `driveClickStep` sent to `moveTo()`? [[CR-LENSMITH-A002-3]]
 * Technical Spec item 2 / Invariant 3.
 */
function driftingFakeChoreographer(offset: PointLike): ChoreographerLike {
	let lastMoveTarget: PointLike = { x: 0, y: 0 };
	return {
		async start() {
			// no-op — no real subprocess to spawn
		},
		stop() {
			// no-op — nothing to tear down
		},
		async moveTo(x: number, y: number): Promise<MoveResultLike> {
			lastMoveTarget = { x, y };
			return { elapsedMs: 0, to: { x, y } };
		},
		async dwell() {
			// no-op — instant, no real hold-still delay
		},
		async click(): Promise<PointLike> {
			return { x: lastMoveTarget.x + offset.x, y: lastMoveTarget.y + offset.y };
		},
	};
}

function stepList(steps: StepList["steps"], minViewportWidth?: number): StepList {
	const result: StepList = { url: "http://localhost:4173/drive-test-page.html", steps };
	if (minViewportWidth !== undefined) result.minViewportWidth = minViewportWidth;
	return result;
}

/**
 * BF-8 / CR-LENSMITH-A002-13 — a locator whose target element genuinely
 * never appears, reproducing Playwright's OWN real contract for a bounded
 * actionability wait: the underlying condition (visibility) never becomes
 * true, but the call rejects once ITS OWN `timeout` option elapses — the
 * same way the real `Locator.waitFor` does. `options.timeout` absent or
 * non-positive reproduces this CR's exact pre-fix defect (no bound was ever
 * passed to `waitFor`) by never settling at all, matching Playwright's own
 * installed default ("Defaults to `0` - no timeout").
 */
function hangingWaitForLocator(selector: string): LocatorLike {
	return {
		waitFor(options?: { timeout?: number }) {
			return new Promise<void>((_resolve, reject) => {
				if (options?.timeout === undefined || options.timeout <= 0) return; // never settles
				setTimeout(() => {
					reject(
						new Error(
							`locator.waitFor: Timeout ${options.timeout}ms exceeded waiting for locator("${selector}") to be visible`,
						),
					);
				}, options.timeout);
			});
		},
		async scrollIntoViewIfNeeded() {
			throw new Error(
				"scrollIntoViewIfNeeded must never be called — the preceding waitFor should have failed first",
			);
		},
		async boundingBox() {
			throw new Error(
				"boundingBox must never be called — the preceding waitFor should have failed first",
			);
		},
		async pressSequentially() {
			throw new Error(
				"pressSequentially must never be called — the preceding waitFor should have failed first",
			);
		},
	};
}

/** A `PageLike` whose every `locator()` call returns the same fixed fake — used with {@link hangingWaitForLocator}. */
function pageWithLocator(
	locator: LocatorLike,
	url = "http://localhost:4173/drive-test-page.html",
): PageLike {
	return {
		async goto() {
			return null;
		},
		async bringToFront() {
			// no-op — this fake has no real window to bring forward
		},
		url: () => url,
		locator: () => locator,
		mouse: {
			async click() {
				// no-op — never reached in the tests this fake serves
			},
		},
		async evaluate<T, Arg>(_fn: (arg: Arg) => T, arg: Arg): Promise<T> {
			if (arg === undefined) {
				return { width: 1280, height: 800 } as unknown as T;
			}
			const asArg = arg as unknown as { x?: unknown; y?: unknown };
			if (typeof asArg.x === "number" && typeof asArg.y === "number") {
				return undefined as T;
			}
			return { screenX: 10, screenY: 10 } as unknown as T;
		},
	};
}

/**
 * BF-8 / CR-LENSMITH-A002-13 — a page whose navigation never reaches `load`,
 * reproducing Playwright's own bounded-navigation contract the same way
 * {@link hangingWaitForLocator} reproduces the bounded-action one: rejects
 * once its own `timeout` option elapses, never otherwise.
 */
function pageWithHangingGoto(url = "http://localhost:4173/drive-test-page.html"): PageLike {
	return {
		goto(_url: string, options?: { timeout?: number }) {
			return new Promise<unknown>((_resolve, reject) => {
				if (options?.timeout === undefined || options.timeout <= 0) return; // never settles
				setTimeout(() => {
					reject(new Error(`page.goto: Timeout ${options.timeout}ms exceeded.`));
				}, options.timeout);
			});
		},
		async bringToFront() {
			throw new Error("bringToFront must never be called — goto should have failed first");
		},
		url: () => url,
		locator() {
			throw new Error("locator must never be called — goto should have failed first");
		},
		mouse: {
			async click() {
				throw new Error("mouse.click must never be called — goto should have failed first");
			},
		},
		async evaluate() {
			throw new Error("evaluate must never be called — goto should have failed first");
		},
	} as unknown as PageLike;
}

/** Skips a `wait` step's real delay — deterministic, fast tests. */
async function noSleep(_ms: number): Promise<void> {
	return undefined;
}

describe("runDrive: Settle pacing (CR-LENSMITH-A007-2)", () => {
	it("travel by distance, dwell 700, then settle, hold 1200 and pause 1500 (zoom-out + breath) between steps (no pause after the last)", async () => {
		const page = fakePage({
			elements: {
				"#a": { x: 100, y: 100, width: 100, height: 100 }, // centre 150,150
				"#b": { x: 750, y: 100, width: 100, height: 100 }, // centre 800,150: 650 pt from #a
			},
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});
		const calls: string[] = [];
		const base = fakeChoreographer();
		const choreographer: ChoreographerLike = {
			...base,
			async moveTo(x, y, durationMs) {
				calls.push(`move:${durationMs}`);
				return base.moveTo(x, y, durationMs);
			},
			async dwell(ms) {
				calls.push(`dwell:${ms}`);
			},
		};
		const sleeps: number[] = [];
		const { actionLog } = await runDriveReal(
			stepList([
				{ type: "click", selector: "#a" },
				{ type: "click", selector: "#b" },
			]),
			{
				page,
				choreographer,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			},
		);
		// First step has no known origin: the longest travel. Second: clamp(300 + 0.4 x 650) = 560.
		expect(calls).toEqual(["move:700", "dwell:700", "move:560", "dwell:700"]);
		expect(sleeps).toEqual([1200, 1500, 1200]);
		for (const entry of actionLog) {
			if (entry.type === "wait") throw new Error("unexpected wait entry");
			expect(typeof entry.settleMs).toBe("number");
		}
	});

	it("BF-11: in a three-click run the sleep after the result hold is 1500, no zoom-in is shifted by the 800 ms floor, and each zoom-in ends before its click", async () => {
		const boxes = {
			"#a": { x: 100, y: 100, width: 100, height: 60 },
			"#b": { x: 1000, y: 600, width: 100, height: 60 },
			"#c": { x: 150, y: 650, width: 100, height: 60 },
		};
		const base = fakePage({
			elements: boxes,
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});
		// A virtual clock: sleeps, cursor travel, dwell and a 450 ms result all advance it.
		let clock = 0;
		const sleeps: number[] = [];
		const page: PageLike = {
			...base,
			async evaluate<T, Arg>(fn: (arg: Arg) => T, arg: Arg): Promise<T> {
				if (arg && typeof arg === "object" && "quietMs" in arg) clock += 450;
				return base.evaluate(fn, arg);
			},
		};
		const inner = fakeChoreographer();
		const choreographer: ChoreographerLike = {
			...inner,
			async moveTo(x, y, durationMs) {
				clock += durationMs ?? 0;
				return inner.moveTo(x, y, durationMs);
			},
			async dwell(ms) {
				clock += ms ?? 0;
			},
		};
		const { actionLog, viewport } = await runDriveReal(
			stepList([
				{ type: "click", selector: "#a" },
				{ type: "click", selector: "#b" },
				{ type: "click", selector: "#c" },
			]),
			{
				page,
				choreographer,
				now: () => clock,
				sleep: async (ms) => {
					sleeps.push(ms);
					clock += ms;
				},
			},
		);
		expect(sleeps).toEqual([1200, 1500, 1200, 1500, 1200]);

		const { fragment } = emitZoomRegions(actionLog, viewport);
		expect(fragment.zoomRegions.every((r) => !r.connect)).toBe(true);
		for (const [i, region] of fragment.zoomRegions.entries()) {
			const entry = actionLog[i];
			if (entry?.type !== "click") throw new Error("expected a click entry");
			expect(region.startMs).toBe(entry.startedAtMs); // not shifted by the floor
			expect(region.startMs + 900).toBeLessThanOrEqual(entry.clickedAtMs); // zoom-in done before the click
		}
	});

	it("records settleMs on a type entry and still never records the typed text", async () => {
		const page = fakePage({
			elements: { "#f": { x: 10, y: 10, width: 100, height: 40 } },
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});
		const { actionLog } = await runDrive(
			stepList([{ type: "type", selector: "#f", text: "secret-value" }]),
			{ page, choreographer: fakeChoreographer() },
		);
		const [entry] = actionLog;
		if (entry?.type !== "type") throw new Error("expected a type entry");
		expect(typeof entry.settleMs).toBe("number");
		expect(JSON.stringify(actionLog)).not.toContain("secret-value");
	});
});

describe("runDrive (fake page + in-memory fake choreographer — no real browser, no OS events)", () => {
	it("drives a 2-click sequence with a wait between, recording plausible coordinates and monotonic timestamps", async () => {
		const page = fakePage({
			elements: {
				"#btn-one": { x: 120, y: 160, width: 160, height: 56 },
				"#btn-two": { x: 520, y: 360, width: 160, height: 56 },
			},
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 50, y: 80 },
		});

		const { actionLog, viewport } = await runDrive(
			stepList([
				{ type: "click", selector: "#btn-one", label: "click button one" },
				{ type: "wait", ms: 500 },
				{ type: "click", selector: "#btn-two", label: "click button two" },
			]),
			{ page, choreographer: fakeChoreographer(), sleep: noSleep },
		);

		expect(viewport).toEqual({ width: 1280, height: 800 });
		expect(actionLog).toHaveLength(3);

		const [first, wait, second] = actionLog;
		if (first?.type !== "click" || second?.type !== "click" || wait?.type !== "wait") {
			throw new Error(
				`unexpected action-log entry types: ${actionLog.map((e) => e.type).join(",")}`,
			);
		}

		// screenX/screenY: offset (50,80) + bbox center. #btn-one center = (200, 188).
		expect(first.screenX).toBe(50 + 120 + 80);
		expect(first.screenY).toBe(80 + 160 + 28);
		expect(first.selector).toBe("#btn-one");
		expect(first.label).toBe("click button one");
		expect(first.index).toBe(0);

		expect(second.screenX).toBe(50 + 520 + 80);
		expect(second.screenY).toBe(80 + 360 + 28);
		expect(second.index).toBe(2);

		// Monotonically increasing timestamps across the whole run.
		expect(first.startedAtMs).toBeLessThanOrEqual(first.clickedAtMs);
		expect(first.clickedAtMs).toBeLessThanOrEqual(wait.atMs);
		expect(wait.atMs).toBeLessThanOrEqual(second.startedAtMs);
		expect(second.startedAtMs).toBeLessThanOrEqual(second.clickedAtMs);

		// The wait step never appears as a choreographed move (no screenX/screenY on it).
		expect(Object.hasOwn(wait, "screenX")).toBe(false);
	});

	it("throws a clear error naming the selector and step index when a selector is not found — and never returns a partial result", async () => {
		const page = fakePage({
			elements: { "#exists": { x: 0, y: 0, width: 10, height: 10 } },
			viewport: { width: 1000, height: 1000 },
			windowOffset: { x: 0, y: 0 },
		});

		const promise = runDrive(
			stepList([
				{ type: "click", selector: "#exists" },
				{ type: "click", selector: "#this-does-not-exist" },
			]),
			{ page, choreographer: fakeChoreographer() },
		);

		await expect(promise).rejects.toThrow(DriveError);
		await expect(promise).rejects.toThrow(/index 1/);
		await expect(promise).rejects.toThrow(/#this-does-not-exist/);
		// `runDrive` rejecting (rather than resolving with a partial action log)
		// is exactly what lets the CLI action's write calls stay unreached —
		// see `registerDriveCommand` in `drive.ts`: both `writeFileSync` calls
		// are only reachable after `await runDrive(...)` resolves.
	});

	it("records a wait step as a marker entry with no choreographed move", async () => {
		const page = fakePage({
			elements: {},
			viewport: { width: 500, height: 500 },
			windowOffset: { x: 0, y: 0 },
		});

		const { actionLog } = await runDrive(stepList([{ type: "wait", ms: 42 }]), {
			page,
			choreographer: fakeChoreographer(),
			sleep: noSleep,
		});

		expect(actionLog).toEqual([{ index: 0, type: "wait", atMs: expect.any(Number), ms: 42 }]);
	});

	it("computes the viewport once from the page, independent of step count", async () => {
		const page = fakePage({
			elements: { "#a": { x: 0, y: 0, width: 10, height: 10 } },
			viewport: { width: 640, height: 480 },
			windowOffset: { x: 0, y: 0 },
		});

		const { viewport } = await runDrive(stepList([{ type: "click", selector: "#a" }]), {
			page,
			choreographer: fakeChoreographer(),
		});

		expect(viewport).toEqual({ width: 640, height: 480 });
	});

	it("records the ACHIEVED click position in the action log, not the computed/requested target ([[BF-2]] / CR-LENSMITH-A002-3 Technical Spec item 2, Invariant 3)", async () => {
		const page = fakePage({
			elements: { "#btn-one": { x: 120, y: 160, width: 160, height: 56 } },
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 50, y: 80 },
		});

		// #btn-one center with offset (50,80): target = (50+120+80, 80+160+28) = (250, 268).
		const computedTarget = { x: 50 + 120 + 80, y: 80 + 160 + 28 };
		const DRIFT = { x: 7, y: -3 };

		const { actionLog } = await runDrive(stepList([{ type: "click", selector: "#btn-one" }]), {
			page,
			choreographer: driftingFakeChoreographer(DRIFT),
		});

		// Written to a real file and read back — "proven by reading the
		// written JSON, not by asserting the code 'should' do it" (the CR's
		// own Invariant wording), the same shape `registerDriveCommand`'s
		// `writeFileSync(opts.out, JSON.stringify(actionLog, ...))` produces.
		const outPath = path.join(
			mkdtempSync(path.join(tmpdir(), "lensmith-director-drive-log-")),
			"log.json",
		);
		writeFileSync(outPath, `${JSON.stringify(actionLog, null, 2)}\n`, "utf-8");
		const written = JSON.parse(readFileSync(outPath, "utf-8")) as typeof actionLog;

		const [entry] = written;
		if (entry?.type !== "click") throw new Error("expected a click entry");
		expect(entry.screenX).toBe(computedTarget.x + DRIFT.x);
		expect(entry.screenY).toBe(computedTarget.y + DRIFT.y);
		// Negative control within the same test: if `runDrive` had wired the
		// computed target instead of the achieved position, THESE would be
		// the (wrong) values recorded.
		expect(entry.screenX).not.toBe(computedTarget.x);
		expect(entry.screenY).not.toBe(computedTarget.y);
	});
});

// CR-LENSMITH-A002-6 — the `type` step.
describe("runDrive: `type` step (fake page + in-memory fake choreographer)", () => {
	it("drives the cursor to the field, clicks it, then types — recording the achieved position and character count but never the text", async () => {
		const typedCalls: Array<{ selector: string; text: string; delayMs: number | undefined }> = [];
		const page = fakePage({
			elements: { "#field": { x: 120, y: 160, width: 200, height: 32 } },
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 50, y: 80 },
			onType: (selector, text, delayMs) => {
				typedCalls.push({ selector, text, delayMs });
			},
		});

		const { actionLog } = await runDrive(
			stepList([{ type: "type", selector: "#field", text: "a sample value", label: "fill field" }]),
			{ page, choreographer: fakeChoreographer() },
		);

		expect(actionLog).toHaveLength(1);
		const [entry] = actionLog;
		if (entry?.type !== "type") throw new Error("expected a type entry");

		// Same screen-point formula as a click: offset + bbox center.
		expect(entry.screenX).toBe(50 + 120 + 100);
		expect(entry.screenY).toBe(80 + 160 + 16);
		expect(entry.selector).toBe("#field");
		expect(entry.label).toBe("fill field");
		expect(entry.characterCount).toBe("a sample value".length);
		expect(entry.startedAtMs).toBeLessThanOrEqual(entry.endedAtMs);

		// The invariant this CR is built against, re-verified at the wiring
		// level: no key of the recorded entry carries the typed text itself.
		expect(Object.values(entry)).not.toContain("a sample value");
		expect(Object.hasOwn(entry, "text")).toBe(false);

		// `pressSequentially` DID receive the real text and a per-character
		// delay — proving the choreographer's click happened before typing,
		// not that typing was skipped entirely.
		expect(typedCalls).toEqual([
			{ selector: "#field", text: "a sample value", delayMs: expect.any(Number) },
		]);
	});

	it("throws a clear DriveError naming the selector and step index when a type step's selector is not found", async () => {
		const page = fakePage({
			elements: { "#exists": { x: 0, y: 0, width: 10, height: 10 } },
			viewport: { width: 1000, height: 1000 },
			windowOffset: { x: 0, y: 0 },
		});

		const promise = runDrive(
			stepList([
				{ type: "click", selector: "#exists" },
				{ type: "type", selector: "#this-field-does-not-exist", text: "hi" },
			]),
			{ page, choreographer: fakeChoreographer() },
		);

		await expect(promise).rejects.toThrow(DriveError);
		await expect(promise).rejects.toThrow(/index 1/);
		await expect(promise).rejects.toThrow(/#this-field-does-not-exist/);
	});

	it("throws a clear DriveError naming the selector when the field refuses input, and the run writes no partial output", async () => {
		const page = fakePage({
			elements: { "#locked-field": { x: 10, y: 10, width: 100, height: 20 } },
			viewport: { width: 800, height: 600 },
			windowOffset: { x: 0, y: 0 },
			typeFailureSelectors: new Set(["#locked-field"]),
		});

		const promise = runDrive(stepList([{ type: "type", selector: "#locked-field", text: "hi" }]), {
			page,
			choreographer: fakeChoreographer(),
		});

		await expect(promise).rejects.toThrow(DriveError);
		await expect(promise).rejects.toThrow(/#locked-field/);
		await expect(promise).rejects.toThrow(/could not receive typed input/);
	});

	it("records the ACHIEVED cursor position (from the choreographer's click), not the computed/requested target", async () => {
		const page = fakePage({
			elements: { "#field": { x: 120, y: 160, width: 200, height: 32 } },
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 50, y: 80 },
		});
		const computedTarget = { x: 50 + 120 + 100, y: 80 + 160 + 16 };
		const DRIFT = { x: 4, y: -2 };

		const { actionLog } = await runDrive(
			stepList([{ type: "type", selector: "#field", text: "x" }]),
			{
				page,
				choreographer: driftingFakeChoreographer(DRIFT),
			},
		);

		const [entry] = actionLog;
		if (entry?.type !== "type") throw new Error("expected a type entry");
		expect(entry.screenX).toBe(computedTarget.x + DRIFT.x);
		expect(entry.screenY).toBe(computedTarget.y + DRIFT.y);
	});

	it("a mixed click/type/click sequence drives all three steps and preserves index order", async () => {
		const page = fakePage({
			elements: {
				"#field": { x: 120, y: 160, width: 200, height: 32 },
				"#submit": { x: 400, y: 300, width: 120, height: 40 },
			},
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});

		const { actionLog } = await runDrive(
			stepList([
				{ type: "click", selector: "#field", label: "focus field" },
				{ type: "type", selector: "#field", text: "some text" },
				{ type: "click", selector: "#submit", label: "submit" },
			]),
			{ page, choreographer: fakeChoreographer() },
		);

		expect(actionLog.map((entry) => entry.type)).toEqual(["click", "type", "click"]);
		expect(actionLog.map((entry) => entry.index)).toEqual([0, 1, 2]);
	});
});

// CR-LENSMITH-A002-10 — a `type` step's text resolved from the macOS
// keychain instead of carried as a literal, via the injectable `execFile`
// seam `keychainText.ts` exposes. No real keychain is ever read here.
const KEYCHAIN_SENTINEL = "SENTINEL-NOT-A-REAL-CODE";

function fakeExecFileFailing(stderr: string, code = 1): ExecFileFn {
	return async () => {
		const error = new Error("Command failed") as Error & {
			code?: number;
			stdout?: string;
			stderr?: string;
		};
		error.code = code;
		error.stdout = "";
		error.stderr = stderr;
		throw error;
	};
}

describe("runDrive: `type` step with `textFrom` (CR-LENSMITH-A002-10) — resolved via a fake execFile, no real keychain read", () => {
	it("resolves the value through execFile, types it, and records the achieved position and character count but never the text or its source", async () => {
		const typedCalls: Array<{ selector: string; text: string; delayMs: number | undefined }> = [];
		const execFileCalls: Array<{ file: string; args: readonly string[] }> = [];
		const execFile: ExecFileFn = async (file, args) => {
			execFileCalls.push({ file, args });
			return { stdout: `${KEYCHAIN_SENTINEL}\n`, stderr: "" };
		};
		const page = fakePage({
			elements: { "#code-field": { x: 120, y: 160, width: 200, height: 32 } },
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 50, y: 80 },
			onType: (selector, text, delayMs) => {
				typedCalls.push({ selector, text, delayMs });
			},
		});

		const { actionLog } = await runDrive(
			stepList([
				{
					type: "type",
					selector: "#code-field",
					textFrom: { keychain: { service: "svc", account: "acct" } },
					label: "fill code",
				},
			]),
			{ page, choreographer: fakeChoreographer(), execFile },
		);

		expect(execFileCalls).toEqual([
			{
				file: "/usr/bin/security",
				args: ["find-generic-password", "-s", "svc", "-a", "acct", "-w"],
			},
		]);
		expect(typedCalls).toEqual([
			{ selector: "#code-field", text: KEYCHAIN_SENTINEL, delayMs: expect.any(Number) },
		]);

		expect(actionLog).toHaveLength(1);
		const [entry] = actionLog;
		if (entry?.type !== "type") throw new Error("expected a type entry");
		expect(entry.characterCount).toBe(KEYCHAIN_SENTINEL.length);
		expect(entry.label).toBe("fill code");

		// The never-leaves-memory invariant, at the wiring level: no key of the
		// recorded entry, and no serialized form of it, carries the resolved
		// value — only `characterCount` traces that anything was typed.
		expect(Object.values(entry)).not.toContain(KEYCHAIN_SENTINEL);
		expect(Object.hasOwn(entry, "text")).toBe(false);
		expect(Object.hasOwn(entry, "textFrom")).toBe(false);
		const serializedActionLog = JSON.stringify(actionLog, null, 2);
		expect(serializedActionLog).not.toContain(KEYCHAIN_SENTINEL);

		// Positive control (same discipline as the CR's own Invariant wording):
		// the same string DOES appear where it is genuinely supposed to —
		// the fake `execFile`'s own return value and the wiring-proof call above.
		expect(typedCalls[0]?.text).toContain(KEYCHAIN_SENTINEL);
	});

	it("passes a service containing shell metacharacters through to execFile as one literal argument, unmodified — no shell, no injection", async () => {
		const dangerous = "svc-$(touch /tmp/pwned)-`echo hi`";
		const execFileCalls: Array<{ file: string; args: readonly string[] }> = [];
		const execFile: ExecFileFn = async (file, args) => {
			execFileCalls.push({ file, args });
			return { stdout: "value\n", stderr: "" };
		};
		const page = fakePage({
			elements: { "#field": { x: 0, y: 0, width: 10, height: 10 } },
			viewport: { width: 500, height: 500 },
			windowOffset: { x: 0, y: 0 },
		});

		await runDrive(
			stepList([
				{
					type: "type",
					selector: "#field",
					textFrom: { keychain: { service: dangerous, account: "acct" } },
				},
			]),
			{ page, choreographer: fakeChoreographer(), execFile },
		);

		expect(execFileCalls[0]?.args).toEqual([
			"find-generic-password",
			"-s",
			dangerous,
			"-a",
			"acct",
			"-w",
		]);
	});

	it("a resolver failure (missing item) fails the run before any character is typed, names service and account, and writes no output — proven by never reaching runDrive's return", async () => {
		const typedCalls: string[] = [];
		const page = fakePage({
			elements: { "#code-field": { x: 10, y: 10, width: 100, height: 20 } },
			viewport: { width: 800, height: 600 },
			windowOffset: { x: 0, y: 0 },
			onType: (_selector, text) => {
				typedCalls.push(text);
			},
		});
		const execFile = fakeExecFileFailing(
			`security: SecKeychainSearchCopyNext: The specified item ${KEYCHAIN_SENTINEL} could not ` +
				"be found in the keychain.",
			44,
		);

		const promise = runDrive(
			stepList([
				{
					type: "type",
					selector: "#code-field",
					textFrom: { keychain: { service: "my-service", account: "my-account" } },
				},
			]),
			{ page, choreographer: fakeChoreographer(), execFile },
		);

		let caughtMessage = "";
		try {
			await promise;
			expect.unreachable("expected runDrive to reject");
		} catch (error) {
			caughtMessage = (error as Error).message;
		}

		expect(caughtMessage).toMatch(/my-service/);
		expect(caughtMessage).toMatch(/my-account/);
		// Neither the child's stdout nor its raw stderr reached the thrown message.
		expect(caughtMessage).not.toContain(KEYCHAIN_SENTINEL);
		// No character was ever typed — the resolver failure happened before
		// `pressSequentially` was reached.
		expect(typedCalls).toHaveLength(0);
	});

	it("a resolver failure never reaches a partial actionLog — `runDrive` rejects rather than resolving, matching every other step failure", async () => {
		const page = fakePage({
			elements: { "#a": { x: 0, y: 0, width: 10, height: 10 } },
			viewport: { width: 500, height: 500 },
			windowOffset: { x: 0, y: 0 },
		});
		const execFile = fakeExecFileFailing("security: item not found", 44);

		const promise = runDrive(
			stepList([
				{ type: "click", selector: "#a" },
				{
					type: "type",
					selector: "#a",
					textFrom: { keychain: { service: "svc", account: "acct" } },
				},
			]),
			{ page, choreographer: fakeChoreographer(), execFile },
		);

		await expect(promise).rejects.toThrow(/svc/);
	});

	it("literal `text` steps never invoke execFile at all — the seam is unused on the unchanged path", async () => {
		let execFileCalls = 0;
		const execFile: ExecFileFn = async () => {
			execFileCalls += 1;
			return { stdout: "unused\n", stderr: "" };
		};
		const page = fakePage({
			elements: { "#field": { x: 0, y: 0, width: 10, height: 10 } },
			viewport: { width: 500, height: 500 },
			windowOffset: { x: 0, y: 0 },
		});

		await runDrive(stepList([{ type: "type", selector: "#field", text: "plain text" }]), {
			page,
			choreographer: fakeChoreographer(),
			execFile,
		});

		expect(execFileCalls).toBe(0);
	});
});

// CR-LENSMITH-A002-10 — the precondition-shaped-failure boundary the CR
// itself calls out: A002-9's `withLaunchedChrome` constructs the
// choreographer before launching Chrome so a precondition failure never
// leaves a browser behind; a missing keychain item is exactly such a
// precondition (just discovered mid-run, inside a `type` step, rather than
// at acquisition time) and must close the same way.
describe("withLaunchedChrome + runDrive: a missing keychain item leaves no launched Chrome and no started recorder behind (CR-LENSMITH-A002-10)", () => {
	it("closes the Chrome context and stops the choreographer exactly once, and never reaches the output-file writes, when the keychain resolver fails mid-run", async () => {
		let closeCalls = 0;
		let stopCalls = 0;
		let reachedOutputWrite = false;

		const page = fakePage({
			elements: { "#code-field": { x: 10, y: 10, width: 100, height: 20 } },
			viewport: { width: 800, height: 600 },
			windowOffset: { x: 0, y: 0 },
		});
		const context = fakePersistentContext({
			pages: () => [page],
			close: async () => {
				closeCalls += 1;
			},
		});
		const baseChoreographer = fakeChoreographer();
		const choreographer: ChoreographerLike = {
			...baseChoreographer,
			stop() {
				stopCalls += 1;
			},
		};
		const execFile = fakeExecFileFailing(
			"security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
			44,
		);

		// Mirrors `registerDriveCommand`'s real action body shape: acquire the
		// page, start the choreographer, drive, then (unreached here) write
		// both output files, with `choreographer.stop()` in the same `finally`
		// production uses.
		const promise = withLaunchedChrome(
			{ profileDir: "/tmp/some-profile", browserChannel: "chrome" },
			async (ctx, ch) => {
				const drivenPage = await acquirePage(ctx);
				try {
					await ch.start();
					const result = await runDrive(
						stepList([
							{
								type: "type",
								selector: "#code-field",
								textFrom: { keychain: { service: "svc", account: "acct" } },
							},
						]),
						{ page: drivenPage, choreographer: ch, execFile },
					);
					reachedOutputWrite = true;
					return result;
				} finally {
					ch.stop();
				}
			},
			{ launch: async () => context, createChoreographer: () => choreographer },
		);

		await expect(promise).rejects.toThrow(/svc/);
		await expect(promise).rejects.toThrow(/acct/);
		expect(closeCalls).toBe(1);
		expect(stopCalls).toBe(1);
		expect(reachedOutputWrite).toBe(false);
	});
});

describe("runDrive interop: a real CursorChoreographer (fake helper subprocess, zero OS events)", () => {
	let dir: string;
	let choreographer: CursorChoreographer;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-drive-"));
		const helperPath = path.join(dir, "fake-helper");
		writeFileSync(helperPath, FAKE_HELPER);
		chmodSync(helperPath, 0o755);
		choreographer = new CursorChoreographer({ helperPath });
	});

	afterEach(() => {
		choreographer.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("drives one click end to end through the real CursorChoreographer's moveTo/dwell/click", async () => {
		await choreographer.start();
		const page = fakePage({
			elements: { "#btn-one": { x: 120, y: 160, width: 160, height: 56 } },
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 50, y: 80 },
		});

		const { actionLog } = await runDrive(stepList([{ type: "click", selector: "#btn-one" }]), {
			page,
			choreographer,
		});

		expect(actionLog).toHaveLength(1);
		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");
		expect(entry.screenX).toBe(50 + 120 + 80);
		expect(entry.screenY).toBe(80 + 160 + 28);
		// The real choreographer answered `click()` with the position it moved
		// to — proving the fake helper actually received and processed the
		// moveTo it was sent, not just that the promise resolved.
		const finalPosition = await choreographer.position();
		expect(finalPosition).toEqual({ x: entry.screenX, y: entry.screenY });
	});
});

/**
 * A fake helper that behaves normally except: its SECOND "click" reply
 * reports a position 5px away (in x) from where the preceding move actually
 * landed — simulating [[BF-2]]'s stray-event failure mode surfacing partway
 * through a multi-step run, not on the first action.
 */
const SECOND_CLICK_DRIFT_HELPER = `#!/usr/bin/env node
"use strict";
let x = 0;
let y = 0;
let clickCount = 0;
let buffer = "";
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    switch (message.cmd) {
      case "position": send({ type: "ok", cmd: "position", x, y }); break;
      case "warm": send({ type: "ok", cmd: "warm", warm: true }); break;
      case "move": {
        const fromX = x, fromY = y;
        x = message.x; y = message.y;
        send({ type: "ok", cmd: "move", steps: 60, elapsedMs: message.durationMs, fromX, fromY, x, y });
        break;
      }
      case "click": {
        clickCount += 1;
        if (clickCount === 2) {
          send({ type: "ok", cmd: "click", x: x + 5, y });
        } else {
          send({ type: "ok", cmd: "click", x, y });
        }
        break;
      }
      default: send({ type: "error", cmd: message.cmd, message: "unknown command" });
    }
  }
});
`;

// QA Scenario ([[CR-LENSMITH-A002-3]]): "drive with one click succeeding
// (achieved matches) and a second click's helper call throwing (divergent)
// → confirm the CR-LENSMITH-A002-2 invariant ('a failed run writes no
// partial output') still holds with this CR's new failure path."
describe("runDrive: a divergent SECOND click aborts the whole run (CR-LENSMITH-A002-2's no-partial-output invariant, re-verified)", () => {
	let dir: string;
	let choreographer: CursorChoreographer;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-drive-2click-"));
		const helperPath = path.join(dir, "fake-helper");
		writeFileSync(helperPath, SECOND_CLICK_DRIFT_HELPER);
		chmodSync(helperPath, 0o755);
		choreographer = new CursorChoreographer({ helperPath });
	});

	afterEach(() => {
		choreographer.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("rejects with CursorDeliveryError from the real class, wired through runDrive, after the first click already succeeded", async () => {
		await choreographer.start();
		const page = fakePage({
			elements: {
				"#btn-one": { x: 120, y: 160, width: 160, height: 56 },
				"#btn-two": { x: 520, y: 360, width: 160, height: 56 },
			},
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});

		const promise = runDrive(
			stepList([
				{ type: "click", selector: "#btn-one" },
				{ type: "click", selector: "#btn-two" },
			]),
			{ page, choreographer },
		);

		await expect(promise).rejects.toThrow(CursorDeliveryError);
		// `runDrive` REJECTS rather than resolving with a 1-entry partial
		// action log — the same structural guarantee already proven for
		// selector-not-found failures above ("never returns a partial
		// result"), now re-verified against this CR's new failure path.
		// `registerDriveCommand`'s two `writeFileSync` calls are gated
		// behind `await runDrive(...)` resolving, so neither output file is
		// ever written when this promise rejects.
	});
});

describe("runDrive: auto-scroll-into-view before computing a click's screen point (CR-LENSMITH-A002-4 Technical Spec item 1)", () => {
	it("calls scrollIntoViewIfNeeded for every click step, and the recorded coordinates reflect the POST-scroll position, not the pre-scroll one", async () => {
		const scrollCalls: string[] = [];
		const page = fakePage({
			elements: {},
			scrollBehavior: {
				"#below-fold": {
					// Pre-scroll: the box a real Playwright boundingBox() call
					// would report while the element is still off-screen below the
					// fold (boundingBox() returns null only for
					// display:none/detached elements, not merely-scrolled-away
					// ones — so this is a realistic "before" value).
					before: { x: 100, y: 2700, width: 160, height: 56 },
					// Post-scroll: the browser scrolled the page so the element now
					// sits near the top of the viewport.
					after: { x: 100, y: 40, width: 160, height: 56 },
				},
			},
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
			onScrollIntoView: (selector) => scrollCalls.push(selector),
		});

		const { actionLog } = await runDrive(stepList([{ type: "click", selector: "#below-fold" }]), {
			page,
			choreographer: fakeChoreographer(),
		});

		expect(scrollCalls).toEqual(["#below-fold"]);

		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");
		expect(entry.boundingBox).toEqual({ x: 100, y: 40, width: 160, height: 56 });
		expect(entry.screenY).toBe(0 + 40 + 28);
		// Negative control: had the box been read BEFORE scrolling (the exact
		// bug this Spec item closes), this is the value that would have been
		// recorded instead — assert it explicitly was NOT.
		expect(entry.screenY).not.toBe(0 + 2700 + 28);
	});

	it("does not change behavior for a target already fully on-screen (the common case, unchanged per Invariant 5)", async () => {
		const page = fakePage({
			elements: { "#on-screen": { x: 50, y: 60, width: 100, height: 40 } },
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 10, y: 20 },
		});

		const { actionLog } = await runDrive(stepList([{ type: "click", selector: "#on-screen" }]), {
			page,
			choreographer: fakeChoreographer(),
		});

		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");
		// Same numbers CR-LENSMITH-A002-2's own formula tests already assert.
		expect(entry.screenX).toBe(10 + 50 + 50);
		expect(entry.screenY).toBe(20 + 60 + 20);
	});

	it("throws a clear DriveError naming the selector if scrollIntoViewIfNeeded itself fails, and never reads boundingBox", async () => {
		const page: PageLike = {
			async goto() {
				return null;
			},
			async bringToFront() {
				// no-op — this fake has no real window to bring forward
			},
			url() {
				return "http://localhost/x";
			},
			locator(_selector: string): LocatorLike {
				return {
					async waitFor() {
						// always "visible" — this test exercises the scroll failure below
					},
					async scrollIntoViewIfNeeded() {
						throw new Error("element detached from DOM mid-scroll");
					},
					async boundingBox() {
						throw new Error("unreachable — scrollIntoViewIfNeeded should have thrown first");
					},
				};
			},
			mouse: {
				async click() {
					// unreachable in this test — calibration succeeds before the failing step runs
				},
			},
			async evaluate<T, Arg>(_fn: (arg: Arg) => T, arg: Arg): Promise<T> {
				if (arg === undefined) return { width: 800, height: 600 } as unknown as T;
				const asArg = arg as unknown as { x?: unknown };
				if (typeof asArg?.x === "number") return undefined as T;
				return { screenX: 0, screenY: 0 } as unknown as T;
			},
		};

		const promise = runDrive(stepList([{ type: "click", selector: "#flaky" }]), {
			page,
			choreographer: fakeChoreographer(),
		});

		await expect(promise).rejects.toThrow(DriveError);
		await expect(promise).rejects.toThrow(/could not be scrolled into view/);
		await expect(promise).rejects.toThrow(/#flaky/);
	});
});

describe("runDrive: the bounds assertion rejects an out-of-window target BEFORE any choreographer call (CR-LENSMITH-A002-4 Technical Spec item 2 / Acceptance Metric 2)", () => {
	/**
	 * A choreographer that FAILS the test if `moveTo`/`dwell`/`click` are ever
	 * called — the same fake-helper/command-log discipline `/proof` used
	 * reviewing CR-LENSMITH-A002-3 (a test that can actually fail, not one
	 * that passes regardless). Stands in for "no CGEventPost call reachable."
	 */
	function poisonedChoreographer(): ChoreographerLike {
		return {
			async start() {
				// no-op — no real subprocess to spawn
			},
			stop() {
				// no-op — nothing to tear down
			},
			async moveTo(): Promise<MoveResultLike> {
				throw new Error(
					"moveTo() must never be called — the bounds check should have rejected first",
				);
			},
			async dwell() {
				throw new Error(
					"dwell() must never be called — the bounds check should have rejected first",
				);
			},
			async click(): Promise<PointLike> {
				throw new Error(
					"click() must never be called — the bounds check should have rejected first",
				);
			},
		};
	}

	it("rejects with TargetOutOfBoundsError for a target whose computed point falls outside the window, and never reaches moveTo/dwell/click", async () => {
		const page = fakePage({
			// Computed screen point lands far outside offset..offset+viewport on
			// every axis — a deliberately-corrupted target, mirroring
			// CR-LENSMITH-A002-2's own negative-control pattern for `compose`.
			elements: { "#way-off": { x: 5000, y: 5000, width: 10, height: 10 } },
			viewport: { width: 800, height: 600 },
			windowOffset: { x: 0, y: 0 },
		});

		const promise = runDrive(stepList([{ type: "click", selector: "#way-off" }]), {
			page,
			choreographer: poisonedChoreographer(),
		});

		await expect(promise).rejects.toThrow(TargetOutOfBoundsError);
	});

	it("rejects when the calibration offset itself is corrupted (non-finite) even for an otherwise-ordinary on-screen box, and never reaches moveTo/dwell/click", async () => {
		const page: PageLike = {
			async goto() {
				return null;
			},
			async bringToFront() {
				// no-op — this fake has no real window to bring forward
			},
			url() {
				return "http://localhost/x";
			},
			locator(_selector: string): LocatorLike {
				return {
					async waitFor() {
						// always "visible" — this test exercises the calibration-offset failure below
					},
					async scrollIntoViewIfNeeded() {
						// no-op — not the behavior under test here
					},
					async boundingBox() {
						return { x: 10, y: 10, width: 20, height: 20 };
					},
				};
			},
			mouse: {
				async click() {
					// the calibration "click" — its effect is stubbed directly in evaluate() below
				},
			},
			async evaluate<T, Arg>(_fn: (arg: Arg) => T, arg: Arg): Promise<T> {
				if (arg === undefined) return { width: 800, height: 600 } as unknown as T;
				const asArg = arg as unknown as { x?: unknown };
				if (typeof asArg?.x === "number") return undefined as T;
				// The calibration "read": a corrupted (non-finite) measurement.
				return { screenX: Number.NaN, screenY: 10 } as unknown as T;
			},
		};

		const promise = runDrive(stepList([{ type: "click", selector: "#ordinary" }]), {
			page,
			choreographer: poisonedChoreographer(),
		});

		await expect(promise).rejects.toThrow(TargetOutOfBoundsError);
	});
});

describe("runDrive: minViewportWidth precondition — fails fast, before any step, when the driven window is too narrow (CR-LENSMITH-A002-4 fix round, item 5)", () => {
	/** Same discipline as the bounds-assertion block above: fails the test if the choreographer is ever reached. */
	function poisonedChoreographer(): ChoreographerLike {
		return {
			async start() {
				// no-op — no real subprocess to spawn
			},
			stop() {
				// no-op — nothing to tear down
			},
			async moveTo(): Promise<MoveResultLike> {
				throw new Error(
					"moveTo() must never be called — the width precondition should have rejected first",
				);
			},
			async dwell() {
				throw new Error(
					"dwell() must never be called — the width precondition should have rejected first",
				);
			},
			async click(): Promise<PointLike> {
				throw new Error(
					"click() must never be called — the width precondition should have rejected first",
				);
			},
		};
	}

	it("rejects with a DriveError naming both the actual and required width, before any locator or choreographer call", async () => {
		let locatorCalled = false;
		const page: PageLike = {
			async goto() {
				return null;
			},
			async bringToFront() {
				// no-op — this fake has no real window to bring forward
			},
			url() {
				return "http://localhost/x";
			},
			locator(_selector: string): LocatorLike {
				locatorCalled = true;
				throw new Error(
					"locator() must never be called — the width precondition should have rejected first",
				);
			},
			mouse: {
				async click() {
					// the calibration click — allowed; calibration runs BEFORE the width check
				},
			},
			async evaluate<T, Arg>(_fn: (arg: Arg) => T, arg: Arg): Promise<T> {
				// Narrower than a common 1024px sidebar breakpoint — the exact
				// shape `/proof` found: viewport: null on a small window.
				if (arg === undefined) return { width: 900, height: 800 } as unknown as T;
				const asArg = arg as unknown as { x?: unknown };
				if (typeof asArg?.x === "number") return undefined as T;
				return { screenX: 0, screenY: 0 } as unknown as T;
			},
		};

		const promise = runDrive(stepList([{ type: "click", selector: "#sidebar-link" }], 1024), {
			page,
			choreographer: poisonedChoreographer(),
		});

		await expect(promise).rejects.toThrow(DriveError);
		await expect(promise).rejects.toThrow(/900px/);
		await expect(promise).rejects.toThrow(/1024px/);
		expect(locatorCalled).toBe(false);
	});

	it("does not throw, and drives normally, when the window meets the minimum exactly (boundary inclusive)", async () => {
		const page = fakePage({
			elements: { "#a": { x: 10, y: 10, width: 20, height: 20 } },
			viewport: { width: 1024, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});

		const { actionLog } = await runDrive(stepList([{ type: "click", selector: "#a" }], 1024), {
			page,
			choreographer: fakeChoreographer(),
		});

		expect(actionLog).toHaveLength(1);
	});

	it("does not throw at any width when minViewportWidth is unset on the step list (existing behavior unchanged, Invariant 5)", async () => {
		const page = fakePage({
			elements: { "#a": { x: 10, y: 10, width: 20, height: 20 } },
			viewport: { width: 320, height: 480 },
			windowOffset: { x: 0, y: 0 },
		});

		const { actionLog } = await runDrive(stepList([{ type: "click", selector: "#a" }]), {
			page,
			choreographer: fakeChoreographer(),
		});

		expect(actionLog).toHaveLength(1);
	});
});

// BF-8 / CR-LENSMITH-A002-13 — every external wait in the drive loop is
// bounded, so a missing element or a hung navigation fails the run instead of
// hanging it forever. Each test below gives its OWN vitest timeout well above
// the (short, injected) bound under test, so the suite stays fast while still
// proving the real failure shape: non-zero exit, step index + selector +
// bound named, no partial output.
describe("BF-8 / CR-LENSMITH-A002-13 — every drive wait is bounded", () => {
	it("a click step's element wait that never resolves fails within its bound, naming the step index, the step type, the selector and the bound", async () => {
		const page = pageWithLocator(hangingWaitForLocator("#ghost"));
		const list = stepList([{ type: "click", selector: "#ghost", timeoutMs: 150 }]);

		const startedAt = Date.now();
		let thrown: unknown;
		try {
			await runDrive(list, { page, choreographer: fakeChoreographer() });
		} catch (error) {
			thrown = error;
		}
		const elapsedMs = Date.now() - startedAt;

		expect(thrown).toBeInstanceOf(DriveError);
		const message = (thrown as Error).message;
		expect(message).toContain("index 0");
		expect(message).toContain('type "click"');
		expect(message).toContain('"#ghost"');
		expect(message).toContain("150ms");
		// QA Scenario 4: fires at ITS OWN bound, nowhere near the 45s default.
		expect(elapsedMs).toBeLessThan(1000);
	}, 2000);

	it("a type step's element wait that never resolves fails within its bound, naming the step index, the step type, the selector and the bound", async () => {
		const page = pageWithLocator(hangingWaitForLocator("#ghost"));
		const list = stepList([{ type: "type", selector: "#ghost", text: "hi", timeoutMs: 150 }]);

		let thrown: unknown;
		try {
			await runDrive(list, { page, choreographer: fakeChoreographer() });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(DriveError);
		const message = (thrown as Error).message;
		expect(message).toContain("index 0");
		expect(message).toContain('type "type"');
		expect(message).toContain('"#ghost"');
		expect(message).toContain("150ms");
	}, 2000);

	it("a navigation that never reaches load fails within its bound, naming the URL and the bound — no step has run yet", async () => {
		const page = pageWithHangingGoto();
		const list = stepList([{ type: "click", selector: "#a" }]);

		let thrown: unknown;
		try {
			await runDrive(list, {
				page,
				choreographer: fakeChoreographer(),
				navigationTimeoutMs: 150,
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(DriveError);
		const message = (thrown as Error).message;
		expect(message).toContain(list.url);
		expect(message).toContain("150ms");
	}, 2000);

	it("wraps a failing keychain resolution into a DriveError naming the step index and selector (the bound itself is proven in tests/keychainText.test.ts)", async () => {
		const failingExecFile: ExecFileFn = async () => {
			throw new Error("simulated keychain failure for this wiring test");
		};
		const page = fakePage({
			elements: { "#code": { x: 10, y: 10, width: 20, height: 20 } },
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});
		const list = stepList([
			{
				type: "type",
				selector: "#code",
				textFrom: { keychain: { service: "svc", account: "acct" } },
			},
		]);

		let thrown: unknown;
		try {
			await runDrive(list, {
				page,
				choreographer: fakeChoreographer(),
				execFile: failingExecFile,
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(DriveError);
		const message = (thrown as Error).message;
		expect(message).toContain("index 0");
		expect(message).toContain('"#code"');
		// `resolveKeychainText` deliberately never echoes a raw execFile error —
		// only its own fixed, non-leaking wording reaches here.
		expect(message).toContain("could not read the keychain item");
	});

	it("an explicit timeoutMs on a click step does not change behavior when the element appears (Invariant: nothing changes on the happy path)", async () => {
		const page = fakePage({
			elements: { "#a": { x: 0, y: 0, width: 10, height: 10 } },
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});
		const list = stepList([{ type: "click", selector: "#a", timeoutMs: 5000 }]);

		const result = await runDrive(list, { page, choreographer: fakeChoreographer() });

		expect(result.actionLog).toHaveLength(1);
		expect(result.actionLog[0]).toMatchObject({ type: "click", selector: "#a" });
	});
});

describe("holdOpen (CR-LENSMITH-A002-4 Technical Spec item 3 / Invariant 3) — fake deps, no real process or signal", () => {
	it("logs the page URL and SIGINT instructions, then waits — resolving only once the interrupt callback fires", async () => {
		const messages: string[] = [];
		let interrupt: (() => void) | undefined;

		const promise = holdOpen("http://localhost:8000/dev-tenant/employees", {
			log: (message) => messages.push(message),
			onInterrupt: (callback) => {
				interrupt = callback;
			},
		});

		let resolved = false;
		promise.then(() => {
			resolved = true;
		});

		// Give the microtask queue a turn — the promise must NOT have resolved
		// yet, since no interrupt has fired.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(resolved).toBe(false);

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("http://localhost:8000/dev-tenant/employees");
		expect(messages[0]).toContain("SIGINT");

		interrupt?.();
		await promise;
		expect(resolved).toBe(true);
	});

	it("registers exactly one interrupt handler per call", async () => {
		let registrations = 0;
		const promise = holdOpen("http://x", {
			log: () => {
				// not the assertion in this test — see the "logs the page URL..." test above
			},
			onInterrupt: (callback) => {
				registrations += 1;
				callback();
			},
		});
		await promise;
		expect(registrations).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// CR-LENSMITH-A002-9 — `drive` launches a real Chrome with a persistent
// profile instead of Playwright's bundled Chromium, via
// `chromium.launchPersistentContext` (returns a `BrowserContext`, not a
// `Browser`). These tests exercise the four small functions this CR
// introduces — `launchChrome`, `acquirePage`, `withChromeContext`,
// `defaultProfileDir` — entirely against fakes / pure computation: no real
// Chrome, no real profile directory, no OS window, no OS cursor event.
// ─────────────────────────────────────────────────────────────────────────

function fakePersistentContext(
	overrides: Partial<PersistentContextLike> = {},
): PersistentContextLike {
	return {
		pages: () => [],
		newPage: async () => ({}) as PageLike,
		close: async () => {
			// no-op by default — tests that care about close() override it
		},
		setDefaultTimeout: () => {
			// no-op by default — the withLaunchedChrome describe block below
			// asserts the real values it's called with
		},
		setDefaultNavigationTimeout: () => {
			// no-op by default — same as setDefaultTimeout above
		},
		...overrides,
	};
}

describe("launchChrome (CR-LENSMITH-A002-9) — never falls back to bundled Chromium", () => {
	it("launches with headless:false, viewport:null, and the requested channel/profile directory", async () => {
		const seen: { profileDir?: string; options?: unknown } = {};
		const context = fakePersistentContext();

		const result = await launchChrome(
			async (profileDir, options) => {
				seen.profileDir = profileDir;
				seen.options = options;
				return context;
			},
			{ profileDir: "/tmp/some-profile", browserChannel: "chrome-beta" },
		);

		expect(result).toBe(context);
		expect(seen.profileDir).toBe("/tmp/some-profile");
		expect(seen.options).toEqual({
			headless: false,
			channel: "chrome-beta",
			viewport: null,
			chromiumSandbox: true,
			args: ["--window-size=1600,900", "--window-position=0,25"],
		});
	});

	it("BF-9: passes chromiumSandbox:true — playwright-core defaults it to false, which shows the '--no-sandbox' infobar on every recorded window", async () => {
		const seen: { options?: unknown } = {};
		const context = fakePersistentContext();

		await launchChrome(
			async (_profileDir, options) => {
				seen.options = options;
				return context;
			},
			{ profileDir: "/tmp/some-profile", browserChannel: "chrome" },
		);

		expect((seen.options as { chromiumSandbox?: boolean }).chromiumSandbox).toBe(true);
	});

	it("a missing channel throws a DriveError naming the channel and the profile directory — never a silent fallback", async () => {
		let thrown: unknown;
		try {
			await launchChrome(
				async () => {
					throw new Error('browserType.launchPersistentContext: unable to find browser "nope"');
				},
				{ profileDir: "/tmp/nope-profile", browserChannel: "nope" },
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(DriveError);
		const message = (thrown as Error).message;
		expect(message).toContain("nope");
		expect(message).toContain("/tmp/nope-profile");
		expect(message).not.toContain("bundled Chromium is used");
	});
});

describe("acquirePage (CR-LENSMITH-A002-9)", () => {
	it("uses the context's existing first page when one exists, and never creates a new one", async () => {
		const existingPage = { url: () => "http://existing" } as unknown as PageLike;
		let newPageCalls = 0;
		const context = fakePersistentContext({
			pages: () => [existingPage],
			newPage: async () => {
				newPageCalls += 1;
				return {} as PageLike;
			},
		});

		const page = await acquirePage(context);

		expect(page).toBe(existingPage);
		expect(newPageCalls).toBe(0);
	});

	it("creates a new page when the context has none yet", async () => {
		const freshPage = { url: () => "http://fresh" } as unknown as PageLike;
		const context = fakePersistentContext({
			pages: () => [],
			newPage: async () => freshPage,
		});

		const page = await acquirePage(context);

		expect(page).toBe(freshPage);
	});
});

describe("withChromeContext (CR-LENSMITH-A002-9) — exactly one close per exit path, seen RED first against the pre-CR two-object teardown", () => {
	it("closes exactly once when the body resolves, and returns the body's value", async () => {
		let closeCalls = 0;
		const context = fakePersistentContext({
			close: async () => {
				closeCalls += 1;
			},
		});

		const result = await withChromeContext(context, async () => "ok");

		expect(result).toBe("ok");
		expect(closeCalls).toBe(1);
	});

	it("closes exactly once when the body throws — a failure injected mid-run leaves no orphaned Chrome process — and the original error propagates unmasked", async () => {
		let closeCalls = 0;
		const context = fakePersistentContext({
			close: async () => {
				closeCalls += 1;
			},
		});
		const injected = new Error("mid-run failure");

		await expect(
			withChromeContext(context, async () => {
				throw injected;
			}),
		).rejects.toBe(injected);
		expect(closeCalls).toBe(1);
	});

	it("closes exactly once even when close() itself would be called twice by a naive caller — the wrapper is the only call site", async () => {
		let closeCalls = 0;
		const context = fakePersistentContext({
			close: async () => {
				closeCalls += 1;
			},
		});

		await withChromeContext(context, async (ctx) => {
			// A body that also reaches for the context is still not a second
			// close call — only `withChromeContext`'s own `finally` closes it.
			expect(ctx).toBe(context);
		});

		expect(closeCalls).toBe(1);
	});
});

// A ChoreographerLike whose every method fails the test if called — used
// where the point is that `withLaunchedChrome` never reaches `fn()`'s body
// (or never needs the choreographer at all), mirroring this file's own
// existing `poisonedChoreographer()` pattern above.
function unusedChoreographer(): ChoreographerLike {
	return {
		async start() {
			throw new Error("start() must never be called in this test");
		},
		stop() {
			throw new Error("stop() must never be called in this test");
		},
		async moveTo(): Promise<MoveResultLike> {
			throw new Error("moveTo() must never be called in this test");
		},
		async dwell() {
			throw new Error("dwell() must never be called in this test");
		},
		async click(): Promise<PointLike> {
			throw new Error("click() must never be called in this test");
		},
	};
}

// CR-LENSMITH-A002-9 round 2 — proof's Finding 1: `registerDriveCommand`'s
// CLI action and `demo.ts`'s `defaultPerformDrive` both built `new
// CursorChoreographer()` AFTER a successful `launchChrome()`, so a
// synchronous throw from the constructor (`NativeHelperMissingError` — the
// default state of any fresh checkout whose native helper isn't built yet)
// orphaned an already-open real Chrome process holding the real persistent
// profile, because `withChromeContext` — the only code that calls
// `context.close()` — was never reached. `withLaunchedChrome` is the fix,
// shared by both call sites: it constructs the choreographer BEFORE
// launching Chrome, so that failure mode can no longer reach a launched
// context at all.
describe("withLaunchedChrome (CR-LENSMITH-A002-9 round 2) — the choreographer/launch ordering that closes proof's Finding 1", () => {
	it(
		"never launches Chrome when createChoreographer() throws — RED against the pre-fix " +
			"ordering (launch-then-construct), where this same fault leaves launchCalls=1, " +
			"closeCalls=0 (proof's exact measurement); GREEN here because construction runs first",
		async () => {
			let launchCalls = 0;
			let closeCalls = 0;
			const launch: LaunchPersistentContext = async () => {
				launchCalls += 1;
				return fakePersistentContext({
					close: async () => {
						closeCalls += 1;
					},
				});
			};
			const helperMissing = new Error("Native helper not found or not executable — build it first");

			const promise = withLaunchedChrome(
				{ profileDir: "/tmp/some-profile", browserChannel: "chrome" },
				async () => "unreachable — fn() must never run",
				{
					launch,
					createChoreographer: () => {
						throw helperMissing;
					},
				},
			);

			await expect(promise).rejects.toBe(helperMissing);
			// The structural proof: the launcher was never even invoked, so there
			// is no context that could have been left open — not "a context was
			// opened and then correctly closed," but "no context ever existed."
			expect(launchCalls).toBe(0);
			expect(closeCalls).toBe(0);
		},
	);

	it("closes the context exactly once when fn() itself throws after a successful launch (the ordinary failure path, unaffected by the reorder)", async () => {
		let closeCalls = 0;
		const context = fakePersistentContext({
			close: async () => {
				closeCalls += 1;
			},
		});
		const injected = new Error("body failure mid-run");

		const promise = withLaunchedChrome(
			{ profileDir: "/tmp/some-profile", browserChannel: "chrome" },
			async () => {
				throw injected;
			},
			{ launch: async () => context, createChoreographer: unusedChoreographer },
		);

		await expect(promise).rejects.toBe(injected);
		expect(closeCalls).toBe(1);
	});

	it("closes the context exactly once on success, and hands fn() the exact context and choreographer instances it constructed — in construct-then-launch order", async () => {
		const order: string[] = [];
		let closeCalls = 0;
		const context = fakePersistentContext({
			close: async () => {
				closeCalls += 1;
			},
		});
		const choreographer = unusedChoreographer();

		let receivedContext: PersistentContextLike | undefined;
		let receivedChoreographer: ChoreographerLike | undefined;

		const result = await withLaunchedChrome(
			{ profileDir: "/tmp/some-profile", browserChannel: "chrome" },
			async (ctx, ch) => {
				receivedContext = ctx;
				receivedChoreographer = ch;
				return "ok";
			},
			{
				createChoreographer: () => {
					order.push("choreographer");
					return choreographer;
				},
				launch: async () => {
					order.push("launch");
					return context;
				},
			},
		);

		expect(result).toBe("ok");
		expect(order).toEqual(["choreographer", "launch"]);
		expect(receivedContext).toBe(context);
		expect(receivedChoreographer).toBe(choreographer);
		expect(closeCalls).toBe(1);
	});

	it("a missing-channel launch failure still throws DriveError, with no context to close (nothing was ever opened)", async () => {
		const promise = withLaunchedChrome(
			{ profileDir: "/tmp/nope-profile", browserChannel: "nope" },
			async () => "unreachable",
			{
				createChoreographer: unusedChoreographer,
				launch: async () => {
					throw new Error('browserType.launchPersistentContext: unable to find browser "nope"');
				},
			},
		);

		await expect(promise).rejects.toBeInstanceOf(DriveError);
	});

	// BF-8 / CR-LENSMITH-A002-13: the one place a finite default action and
	// navigation timeout are set on the context — before fn() (and therefore
	// acquirePage and every step) ever touches a page.
	it("sets the context's default action and navigation timeout right after launch, before fn() runs", async () => {
		const seen: { actionMs?: number; navigationMs?: number } = {};
		const context = fakePersistentContext({
			setDefaultTimeout: (ms: number) => {
				seen.actionMs = ms;
			},
			setDefaultNavigationTimeout: (ms: number) => {
				seen.navigationMs = ms;
			},
		});

		const result = await withLaunchedChrome(
			{ profileDir: "/tmp/some-profile", browserChannel: "chrome" },
			async () => {
				// By the time fn() runs, both must already be set — not deferred
				// to some later call inside the step loop.
				expect(seen.actionMs).toBe(DEFAULT_ACTION_TIMEOUT_MS);
				expect(seen.navigationMs).toBe(DEFAULT_NAVIGATION_TIMEOUT_MS);
				return "ok";
			},
			{ createChoreographer: unusedChoreographer, launch: async () => context },
		);

		expect(result).toBe("ok");
		expect(seen.actionMs).toBe(DEFAULT_ACTION_TIMEOUT_MS);
		expect(seen.navigationMs).toBe(DEFAULT_NAVIGATION_TIMEOUT_MS);
	});
});

describe("defaultProfileDir (CR-LENSMITH-A002-9)", () => {
	it("is absolute, under the OS home directory, and never inside this repository's working tree", () => {
		const dir = defaultProfileDir();
		expect(path.isAbsolute(dir)).toBe(true);
		expect(dir.startsWith(homedir())).toBe(true);
		expect(dir.startsWith(process.cwd())).toBe(false);
	});
});

describe("BF-15 — fixed window and driven-window discovery", () => {
	it("DRIVEN_WINDOW is 1600x900 at 0,25 and its Chrome args match", () => {
		expect(DRIVEN_WINDOW).toEqual({ width: 1600, height: 900, x: 0, y: 25 });
		expect(DRIVEN_WINDOW_ARGS).toEqual(["--window-size=1600,900", "--window-position=0,25"]);
	});

	it("BF-16: discoverDrivenWindowId picks the largest window owned by the PID, wherever it sits", async () => {
		const id = await discoverDrivenWindowId({
			pid: 500,
			sleep: async () => undefined,
			list: async () => [
				{ id: 10, ownerPid: 999, x: 0, y: 25, width: 1600, height: 900 }, // another app, perfect geometry
				{ id: 11, ownerPid: 500, x: 40, y: 117, width: 300, height: 200 }, // ours, small
				{ id: 12, ownerPid: 500, x: 13, y: 117, width: 1512, height: 982 }, // ours, largest, moved
			],
		});
		expect(id).toBe(12);
	});

	it("discoverDrivenWindowId polls until the window appears", async () => {
		let calls = 0;
		const id = await discoverDrivenWindowId({
			pid: 7,
			sleep: async () => undefined,
			list: async () => {
				calls += 1;
				return calls < 3 ? [] : [{ id: 7, ownerPid: 7, x: 0, y: 25, width: 1600, height: 900 }];
			},
		});
		expect(id).toBe(7);
		expect(calls).toBe(3);
	});

	it("discoverDrivenWindowId returns null (never throws) and logs the candidates when nothing matches or listing fails", async () => {
		const lines: string[] = [];
		const none = await discoverDrivenWindowId({
			pid: 1,
			sleep: async () => undefined,
			attempts: 3,
			log: (l) => lines.push(l),
			list: async () => [
				{ id: 5, ownerPid: 2, ownerName: "Google Chrome", x: 0, y: 117, width: 800, height: 600 },
			],
		});
		expect(none).toBeNull();
		expect(lines.join("\n")).toContain("pid 1");
		expect(lines.join("\n")).toContain("#5 pid=2");
		const failing = await discoverDrivenWindowId({
			pid: 1,
			sleep: async () => undefined,
			list: async () => {
				throw new Error("osascript missing");
			},
		});
		expect(failing).toBeNull();
	});

	it("pinWindowBounds sets the 1600x900 bounds at 0,25 through CDP and never throws", async () => {
		const calls: Array<[string, unknown]> = [];
		const ctx = fakePersistentContext({
			newCDPSession: async () => ({
				send: async (method, params) => {
					calls.push([method, params]);
					return { windowId: 77 };
				},
				detach: async () => undefined,
			}),
		});
		expect(await pinWindowBounds(ctx, {} as PageLike, () => undefined)).toBe(true);
		expect(calls[0]?.[0]).toBe("Browser.getWindowForTarget");
		expect(calls[1]).toEqual([
			"Browser.setWindowBounds",
			{
				windowId: 77,
				bounds: { windowState: "normal", left: 0, top: 25, width: 1600, height: 900 },
			},
		]);
		const lines: string[] = [];
		const broken = fakePersistentContext({
			newCDPSession: async () => {
				throw new Error("no cdp");
			},
		});
		expect(await pinWindowBounds(broken, {} as PageLike, (l) => lines.push(l))).toBe(false);
		expect(lines[0]).toContain("no cdp");
	});

	it("withLaunchedChrome({discoverWindow}) pins bounds via CDP BEFORE the lookup and hands fn the window found by PID; without the flag it never looks and passes null", async () => {
		const order: string[] = [];
		const list = async () => {
			order.push("list");
			return [
				{ id: 3, ownerPid: 4321, x: 0, y: 117, width: 1280, height: 720 }, // not at the requested position
				{ id: 1, ownerPid: 1, x: 0, y: 25, width: 1600, height: 900 },
			];
		};
		const run = (discoverWindow: boolean) =>
			withLaunchedChrome(
				{ profileDir: "/tmp/p", browserChannel: "chrome", discoverWindow },
				async (_ctx, _ch, windowId) => windowId,
				{
					createChoreographer: unusedChoreographer,
					launch: async () =>
						fakePersistentContext({
							newCDPSession: async () => ({
								send: async (method) => {
									order.push(method);
									return { windowId: 1 };
								},
							}),
						}),
					listChromeWindows: list,
					findBrowserPid: async () => 4321,
					log: () => undefined,
					sleep: async () => undefined,
				},
			);
		expect(await run(true)).toBe(3);
		expect(order).toEqual(["Browser.getWindowForTarget", "Browser.setWindowBounds", "list"]);
		order.length = 0;
		expect(await run(false)).toBeNull();
		expect(order).toEqual([]);
	});

	it("withLaunchedChrome({discoverWindow}) yields null and logs when the browser PID is unknown", async () => {
		const lines: string[] = [];
		const id = await withLaunchedChrome(
			{ profileDir: "/tmp/p", browserChannel: "chrome", discoverWindow: true },
			async (_ctx, _ch, windowId) => windowId,
			{
				createChoreographer: unusedChoreographer,
				launch: async () => fakePersistentContext(),
				listChromeWindows: async () => [],
				findBrowserPid: async () => null,
				log: (l) => lines.push(l),
				sleep: async () => undefined,
			},
		);
		expect(id).toBeNull();
		expect(lines.join("\n")).toContain("could not find the browser process");
	});
});

describe("BF-17: the driven Chrome is brought to the front before the first step", () => {
	function activationHarness(frontmostSequence: Array<number | null>) {
		const order: string[] = [];
		const seq = [...frontmostSequence];
		return {
			order,
			deps: {
				createChoreographer: (): ChoreographerLike => ({
					async start() {
						order.push("ch.start");
					},
					stop() {
						order.push("ch.stop");
					},
					async moveTo(x: number, y: number): Promise<MoveResultLike> {
						order.push(`ch.moveTo ${x},${y}`);
						return { x, y } as unknown as MoveResultLike;
					},
					async dwell() {
						// no-op
					},
					async click() {
						order.push("ch.click");
						return { x: 0, y: 0 };
					},
				}),
				launch: async () =>
					fakePersistentContext({
						pages: () => [
							{
								bringToFront: async () => {
									order.push("bringToFront");
								},
							} as unknown as PageLike,
						],
						newCDPSession: async () => ({
							send: async (method: string) => {
								order.push(method);
								return { windowId: 1 };
							},
						}),
					}),
				findBrowserPid: async () => 4321,
				activateProcess: async (pid: number) => {
					order.push(`activate ${pid}`);
				},
				frontmostPid: async () => (seq.length > 1 ? (seq.shift() ?? null) : (seq[0] ?? null)),
				listChromeWindows: async () => [],
				log: (l: string) => order.push(`log: ${l}`),
				sleep: async () => undefined,
			},
		};
	}

	it("activates exactly once, by PID, after the bounds are pinned and before fn (the first step) runs; no page-content input", async () => {
		const h = activationHarness([1, 4321]);
		await withLaunchedChrome(
			{ profileDir: "/tmp/p", browserChannel: "chrome", activate: true },
			async () => {
				h.order.push("FN");
			},
			h.deps,
		);
		const plain = h.order.filter((o) => !o.startsWith("log:"));
		expect(plain).toEqual([
			"Browser.getWindowForTarget",
			"Browser.setWindowBounds",
			"bringToFront",
			"activate 4321",
			"FN",
		]);
		expect(h.order.some((o) => o.includes("is frontmost"))).toBe(true);
		expect(h.order.some((o) => o.startsWith("ch."))).toBe(false);
	});

	it("does nothing when activate is not requested", async () => {
		const h = activationHarness([4321]);
		await withLaunchedChrome(
			{ profileDir: "/tmp/p", browserChannel: "chrome" },
			async () => undefined,
			h.deps,
		);
		expect(h.order).toEqual([]);
	});

	it("when frontmost is never confirmed it makes ONE click on the title-bar strip, not on page content, and says so", async () => {
		const h = activationHarness([1]);
		await withLaunchedChrome(
			{ profileDir: "/tmp/p", browserChannel: "chrome", activate: true },
			async () => {
				h.order.push("FN");
			},
			h.deps,
		);
		expect(h.order.filter((o) => o === "ch.click")).toHaveLength(1);
		const move = h.order.find((o) => o.startsWith("ch.moveTo"));
		// inside the window's title-bar strip: y within the first 40px under the window top (25)
		const y = Number(move?.split(",")[1]);
		expect(y).toBeGreaterThanOrEqual(25);
		expect(y).toBeLessThan(25 + 40);
		expect(h.order.indexOf("ch.click")).toBeLessThan(h.order.indexOf("FN"));
		expect(h.order.some((o) => o.includes("clicked the window title bar"))).toBe(true);
	});

	it("activateDrivenChrome never throws when activation itself fails", async () => {
		const lines: string[] = [];
		const ok = await activateDrivenChrome({
			page: { bringToFront: async () => undefined } as unknown as PageLike,
			pid: 7,
			choreographer: {
				start: async () => {
					throw new Error("no helper");
				},
				stop: () => undefined,
				moveTo: async () => ({}) as MoveResultLike,
				dwell: async () => undefined,
				click: async () => ({ x: 0, y: 0 }),
			},
			activate: async () => {
				throw new Error("boom");
			},
			frontmost: async () => null,
			sleep: async () => undefined,
			log: (l) => lines.push(l),
		});
		expect(ok).toBe(false);
		expect(lines.join("\n")).toContain("boom");
		expect(lines.join("\n")).toContain("no helper");
	});
});

describe("runDrive: say lines timed to the voice (CR-LENSMITH-A008-2)", () => {
	const boxes = {
		"#a": { x: 100, y: 100, width: 100, height: 100 }, // centre 150,150
		"#b": { x: 750, y: 100, width: 100, height: 100 }, // centre 800,150: 650 pt from #a
		"#f": { x: 100, y: 400, width: 200, height: 40 },
	};

	/** Virtual clock: travel, dwell, sleeps and a 450 ms settle advance it. The real cursor is never touched. */
	function harness() {
		const state = {
			clock: 0,
			sleeps: [] as number[],
			dwells: [] as number[],
			clicksAt: [] as number[],
		};
		const base = fakePage({
			elements: boxes,
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});
		const page: PageLike = {
			...base,
			async evaluate<T, Arg>(fn: (arg: Arg) => T, arg: Arg): Promise<T> {
				if (arg && typeof arg === "object" && "quietMs" in arg) state.clock += 450;
				return base.evaluate(fn, arg);
			},
		};
		const inner = fakeChoreographer();
		const choreographer: ChoreographerLike = {
			...inner,
			async moveTo(x, y, durationMs) {
				state.clock += durationMs ?? 0;
				return inner.moveTo(x, y, durationMs);
			},
			async dwell(ms) {
				state.dwells.push(ms ?? 0);
				state.clock += ms ?? 0;
			},
			async click() {
				state.clicksAt.push(state.clock);
				return inner.click();
			},
		};
		const deps = {
			page,
			choreographer,
			now: () => state.clock,
			sleep: async (ms: number) => {
				state.sleeps.push(ms);
				state.clock += ms;
			},
		};
		return { state, deps };
	}

	function timings(lines: Record<string, { durationMs: number; marks?: Record<string, number> }>) {
		const out: {
			lines: Record<string, { file: string; durationMs: number; marks: Record<string, number> }>;
		} = {
			lines: {},
		};
		for (const [id, l] of Object.entries(lines)) {
			out.lines[id] = { file: `${id}.wav`, durationMs: l.durationMs, marks: l.marks ?? {} };
		}
		return out;
	}

	it("the timing rule: a late mark stretches the dwell, an early mark delays the voice", () => {
		expect(narrationDwell(700, 900)).toEqual({ dwellMs: 700, voiceDelayMs: 500 });
		expect(narrationDwell(700, 2000)).toEqual({ dwellMs: 1300, voiceDelayMs: 0 });
		expect(narrationDwell(700, 1400)).toEqual({ dwellMs: 700, voiceDelayMs: 0 });
		expect(narrationDwell(560, undefined)).toEqual({ dwellMs: 700, voiceDelayMs: 0 });
	});

	it("a click step with say + mark at 900 ms clicks at voiceStart + 900 (voice start delayed, dwell unchanged)", async () => {
		const { state, deps } = harness();
		const { actionLog } = await runDriveReal(
			stepList([{ type: "click", selector: "#a", say: "Open the [[story]] Buildr story" }]),
			{ ...deps, narration: timings({ s0: { durationMs: 1800, marks: { story: 900 } } }) },
		);
		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");
		// travel 700 (first step) + dwell 700 = 1400 > 900: the voice starts 500 ms after the travel does.
		expect(state.dwells).toEqual([700]);
		expect(entry.startedAtMs).toBe(0);
		expect(entry.voiceLineId).toBe("s0");
		expect(entry.voiceStartMs).toBe(500);
		expect(entry.clickedAtMs).toBe(1400);
		expect(entry.clickedAtMs).toBe((entry.voiceStartMs ?? Number.NaN) + 900);
	});

	it("a mark later than travel + dwell stretches the dwell; the voice starts with the travel", async () => {
		const { state, deps } = harness();
		const { actionLog } = await runDriveReal(
			stepList([
				{ type: "click", selector: "#a", say: "After a long lead-in we open the [[go]] story" },
			]),
			{ ...deps, narration: timings({ s0: { durationMs: 3000, marks: { go: 2000 } } }) },
		);
		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");
		expect(state.dwells).toEqual([1300]);
		expect(entry.voiceStartMs).toBe(entry.startedAtMs);
		expect(entry.clickedAtMs).toBe(entry.startedAtMs + 2000);
	});

	it("the result hold lasts until max(settle + 1200, voice end + 600), then the normal pause", async () => {
		const { state, deps } = harness();
		const { actionLog } = await runDriveReal(
			stepList([
				{
					type: "click",
					selector: "#a",
					say: "A long [[go]] line that keeps talking well after the click",
				},
				{ type: "click", selector: "#b", say: "A [[go]] short one" },
			]),
			{
				...deps,
				narration: timings({
					s0: { durationMs: 4000, marks: { go: 900 } },
					s1: { durationMs: 1000, marks: { go: 300 } },
				}),
			},
		);
		const [first, second] = actionLog;
		if (first?.type !== "click" || second?.type !== "click")
			throw new Error("expected click entries");
		// Step 0: voice 500..4500, +600 = 5100; settle ends at 1400 + 450 = 1850; settle + 1200 = 3050 → hold 3250.
		// Step 1: the short line ends before settle + 1200 → the normal 1200 hold. The 1500 pause sits after the voice.
		expect(state.sleeps).toEqual([3250, 1500, 1200]);
		expect(second.startedAtMs).toBeGreaterThanOrEqual((first.voiceStartMs ?? 0) + 4000 + 600);
		expect(second.clickedAtMs).toBe((second.voiceStartMs ?? Number.NaN) + 300);
	});

	it("a say line without a mark starts with the travel and leaves the dwell alone", async () => {
		const { state, deps } = harness();
		const { actionLog } = await runDriveReal(
			stepList([{ type: "click", selector: "#a", say: "Here is the story" }]),
			{
				...deps,
				narration: timings({ s0: { durationMs: 1000 } }),
			},
		);
		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");
		expect(state.dwells).toEqual([700]);
		expect(entry.voiceStartMs).toBe(entry.startedAtMs);
		expect(state.sleeps).toEqual([1200]);
	});

	it("steps without say (with or without narration) behave exactly as today and carry no voice fields", async () => {
		for (const narration of [undefined, timings({})]) {
			const { state, deps } = harness();
			const { actionLog } = await runDriveReal(
				stepList([
					{ type: "click", selector: "#a" },
					{ type: "click", selector: "#b" },
				]),
				narration === undefined ? deps : { ...deps, narration },
			);
			expect(state.dwells).toEqual([700, 700]);
			expect(state.sleeps).toEqual([1200, 1500, 1200]);
			for (const entry of actionLog) {
				expect(entry.voiceLineId).toBeUndefined();
				expect(entry.voiceStartMs).toBeUndefined();
			}
		}
	});

	it("say lines are ignored when no narration is given", async () => {
		const { state, deps } = harness();
		const { actionLog } = await runDriveReal(
			stepList([{ type: "click", selector: "#a", say: "Open the [[story]] story" }]),
			deps,
		);
		expect(state.dwells).toEqual([700]);
		expect(state.sleeps).toEqual([1200]);
		expect(actionLog[0]?.voiceLineId).toBeUndefined();
	});

	it("a type step lands its mark on the focus click; a wait step lasts max(ms, voice + 600)", async () => {
		const { state, deps } = harness();
		const { actionLog } = await runDriveReal(
			stepList([
				{ type: "wait", ms: 500, say: "First, a word about the page" },
				{ type: "type", selector: "#f", text: "hello", say: "We type into the [[box]] search box" },
			]),
			{
				...deps,
				narration: timings({
					s0: { durationMs: 2000 },
					s1: { durationMs: 1500, marks: { box: 1000 } },
				}),
			},
		);
		const [wait, typed] = actionLog;
		if (wait?.type !== "wait" || typed?.type !== "type") throw new Error("expected wait then type");
		expect(state.sleeps[0]).toBe(2600);
		expect(wait.ms).toBe(500);
		expect(wait.voiceLineId).toBe("s0");
		expect(wait.voiceStartMs).toBe(wait.atMs);
		expect(typed.voiceLineId).toBe("s1");
		expect(state.clicksAt[0]).toBe((typed.voiceStartMs ?? Number.NaN) + 1000);
		expect(JSON.stringify(actionLog)).not.toContain("hello");
	});

	it("rejects narration that lacks a step's line or mark, before anything runs", async () => {
		const list = stepList([{ type: "click", selector: "#a", say: "Open the [[story]] story" }]);
		const { deps } = harness();
		await expect(runDriveReal(list, { ...deps, narration: timings({}) })).rejects.toThrow(
			/no line "s0"/,
		);
		await expect(
			runDriveReal(list, {
				...deps,
				narration: timings({ s0: { durationMs: 1000, marks: { other: 10 } } }),
			}),
		).rejects.toThrow(/marks \[\[story\]\]/);
		await expect(
			runDriveReal(list, {
				...deps,
				narration: timings({ s0: { durationMs: 1000, marks: { story: 1200 } } }),
			}),
		).rejects.toThrow(/no such mark within the line/);
		expect(() => readNarrationTimings("{nope", "t.json", list)).toThrow(/not valid JSON/);
		expect(() => readNarrationTimings(JSON.stringify({ lines: [] }), "t.json", list)).toThrow(
			/no "lines" object/,
		);
		expect(
			readNarrationTimings(
				JSON.stringify(timings({ s0: { durationMs: 1000, marks: { story: 400 } } })),
				"t.json",
				list,
			).lines.s0?.marks.story,
		).toBe(400);
	});
});

describe("runDrive: web right-click and web key (CR-LENSMITH-A011-5)", () => {
	const boxes = {
		"#node": { x: 100, y: 100, width: 100, height: 40 }, // centre 150,120
		"#q": { x: 300, y: 400, width: 200, height: 30 },
	};
	interface Recorded {
		mouse: { x: number; y: number; button: string | undefined }[];
		keys: string[];
		focused: string[];
		events: string[];
	}
	const instrumented = (): { page: PageLike; rec: Recorded } => {
		const rec: Recorded = { mouse: [], keys: [], focused: [], events: [] };
		const base = fakePage({
			elements: boxes,
			viewport: { width: 1280, height: 800 },
			windowOffset: { x: 0, y: 0 },
		});
		const page: PageLike = {
			...base,
			async bringToFront() {
				rec.events.push("front");
			},
			locator(selector: string) {
				const loc = base.locator(selector);
				return {
					...loc,
					async focus() {
						rec.focused.push(selector);
						rec.events.push(`focus:${selector}`);
					},
				};
			},
			mouse: {
				async click(x: number, y: number, options?: { button?: "left" | "right" }) {
					rec.mouse.push({ x, y, button: options?.button });
					rec.events.push(`mouse:${options?.button ?? "left"}`);
					await base.mouse.click(x, y);
				},
			},
			keyboard: {
				async press(key: string) {
					rec.keys.push(key);
					rec.events.push(`press:${key}`);
				},
			},
		};
		return { page, rec };
	};

	it("a click without button goes through the real-cursor click, as before", async () => {
		const { page, rec } = instrumented();
		let helperClicks = 0;
		const base = fakeChoreographer();
		const choreographer: ChoreographerLike = {
			...base,
			async click() {
				helperClicks += 1;
				return base.click();
			},
		};
		const { actionLog } = await runDrive(stepList([{ type: "click", selector: "#node" }]), {
			page,
			choreographer,
		});
		expect(helperClicks).toBe(1);
		// Only the calibration click reaches Playwright's mouse, never a right button.
		expect(rec.mouse.every((m) => m.button === undefined)).toBe(true);
		expect(actionLog[0]).not.toHaveProperty("button");
	});

	it("a right-click travels the real cursor first, then posts the right button at the element centre", async () => {
		const { page, rec } = instrumented();
		const calls: string[] = [];
		const base = fakeChoreographer();
		const choreographer: ChoreographerLike = {
			...base,
			async moveTo(x, y, d) {
				calls.push(`move:${x},${y}`);
				return base.moveTo(x, y, d);
			},
			async dwell() {
				calls.push("dwell");
			},
			async click() {
				calls.push("helper-click");
				return base.click();
			},
		};
		const recMouse = page.mouse.click.bind(page.mouse);
		page.mouse.click = async (x, y, options) => {
			calls.push(`mouse:${options?.button ?? "left"}`);
			await recMouse(x, y, options);
		};
		const { actionLog } = await runDrive(
			stepList([{ type: "click", selector: "#node", button: "right" }]),
			{ page, choreographer },
		);
		// calibration's left click first, then: travel, dwell, the right button — no helper click.
		expect(calls.slice(-3)).toEqual(["move:150,120", "dwell", "mouse:right"]);
		expect(calls).not.toContain("helper-click");
		expect(rec.mouse.at(-1)).toEqual({ x: 150, y: 120, button: "right" });
		const entry = actionLog[0];
		expect(entry).toMatchObject({ type: "click", selector: "#node", button: "right" });
		expect(entry).toMatchObject({ screenX: 150, screenY: 120 });
		const zooms = emitZoomRegions(actionLog, { width: 1280, height: 800 });
		expect(zooms.fragment.zoomRegions.length).toBe(1);
	});

	it("a web key focuses the page, then presses each chord with Playwright names", async () => {
		const { page, rec } = instrumented();
		const { actionLog } = await runDrive(
			{
				url: "http://localhost:4173/drive-test-page.html",
				steps: [{ type: "key", keys: ["cmd+enter", "escape"], label: "Run" }],
			} as StepList,
			{ page, choreographer: fakeChoreographer() },
		);
		expect(rec.keys).toEqual(["Meta+Enter", "Escape"]);
		const front = rec.events.lastIndexOf("front");
		expect(front).toBeGreaterThanOrEqual(0);
		expect(front).toBeLessThan(rec.events.indexOf("press:Meta+Enter"));
		expect(actionLog[0]).toMatchObject({
			index: 0,
			type: "key",
			keys: ["cmd+return", "escape"],
			label: "Run",
		});
		expect(actionLog[0]).not.toHaveProperty("app");
	});

	it("a web key with a selector focuses it first and zooms on it", async () => {
		const { page, rec } = instrumented();
		const { actionLog } = await runDrive(
			{
				url: "http://localhost:4173/drive-test-page.html",
				steps: [{ type: "key", keys: "cmd+enter", selector: "#q" }],
			} as StepList,
			{ page, choreographer: fakeChoreographer() },
		);
		expect(rec.focused).toEqual(["#q"]);
		expect(rec.events.indexOf("focus:#q")).toBeLessThan(rec.events.indexOf("press:Meta+Enter"));
		expect(actionLog[0]).toMatchObject({
			type: "key",
			selector: "#q",
			keys: ["cmd+return"],
			boundingBox: boxes["#q"],
		});
		expect(
			emitZoomRegions(actionLog, { width: 1280, height: 800 }).fragment.zoomRegions.length,
		).toBe(1);
	});

	it("a web key whose selector never appears fails naming the step", async () => {
		const { page } = instrumented();
		await expect(
			runDrive(
				{
					url: "http://localhost:4173/drive-test-page.html",
					steps: [{ type: "key", keys: "return", selector: "#missing", timeoutMs: 50 }],
				} as StepList,
				{ page, choreographer: fakeChoreographer() },
			),
		).rejects.toThrow(/index 0 \(type "key"\).*#missing/);
	});

	it("maps chords to Playwright key strings", () => {
		expect(playwrightChord({ key: "return", mods: ["cmd"] })).toBe("Meta+Enter");
		expect(playwrightChord({ key: "v", mods: ["cmd", "shift"] })).toBe("Meta+Shift+v");
		expect(playwrightChord({ key: "f5", mods: [] })).toBe("F5");
		expect(playwrightChord({ key: "left", mods: ["opt", "ctrl"] })).toBe("Alt+Control+ArrowLeft");
		expect(playwrightChord({ key: "delete", mods: [] })).toBe("Backspace");
	});
});

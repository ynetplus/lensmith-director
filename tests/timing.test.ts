import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ChoreographerLike,
	continuousPlanFor,
	continuousZoomFragment,
	DriveError,
	type NarrationTimings,
	narrationModeFrom,
	runDrive,
	settleInPage,
	validateContinuousSteps,
	validateNarration,
} from "../src/commands/drive.js";
import type { ActionLogEntry } from "../src/lib/actionLog.js";
import type { DriveStepList } from "../src/lib/stepList.js";
import {
	CONTINUOUS_NARRATION,
	DEFAULT_MOVE_DURATION_MS,
	distancePx,
	EASE_IN_OUT_CUBIC_PEAK_VELOCITY_FACTOR,
	easeInOutCubic,
	MAX_RECOMMENDED_MOVE_DURATION_MS,
	MIN_PEAK_VELOCITY_PX_PER_SEC,
	moveTimingWarnings,
	pauseBeforeNextStepMs,
	peakVelocityPxPerSec,
	planContinuousNarration,
	SETTLE_PACING,
	travelMs,
} from "../src/lib/timing.js";

const ORIGIN = { x: 0, y: 0 };

describe("easeInOutCubic", () => {
	it("is anchored at both ends and symmetric about the midpoint", () => {
		expect(easeInOutCubic(0)).toBe(0);
		expect(easeInOutCubic(1)).toBe(1);
		expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
		expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 12);
	});

	it("spends most of the move slower than a constant-speed move would", () => {
		// The whole point of the curve: it eases in and out, so at 25% of the
		// time it has covered far less than 25% of the distance.
		expect(easeInOutCubic(0.25)).toBeLessThan(0.25);
		expect(easeInOutCubic(0.75)).toBeGreaterThan(0.75);
	});

	it("peaks at 3x the average speed (the factor the velocity check relies on)", () => {
		// Numerically differentiate the curve and confirm the analytic peak.
		const h = 1e-6;
		let peak = 0;
		for (let t = h; t < 1 - h; t += 0.001) {
			peak = Math.max(peak, (easeInOutCubic(t + h) - easeInOutCubic(t - h)) / (2 * h));
		}
		expect(peak).toBeCloseTo(EASE_IN_OUT_CUBIC_PEAK_VELOCITY_FACTOR, 3);
	});
});

describe("peakVelocityPxPerSec", () => {
	it("is 3x distance over duration", () => {
		expect(peakVelocityPxPerSec(500, 500)).toBeCloseTo(3000, 6);
		expect(peakVelocityPxPerSec(200, 900)).toBeCloseTo(666.67, 1);
	});

	it("computes distance as a straight line between two points", () => {
		expect(distancePx({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
	});
});

describe("moveTimingWarnings — the measured recipe", () => {
	it("the recommended move (500px in 500ms) is clean", () => {
		expect(moveTimingWarnings(ORIGIN, { x: 500, y: 0 }, 500)).toEqual([]);
		expect(peakVelocityPxPerSec(500, DEFAULT_MOVE_DURATION_MS)).toBeGreaterThan(
			MIN_PEAK_VELOCITY_PX_PER_SEC,
		);
	});

	it("500px over 2500ms — the natural, attractive move — is flagged on both counts", () => {
		const warnings = moveTimingWarnings(ORIGIN, { x: 500, y: 0 }, 2500);
		expect(warnings).toHaveLength(2);
		expect(warnings.join(" ")).toContain("phantom region");
		expect(warnings.join(" ")).toContain("below");
	});

	it("200px over 900ms — a typical UI hop — is flagged as too slow to register", () => {
		const warnings = moveTimingWarnings(ORIGIN, { x: 200, y: 0 }, 900);
		expect(warnings.join(" ")).toContain(`below ${MIN_PEAK_VELOCITY_PX_PER_SEC}px/s`);
	});

	it("warns about fusing once past the recommended ceiling, before the phantom threshold", () => {
		const warnings = moveTimingWarnings(ORIGIN, { x: 2000, y: 0 }, 800);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`exceeds the recommended ${MAX_RECOMMENDED_MOVE_DURATION_MS}ms`);
	});

	it("says nothing about a zero-distance move", () => {
		expect(moveTimingWarnings(ORIGIN, ORIGIN, 5000)).toEqual([]);
	});

	it("treats negative-origin targets as ordinary coordinates", () => {
		// A second display can legitimately sit at a negative origin; the
		// distance is what matters, never the sign.
		expect(moveTimingWarnings({ x: 0, y: 0 }, { x: -1878, y: -1050 }, 500)).toEqual([]);
	});
});

describe("SETTLE_PACING — the Settle spec table (CR-LENSMITH-A007-2)", () => {
	it("holds exactly the spec numbers", () => {
		expect(SETTLE_PACING).toEqual({
			travelBaseMs: 300,
			travelPerPt: 0.4,
			travelMinMs: 400,
			travelMaxMs: 700,
			dwellMs: 700,
			settleQuietMs: 300,
			settleCapMs: 4000,
			resultHoldMs: 1200,
			breathMs: 800,
			typeCharDelayMs: 60,
			zoomScale: 1.8,
			zoomInMs: 900,
			zoomOutMs: 700,
			zoomMinGapAfterOutMs: 800,
			zoomConnectMarginRatio: 0.08,
		});
	});
});

describe("travelMs — clamp(300 + 0.4 x d, 400, 700)", () => {
	it("is 400 at d=100 (floor: 340 clamps up) and at 250 pt or less", () => {
		expect(travelMs(100)).toBe(400);
		expect(travelMs(250)).toBe(400);
		expect(travelMs(0)).toBe(400);
	});

	it("is 540 at d=600", () => {
		expect(travelMs(600)).toBe(540);
	});

	it("is 700 at d=1500 (ceiling) and at 1000 pt", () => {
		expect(travelMs(1500)).toBe(700);
		expect(travelMs(1000)).toBe(700);
	});

	it("never exceeds the director's own recommended maximum", () => {
		expect(SETTLE_PACING.travelMaxMs).toBe(MAX_RECOMMENDED_MOVE_DURATION_MS);
	});
});

describe("settleInPage — the in-page settle wait", () => {
	// A tiny stand-in for the three DOM globals the function touches. No browser.
	let mutate: () => void;
	let disconnected: boolean;
	let visibleSelectors: Set<string>;

	beforeEach(() => {
		vi.useFakeTimers();
		disconnected = false;
		visibleSelectors = new Set();
		class FakeObserver {
			constructor(cb: () => void) {
				mutate = cb;
			}
			observe() {
				// no-op: the test drives mutations by calling `mutate()`
			}
			disconnect() {
				disconnected = true;
			}
		}
		vi.stubGlobal("MutationObserver", FakeObserver);
		vi.stubGlobal("document", {
			querySelector: (sel: string) =>
				visibleSelectors.has(sel) ? { getClientRects: () => [1] } : null,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("returns at the expect selector as soon as it is visible", async () => {
		let done = false;
		const p = settleInPage({ expectSelector: "#result", quietMs: 300, capMs: 4000 }).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(done).toBe(false); // keeps waiting while the selector is absent
		visibleSelectors.add("#result");
		mutate();
		await p;
		expect(done).toBe(true);
		expect(disconnected).toBe(true);
	});

	it("without a selector, returns after 300 ms with no DOM mutation", async () => {
		let done = false;
		const p = settleInPage({ quietMs: 300, capMs: 4000 }).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(299);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await p;
		expect(done).toBe(true);
	});

	it("restarts the quiet window on every mutation", async () => {
		let done = false;
		const p = settleInPage({ quietMs: 300, capMs: 4000 }).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(200);
		mutate();
		await vi.advanceTimersByTimeAsync(200);
		expect(done).toBe(false); // 400 ms in, but only 200 ms since the last mutation
		await vi.advanceTimersByTimeAsync(100);
		await p;
		expect(done).toBe(true);
	});

	it("is capped at 4000 ms however busy the page stays", async () => {
		let done = false;
		const p = settleInPage({ quietMs: 300, capMs: 4000 }).then(() => {
			done = true;
		});
		for (let t = 0; t < 3900; t += 100) {
			await vi.advanceTimersByTimeAsync(100);
			mutate();
		}
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(100);
		await p;
		expect(done).toBe(true);
	});

	it("returns at once when the expect selector is already visible", async () => {
		visibleSelectors.add("#result");
		await settleInPage({ expectSelector: "#result", quietMs: 300, capMs: 4000 });
		expect(disconnected).toBe(false); // never even started observing
	});
});

describe("pauseBeforeNextStepMs (BF-11)", () => {
	it("is zoom-out + breath = 1500 when not connected, breath = 800 when connected", () => {
		expect(pauseBeforeNextStepMs(false)).toBe(1500);
		expect(pauseBeforeNextStepMs(true)).toBe(800);
	});
});

describe("planContinuousNarration (Settle LOCK v1.1, CR-LENSMITH-A011-6)", () => {
	const LEAD = 700 + SETTLE_PACING.dwellMs; // travel 700 + dwell 700

	it("chains lines 300 ms apart when every mark leaves the cursor time to arrive", () => {
		const plan = planContinuousNarration(
			[
				{ durationMs: 3000 },
				{ durationMs: 4000, markMs: 2000 },
				{ durationMs: 2000, markMs: 1800 },
			],
			[undefined, { travelMs: 700 }, { travelMs: 700 }],
		);
		expect(plan.steps.map((s) => s.lineStartMs)).toEqual([0, 3300, 7600]);
		expect(plan.steps.map((s) => s.gapBeforeMs)).toEqual([0, 300, 300]);
		expect(plan.steps.map((s) => s.delayMs)).toEqual([0, 0, 0]);
		expect(plan.endMs).toBe(9600 + CONTINUOUS_NARRATION.finalHoldMs);
	});

	it("lands each action on its mark and starts the travel travel + dwell earlier", () => {
		const plan = planContinuousNarration(
			[{ durationMs: 3000 }, { durationMs: 4000, markMs: 2000 }],
			[undefined, { travelMs: 500 }],
		);
		const step = plan.steps[1];
		expect(step?.actionMs).toBe(3300 + 2000);
		expect(step?.travelStartMs).toBe(3300 + 2000 - 500 - SETTLE_PACING.dwellMs);
	});

	it("starts a line later by exactly the travel + dwell deficit when its mark comes too early", () => {
		const plan = planContinuousNarration(
			[{ durationMs: 1000 }, { durationMs: 3000, markMs: 200 }],
			[undefined, { travelMs: 700 }],
		);
		// Natural start 1300; the cursor can leave at 0 and click at 1400 => line start >= 1200. No deficit.
		expect(plan.steps[1]?.delayMs).toBe(0);
		const tight = planContinuousNarration(
			[
				{ durationMs: 2000, markMs: 1900 },
				{ durationMs: 3000, markMs: 100 },
			],
			[{ travelMs: 700 }, { travelMs: 700 }],
		);
		// Line 0 click at 1900, cursor free at 2200; line 1 click >= 2200 + 1400 = 3600 => start 3500.
		const second = tight.steps[1];
		expect(second?.lineStartMs).toBe(3500);
		expect(second?.delayMs).toBe(3500 - 2300);
		expect(second?.actionMs).toBe(3600);
		expect(second?.lineEndMs).toBe(3500 + 3000); // never cut
	});

	it("delays the first line when its mark comes before the cursor can arrive", () => {
		const plan = planContinuousNarration([{ durationMs: 2000, markMs: 300 }], [{ travelMs: 700 }]);
		expect(plan.steps[0]?.lineStartMs).toBe(LEAD - 300);
		expect(plan.steps[0]?.travelStartMs).toBe(0);
	});

	it("rejects mismatched inputs and marks outside the line", () => {
		expect(() => planContinuousNarration([{ durationMs: 100 }], [])).toThrow(
			/1 lines but 0 actions/,
		);
		expect(() =>
			planContinuousNarration([{ durationMs: 100, markMs: 200 }], [{ travelMs: 400 }]),
		).toThrow(/mark outside the line/);
	});

	describe("DBX v2 fixture", () => {
		const fixture = JSON.parse(
			readFileSync(new URL("./fixtures/dbx-v2-continuous.json", import.meta.url), "utf-8"),
		) as { steps: []; timings: NarrationTimings };
		const plan = continuousPlanFor(fixture, fixture.timings);

		it("keeps every gap at 300 ms unless the cursor needs more, and lands every click on its mark", () => {
			fixture.steps.forEach((step: { type: string; say: string }, index) => {
				const planned = plan.steps[index];
				expect(planned).toBeDefined();
				if (!planned) return;
				if (index > 0)
					expect(planned.gapBeforeMs).toBe(CONTINUOUS_NARRATION.maxLineGapMs + planned.delayMs);
				const mark = /\[\[([^\]]+)\]\]/.exec(step.say)?.[1];
				const line = fixture.timings.lines[`s${index}`];
				if (step.type !== "wait" && mark !== undefined && line) {
					expect(planned.actionMs).toBe(planned.lineStartMs + (line.marks[mark] ?? Number.NaN));
				}
			});
		});

		it("produces the schedule recorded in the forge report", () => {
			// [line start, gap before, click]. The 3840 ms gap before "Run" is the typing (49 chars x 60 ms)
			// after the [[columns]] mark: the planner never cuts a line, so the script must move a mark.
			expect(plan.steps.map((s) => [s.lineStartMs, s.gapBeforeMs, s.actionMs ?? null])).toEqual([
				[0, 0, null],
				[3800, 300, null],
				[13300, 300, 13685],
				[17500, 300, 20200],
				[24840, 3840, 24840],
				[30540, 300, 30925],
				[34740, 300, 35895],
				[37595, 455, 37595],
				[38910, 515, 39295],
				[40410, 300, null],
			]);
			expect(plan.endMs).toBe(40410 + 7300 + CONTINUOUS_NARRATION.finalHoldMs);
		});
	});

	describe("speech bounds (BF-23)", () => {
		it("places each next first word 300 ms after the last word of padded lines (lead 400, trail 650)", () => {
			const padded = (durationMs: number) => ({
				durationMs,
				speechStartMs: 400,
				speechEndMs: durationMs - 650,
			});
			const plan = planContinuousNarration(
				[padded(3000), padded(4000), padded(2500)],
				[undefined, undefined, undefined],
			);
			// Line 0 speech ends at 2350; line 1's first word at 2650 => file start 2250.
			expect(plan.steps.map((s) => s.lineStartMs)).toEqual([0, 2250, 5500]);
			expect(plan.steps.map((s) => s.gapBeforeMs)).toEqual([0, 300, 300]);
			const speech = plan.steps.map((s, i) => [
				s.lineStartMs + 400,
				s.lineStartMs + [3000, 4000, 2500][i]! - 650,
			]);
			for (let i = 1; i < speech.length; i += 1) {
				expect(speech[i]![0] - speech[i - 1]![1]).toBe(CONTINUOUS_NARRATION.maxLineGapMs);
			}
			// The payoff hold still counts from the file end, unchanged.
			expect(plan.endMs).toBe(5500 + 2500 + CONTINUOUS_NARRATION.finalHoldMs);
		});

		it("keeps [[mark]] times file-relative and measures the travel + dwell deficit from speech end", () => {
			const plan = planContinuousNarration(
				[
					{ durationMs: 2000, markMs: 1900, speechStartMs: 400, speechEndMs: 1350 },
					{ durationMs: 3000, markMs: 500, speechStartMs: 400, speechEndMs: 2350 },
				],
				[{ travelMs: 700 }, { travelMs: 700 }],
			);
			// Natural start: 1350 + 300 - 400 = 1250. Cursor free at 1900 + 300; click >= 2200 + 1400 = 3600
			// => start 3600 - 500 = 3100, delay 1850, speech gap 3100 + 400 - 1350.
			const second = plan.steps[1];
			expect(second?.lineStartMs).toBe(3100);
			expect(second?.delayMs).toBe(3100 - 1250);
			expect(second?.gapBeforeMs).toBe(3100 + 400 - 1350);
			expect(second?.actionMs).toBe(3100 + 500);
		});

		it("falls back to the whole file when a line has no bounds: byte for byte the pre-BF-23 plan", () => {
			const fixture = JSON.parse(
				readFileSync(new URL("./fixtures/dbx-v2-continuous.json", import.meta.url), "utf-8"),
			) as { steps: []; timings: NarrationTimings };
			// Recorded from origin/main fd088d2 before the change.
			expect(JSON.stringify(continuousPlanFor(fixture, fixture.timings))).toBe(
				'{"steps":[{"index":0,"lineStartMs":0,"lineEndMs":3500,"gapBeforeMs":0,"delayMs":0},{"index":1,"lineStartMs":3800,"lineEndMs":13000,"gapBeforeMs":300,"delayMs":0},{"index":2,"lineStartMs":13300,"lineEndMs":17200,"gapBeforeMs":300,"delayMs":0,"actionMs":13685,"travelStartMs":12285},{"index":3,"lineStartMs":17500,"lineEndMs":21000,"gapBeforeMs":300,"delayMs":0,"actionMs":20200,"travelStartMs":18800},{"index":4,"lineStartMs":24840,"lineEndMs":30240,"gapBeforeMs":3840,"delayMs":3540,"actionMs":24840,"travelStartMs":23440},{"index":5,"lineStartMs":30540,"lineEndMs":34440,"gapBeforeMs":300,"delayMs":0,"actionMs":30925,"travelStartMs":29525},{"index":6,"lineStartMs":34740,"lineEndMs":37140,"gapBeforeMs":300,"delayMs":0,"actionMs":35895,"travelStartMs":34495},{"index":7,"lineStartMs":37595,"lineEndMs":38395,"gapBeforeMs":455,"delayMs":155,"actionMs":37595,"travelStartMs":36195},{"index":8,"lineStartMs":38910,"lineEndMs":40110,"gapBeforeMs":515,"delayMs":215,"actionMs":39295,"travelStartMs":37895},{"index":9,"lineStartMs":40410,"lineEndMs":47710,"gapBeforeMs":300,"delayMs":0}],"endMs":48910}',
			);
		});

		it("dry plan: the ten DBX lines with the engine's measured bounds", () => {
			const durations = [11550, 4775, 8900, 5875, 4575, 1800, 2300, 1925, 2250, 9500];
			const starts = [407, 417, 387, 423, 413, 395, 403, 375, 398, 414];
			const ends = [10898, 4162, 8332, 5333, 3923, 1243, 1798, 1411, 1606, 8998];
			const marks = [
				{},
				{ postgres: 725 },
				{ type: 350 },
				{ run: 425 },
				{ redis: 650 },
				{ one: 400 },
				{ right: 425 },
				{ structure: 375 },
				{ view: 612 },
				{},
			];
			const steps = [
				{ type: "wait", ms: 400, say: "Intro." },
				{ type: "click", selector: "#a", say: "Open [[postgres]] Postgres." },
				{
					type: "type",
					selector: "#b",
					text: "SELECT name, price FROM products WHERE price > 50",
					say: "[[type]] Type a query.",
				},
				{ type: "key", keys: "cmd+enter", selector: "#b", say: "[[run]] Run it." },
				{ type: "click", selector: "#c", say: "Now [[redis]] Redis." },
				{ type: "click", selector: "#d", say: "[[one]] One more thing." },
				{ type: "click", selector: "#e", say: "[[right]] Right-click the database." },
				{ type: "click", selector: "#f", say: "[[structure]] Structure tools," },
				{ type: "click", selector: "#g", say: "then [[view]] View Diagram." },
				{ type: "wait", ms: 1200, say: "Payoff." },
			] as unknown as DriveStepList["steps"];
			const timings = validateNarration(
				{
					lines: Object.fromEntries(
						durations.map((durationMs, i) => [
							`s${i}`,
							{ durationMs, marks: marks[i], speechStartMs: starts[i], speechEndMs: ends[i] },
						]),
					),
				},
				{ steps } as never,
			);
			const plan = continuousPlanFor({ steps }, timings);
			const speechGaps = plan.steps.map((s, i) =>
				i === 0 ? 0 : s.lineStartMs + starts[i]! - (plan.steps[i - 1]!.lineStartMs + ends[i - 1]!),
			);
			expect(speechGaps).toEqual(plan.steps.map((s) => s.gapBeforeMs));
			// 300 everywhere except s6..s8, where the click before (cursor busy + 700 travel + 700 dwell)
			// leaves the cursor too little time to reach the early mark: the line waits, never cut.
			expect(plan.steps.map((s) => [s.lineStartMs, s.gapBeforeMs, s.delayMs])).toEqual([
				[0, 0, 0],
				[10781, 300, 0],
				[14856, 300, 0],
				[23065, 300, 0],
				[28285, 300, 0],
				[32113, 300, 0],
				[33788, 835, 535],
				[35538, 327, 27],
				[37001, 450, 150],
				[38493, 300, 0],
			]);
		});

		it("validates the bounds in timings.json: both or neither, integers, inside the line", () => {
			const steps = [{ type: "wait", ms: 100, say: "One." }] as unknown as DriveStepList["steps"];
			const check = (line: Record<string, unknown>) =>
				validateNarration({ lines: { s0: { durationMs: 1000, marks: {}, ...line } } }, {
					steps,
				} as never);
			expect(() => check({})).not.toThrow();
			expect(() => check({ speechStartMs: 400, speechEndMs: 1000 })).not.toThrow();
			expect(() => check({ speechStartMs: 400 })).toThrow(/line "s0": .*only one is present/);
			expect(() => check({ speechEndMs: 600 })).toThrow(/line "s0": .*only one is present/);
			for (const bad of [
				{ speechStartMs: 600, speechEndMs: 600 },
				{ speechStartMs: -1, speechEndMs: 600 },
				{ speechStartMs: 400, speechEndMs: 1001 },
				{ speechStartMs: 400.5, speechEndMs: 600 },
				{ speechStartMs: "400", speechEndMs: 600 },
			]) {
				expect(() => check(bad)).toThrow(/line "s0": speech bounds must be integers/);
			}
		});
	});

	it("refuses a silent step in continuous mode, naming the step", () => {
		expect(() =>
			validateContinuousSteps({
				steps: [
					{ type: "wait", ms: 100, say: "Hello." },
					{ type: "click", selector: "#go" },
				],
			}),
		).toThrow(DriveError);
		expect(() => validateContinuousSteps({ steps: [{ type: "click", selector: "#go" }] })).toThrow(
			/step at index 0 \(type "click"\) has no "say" line/,
		);
	});
});

describe("continuous narration wiring (CR-LENSMITH-A011-6)", () => {
	it("reads the mode from the flag, else the step list, else settle", () => {
		expect(narrationModeFrom('{"steps":[]}')).toBe("settle");
		expect(narrationModeFrom('{"narration":"continuous","steps":[]}')).toBe("continuous");
		expect(narrationModeFrom('{"narration":"continuous"}', "settle")).toBe("settle");
		expect(() => narrationModeFrom('{"narration":"loud"}')).toThrow(/settle" or "continuous/);
	});

	it("drives narrated waits on the plan: voice starts 300 ms apart, film ends at the payoff hold", async () => {
		let clock = 0;
		const timings: NarrationTimings = {
			lines: { s0: { durationMs: 1000, marks: {} }, s1: { durationMs: 2000, marks: {} } },
		};
		const list = {
			steps: [
				{ type: "wait", ms: 5000, say: "One." },
				{ type: "wait", ms: 5000, say: "Two." },
			],
		} as unknown as DriveStepList;
		const { actionLog, plan } = await runDrive(list, {
			choreographer: {} as ChoreographerLike,
			narration: timings,
			narrationMode: "continuous",
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		expect(actionLog.map((e) => e.voiceStartMs)).toEqual([0, 1300]);
		expect(plan?.endMs).toBe(1300 + 2000 + CONTINUOUS_NARRATION.finalHoldMs);
		expect(clock).toBe(plan?.endMs);
	});

	it("refuses a continuous run without voice timings", async () => {
		await expect(
			runDrive({ steps: [{ type: "wait", ms: 1, say: "x" }] } as unknown as DriveStepList, {
				choreographer: {} as ChoreographerLike,
				narrationMode: "continuous",
				now: () => 0,
				sleep: async () => undefined,
			}),
		).rejects.toThrow(/needs the voice timings/);
	});

	it("ends each zoom region where the next travel starts, the last at the film end, under voice", () => {
		const log = [
			{ index: 2, type: "click", startedAtMs: 1000, clickedAtMs: 2400 },
			{ index: 3, type: "click", startedAtMs: 4000, clickedAtMs: 5400 },
		] as unknown as ActionLogEntry[];
		const region = (id: string, startMs: number) => ({
			id,
			startMs,
			endMs: startMs + 3000,
			focus: { cx: 0.5, cy: 0.5 },
			connect: false,
			depth: 3,
			customScale: 1.8,
			source: "auto" as const,
		});
		const out = continuousZoomFragment(
			{ zoomRegions: [region("zoom-2", 1000), region("zoom-3", 6500)] },
			log,
			9000,
		);
		expect(out.zoomRegions.map((r) => [r.startMs, r.endMs])).toEqual([
			[1000, 4000],
			[4000, 9000],
		]);
		expect(out.zoomRegions.every((r) => (r as { underVoice?: boolean }).underVoice === true)).toBe(
			true,
		);
	});
});

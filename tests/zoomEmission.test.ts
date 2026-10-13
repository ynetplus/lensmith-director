import { describe, expect, it } from "vitest";
import type { ActionLogEntry } from "../src/lib/actionLog.js";
import { SETTLE_PACING } from "../src/lib/timing.js";
import { emitZoomRegions } from "../src/lib/zoomEmission.js";

const VIEWPORT = { width: 1000, height: 500 };

function clickEntry(
	overrides: Partial<Extract<ActionLogEntry, { type: "click" }>>,
): ActionLogEntry {
	return {
		index: 0,
		type: "click",
		selector: "#a",
		startedAtMs: 1000,
		clickedAtMs: 1400,
		settleMs: 450,
		screenX: 0,
		screenY: 0,
		boundingBox: { x: 100, y: 50, width: 40, height: 20 },
		...overrides,
	};
}

function typeEntry(overrides: Partial<Extract<ActionLogEntry, { type: "type" }>>): ActionLogEntry {
	return {
		index: 0,
		type: "type",
		selector: "#field",
		startedAtMs: 1000,
		endedAtMs: 1600,
		screenX: 0,
		screenY: 0,
		boundingBox: { x: 100, y: 50, width: 40, height: 20 },
		characterCount: 5,
		settleMs: 450,
		...overrides,
	};
}

describe("emitZoomRegions", () => {
	it("BF-12: every region carries depth 3, customScale = SETTLE_PACING.zoomScale and source auto", () => {
		const actionLog: ActionLogEntry[] = [
			clickEntry({ index: 0 }),
			typeEntry({ index: 1, boundingBox: { x: 700, y: 300, width: 60, height: 30 } }),
		];
		const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
		expect(fragment.zoomRegions).toHaveLength(2);
		for (const region of fragment.zoomRegions) {
			expect(region.depth).toBe(3);
			expect(region.customScale).toBe(SETTLE_PACING.zoomScale);
			expect(region.customScale).toBe(1.8);
			expect(region.source).toBe("auto");
		}
	});

	it("emits exactly one region per click entry, none for wait entries", () => {
		const actionLog: ActionLogEntry[] = [
			clickEntry({ index: 0 }),
			{ index: 1, type: "wait", atMs: 1450, ms: 500 },
			clickEntry({ index: 2, boundingBox: { x: 500, y: 200, width: 60, height: 30 } }),
		];
		const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
		expect(fragment.zoomRegions).toHaveLength(2);
		expect(fragment.zoomRegions.map((r) => r.id)).toEqual(["zoom-0", "zoom-2"]);
	});

	it("Settle: startMs = travel start; endMs = clickedAtMs + settleMs + 1200", () => {
		const actionLog: ActionLogEntry[] = [
			clickEntry({ startedAtMs: 1000, clickedAtMs: 1400, settleMs: 450 }),
		];
		const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
		const region = fragment.zoomRegions[0];
		expect(region).toBeDefined();
		expect(region?.startMs).toBe(1000);
		expect(region?.endMs).toBe(1400 + 450 + 1200);
	});

	it("clamps startMs at 0 rather than going negative", () => {
		const actionLog: ActionLogEntry[] = [clickEntry({ startedAtMs: -50, clickedAtMs: 300 })];
		const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
		expect(fragment.zoomRegions[0]?.startMs).toBe(0);
	});

	it("normalizes focus.cx/cy to the bounding-box center over the viewport size", () => {
		const actionLog: ActionLogEntry[] = [
			clickEntry({ boundingBox: { x: 100, y: 50, width: 40, height: 20 } }),
		];
		const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
		const region = fragment.zoomRegions[0];
		// center = (100 + 20, 50 + 10) = (120, 60); normalized over 1000x500.
		expect(region?.focus.cx).toBeCloseTo(120 / 1000);
		expect(region?.focus.cy).toBeCloseTo(60 / 500);
	});

	it("every emitted region satisfies compose's own validation rules (startMs < endMs, cx/cy in 0..1, non-empty id)", () => {
		const actionLog: ActionLogEntry[] = [
			clickEntry({ index: 0, startedAtMs: 1000, clickedAtMs: 1400 }),
			clickEntry({
				index: 1,
				startedAtMs: 5000,
				clickedAtMs: 5350,
				boundingBox: { x: 900, y: 480, width: 20, height: 15 },
			}),
		];
		const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
		expect(fragment.zoomRegions).toHaveLength(2);
		for (const region of fragment.zoomRegions) {
			expect(region.id.length).toBeGreaterThan(0);
			expect(region.startMs).toBeLessThan(region.endMs);
			expect(region.focus.cx).toBeGreaterThanOrEqual(0);
			expect(region.focus.cx).toBeLessThanOrEqual(1);
			expect(region.focus.cy).toBeGreaterThanOrEqual(0);
			expect(region.focus.cy).toBeLessThanOrEqual(1);
		}
	});

	it("clamps an out-of-range focus and reports a warning rather than emitting an invalid fragment", () => {
		// A bounding box hanging off the right/bottom edge of the viewport
		// (e.g. a partially scrolled-to element) would otherwise normalize > 1.
		const actionLog: ActionLogEntry[] = [
			clickEntry({ boundingBox: { x: 980, y: 490, width: 100, height: 60 } }),
		];
		const { fragment, warnings } = emitZoomRegions(actionLog, VIEWPORT);
		const region = fragment.zoomRegions[0];
		expect(region?.focus.cx).toBe(1);
		expect(region?.focus.cy).toBe(1);
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("the last region never connects", () => {
		const { fragment } = emitZoomRegions([clickEntry({})], VIEWPORT);
		expect(fragment.zoomRegions[0]?.connect).toBe(false);
	});

	it("emits an empty zoomRegions array for an action log with no click entries", () => {
		const actionLog: ActionLogEntry[] = [{ index: 0, type: "wait", atMs: 0, ms: 500 }];
		const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
		expect(fragment.zoomRegions).toEqual([]);
	});

	// CR-LENSMITH-A002-6 — a `type` step's zoom region, derived the same way a
	// click's is (Technical Spec item 3), spanning from before the field is
	// focused (startedAtMs - leadIn) to after the last character (endedAtMs + hold).
	describe("type entries", () => {
		it("emits exactly one region per type entry, using startedAtMs/endedAtMs (not clickedAtMs)", () => {
			const actionLog: ActionLogEntry[] = [
				typeEntry({ index: 0, startedAtMs: 1000, endedAtMs: 1600 }),
			];
			const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
			expect(fragment.zoomRegions).toHaveLength(1);
			const region = fragment.zoomRegions[0];
			expect(region?.id).toBe("zoom-0");
			expect(region?.startMs).toBe(1000);
			expect(region?.endMs).toBe(1600 + 450 + 1200);
		});

		it("focuses on the field's bounding-box center, same formula as a click entry", () => {
			const actionLog: ActionLogEntry[] = [
				typeEntry({ boundingBox: { x: 100, y: 50, width: 40, height: 20 } }),
			];
			const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
			const region = fragment.zoomRegions[0];
			expect(region?.focus.cx).toBeCloseTo(120 / 1000);
			expect(region?.focus.cy).toBeCloseTo(60 / 500);
		});

		it("emits one region each for a mixed click/type/wait action log, in step order", () => {
			const actionLog: ActionLogEntry[] = [
				clickEntry({ index: 0 }),
				typeEntry({ index: 1, boundingBox: { x: 500, y: 200, width: 60, height: 30 } }),
				{ index: 2, type: "wait", atMs: 1700, ms: 100 },
				clickEntry({ index: 3, boundingBox: { x: 700, y: 300, width: 60, height: 30 } }),
			];
			const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
			expect(fragment.zoomRegions.map((r) => r.id)).toEqual(["zoom-0", "zoom-1", "zoom-3"]);
		});

		it("never carries the typed text or a characterCount field on the emitted region", () => {
			const actionLog: ActionLogEntry[] = [typeEntry({ characterCount: 5 })];
			const { fragment } = emitZoomRegions(actionLog, VIEWPORT);
			const region = fragment.zoomRegions[0];
			expect(region).toBeDefined();
			expect(Object.hasOwn(region as object, "text")).toBe(false);
			expect(Object.hasOwn(region as object, "characterCount")).toBe(false);
		});
	});
});

// CR-LENSMITH-A007-10 — the connect flag and the 800 ms floor. VIEWPORT is 1000x500,
// so the 1.8x frame is 555.6 x 277.8 and the 8 percent margin is 44.4 x 22.2.
describe("emitZoomRegions: connect and the zoom-in floor (Settle)", () => {
	const near = { x: 300, y: 100, width: 60, height: 30 }; // centre 330,115 (frame left 52.2..607.8 after clamp)
	const first = { x: 100, y: 50, width: 40, height: 20 }; // centre 120,60 -> frame clamps to 0..555.6 x 0..277.8

	it("connect is true when the next target box lies inside the zoomed frame with the margin", () => {
		const { fragment } = emitZoomRegions(
			[clickEntry({ index: 0, boundingBox: first }), clickEntry({ index: 1, boundingBox: near })],
			VIEWPORT,
		);
		expect(fragment.zoomRegions[0]?.connect).toBe(true);
	});

	it("connect is false when the next target lies outside the frame", () => {
		const far = { x: 800, y: 400, width: 60, height: 30 };
		const { fragment } = emitZoomRegions(
			[clickEntry({ index: 0, boundingBox: first }), clickEntry({ index: 1, boundingBox: far })],
			VIEWPORT,
		);
		expect(fragment.zoomRegions[0]?.connect).toBe(false);
	});

	it("connect is false when the next box is inside the frame but within the 8 percent margin", () => {
		// Frame is 0..555.6 wide; the margin keeps boxes within 44.4..511.2. This box ends at 530.
		const edge = { x: 470, y: 100, width: 60, height: 30 };
		const { fragment } = emitZoomRegions(
			[clickEntry({ index: 0, boundingBox: first }), clickEntry({ index: 1, boundingBox: edge })],
			VIEWPORT,
		);
		expect(fragment.zoomRegions[0]?.connect).toBe(false);
		// Just inside the margin on the same row connects: right edge 510 <= 511.2.
		const inside = { x: 450, y: 100, width: 60, height: 30 };
		const { fragment: ok } = emitZoomRegions(
			[clickEntry({ index: 0, boundingBox: first }), clickEntry({ index: 1, boundingBox: inside })],
			VIEWPORT,
		);
		expect(ok.zoomRegions[0]?.connect).toBe(true);
	});

	it("never starts a zoom-in within 800 ms of a non-connected zoom-out's end (shifts it later)", () => {
		const far = { x: 800, y: 400, width: 60, height: 30 };
		// Region 0 ends at 1400 + 450 + 1200 = 3050; its zoom-out ends at 3050 + 700 = 3750.
		// Region 1's natural start 3850 is only 100 ms after that: shifted to 3750 + 800 = 4550.
		const { fragment } = emitZoomRegions(
			[
				clickEntry({ index: 0, boundingBox: first }),
				clickEntry({
					index: 1,
					boundingBox: far,
					startedAtMs: 3850,
					clickedAtMs: 5100,
				}),
			],
			VIEWPORT,
		);
		const [r0, r1] = fragment.zoomRegions;
		expect(r0?.endMs).toBe(3050);
		expect(r1?.startMs).toBe(3050 + SETTLE_PACING.zoomOutMs + SETTLE_PACING.zoomMinGapAfterOutMs);
		expect(r1?.startMs).toBe(4550);
	});

	it("leaves a start alone when it is already 800 ms or more after the zoom-out end", () => {
		const far = { x: 800, y: 400, width: 60, height: 30 };
		const { fragment } = emitZoomRegions(
			[
				clickEntry({ index: 0, boundingBox: first }),
				clickEntry({ index: 1, boundingBox: far, startedAtMs: 6000, clickedAtMs: 7000 }),
			],
			VIEWPORT,
		);
		expect(fragment.zoomRegions[1]?.startMs).toBe(6000);
	});

	it("applies no floor after a connected region (the camera pans, there is no zoom-out)", () => {
		const { fragment } = emitZoomRegions(
			[
				clickEntry({ index: 0, boundingBox: first }),
				clickEntry({ index: 1, boundingBox: near, startedAtMs: 3850, clickedAtMs: 5100 }),
			],
			VIEWPORT,
		);
		expect(fragment.zoomRegions[0]?.connect).toBe(true);
		expect(fragment.zoomRegions[1]?.startMs).toBe(3850);
	});
});

describe("Invariant: no dwell-heuristic code path is reachable from the new `drive` files", () => {
	it("contains neither 'zoomSuggestion' nor 'DWELL' in any new source file", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const path = await import("node:path");
		const __dirname = path.dirname(fileURLToPath(import.meta.url));
		const repoRoot = path.join(__dirname, "..");
		const newFiles = [
			"src/lib/actionLog.ts",
			"src/lib/stepList.ts",
			"src/lib/calibration.ts",
			"src/lib/zoomEmission.ts",
			"src/commands/drive.ts",
		];
		for (const relative of newFiles) {
			const source = readFileSync(path.join(repoRoot, relative), "utf-8");
			expect(source, `${relative} must not reference the dwell detector`).not.toMatch(
				/zoomSuggestion|DWELL/,
			);
		}
	});
});

describe("emitZoomRegions — native hover and key (CR-LENSMITH-A010-8)", () => {
	const hover: ActionLogEntry = {
		index: 0,
		type: "hover",
		app: "com.example.app",
		selector: "ax:AXRow",
		ax: { role: "AXRow" },
		startedAtMs: 1000,
		hoveredAtMs: 1500,
		screenX: 0,
		screenY: 0,
		boundingBox: { x: 100, y: 50, width: 40, height: 20 },
		settleMs: 300,
		settleReason: "quiet",
	} as ActionLogEntry;
	const zoomedKey: ActionLogEntry = {
		index: 1,
		type: "key",
		app: "com.example.app",
		keys: ["opt+space"],
		atMs: 6000,
		settleMs: 200,
		settleReason: "quiet",
		boundingBox: { x: 700, y: 300, width: 60, height: 30 },
	};
	const plainKey: ActionLogEntry = {
		index: 2,
		type: "key",
		app: "com.example.app",
		keys: ["return"],
		atMs: 9000,
		settleMs: 200,
		settleReason: "quiet",
	};

	it("emits a hover region ending at hoveredAtMs + settle + hold", () => {
		const { fragment } = emitZoomRegions([hover], VIEWPORT);
		expect(fragment.zoomRegions).toHaveLength(1);
		const [region] = fragment.zoomRegions;
		expect(region?.id).toBe("zoom-0");
		expect(region?.startMs).toBe(1000);
		expect(region?.endMs).toBe(1500 + 300 + SETTLE_PACING.resultHoldMs);
		expect(region?.focus).toEqual({ cx: 0.12, cy: 0.12 });
	});

	it("emits a zoomed key region starting at atMs (no travel), and none for a key without zoom", () => {
		const { fragment } = emitZoomRegions([zoomedKey, plainKey], VIEWPORT);
		expect(fragment.zoomRegions).toHaveLength(1);
		const [region] = fragment.zoomRegions;
		expect(region?.id).toBe("zoom-1");
		expect(region?.startMs).toBe(6000);
		expect(region?.endMs).toBe(6000 + 200 + SETTLE_PACING.resultHoldMs);
		expect(region?.connect).toBe(false);
	});

	it("keeps the minimum gap after a non-connected region for native entries too", () => {
		const earlyKey = { ...zoomedKey, atMs: 1600 } as ActionLogEntry;
		const { fragment } = emitZoomRegions([hover, earlyKey], VIEWPORT);
		const [first, second] = fragment.zoomRegions;
		expect(first?.connect).toBe(false);
		expect(second?.startMs).toBe(
			(first?.endMs ?? 0) + SETTLE_PACING.zoomOutMs + SETTLE_PACING.zoomMinGapAfterOutMs,
		);
	});
});

describe("CR-LENSMITH-A011-9 shot grammar in emitZoomRegions", () => {
	const hold = SETTLE_PACING.resultHoldMs;
	const waitEntry = (
		index: number,
		atMs: number,
		ms: number,
		voiceStartMs?: number,
	): ActionLogEntry => ({
		index,
		type: "wait",
		atMs,
		ms,
		...(voiceStartMs === undefined ? {} : { voiceStartMs }),
	});

	it("two consecutive close steps on the same spot share ONE region (no bounce)", () => {
		const log = [
			clickEntry({ index: 0, startedAtMs: 1000, clickedAtMs: 1400, settleMs: 400 }),
			clickEntry({
				index: 1,
				startedAtMs: 3500,
				clickedAtMs: 3900,
				settleMs: 300,
				boundingBox: { x: 150, y: 60, width: 40, height: 20 },
			}),
		];
		const { fragment } = emitZoomRegions(log, VIEWPORT, ["close", "close"]);
		expect(fragment.zoomRegions).toHaveLength(1);
		expect(fragment.zoomRegions[0]).toMatchObject({
			id: "zoom-0",
			startMs: 1000,
			endMs: 3900 + 300 + hold,
		});
	});

	it("same spot but starting more than 1500 ms after the previous end keeps two regions", () => {
		const log = [
			clickEntry({ index: 0, startedAtMs: 1000, clickedAtMs: 1400, settleMs: 400 }),
			clickEntry({
				index: 1,
				startedAtMs: 1400 + 400 + hold + 1501,
				clickedAtMs: 6000,
				settleMs: 0,
			}),
		];
		expect(emitZoomRegions(log, VIEWPORT, ["close", "close"]).fragment.zoomRegions).toHaveLength(2);
	});

	it("follow connects to the previous region even when the target is outside its frame", () => {
		const far = { x: 900, y: 450, width: 40, height: 20 };
		const log = [
			clickEntry({ index: 0 }),
			clickEntry({ index: 1, startedAtMs: 3000, clickedAtMs: 3400, boundingBox: far }),
		];
		expect(
			emitZoomRegions(log, VIEWPORT, ["close", "close"]).fragment.zoomRegions[0]?.connect,
		).toBe(false);
		const followed = emitZoomRegions(log, VIEWPORT, ["close", "follow"]).fragment.zoomRegions;
		expect(followed).toHaveLength(2);
		expect(followed[0]?.connect).toBe(true);
		expect(followed[1]?.startMs).toBe(3000);
	});

	it("wide emits no region, ends the open region at its start, and records the close for later passes", () => {
		const log = [clickEntry({ index: 0 }), waitEntry(1, 2000, 5000, 1900)];
		const result = emitZoomRegions(log, VIEWPORT, ["close", "wide"]);
		expect(result.fragment.zoomRegions).toHaveLength(1);
		expect(result.fragment.zoomRegions[0]).toMatchObject({ endMs: 2000, connect: false });
		expect(result.closedAtMs).toEqual({ "zoom-0": 2000 });
	});

	it("a close step marked wide emits no region of its own", () => {
		const log = [clickEntry({ index: 0 })];
		expect(emitZoomRegions(log, VIEWPORT, ["wide"]).fragment.zoomRegions).toEqual([]);
	});

	it("hold moves the previous region's end to the hold's end", () => {
		const log = [clickEntry({ index: 0 }), waitEntry(1, 2000, 9000)];
		const { fragment } = emitZoomRegions(log, VIEWPORT, ["close", "hold"]);
		expect(fragment.zoomRegions).toHaveLength(1);
		expect(fragment.zoomRegions[0]?.endMs).toBe(11000);
	});

	it("reveal ends the open region at the entry's line start and adds nothing", () => {
		const log = [clickEntry({ index: 0 }), waitEntry(1, 2600, 4000, 2100)];
		const result = emitZoomRegions(log, VIEWPORT, ["close", "reveal"]);
		expect(result.fragment.zoomRegions).toHaveLength(1);
		expect(result.fragment.zoomRegions[0]?.endMs).toBe(2100);
		expect(result.closedAtMs).toEqual({ "zoom-0": 2100 });
	});

	it("without shots every entry is close: distinct spots keep today's regions", () => {
		const log = [
			clickEntry({ index: 0 }),
			clickEntry({
				index: 1,
				startedAtMs: 3000,
				clickedAtMs: 3400,
				boundingBox: { x: 800, y: 400, width: 40, height: 20 },
			}),
		];
		const regions = emitZoomRegions(log, VIEWPORT).fragment.zoomRegions;
		expect(regions.map((r) => r.id)).toEqual(["zoom-0", "zoom-1"]);
	});

	/** The recorded action log of a real 1920x1080 pilot run (times in ms, boxes in CSS px). */
	const PILOT_LOG: ActionLogEntry[] = [
		waitEntry(0, 32, 400, 0),
		clickEntry({
			index: 1,
			startedAtMs: 10168,
			clickedAtMs: 11603,
			settleMs: 621,
			boundingBox: { x: 611, y: 355, width: 564.4, height: 61 },
		}),
		typeEntry({
			index: 2,
			startedAtMs: 13852,
			endedAtMs: 18523,
			settleMs: 393,
			boundingBox: { x: 288, y: 112, width: 21.06, height: 20.8 },
		}),
		{
			index: 3,
			type: "key",
			keys: ["cmd+return"],
			atMs: 23539,
			settleMs: 421,
			boundingBox: { x: 288, y: 112, width: 21.06, height: 20.8 },
		},
		clickEntry({
			index: 4,
			startedAtMs: 27566,
			clickedAtMs: 28980,
			settleMs: 332,
			boundingBox: { x: 50, y: 141, width: 178, height: 21 },
		}),
		clickEntry({
			index: 5,
			startedAtMs: 31153,
			clickedAtMs: 32568,
			settleMs: 338,
			boundingBox: { x: 50, y: 112, width: 164, height: 21 },
		}),
		clickEntry({
			index: 6,
			startedAtMs: 32934,
			clickedAtMs: 34355,
			settleMs: 303,
			boundingBox: { x: 66, y: 141, width: 75.6, height: 21 },
		}),
		clickEntry({
			index: 7,
			startedAtMs: 34682,
			clickedAtMs: 36097,
			settleMs: 302,
			boundingBox: { x: 139, y: 288, width: 135.77, height: 16 },
		}),
		clickEntry({
			index: 8,
			startedAtMs: 36436,
			clickedAtMs: 37852,
			settleMs: 538,
			boundingBox: { x: 346.77, y: 292, width: 176, height: 16 },
		}),
		waitEntry(9, 38390, 1200, 37817),
	];
	const PILOT_VIEWPORT = { width: 1920, height: 1080 };
	const PILOT_SHOTS = [
		"wide",
		"close",
		"close",
		"close",
		"close",
		"close",
		"close",
		"close",
		"close",
		"hold",
	] as const;

	it("pilot list: no two consecutive regions on the same spot, and steps 6 to 8 are one connected sequence", () => {
		const regions = emitZoomRegions(PILOT_LOG, PILOT_VIEWPORT, PILOT_SHOTS).fragment.zoomRegions;
		for (let i = 1; i < regions.length; i++) {
			const a = regions[i - 1] as (typeof regions)[number];
			const b = regions[i] as (typeof regions)[number];
			const sameSpot =
				Math.abs(a.focus.cx - b.focus.cx) <= 0.12 && Math.abs(a.focus.cy - b.focus.cy) <= 0.12;
			const gap = b.startMs - a.endMs;
			expect(sameSpot && gap <= 1500 && !a.connect).toBe(false);
		}
		expect(regions.map((r) => r.id)).toEqual(["zoom-1", "zoom-2", "zoom-3", "zoom-4", "zoom-7"]);
		const r4 = regions.find((r) => r.id === "zoom-4");
		expect(r4?.connect).toBe(true);
		// step 9 is a hold: the last region lasts to the end of the payoff wait
		expect(regions.at(-1)?.endMs).toBe(38390 + 1200);
	});

	it("pilot list with the payoff as wide: the last region ends where the payoff starts", () => {
		const shots = [...PILOT_SHOTS.slice(0, 9), "wide"] as const;
		const result = emitZoomRegions(PILOT_LOG, PILOT_VIEWPORT, shots);
		expect(result.fragment.zoomRegions.at(-1)).toMatchObject({
			id: "zoom-7",
			endMs: 38390,
			connect: false,
		});
		expect(result.closedAtMs).toEqual({ "zoom-7": 38390 });
	});
});

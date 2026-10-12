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

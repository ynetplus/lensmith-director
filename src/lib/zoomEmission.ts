/**
 * Zoom-region emission — turns a driven action log directly into the
 * `{ zoomRegions: [...] }` fragment `lensmith compose --zooms` accepts
 * verbatim. CR-LENSMITH-A002-2.
 *
 * NO dwell-detection heuristic is involved anywhere in this path — per
 * RN-040 §5b, natural cursor motion and the sibling `lensmith` repo's dwell
 * detector are in conflict (a pretty move can fuse with its pause and be
 * rejected, or spawn a phantom region). The whole architectural point of the
 * director existing is that it already KNOWS what was clicked and when, so
 * the region comes directly from the action log's own recorded timestamps
 * and bounding box — never from re-deriving intent out of cursor telemetry.
 */

import type {
	ActionLogClickEntry,
	ActionLogEntry,
	ActionLogHoverEntry,
	ActionLogKeyEntry,
	ActionLogTypeEntry,
	BoundingBoxLike,
} from "./actionLog.js";
import { SETTLE_PACING } from "./timing.js";

/**
 * Zoom-region timing follows the Settle pacing (CR-LENSMITH-A007-10): every
 * number lives in `timing.ts`'s `SETTLE_PACING`. A region starts when the cursor
 * starts travelling (the renderer's 900 ms zoom-in is then settled before the
 * click, since travel + dwell is at least 1100 ms) and ends 1200 ms after the
 * click's result settled.
 */

export interface ZoomRegion {
	id: string;
	startMs: number;
	endMs: number;
	focus: { cx: number; cy: number };
	/**
	 * True when the NEXT region's target box lies inside this region's zoomed frame
	 * (with the margin): the camera pans there instead of zooming out. False for
	 * the last region.
	 */
	connect: boolean;
	/** Zoom depth the renderer reads; without it (and `customScale`) the film renders wallpaper only (BF-12). */
	depth: number;
	/** Zoom scale, `SETTLE_PACING.zoomScale`. */
	customScale: number;
	/** Same marker the engine's `suggest-zooms` writes. */
	source: "auto";
}

export interface ZoomFragment {
	zoomRegions: ZoomRegion[];
}

export interface ViewportSize {
	width: number;
	height: number;
}

export interface EmitZoomRegionsResult {
	fragment: ZoomFragment;
	/** Non-fatal: e.g. a clamped `focus.cx`/`cy` that landed outside 0..1 before clamping. */
	warnings: string[];
}

/** Zoom depth the engine's `suggest-zooms` emits for every region. */
const ZOOM_DEPTH = 3;

/**
 * The film's time base (CR-LENSMITH-A008-6): the recording starts at the action log's `t0`, so an
 * action-log time IS the film time (identity, floored at 0). Zoom regions and the narration's
 * voice starts both go through this one function, so voice and camera cannot drift apart.
 */
export function logMsToFilmMs(logMs: number): number {
	return Math.max(0, logMs);
}

type ZoomableEntry =
	| ActionLogClickEntry
	| ActionLogTypeEntry
	| ActionLogHoverEntry
	| (ActionLogKeyEntry & { boundingBox: BoundingBoxLike });

/**
 * A `click` step and a `type` step (CR-LENSMITH-A002-6) both drive a
 * choreographed move to a bounding box and both belong in the zoom fragment —
 * `wait` entries never do, having no bounding box to frame a zoom around.
 * CR-LENSMITH-A010-8: a native `hover` (it has a box), and a `key` step that named a
 * `zoom` locator (its box), are zoomable too; a key without `zoom` has no box and emits none.
 */
function isZoomableEntry(entry: ActionLogEntry): entry is ZoomableEntry {
	if (entry.type === "click" || entry.type === "type") return true;
	if (entry.type === "hover" || entry.type === "key") return entry.boundingBox !== undefined;
	return false;
}

/**
 * The moment the entry's zoom-worthy action finished — a click's own click, a type step's last
 * character, a hover's arrival on its target, a key's press.
 */
function zoomEndMs(entry: ZoomableEntry): number {
	switch (entry.type) {
		case "click":
			return entry.clickedAtMs;
		case "type":
			return entry.endedAtMs;
		case "hover":
			return entry.hoveredAtMs;
		case "key":
			return entry.atMs;
	}
}

/** When the region starts: the travel start, or for a key (no travel) the press itself. */
function zoomStartMs(entry: ZoomableEntry): number {
	return entry.type === "key" ? entry.atMs : entry.startedAtMs;
}

/** Clamps to `compose`'s validated `0..1` range, recording a warning if clamping was needed. */
function clampUnit(value: number, label: string, warnings: string[]): number {
	if (value < 0 || value > 1) {
		const clamped = Math.min(1, Math.max(0, value));
		warnings.push(
			`${label} = ${value} is outside the normalized 0..1 range — clamped to ${clamped}`,
		);
		return clamped;
	}
	return value;
}

/**
 * True when `box` lies inside the frame the camera shows at `SETTLE_PACING.zoomScale`
 * centred on `focus`, shrunk by the 8 percent margin on every side. The frame is
 * clamped inside the viewport, as the renderer's `clampFocusToScale` does.
 */
function fitsInZoomedFrame(
	box: BoundingBoxLike,
	focus: { cx: number; cy: number },
	viewport: ViewportSize,
): boolean {
	const frameW = viewport.width / SETTLE_PACING.zoomScale;
	const frameH = viewport.height / SETTLE_PACING.zoomScale;
	const left = Math.min(
		viewport.width - frameW,
		Math.max(0, focus.cx * viewport.width - frameW / 2),
	);
	const top = Math.min(
		viewport.height - frameH,
		Math.max(0, focus.cy * viewport.height - frameH / 2),
	);
	const marginX = frameW * SETTLE_PACING.zoomConnectMarginRatio;
	const marginY = frameH * SETTLE_PACING.zoomConnectMarginRatio;
	return (
		box.x >= left + marginX &&
		box.y >= top + marginY &&
		box.x + box.width <= left + frameW - marginX &&
		box.y + box.height <= top + frameH - marginY
	);
}

/**
 * One region per `click`, `type`, `hover` or zoomed `key` entry in the action log. `wait` entries
 * are ignored — they never appear as choreographed moves and have no
 * bounding box to frame a zoom around.
 *
 * Region `startMs` = the step's travel start; `endMs` = the action's end +
 * `settleMs` + the result hold. `connect` marks back-to-back targets that share
 * a zoomed frame. After a non-connected region a zoom-in is never scheduled
 * within `zoomMinGapAfterOutMs` of that zoom-out's end: it is shifted later.
 */
export function emitZoomRegions(
	actionLog: ActionLogEntry[],
	viewport: ViewportSize,
): EmitZoomRegionsResult {
	const warnings: string[] = [];
	const entries = actionLog.filter(isZoomableEntry);
	const zoomRegions: ZoomRegion[] = [];

	for (const [i, entry] of entries.entries()) {
		const centerX = entry.boundingBox.x + entry.boundingBox.width / 2;
		const centerY = entry.boundingBox.y + entry.boundingBox.height / 2;
		const cx = clampUnit(centerX / viewport.width, `focus.cx for step ${entry.index}`, warnings);
		const cy = clampUnit(centerY / viewport.height, `focus.cy for step ${entry.index}`, warnings);
		const focus = { cx, cy };

		let startMs = logMsToFilmMs(zoomStartMs(entry));
		const previous = zoomRegions[zoomRegions.length - 1];
		if (previous && !previous.connect) {
			const earliest =
				previous.endMs + SETTLE_PACING.zoomOutMs + SETTLE_PACING.zoomMinGapAfterOutMs;
			startMs = Math.max(startMs, earliest);
		}

		const next = entries[i + 1];
		zoomRegions.push({
			id: `zoom-${entry.index}`,
			startMs,
			endMs: zoomEndMs(entry) + entry.settleMs + SETTLE_PACING.resultHoldMs,
			focus,
			connect: next ? fitsInZoomedFrame(next.boundingBox, focus, viewport) : false,
			depth: ZOOM_DEPTH,
			customScale: SETTLE_PACING.zoomScale,
			source: "auto",
		});
	}

	return { fragment: { zoomRegions }, warnings };
}

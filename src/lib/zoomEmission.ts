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
import type { ShotName } from "./stepList.js";
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
	 * True when the camera pans to the NEXT region instead of zooming out: settle, its target box
	 * lies inside this region's zoomed frame (with the margin); continuous, the two zoomed frames
	 * overlap. False for the last region.
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
	/**
	 * CR-LENSMITH-A011-9: region id -> the end a `wide` or `reveal` step fixed for it. A later pass
	 * that stretches regions (continuous narration) must not carry a region past this point.
	 */
	closedAtMs: Record<string, number>;
}

/**
 * CR-LENSMITH-A011-9: two consecutive `close` targets this near (normalised, on both axes) share
 * one region, however long apart they are (round 2: no time limit — the voice is continuous, so the
 * camera has no reason to leave and return to the same spot).
 */
export const SAME_SPOT_MAX_DISTANCE = 0.12;

/** Zoom depth the engine's `suggest-zooms` emits for every region. */
const ZOOM_DEPTH = 3;

/**
 * The film's time base (CR-LENSMITH-A008-6, BF-27): the recording starts `leadMs` BEFORE the action
 * log's `t0` (the recorder is started before the page is navigated, BF-15), so a film time is the
 * log time plus that lead, floored at 0. `leadMs = 0` is the old identity. Zoom regions and the
 * narration's voice starts all go through this one function, so voice and camera cannot drift apart.
 */
export function logMsToFilmMs(logMs: number, leadMs = 0): number {
	return Math.max(0, logMs + leadMs);
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
 * CR-LENSMITH-A011-9 round 3: true when the zoomed frame around `focus` overlaps `region`'s zoomed
 * frame — both focus points within 1/scale of each other on each axis (normalised; 0.556 at the
 * Settle scale 1.8), using the region's own `customScale`.
 */
function zoomedFramesOverlap(region: ZoomRegion, focus: { cx: number; cy: number }): boolean {
	const reach = 1 / region.customScale;
	return (
		Math.abs(focus.cx - region.focus.cx) <= reach && Math.abs(focus.cy - region.focus.cy) <= reach
	);
}

/** When an entry began: its travel start, or the moment it was logged. */
function entryStartMs(entry: ActionLogEntry): number {
	return "startedAtMs" in entry ? entry.startedAtMs : entry.atMs;
}

/** When an entry's on-screen result is over: a zoomable entry's region end, a wait's last ms. */
function entryEndMs(entry: ActionLogEntry): number {
	if (isZoomableEntry(entry)) {
		return zoomEndMs(entry) + entry.settleMs + SETTLE_PACING.resultHoldMs;
	}
	if (entry.type === "wait") return entry.atMs + entry.ms;
	return entryStartMs(entry);
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
 *
 * CR-LENSMITH-A011-9: `shots` (one per step, from `resolveShots`, read by each entry's `index`;
 * omitted = every entry is `close`) applies the shot grammar: `wide` emits nothing and ends an open
 * region at the entry's start; `hold` emits nothing and extends the open region to the entry's end;
 * `follow` connects to the previous region; `reveal` ends the open region at the entry's line start;
 * a `close` on the same spot as the previous `close` region (within {@link SAME_SPOT_MAX_DISTANCE},
 * no time limit) extends that region instead of opening a new one; otherwise a `close` whose target
 * fits inside the open region's zoomed frame connects it (a pan — no zoom-out, and no zoom-in delay).
 * Round 3, `continuous` only: the pan test is {@link zoomedFramesOverlap} (the two zoomed frames
 * overlap) instead of the stricter fit test, so neighbouring close-ups pan rather than zoom out and in;
 * settle keeps the fit test unchanged.
 */
export function emitZoomRegions(
	actionLog: ActionLogEntry[],
	viewport: ViewportSize,
	shots?: readonly ShotName[],
	options: { continuous?: boolean; leadMs?: number } = {},
): EmitZoomRegionsResult {
	const leadMs = options.leadMs ?? 0;
	const warnings: string[] = [];
	const zoomRegions: ZoomRegion[] = [];
	const closedAtMs: Record<string, number> = {};
	let last: ZoomRegion | undefined;
	let lastShot: ShotName | undefined;
	let lastClosed = false;

	for (const entry of actionLog) {
		const shot: ShotName = shots?.[entry.index] ?? "close";

		if (shot === "wide" || shot === "reveal") {
			if (last && !lastClosed) {
				const voiceStart = (entry as { voiceStartMs?: number }).voiceStartMs;
				const at = logMsToFilmMs(
					// Round 2 (CR-LENSMITH-A011-10): a `wide` line closes the region at its START too, so the
					// zoom-out plays under the first words and the first point is already at 1x.
					voiceStart !== undefined ? voiceStart : entryStartMs(entry),
					leadMs,
				);
				last.endMs = Math.max(last.startMs, at);
				last.connect = false;
				closedAtMs[last.id] = last.endMs;
				lastClosed = true;
			}
			continue;
		}
		if (shot === "hold") {
			if (last && !lastClosed)
				last.endMs = Math.max(last.endMs, logMsToFilmMs(entryEndMs(entry), leadMs));
			continue;
		}
		if (!isZoomableEntry(entry)) continue;

		const centerX = entry.boundingBox.x + entry.boundingBox.width / 2;
		const centerY = entry.boundingBox.y + entry.boundingBox.height / 2;
		const cx = clampUnit(centerX / viewport.width, `focus.cx for step ${entry.index}`, warnings);
		const cy = clampUnit(centerY / viewport.height, `focus.cy for step ${entry.index}`, warnings);
		const focus = { cx, cy };
		const endMs = logMsToFilmMs(
			zoomEndMs(entry) + entry.settleMs + SETTLE_PACING.resultHoldMs,
			leadMs,
		);

		let startMs = logMsToFilmMs(zoomStartMs(entry), leadMs);
		const open = last && !lastClosed ? last : undefined;
		if (
			open &&
			shot === "close" &&
			lastShot === "close" &&
			Math.abs(focus.cx - open.focus.cx) <= SAME_SPOT_MAX_DISTANCE &&
			Math.abs(focus.cy - open.focus.cy) <= SAME_SPOT_MAX_DISTANCE
		) {
			open.endMs = Math.max(open.endMs, endMs);
			continue;
		}
		if (open) {
			open.connect =
				shot === "follow" ||
				(options.continuous
					? zoomedFramesOverlap(open, focus)
					: fitsInZoomedFrame(entry.boundingBox, open.focus, viewport));
		}
		if (last && !last.connect) {
			const earliest = last.endMs + SETTLE_PACING.zoomOutMs + SETTLE_PACING.zoomMinGapAfterOutMs;
			startMs = Math.max(startMs, earliest);
		}

		last = {
			id: `zoom-${entry.index}`,
			startMs,
			endMs,
			focus,
			connect: false,
			depth: ZOOM_DEPTH,
			customScale: SETTLE_PACING.zoomScale,
			source: "auto",
		};
		zoomRegions.push(last);
		lastShot = shot;
		lastClosed = false;
	}

	return { fragment: { zoomRegions }, warnings, closedAtMs };
}

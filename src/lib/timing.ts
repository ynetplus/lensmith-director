/**
 * The timing recipe.
 *
 * These numbers are not taste. They were measured against a real automatic
 * zoom-region detector fed by real cursor telemetry, and the result was
 * counter-intuitive enough to be worth stating plainly:
 *
 *   **The prettier the cursor motion, the worse the downstream result.**
 *
 * What was measured:
 *
 *   | move                              | outcome                                              |
 *   |-----------------------------------|------------------------------------------------------|
 *   | 500 px over 2500 ms (natural)     | ZERO zoom candidates — move and pause fuse into one   |
 *   |                                   | run that exceeds the detector's maximum and is dropped |
 *   | 200 px over 900 ms (a UI hop)     | one candidate, focused on the CENTROID between origin  |
 *   |                                   | and target — i.e. the empty space between two buttons  |
 *   | any move >= 1200 ms               | additionally spawns a PHANTOM region at the origin     |
 *   | 500 px / 500 ms + 700-1200 ms dwell | correct: focus lands on the target                   |
 *
 * A dwell run is only broken by motion whose peak speed clears roughly
 * {@link MIN_PEAK_VELOCITY_PX_PER_SEC}. Below that, a move is indistinguishable
 * from standing still, which is why a slow, elegant glide produces nothing at all.
 *
 * So: move fast, then hold still. Both halves matter.
 */

/** Default eased-move duration. Inside the recipe, with headroom. */
export const DEFAULT_MOVE_DURATION_MS = 500;

/** Beyond this, a move starts fusing with the pause around it. */
export const MAX_RECOMMENDED_MOVE_DURATION_MS = 700;

/** Beyond this, a move additionally spawns a phantom region at its origin. */
export const PHANTOM_REGION_MOVE_DURATION_MS = 1200;

/** Peak speed a move must clear to register as motion at all. */
export const MIN_PEAK_VELOCITY_PX_PER_SEC = 891;

/** Hold still this long after arriving, before clicking. */
export const MIN_DWELL_MS = 700;
export const MAX_DWELL_MS = 1200;
export const DEFAULT_DWELL_MS = 900;

/**
 * Peak speed of an `easeInOutCubic` move, as a multiple of its average speed.
 *
 * For `easeInOut` of power n the normalised velocity peaks at exactly n (at the
 * midpoint): d/dt[4t^3] = 12t^2, which is 3 at t = 0.5. Cubic easing therefore
 * spends most of its budget slower than the average, and its peak is only 3x the
 * average — which is precisely why a move that "looks fast enough" can still sit
 * under the detection threshold.
 */
export const EASE_IN_OUT_CUBIC_PEAK_VELOCITY_FACTOR = 3;

/** The easing curve the native helper uses. Kept here for calculation and tests. */
export function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function distancePx(from: { x: number; y: number }, to: { x: number; y: number }): number {
	return Math.hypot(to.x - from.x, to.y - from.y);
}

/** Peak speed, in px/s, of an eased move covering `distance` px in `durationMs`. */
export function peakVelocityPxPerSec(distance: number, durationMs: number): number {
	if (durationMs <= 0) return Number.POSITIVE_INFINITY;
	return (EASE_IN_OUT_CUBIC_PEAK_VELOCITY_FACTOR * distance) / (durationMs / 1000);
}

/**
 * Advisory only — never throws, never rejects a move. A caller may have a good
 * reason to move slowly (framing a shot, exiting a scene); what it must not do
 * is move slowly by accident and then wonder why nothing was detected.
 */
export function moveTimingWarnings(
	from: { x: number; y: number },
	to: { x: number; y: number },
	durationMs: number,
): string[] {
	const warnings: string[] = [];
	const distance = distancePx(from, to);
	if (distance === 0) return warnings;

	if (durationMs > PHANTOM_REGION_MOVE_DURATION_MS) {
		warnings.push(
			`move duration ${durationMs}ms exceeds ${PHANTOM_REGION_MOVE_DURATION_MS}ms — long moves also spawn a phantom region at the origin`,
		);
	} else if (durationMs > MAX_RECOMMENDED_MOVE_DURATION_MS) {
		warnings.push(
			`move duration ${durationMs}ms exceeds the recommended ${MAX_RECOMMENDED_MOVE_DURATION_MS}ms — the move starts fusing with the pause around it`,
		);
	}

	const peak = peakVelocityPxPerSec(distance, durationMs);
	if (peak < MIN_PEAK_VELOCITY_PX_PER_SEC) {
		warnings.push(
			`peak velocity ${Math.round(peak)}px/s is below ${MIN_PEAK_VELOCITY_PX_PER_SEC}px/s — this move may not register as motion at all (try a shorter duration)`,
		);
	}

	return warnings;
}

/** Hold still. The other half of the recipe; a move without it lands nothing. */
export function dwell(ms: number = DEFAULT_DWELL_MS): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The "Settle" pacing (Pacing card, treatment C; CR-LENSMITH-A007-2). Every
 * number is from the Settle spec table; none is invented. Provisional until
 * Drew approves them on a real film (CR-LENSMITH-A007-7), then locked here.
 *
 * Step rhythm: travel (by distance) + dwell, click, wait for the result to
 * settle, hold the result, breathe at 1x, next step.
 */
export const SETTLE_PACING = {
	/** travel_ms = clamp(base + perPt x d, min, max), d in screen points. */
	travelBaseMs: 300,
	travelPerPt: 0.4,
	travelMinMs: 400,
	travelMaxMs: 700,
	/** Hold still on the target before the click. */
	dwellMs: 700,
	/** Settle: no DOM mutation for this long (when the step has no `expect` selector)... */
	settleQuietMs: 300,
	/** ...but never wait longer than this. */
	settleCapMs: 4000,
	/** Held at full zoom after the result settled, cursor still. */
	resultHoldMs: 1200,
	/** At 1x after the hold, before the next step's travel starts. */
	breathMs: 800,
	/** Type steps: per character, unchanged. */
	typeCharDelayMs: 60,
	/** Zoom regions (CR-LENSMITH-A007-10). Scale is the renderer's, unchanged. */
	zoomScale: 1.8,
	/** The renderer's zoom-in window, begins at travel start. */
	zoomInMs: 900,
	/** The renderer's zoom-out, begins at the region's `endMs`. */
	zoomOutMs: 700,
	/** A zoom-in never starts within this long of a (non-connected) zoom-out's end. */
	zoomMinGapAfterOutMs: 800,
	/** Next target must sit inside the zoomed frame with this margin on every side to connect. */
	zoomConnectMarginRatio: 0.08,
} as const;

/** Cursor travel time for a move of `distancePt` screen points: clamp(300 + 0.4 x d, 400, 700). */
export function travelMs(distancePt: number): number {
	const { travelBaseMs, travelPerPt, travelMinMs, travelMaxMs } = SETTLE_PACING;
	return Math.min(travelMaxMs, Math.max(travelMinMs, travelBaseMs + travelPerPt * distancePt));
}

/**
 * Sleep after a step's result hold, before the next step starts (BF-11). The zoom-out
 * lasts `zoomOutMs` from the region end, and the film then breathes `breathMs` at 1x, so
 * the breath counts from the END of the zoom-out. A connected step pans instead of
 * zooming out, so only the breath remains.
 */
export function pauseBeforeNextStepMs(connected: boolean): number {
	return connected ? SETTLE_PACING.breathMs : SETTLE_PACING.zoomOutMs + SETTLE_PACING.breathMs;
}

/**
 * Continuous narration (Settle LOCK v1.1, CR-LENSMITH-A011-6): the voice is the clock. Lines
 * follow each other with at most `maxLineGapMs` of silence, every action lands on its line's
 * `[[mark]]`, the 800 ms breath is dropped and the zoom-out may run under the voice. Zoom in/out
 * durations and the Settle curve are unchanged. After the last word the result is held
 * `finalHoldMs` (the payoff hold), and that is the end of the film.
 */
export const CONTINUOUS_NARRATION = {
	/**
	 * Silence between one line's last word and the next line's first word, unless an action forces
	 * more (BF-23: measured on the speech bounds, so the files' own padding does not add to it).
	 */
	maxLineGapMs: 300,
	/** Held after the last word (payoff), at full zoom. */
	finalHoldMs: SETTLE_PACING.resultHoldMs,
	/** Minimum time an action occupies after its click before the next travel can start. */
	defaultBusyMs: SETTLE_PACING.settleQuietMs,
} as const;

/**
 * Settle LOCK v1.2 (BF-25), continuous mode only: an action may land up to this long after its
 * `[[mark]]` when the cursor cannot travel and dwell to the target in time, so the voice does not
 * wait for the cursor. Only a deficit beyond this delays the line, by the remainder.
 */
export const LATE_ACTION_MAX_MS = 900;

/** One voice line, from the engine's `timings.json` (`lines.s<index>`). */
export interface ContinuousLine {
	durationMs: number;
	/** The `[[mark]]` time into the line, when the step's `say` carries one. */
	markMs?: number;
	/**
	 * BF-23: first and last speech sample, ms from the start of the file. Absent (older engines):
	 * the whole file counts as speech, 0 and `durationMs`.
	 */
	speechStartMs?: number;
	speechEndMs?: number;
}

/** The cursor action a step performs; omitted for a step with no cursor action (a wait). */
export interface ContinuousAction {
	/** Cursor travel to the target (see {@link travelMs}). */
	travelMs: number;
	/** Hold still on the target before the click; default {@link SETTLE_PACING.dwellMs}. */
	dwellMs?: number;
	/** How long the action keeps the page busy after the click (typing, settle); default 300. */
	busyMs?: number;
}

export interface ContinuousPlanStep {
	index: number;
	lineStartMs: number;
	lineEndMs: number;
	/** Silence before this line's first word, after the previous line's last word (0 for the first line). */
	gapBeforeMs: number;
	/** How much later than `maxLineGapMs` the line starts because the cursor needed the time. */
	delayMs: number;
	/** The mark's time (or travel + dwell into the line without a mark); absent without an action. */
	actionMs?: number;
	/**
	 * BF-25: how long after `actionMs` the click lands (0 when on time, at most
	 * {@link LATE_ACTION_MAX_MS}); the click is at `actionMs + actionLateMs`. Absent without an action.
	 */
	actionLateMs?: number;
	/** When the cursor leaves for the target (= click - travel - dwell); the previous zoom region ends here. */
	travelStartMs?: number;
}

export interface ContinuousPlan {
	steps: ContinuousPlanStep[];
	/** Last word + the final hold: the film's length. */
	endMs: number;
}

/**
 * Plans a continuously narrated film. Pure. Each line's first word comes `maxLineGapMs` after the
 * previous line's last word (BF-23: speech bounds, falling back to the whole file when a line has
 * none), unless its action cannot reach its mark in time: the cursor can leave only after the
 * previous action is done (click + busy), and needs travel + dwell to arrive. BF-25: the action
 * then lands late by the deficit, up to {@link LATE_ACTION_MAX_MS}, and only the remainder delays
 * the line (the line is never cut). An action without a mark clicks travel + dwell after its line
 * starts.
 */
export function planContinuousNarration(
	lines: readonly ContinuousLine[],
	actions: readonly (ContinuousAction | undefined)[],
): ContinuousPlan {
	if (lines.length !== actions.length) {
		throw new Error(
			`planContinuousNarration: ${lines.length} lines but ${actions.length} actions (one per step)`,
		);
	}
	const { maxLineGapMs, finalHoldMs, defaultBusyMs } = CONTINUOUS_NARRATION;
	const steps: ContinuousPlanStep[] = [];
	let previousLineEndMs: number | undefined;
	let previousSpeechEndMs: number | undefined;
	let cursorFreeAtMs = 0;

	lines.forEach((line, index) => {
		if (!Number.isFinite(line.durationMs) || line.durationMs <= 0) {
			throw new Error(`planContinuousNarration: line ${index} needs a positive durationMs`);
		}
		if (line.markMs !== undefined && (line.markMs < 0 || line.markMs > line.durationMs)) {
			throw new Error(`planContinuousNarration: line ${index} has its mark outside the line`);
		}
		const speechStartMs = line.speechStartMs ?? 0;
		const speechEndMs = line.speechEndMs ?? line.durationMs;
		if (!(speechStartMs >= 0 && speechStartMs < speechEndMs && speechEndMs <= line.durationMs)) {
			throw new Error(
				`planContinuousNarration: line ${index} has its speech bounds outside the line`,
			);
		}
		const action = actions[index];
		const naturalStartMs =
			previousSpeechEndMs === undefined ? 0 : previousSpeechEndMs + maxLineGapMs - speechStartMs;
		let lineStartMs = naturalStartMs;
		let leadMs = 0;
		let actionLateMs = 0;
		if (action !== undefined) {
			leadMs = action.travelMs + (action.dwellMs ?? SETTLE_PACING.dwellMs);
			const intoLineMs = line.markMs ?? leadMs;
			// The mark sits at lineStart + intoLine; travel needs leadMs and starts no earlier than the
			// cursor is free. A deficit lands the click late, up to the allowance; the rest delays the line.
			const deficitMs = cursorFreeAtMs + leadMs - (naturalStartMs + intoLineMs);
			if (deficitMs > 0) {
				actionLateMs = Math.min(deficitMs, LATE_ACTION_MAX_MS);
				lineStartMs = naturalStartMs + deficitMs - actionLateMs;
			}
		}
		const step: ContinuousPlanStep = {
			index,
			lineStartMs,
			lineEndMs: lineStartMs + line.durationMs,
			gapBeforeMs:
				previousSpeechEndMs === undefined ? 0 : lineStartMs + speechStartMs - previousSpeechEndMs,
			delayMs: lineStartMs - naturalStartMs,
		};
		if (action !== undefined) {
			const actionMs = lineStartMs + (line.markMs ?? leadMs);
			const clickMs = actionMs + actionLateMs;
			step.actionMs = actionMs;
			step.actionLateMs = actionLateMs;
			step.travelStartMs = clickMs - leadMs;
			cursorFreeAtMs = clickMs + (action.busyMs ?? defaultBusyMs);
		}
		steps.push(step);
		previousLineEndMs = step.lineEndMs;
		previousSpeechEndMs = lineStartMs + speechEndMs;
	});

	const lastLineEndMs = previousLineEndMs ?? 0;
	return { steps, endMs: lastLineEndMs + finalHoldMs };
}

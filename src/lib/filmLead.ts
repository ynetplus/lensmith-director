/**
 * BF-27 round 2: the film lead (how far the picture runs behind the action log) measured from the
 * recording's own cursor telemetry, per run. Round 1 stamped the lead at the Director's receipt of
 * the engine's `Recording ready.` line; DBX round 10 measured that at 156 ms while the telemetry still
 * showed the picture 310 to 370 ms behind the log, so the recording starts before that line arrives.
 *
 * Pure: no file or clock access. The caller reads `raw.mp4.cursor.json` and passes it in.
 */

/** The capture size the normalised telemetry (`cx`/`cy` in 0..1) is converted with, in points. */
export const TELEMETRY_CAPTURE_WIDTH = 1920;
export const TELEMETRY_CAPTURE_HEIGHT = 1080;
/** Motion is confirmed once the cursor is this far from its resting position. */
export const MOTION_THRESHOLD_PX = 2;
/** Travels used for the measurement: the first ones in the log. */
export const FILM_LEAD_TRAVELS = 3;
/** A match whose offset falls outside 0..this is not the same travel. */
const MAX_MATCH_OFFSET_MS = 5_000;

export interface CursorTelemetrySample {
	timeMs: number;
	cx: number;
	cy: number;
	visible?: boolean;
}

export interface CursorTelemetry {
	samples: CursorTelemetrySample[];
}

/** The log fields this measurement reads; any action-log entry fits. */
export interface FilmLeadLogEntry {
	type: string;
	startedAtMs?: number;
	travelStartMs?: number;
}

export interface FilmLeadSample {
	/** Travel start on the log clock. */
	logMs: number;
	/** Motion onset on the film (telemetry) clock. */
	onsetMs: number;
	offsetMs: number;
}

export interface FilmLead {
	leadMs: number;
	samples: FilmLeadSample[];
}

function travelStarts(actionLog: readonly FilmLeadLogEntry[]): number[] {
	const starts: number[] = [];
	for (const entry of actionLog) {
		if ((entry.type === "click" || entry.type === "type") && entry.startedAtMs !== undefined) {
			starts.push(entry.startedAtMs);
		} else if (entry.type === "point" && entry.travelStartMs !== undefined) {
			starts.push(entry.travelStartMs);
		}
	}
	return starts.sort((a, b) => a - b);
}

function distancePx(a: CursorTelemetrySample, b: CursorTelemetrySample): number {
	return Math.hypot(
		(a.cx - b.cx) * TELEMETRY_CAPTURE_WIDTH,
		(a.cy - b.cy) * TELEMETRY_CAPTURE_HEIGHT,
	);
}

/**
 * The motion onset of the travel that starts at `logMs` on the log clock, or undefined. The picture
 * runs behind the log, so at film time `logMs` the cursor has not left yet: start at the last sample at
 * or before it; if the cursor is still finishing an earlier travel there, walk on to where it rests.
 * Motion is confirmed by the first later sample more than {@link MOTION_THRESHOLD_PX} from that rest;
 * the onset is the last sample still exactly at the rest before it (the "last still sample" of the
 * BF-27 round-1 evidence table — an eased start creeps sub-pixel for a sample or two first).
 */
function motionOnsetMs(samples: CursorTelemetrySample[], logMs: number): number | undefined {
	let j = -1;
	for (let i = 0; i < samples.length; i++) {
		if ((samples[i] as CursorTelemetrySample).timeMs <= logMs) j = i;
		else break;
	}
	if (j < 0) return undefined;
	while (
		j > 0 &&
		j + 1 < samples.length &&
		distancePx(samples[j] as CursorTelemetrySample, samples[j - 1] as CursorTelemetrySample) > 0
	) {
		j++;
	}
	const rest = samples[j] as CursorTelemetrySample;
	let k = j + 1;
	while (
		k < samples.length &&
		distancePx(samples[k] as CursorTelemetrySample, rest) <= MOTION_THRESHOLD_PX
	) {
		k++;
	}
	if (k >= samples.length) return undefined;
	let onset = k - 1;
	while (onset > j && distancePx(samples[onset] as CursorTelemetrySample, rest) > 0) onset--;
	return (samples[onset] as CursorTelemetrySample).timeMs;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The film lead from the first {@link FILM_LEAD_TRAVELS} cursor travels in the log (click/type steps'
 * `startedAtMs`, `point` entries' `travelStartMs`) against their motion onsets in the telemetry:
 * `leadMs` = median(onset − log start), rounded. Undefined when fewer than two travels match.
 */
export function measureFilmLead(
	actionLog: readonly FilmLeadLogEntry[],
	telemetry: CursorTelemetry | undefined,
): FilmLead | undefined {
	const samples = (telemetry?.samples ?? [])
		.filter((s) => s.visible !== false && Number.isFinite(s.timeMs))
		.sort((a, b) => a.timeMs - b.timeMs);
	if (samples.length === 0) return undefined;
	const matched: FilmLeadSample[] = [];
	for (const logMs of travelStarts(actionLog).slice(0, FILM_LEAD_TRAVELS)) {
		const onsetMs = motionOnsetMs(samples, logMs);
		if (onsetMs === undefined) continue;
		const offsetMs = onsetMs - logMs;
		if (offsetMs < 0 || offsetMs > MAX_MATCH_OFFSET_MS) continue;
		matched.push({ logMs, onsetMs, offsetMs });
	}
	if (matched.length < 2) return undefined;
	return { leadMs: Math.round(median(matched.map((m) => m.offsetMs))), samples: matched };
}

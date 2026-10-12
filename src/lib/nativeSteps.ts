/**
 * CR-LENSMITH-A010-6: runs one native step (a step that names an `app`) through the
 * native driver helper, with the same pacing as a web step: find, travel, dwell, real
 * click or keys, settle. Design note §4 (step execution, action log), §5 (settle) and
 * §6 (capture space).
 *
 * Typed text: held only in a local inside `driveType`, passed to `driver.type`, and
 * never written to an entry or an error; the entry carries `characterCount` only.
 */

import { type ChoreographerLike, narrationDwell, travelFor } from "../commands/drive.js";
import type {
	ActionLogActivateEntry,
	ActionLogClickEntry,
	ActionLogEntry,
	ActionLogHoverEntry,
	ActionLogKeyEntry,
	ActionLogTypeEntry,
	ActionLogWaitEntry,
	BoundingBoxLike,
} from "./actionLog.js";
import { type ExecFileFn, resolveKeychainText } from "./keychainText.js";
import {
	describeLocator,
	NATIVE_DEFAULT_TIMEOUT_MS,
	NativeDriverError,
	type NativeDriverLike,
	type NativeElement,
	resolveTarget,
} from "./nativeDriver.js";
import { type AxLocator, type Chord, type NativeStep, parseKeys } from "./stepList.js";
import { SETTLE_PACING } from "./timing.js";

/** The capture region in screen points (its origin is subtracted from every box). */
export interface CaptureRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Screen points in, capture points out: the box minus the capture origin. */
export function toCaptureSpace(box: BoundingBoxLike, capture: CaptureRegion): BoundingBoxLike {
	return { x: box.x - capture.x, y: box.y - capture.y, width: box.width, height: box.height };
}

/** What a narrated step needs to know about its voice line (mirrors `drive.ts`'s plan). */
export interface NativeVoice {
	lineId: string;
	durationMs: number;
	markMs?: number;
}

export interface NativeStepDeps {
	driver: NativeDriverLike;
	choreographer: Pick<ChoreographerLike, "moveTo" | "dwell" | "click">;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	execFile?: ExecFileFn;
	activate: (pid: number) => Promise<void>;
}

export interface NativeStepContext {
	/** bundle id → pid of the launched app. */
	pids: Map<string, number>;
	capture: CaptureRegion;
	t0: number;
	lastPoint: { x: number; y: number } | undefined;
	voice?: NativeVoice;
}

/** A chord as its normalised name, e.g. `cmd+shift+v`. */
export function chordName(chord: Chord): string {
	return [...chord.mods, chord.key].join("+");
}

function stepPrefix(index: number, step: NativeStep): string {
	return `step at index ${index} (type "${step.type}", app "${step.app}")`;
}

/** Re-throws a helper failure with the step named, keeping its `code`. */
function nameStep(error: unknown, index: number, step: NativeStep): never {
	if (error instanceof NativeDriverError) {
		throw new NativeDriverError(error.code, `${stepPrefix(index, step)}: ${error.message}`, {
			candidates: error.candidates,
			details: error.details,
		});
	}
	const message = error instanceof Error ? error.message : String(error);
	throw new NativeDriverError("step_failed", `${stepPrefix(index, step)}: ${message}`);
}

function pidFor(step: NativeStep, index: number, ctx: NativeStepContext): number {
	const pid = ctx.pids.get(step.app);
	if (pid === undefined) {
		throw new NativeDriverError(
			"app_not_running",
			`${stepPrefix(index, step)}: no running process for "${step.app}"`,
		);
	}
	return pid;
}

function boxOf(element: NativeElement, capture: CaptureRegion): BoundingBoxLike {
	const frame = element.frame ?? { x: 0, y: 0, width: 0, height: 0 };
	return toCaptureSpace(frame, capture);
}

function voiceStart(voice: NativeVoice, startedAtMs: number, actionAtMs: number): number {
	return voice.markMs === undefined ? startedAtMs : actionAtMs - voice.markMs;
}

function settleOptions(expect?: AxLocator) {
	const options: { quietMs: number; capMs: number; expect?: AxLocator } = {
		quietMs: SETTLE_PACING.settleQuietMs,
		capMs: SETTLE_PACING.settleCapMs,
	};
	if (expect !== undefined) options.expect = expect;
	return options;
}

/** find → travel → dwell; the shared front half of click, hover and focusing type. */
async function approach(
	pid: number,
	ax: AxLocator,
	timeoutMs: number,
	deps: NativeStepDeps,
	ctx: NativeStepContext,
) {
	const target = await resolveTarget(deps.driver, pid, ax, timeoutMs);
	const startedAtMs = deps.now() - ctx.t0;
	const travel = travelFor(ctx.lastPoint, target.center);
	const moved = await deps.choreographer.moveTo(target.center.x, target.center.y, travel);
	await deps.choreographer.dwell(narrationDwell(travel, ctx.voice?.markMs).dwellMs);
	return { target, startedAtMs, moved };
}

async function run(
	step: NativeStep,
	index: number,
	deps: NativeStepDeps,
	ctx: NativeStepContext,
): Promise<ActionLogEntry> {
	const { driver, now } = deps;
	const pid = pidFor(step, index, ctx);
	const timeoutMs = ("timeoutMs" in step ? step.timeoutMs : undefined) ?? NATIVE_DEFAULT_TIMEOUT_MS;
	const voice = ctx.voice;

	switch (step.type) {
		case "click": {
			const { target, startedAtMs } = await approach(pid, step.ax, timeoutMs, deps, ctx);
			const achieved = await deps.choreographer.click();
			const clickedAtMs = now() - ctx.t0;
			const settled = await driver.settle(pid, settleOptions(step.expect));
			const entry: ActionLogClickEntry = {
				index,
				type: "click",
				selector: describeLocator(step.ax),
				startedAtMs,
				clickedAtMs,
				screenX: achieved.x,
				screenY: achieved.y,
				boundingBox: boxOf(target.element, ctx.capture),
				settleMs: settled.settleMs,
				app: step.app,
				ax: step.ax,
				settleReason: settled.reason,
			};
			if (step.label !== undefined) entry.label = step.label;
			if (voice) {
				entry.voiceLineId = voice.lineId;
				entry.voiceStartMs = voiceStart(voice, startedAtMs, clickedAtMs);
			}
			return entry;
		}
		case "hover": {
			const { target, startedAtMs, moved } = await approach(pid, step.ax, timeoutMs, deps, ctx);
			const hoveredAtMs = now() - ctx.t0;
			const settled = await driver.settle(pid, settleOptions(step.expect));
			const entry: ActionLogHoverEntry = {
				index,
				type: "hover",
				app: step.app,
				selector: describeLocator(step.ax),
				ax: step.ax,
				startedAtMs,
				hoveredAtMs,
				screenX: moved.to.x,
				screenY: moved.to.y,
				boundingBox: boxOf(target.element, ctx.capture),
				settleMs: settled.settleMs,
				settleReason: settled.reason,
			};
			if (step.label !== undefined) entry.label = step.label;
			if (voice) {
				entry.voiceLineId = voice.lineId;
				entry.voiceStartMs = voiceStart(voice, startedAtMs, hoveredAtMs);
			}
			return entry;
		}
		case "type": {
			let focus:
				| { element: NativeElement; achieved: { x: number; y: number }; startedAtMs: number }
				| undefined;
			if (step.ax !== undefined) {
				const { target, startedAtMs } = await approach(pid, step.ax, timeoutMs, deps, ctx);
				if (target.element.role === "AXSecureTextField" && "text" in step) {
					throw new NativeDriverError(
						"secret_requires_keychain",
						`${stepPrefix(index, step)}: ${describeLocator(step.ax)} is a secure text field; ` +
							'literal "text" is refused there — use "textFrom": { "keychain": ... }',
					);
				}
				const achieved = await deps.choreographer.click();
				focus = { element: target.element, achieved, startedAtMs };
			}
			const startedAtMs = focus?.startedAtMs ?? now() - ctx.t0;
			let text: string;
			if ("text" in step) {
				text = step.text;
			} else {
				try {
					text = await resolveKeychainText(step.textFrom.keychain, { execFile: deps.execFile });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new NativeDriverError(
						"keychain",
						`${stepPrefix(index, step)}: could not resolve its keychain text — ${message}`,
					);
				}
			}
			const characterCount = text.length;
			await driver.type(text, SETTLE_PACING.typeCharDelayMs);
			const endedAtMs = now() - ctx.t0;
			const settled = await driver.settle(pid, settleOptions());
			const point = focus?.achieved ?? ctx.lastPoint ?? { x: 0, y: 0 };
			const entry: ActionLogTypeEntry = {
				index,
				type: "type",
				selector: step.ax !== undefined ? describeLocator(step.ax) : `app:${step.app}`,
				startedAtMs,
				endedAtMs,
				screenX: point.x,
				screenY: point.y,
				boundingBox: focus
					? boxOf(focus.element, ctx.capture)
					: { x: 0, y: 0, width: ctx.capture.width, height: ctx.capture.height },
				characterCount,
				settleMs: settled.settleMs,
				app: step.app,
				settleReason: settled.reason,
			};
			if (step.ax !== undefined) entry.ax = step.ax;
			if (step.label !== undefined) entry.label = step.label;
			if (voice) {
				entry.voiceLineId = voice.lineId;
				entry.voiceStartMs = voiceStart(voice, startedAtMs, endedAtMs);
			}
			return entry;
		}
		case "key": {
			const trust = await driver.trust();
			if (trust.secureInput) {
				throw new NativeDriverError(
					"secure_input",
					`${stepPrefix(index, step)}: Secure Input is on, so posted keys would be dropped`,
				);
			}
			const chords = parseKeys(step.keys);
			const atMs = now() - ctx.t0;
			await driver.key(chords);
			const settled = await driver.settle(pid, settleOptions());
			const entry: ActionLogKeyEntry = {
				index,
				type: "key",
				app: step.app,
				keys: chords.map(chordName),
				atMs,
				settleMs: settled.settleMs,
				settleReason: settled.reason,
			};
			if (step.zoom !== undefined) {
				const zoomed = await driver.find(pid, step.zoom, timeoutMs);
				entry.boundingBox = boxOf(zoomed, ctx.capture);
			}
			if (step.label !== undefined) entry.label = step.label;
			if (voice) {
				entry.voiceLineId = voice.lineId;
				entry.voiceStartMs = atMs;
			}
			return entry;
		}
		case "activate": {
			const atMs = now() - ctx.t0;
			await deps.activate(pid);
			const entry: ActionLogActivateEntry = { index, type: "activate", app: step.app, atMs };
			if (step.label !== undefined) entry.label = step.label;
			if (voice) {
				entry.voiceLineId = voice.lineId;
				entry.voiceStartMs = atMs;
			}
			return entry;
		}
		case "wait": {
			const atMs = now() - ctx.t0;
			await driver.find(pid, step.until, step.timeoutMs);
			const entry: ActionLogWaitEntry = {
				index,
				type: "wait",
				atMs,
				ms: now() - ctx.t0 - atMs,
				app: step.app,
				until: step.until,
			};
			if (voice) {
				entry.voiceLineId = voice.lineId;
				entry.voiceStartMs = atMs;
			}
			return entry;
		}
	}
}

/**
 * Drives one native step and returns its action-log entry. Every box is in capture
 * space; every failure is a {@link NativeDriverError} naming the step index and keeping
 * the helper's `code` (`occluded`, `not_found`, `secure_input`, ...).
 */
export async function driveNativeStep(
	step: NativeStep,
	index: number,
	deps: NativeStepDeps,
	ctx: NativeStepContext,
): Promise<ActionLogEntry> {
	try {
		return await run(step, index, deps, ctx);
	} catch (error) {
		if (error instanceof NativeDriverError && error.message.startsWith("step at index")) {
			throw error;
		}
		nameStep(error, index, step);
	}
}

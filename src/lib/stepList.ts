/**
 * Step-list schema + validator for `drive --steps`.
 *
 * Whatever generates this file is out of scope here (the step list is
 * plain JSON) — this module only
 * validates the shape, mirroring `compose`'s own validate-before-write
 * discipline in the sibling `lensmith` repo
 * (`lensmith/src/commands/compose.ts:validateZoomFragment`): a malformed
 * input fails fast, before anything is launched, naming the offending step's
 * index — never a raw stack trace, never a partially-driven run.
 */

/**
 * CR-LENSMITH-A011-9: the shot grammar v1 — the five named shots a step may carry. The Director turns
 * the name into camera (and, later, cursor) behaviour; an author never writes zoom numbers.
 */
export const SHOT_NAMES = ["wide", "close", "follow", "hold", "reveal"] as const;
export type ShotName = (typeof SHOT_NAMES)[number];

/** CR-LENSMITH-A011-9: fields every step may carry for the shot grammar. */
interface ShotFields {
	/** The named shot; omitted, {@link resolveShots} picks one by the default rule. */
	shot?: ShotName;
}

/**
 * CR-LENSMITH-A011-9: web steps only — maps each `[[mark]]` id in `say` to the CSS selector the
 * cursor points at when that mark is spoken (`wide`, `follow`, `reveal`).
 */
interface TargetFields extends ShotFields {
	targets?: Record<string, string>;
}

export interface ClickStep extends TargetFields {
	type: "click";
	selector: string;
	label?: string;
	/**
	 * Overrides `drive.ts`'s
	 * `DEFAULT_ACTION_TIMEOUT_MS` for this step's element wait, scroll and
	 * bounding-box read. Validated exactly as `wait`'s `ms` is — a finite
	 * positive number, or the step list is rejected before anything launches.
	 */
	timeoutMs?: number;
	/**
	 * CR-LENSMITH-A008-2. The narration line spoken over this step, with at most one `[[mark]]`
	 * placed before the word the click should land on. Timed by `drive --narration`; ignored
	 * (the step drives exactly as without it) when no narration timings are given.
	 */
	say?: string;
	/**
	 * CR-LENSMITH-A011-5. Which mouse button the click uses. Omitted means `"left"` (every existing
	 * step list); `"right"` opens the page's context menu after the real cursor has travelled there.
	 */
	button?: "left" | "right";
}

/**
 * CR-LENSMITH-A011-5. A web `key` step (no `app`): posts one chord, or several in order, to the
 * focused page. Same chord grammar as a native `key` ({@link parseKeys}), plus `enter` as a web
 * name for `return`; `fn` has no web equivalent. `selector`, when given, is focused first.
 */
export interface WebKeyStep extends TargetFields {
	type: "key";
	keys: string | string[];
	selector?: string;
	label?: string;
	/** See {@link ClickStep.timeoutMs} — bounds the `selector` wait and focus. */
	timeoutMs?: number;
	/** See {@link ClickStep.say}. The mark lands on the key press. */
	say?: string;
}

export interface WaitStep extends TargetFields {
	type: "wait";
	ms: number;
	/** See {@link ClickStep.say}. A wait step has no click: a mark, if present, is not used. */
	say?: string;
}

/**
 * Focuses `selector` (driven through the same choreographer
 * a `click` step uses) and enters `text` as real input, character by character.
 * `text` is carried only as long as it takes to drive it — neither `drive.ts`'s
 * action-log entry nor `zoomEmission.ts`'s fragment ever records it (see
 * `actionLog.ts`'s `ActionLogTypeEntry`).
 */
export interface TypeStepLiteral extends TargetFields {
	type: "type";
	selector: string;
	text: string;
	label?: string;
	/** See {@link ClickStep.timeoutMs} — same override, same validation. */
	timeoutMs?: number;
	/** See {@link ClickStep.say}. The mark lands on the click that focuses the field. */
	say?: string;
}

/**
 * The alternative to a literal `text` — the step names
 * *where* to find the value (a macOS keychain service/account pair) rather
 * than carrying the value itself, so a credential never has to be written
 * into a step-list file. Resolution happens at drive time only
 * (`keychainText.ts`); this module never executes anything.
 */
export interface TypeStepFromKeychain extends TargetFields {
	type: "type";
	selector: string;
	textFrom: { keychain: { service: string; account: string } };
	label?: string;
	/** See {@link ClickStep.timeoutMs} — same override, same validation. */
	timeoutMs?: number;
	/** See {@link ClickStep.say}. The mark lands on the click that focuses the field. */
	say?: string;
}

export type TypeStep = TypeStepLiteral | TypeStepFromKeychain;

export type Step = ClickStep | WaitStep | TypeStep | WebKeyStep;

export interface StepList {
	url: string;
	steps: Step[];
	/**
	 * Optional minimum driven-window width (CSS px) this step list requires.
	 * A target UI can hide elements behind a responsive breakpoint (for
	 * example a sidebar that is `hidden lg:flex`, invisible below Tailwind's
	 * 1024px `lg` breakpoint) while `drive`
	 * always launches with `viewport: null` (the real OS window size). On a
	 * narrow window, a step targeting that element fails with Playwright's
	 * generic 30s `waitFor` timeout and no indication why. When set,
	 * `runDrive` checks this ONCE, before any step runs (the whole run
	 * shares one window), and raises a specific, named error instead.
	 */
	minViewportWidth?: number;
}

export class StepListError extends Error {}

function hasTargets(raw: unknown): boolean {
	return (raw as { targets?: unknown }).targets !== undefined;
}

function stepLabel(index: number): string {
	return `step at index ${index}`;
}

/**
 * Shared by the `click` and `type` branches below: a non-positive or non-numeric `timeoutMs` is rejected by name,
 * exactly like `wait`'s `ms` is, before anything launches.
 */
function validateOptionalTimeoutMs(
	value: unknown,
	label: string,
	stepType: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || (value as number) <= 0) {
		throw new StepListError(
			`${label} (type "${stepType}") has a non-positive or non-numeric "timeoutMs" ` +
				`(got ${JSON.stringify(value)})`,
		);
	}
	return value as number;
}

/** Any `[[...]]` tag in a `say` line; the name is checked separately so a bad name is named. */
const SAY_TAG = /\[\[([^\]]*)\]\]/g;
/**
 * CR-LENSMITH-A008-2: the allowed mark name — the same rule the engine's `lensmith narrate` uses to
 * find marks (`/\[\[(\w+)\]\]/`, CR-LENSMITH-A008-5): letters, digits and "_", no hyphen.
 */
export const SAY_MARK_NAME = /^\w+$/;

/** The `[[mark]]` name in a validated `say` line, or undefined when the line carries none. */
export function sayMark(say: string): string | undefined {
	for (const m of say.matchAll(SAY_TAG)) return m[1];
	return undefined;
}

/**
 * CR-LENSMITH-A008-2: `say` is optional; when present it is a non-empty string with at most
 * one `[[mark]]`, whose name matches {@link SAY_MARK_NAME}.
 */
function validateOptionalSay(
	value: unknown,
	label: string,
	stepType: string,
	hasTargets = false,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new StepListError(`${label} (type "${stepType}") has a non-string or empty "say"`);
	}
	const marks = [...value.matchAll(SAY_TAG)].map((m) => m[1] as string);
	if (hasTargets) {
		// CR-LENSMITH-A011-9: with `targets`, a line may carry several marks; each name is checked.
		for (const name of marks) {
			if (!SAY_MARK_NAME.test(name)) {
				throw new StepListError(
					`${label} (type "${stepType}") has an invalid [[mark]] name in "say" ` +
						`(got ${JSON.stringify(name)}; allowed: letters, digits and "_")`,
				);
			}
		}
		return value;
	}
	if (marks.length > 1) {
		throw new StepListError(
			`${label} (type "${stepType}") has ${marks.length} [[mark]] tags in "say" — at most one is allowed without "targets"`,
		);
	}
	const [mark] = marks;
	if (mark !== undefined && !SAY_MARK_NAME.test(mark)) {
		throw new StepListError(
			`${label} (type "${stepType}") has an invalid [[mark]] name in "say" ` +
				`(got ${JSON.stringify(mark)}; allowed: letters, digits and "_")`,
		);
	}
	return value;
}

/** Every `[[mark]]` name in a validated `say` line, in order. */
export function sayMarks(say: string): string[] {
	return [...say.matchAll(SAY_TAG)].map((m) => m[1] as string);
}

/** CR-LENSMITH-A011-9: refuses a `shot` outside the shot grammar, before anything launches. */
function validateOptionalShot(
	value: unknown,
	label: string,
	stepType: string,
): ShotName | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !(SHOT_NAMES as readonly string[]).includes(value)) {
		throw new StepListError(
			`${label} (type "${stepType}") has an unknown "shot" (got ${JSON.stringify(value)}) — ` +
				`expected one of ${SHOT_NAMES.join(", ")} (the Lensmith shot grammar)`,
		);
	}
	return value as ShotName;
}

/**
 * CR-LENSMITH-A011-9: `targets` maps each `[[mark]]` in `say` to a CSS selector; every mark needs a
 * target and every target a mark.
 */
function validateOptionalTargets(
	value: unknown,
	say: string | undefined,
	label: string,
	stepType: string,
): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new StepListError(`${label} (type "${stepType}") has a non-object "targets"`);
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) {
		throw new StepListError(`${label} (type "${stepType}") has an empty "targets"`);
	}
	const targets: Record<string, string> = {};
	for (const [markId, selector] of entries) {
		if (typeof selector !== "string" || selector.length === 0) {
			throw new StepListError(
				`${label} (type "${stepType}") has a missing or empty selector for "targets.${markId}"`,
			);
		}
		targets[markId] = selector;
	}
	const marks = say === undefined ? [] : sayMarks(say);
	for (const mark of marks) {
		if (targets[mark] === undefined) {
			throw new StepListError(
				`${label} (type "${stepType}") marks [[${mark}]] in "say" but "targets" has no "${mark}"`,
			);
		}
	}
	for (const markId of Object.keys(targets)) {
		if (!marks.includes(markId)) {
			throw new StepListError(
				`${label} (type "${stepType}") has "targets.${markId}" but "say" has no [[${markId}]] mark`,
			);
		}
	}
	return targets;
}

/** CR-LENSMITH-A011-9: copies a validated `shot` and `targets` onto a web step. */
function withShotAndTargets<T extends Step>(
	step: T,
	raw: Record<string, unknown>,
	label: string,
): T {
	const shot = validateOptionalShot(raw.shot, label, step.type);
	const targets = validateOptionalTargets(raw.targets, step.say, label, step.type);
	if (shot !== undefined) step.shot = shot;
	if (targets !== undefined) step.targets = targets;
	return step;
}

function validateStep(raw: unknown, index: number): Step {
	const step = validateStepShape(raw, index);
	return withShotAndTargets(step, raw as Record<string, unknown>, stepLabel(index));
}

function validateStepShape(raw: unknown, index: number): Step {
	const label = stepLabel(index);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new StepListError(`${label} is not an object`);
	}

	const { type } = raw as { type?: unknown };

	if (type === "click") {
		const {
			selector,
			label: stepDisplayLabel,
			timeoutMs,
			say,
			button,
		} = raw as {
			selector?: unknown;
			label?: unknown;
			timeoutMs?: unknown;
			say?: unknown;
			button?: unknown;
		};
		if (typeof selector !== "string" || selector.length === 0) {
			throw new StepListError(`${label} (type "click") has a missing or empty "selector"`);
		}
		if (button !== undefined && button !== "left" && button !== "right") {
			throw new StepListError(
				`${label} (type "click") has an invalid "button" (got ${JSON.stringify(button)}; allowed: left, right)`,
			);
		}
		if (stepDisplayLabel !== undefined && typeof stepDisplayLabel !== "string") {
			throw new StepListError(`${label} (type "click") has a non-string "label"`);
		}
		const validatedTimeoutMs = validateOptionalTimeoutMs(timeoutMs, label, "click");
		const validatedSay = validateOptionalSay(say, label, "click", hasTargets(raw));
		const step: ClickStep = { type: "click", selector };
		if (typeof stepDisplayLabel === "string") step.label = stepDisplayLabel;
		if (validatedTimeoutMs !== undefined) step.timeoutMs = validatedTimeoutMs;
		if (validatedSay !== undefined) step.say = validatedSay;
		if (button !== undefined) step.button = button;
		return step;
	}

	if (type === "key") {
		return validateWebKeyStep(raw as Record<string, unknown>, label);
	}

	if (type === "wait") {
		const { ms, say } = raw as { ms?: unknown; say?: unknown };
		if (!Number.isFinite(ms) || (ms as number) <= 0) {
			throw new StepListError(
				`${label} (type "wait") has a missing or non-positive "ms" (got ${JSON.stringify(ms)})`,
			);
		}
		const validatedSay = validateOptionalSay(say, label, "wait", hasTargets(raw));
		const step: WaitStep = { type: "wait", ms: ms as number };
		if (validatedSay !== undefined) step.say = validatedSay;
		return step;
	}

	if (type === "type") {
		const {
			selector,
			text,
			textFrom,
			label: stepDisplayLabel,
			timeoutMs,
			say,
		} = raw as {
			selector?: unknown;
			text?: unknown;
			textFrom?: unknown;
			label?: unknown;
			timeoutMs?: unknown;
			say?: unknown;
		};
		if (typeof selector !== "string" || selector.length === 0) {
			throw new StepListError(`${label} (type "type") has a missing or empty "selector"`);
		}
		if (stepDisplayLabel !== undefined && typeof stepDisplayLabel !== "string") {
			throw new StepListError(`${label} (type "type") has a non-string "label"`);
		}
		const validatedTimeoutMs = validateOptionalTimeoutMs(timeoutMs, label, "type");
		const validatedSay = validateOptionalSay(say, label, "type", hasTargets(raw));

		const hasText = text !== undefined;
		const hasTextFrom = textFrom !== undefined;
		if (hasText === hasTextFrom) {
			throw new StepListError(
				`${label} (type "type") must have exactly one of "text" or "textFrom" ` +
					`(got ${hasText ? "both" : "neither"})`,
			);
		}

		if (hasText) {
			if (typeof text !== "string") {
				throw new StepListError(`${label} (type "type") has a non-string "text"`);
			}
			const step: TypeStepLiteral = { type: "type", selector, text };
			if (typeof stepDisplayLabel === "string") step.label = stepDisplayLabel;
			if (validatedTimeoutMs !== undefined) step.timeoutMs = validatedTimeoutMs;
			if (validatedSay !== undefined) step.say = validatedSay;
			return step;
		}

		if (typeof textFrom !== "object" || textFrom === null || Array.isArray(textFrom)) {
			throw new StepListError(`${label} (type "type") has a non-object "textFrom"`);
		}
		const { keychain } = textFrom as { keychain?: unknown };
		if (typeof keychain !== "object" || keychain === null || Array.isArray(keychain)) {
			throw new StepListError(
				`${label} (type "type") has a "textFrom" with a missing or invalid "keychain" object`,
			);
		}
		const { service, account } = keychain as { service?: unknown; account?: unknown };
		if (typeof service !== "string" || service.length === 0) {
			throw new StepListError(
				`${label} (type "type") has a "textFrom.keychain" with a missing or empty "service"`,
			);
		}
		if (typeof account !== "string" || account.length === 0) {
			throw new StepListError(
				`${label} (type "type") has a "textFrom.keychain" with a missing or empty "account"`,
			);
		}
		const step: TypeStepFromKeychain = {
			type: "type",
			selector,
			textFrom: { keychain: { service, account } },
		};
		if (typeof stepDisplayLabel === "string") step.label = stepDisplayLabel;
		if (validatedTimeoutMs !== undefined) step.timeoutMs = validatedTimeoutMs;
		if (validatedSay !== undefined) step.say = validatedSay;
		return step;
	}

	throw new StepListError(
		`${label} has an unknown "type" (got ${JSON.stringify(type)}) — expected "click", "wait", "type", or "key"`,
	);
}

/**
 * CR-LENSMITH-A011-5: a web chord in the native grammar's form — `enter` is accepted as the web
 * name for `return` (what Playwright and web apps call it); everything else is unchanged.
 */
function normaliseWebChord(chord: unknown): unknown {
	if (typeof chord !== "string") return chord;
	const parts = chord.split("+");
	if (parts[parts.length - 1] === "enter") parts[parts.length - 1] = "return";
	return parts.join("+");
}

/**
 * CR-LENSMITH-A011-5: parses a web `key` step's `keys` — {@link parseKeys} after
 * {@link normaliseWebChord}, refusing `fn`, which a web page cannot receive.
 */
export function parseWebKeys(keys: unknown): Chord[] {
	const normalised = Array.isArray(keys) ? keys.map(normaliseWebChord) : normaliseWebChord(keys);
	const chords = parseKeys(normalised);
	for (const chord of chords) {
		if (chord.mods.includes("fn")) {
			throw new StepListError(
				`"keys" chord ${JSON.stringify([...chord.mods, chord.key].join("+"))} uses "fn", ` +
					"which a web page cannot receive",
			);
		}
	}
	return chords;
}

function validateWebKeyStep(raw: Record<string, unknown>, label: string): WebKeyStep {
	try {
		parseWebKeys(raw.keys);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new StepListError(`${label} (type "key") has an invalid "keys": ${message}`);
	}
	const { selector, label: stepDisplayLabel } = raw;
	if (selector !== undefined && (typeof selector !== "string" || selector.length === 0)) {
		throw new StepListError(`${label} (type "key") has a non-string or empty "selector"`);
	}
	if (stepDisplayLabel !== undefined && typeof stepDisplayLabel !== "string") {
		throw new StepListError(`${label} (type "key") has a non-string "label"`);
	}
	const timeoutMs = validateOptionalTimeoutMs(raw.timeoutMs, label, "key");
	const say = validateOptionalSay(raw.say, label, "key", hasTargets(raw));
	const keys = Array.isArray(raw.keys) ? [...(raw.keys as string[])] : (raw.keys as string);
	const step: WebKeyStep = { type: "key", keys };
	if (typeof selector === "string") step.selector = selector;
	if (typeof stepDisplayLabel === "string") step.label = stepDisplayLabel;
	if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;
	if (say !== undefined) step.say = say;
	return step;
}

/** Validates an already-parsed value. Throws {@link StepListError} naming the first problem found. */
export function validateStepList(parsed: unknown): StepList {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new StepListError('the step list must be an object with "url" and "steps"');
	}

	const { url, steps, minViewportWidth } = parsed as {
		url?: unknown;
		steps?: unknown;
		minViewportWidth?: unknown;
	};

	if (typeof url !== "string" || url.length === 0) {
		throw new StepListError('the step list\'s "url" must be a non-empty string');
	}
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new StepListError('the step list\'s "steps" must be a non-empty array');
	}
	if (
		minViewportWidth !== undefined &&
		(typeof minViewportWidth !== "number" ||
			!Number.isFinite(minViewportWidth) ||
			minViewportWidth <= 0)
	) {
		throw new StepListError(
			`the step list's "minViewportWidth" must be a positive finite number when present ` +
				`(got ${JSON.stringify(minViewportWidth)})`,
		);
	}

	const result: StepList = { url, steps: steps.map((raw, index) => validateStep(raw, index)) };
	if (minViewportWidth !== undefined) result.minViewportWidth = minViewportWidth as number;
	return result;
}

/** Reads and validates `--steps`. Throws {@link StepListError} for bad JSON or a bad shape. */
export function readStepList(rawJson: string, sourcePath: string): StepList {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new StepListError(`"${sourcePath}" is not valid JSON: ${message}`);
	}
	return validateStepList(parsed);
}

/* -------------------------------------------------------------------------------------------- */
/* CR-LENSMITH-A010-2: native step schema (design note §2). A parallel entry point: the web     */
/* types and validators above keep their exact shapes and messages.                             */
/* -------------------------------------------------------------------------------------------- */

/** An Accessibility locator: how a native step finds its element in an app's AX tree. */
export interface AxLocator {
	identifier?: string;
	role?: string;
	title?: string;
	/** Matched against AXDescription. */
	label?: string;
	value?: string;
	match?: "exact" | "contains";
	index?: number;
	in?: "app" | "window" | "menubar" | "statusbar";
	path?: number[];
	/** Window-relative point; last resort, warned by {@link stepListWarnings}. */
	point?: { x: number; y: number };
}

export interface NativeClickStep extends ShotFields {
	type: "click";
	app: string;
	ax: AxLocator;
	expect?: AxLocator;
	label?: string;
	say?: string;
	timeoutMs?: number;
}

export interface NativeHoverStep extends ShotFields {
	type: "hover";
	app: string;
	ax: AxLocator;
	expect?: AxLocator;
	label?: string;
	say?: string;
	timeoutMs?: number;
}

interface NativeTypeStepBase extends ShotFields {
	type: "type";
	app: string;
	/** Clicked to focus before typing, when given. */
	ax?: AxLocator;
	label?: string;
	say?: string;
	timeoutMs?: number;
}

export interface NativeTypeStepLiteral extends NativeTypeStepBase {
	text: string;
}

export interface NativeTypeStepFromKeychain extends NativeTypeStepBase {
	textFrom: { keychain: { service: string; account: string } };
}

export type NativeTypeStep = NativeTypeStepLiteral | NativeTypeStepFromKeychain;

export interface KeyStep extends ShotFields {
	type: "key";
	app: string;
	/** `"cmd+shift+v"` or an array of such chords; see {@link parseKeys}. */
	keys: string | string[];
	/** Locator framed by the zoom after the key settles. */
	zoom?: AxLocator;
	label?: string;
	say?: string;
	timeoutMs?: number;
}

export interface ActivateStep extends ShotFields {
	type: "activate";
	app: string;
	label?: string;
	say?: string;
}

export interface NativeWaitStep extends ShotFields {
	type: "wait";
	app: string;
	until: AxLocator;
	timeoutMs: number;
	say?: string;
}

export type NativeStep =
	| NativeClickStep
	| NativeHoverStep
	| NativeTypeStep
	| KeyStep
	| ActivateStep
	| NativeWaitStep;

export type DriveStep = Step | NativeStep;

/** A native step is one that names an `app`. */
export function isNativeStep(step: DriveStep): step is NativeStep {
	return typeof (step as { app?: unknown }).app === "string";
}

export interface AppSpec {
	bundleId: string;
	frame?: { x: number; y: number; width: number; height: number };
	args?: string[];
}

export type CaptureSpec =
	| "auto"
	| "window"
	| "screen"
	| { region: { x: number; y: number; width: number; height: number } };

export interface DriveStepList {
	url?: string;
	steps: DriveStep[];
	apps?: AppSpec[];
	capture?: CaptureSpec;
	minViewportWidth?: number;
}

export const MODIFIER_NAMES = ["cmd", "shift", "opt", "ctrl", "fn"] as const;
export type Modifier = (typeof MODIFIER_NAMES)[number];

const LETTER_KEYS = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGIT_KEYS = "0123456789".split("");
const PUNCTUATION_KEYS = [
	"minus",
	"equal",
	"comma",
	"period",
	"slash",
	"semicolon",
	"quote",
	"backslash",
	"leftbracket",
	"rightbracket",
	"grave",
];
const CONTROL_KEYS = [
	"return",
	"tab",
	"space",
	"escape",
	"delete",
	"forwarddelete",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
];

export const KEY_NAMES: readonly string[] = [
	...LETTER_KEYS,
	...DIGIT_KEYS,
	...CONTROL_KEYS,
	...PUNCTUATION_KEYS,
];
export type KeyName = string;

/** Keys that would print a character: they need cmd, ctrl or opt so `keys` never spells text. */
const PRINTABLE_KEYS = new Set<string>([
	...LETTER_KEYS,
	...DIGIT_KEYS,
	...PUNCTUATION_KEYS,
	"space",
]);
const KEY_NAME_SET = new Set<string>(KEY_NAMES);
const MODIFIER_SET = new Set<string>(MODIFIER_NAMES);

export interface Chord {
	key: KeyName;
	mods: Modifier[];
}

function parseChord(chord: unknown): Chord {
	if (typeof chord !== "string" || chord.length === 0) {
		throw new StepListError(
			`a "keys" chord must be a non-empty string (got ${JSON.stringify(chord)})`,
		);
	}
	const parts = chord.split("+");
	const key = parts[parts.length - 1] as string;
	const mods = parts.slice(0, -1);
	for (const mod of mods) {
		if (!MODIFIER_SET.has(mod)) {
			throw new StepListError(
				`"keys" chord ${JSON.stringify(chord)} has an unknown modifier ${JSON.stringify(mod)} ` +
					`(allowed: ${MODIFIER_NAMES.join(", ")})`,
			);
		}
	}
	if (new Set(mods).size !== mods.length) {
		throw new StepListError(`"keys" chord ${JSON.stringify(chord)} repeats a modifier`);
	}
	if (!KEY_NAME_SET.has(key)) {
		throw new StepListError(
			`"keys" chord ${JSON.stringify(chord)} has an unknown key ${JSON.stringify(key)}`,
		);
	}
	if (PRINTABLE_KEYS.has(key) && !mods.some((m) => m === "cmd" || m === "ctrl" || m === "opt")) {
		throw new StepListError(
			`"keys" chord ${JSON.stringify(chord)} is a printable key without cmd, ctrl or opt — ` +
				`free text goes through a "type" step`,
		);
	}
	return { key, mods: mods as Modifier[] };
}

/** Parses `"cmd+shift+v"` or an array of such strings. Throws {@link StepListError} on a bad chord. */
export function parseKeys(keys: unknown): Chord[] {
	if (typeof keys === "string") return [parseChord(keys)];
	if (Array.isArray(keys) && keys.length > 0) return keys.map(parseChord);
	throw new StepListError(
		`"keys" must be a chord string or a non-empty array of chord strings (got ${JSON.stringify(keys)})`,
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const LOCATOR_KEYS = ["identifier", "role", "title", "label", "value", "path", "point"] as const;
const LOCATOR_STRING_KEYS = ["identifier", "role", "title", "label", "value"] as const;

function validateLocator(raw: unknown, where: string): AxLocator {
	if (!isPlainObject(raw)) {
		throw new StepListError(`${where} must be an object`);
	}
	if (!LOCATOR_KEYS.some((k) => raw[k] !== undefined)) {
		throw new StepListError(`${where} needs at least one of ${LOCATOR_KEYS.join(", ")}`);
	}
	const locator: AxLocator = {};
	for (const k of LOCATOR_STRING_KEYS) {
		const v = raw[k];
		if (v === undefined) continue;
		if (typeof v !== "string" || v.length === 0) {
			throw new StepListError(`${where} has a non-string or empty "${k}"`);
		}
		locator[k] = v;
	}
	if (raw.match !== undefined) {
		if (raw.match !== "exact" && raw.match !== "contains") {
			throw new StepListError(
				`${where} has an invalid "match" (got ${JSON.stringify(raw.match)}; allowed: exact, contains)`,
			);
		}
		locator.match = raw.match;
	}
	if (raw.index !== undefined) {
		if (!isNonNegativeInteger(raw.index)) {
			throw new StepListError(
				`${where} has a non-integer or negative "index" (got ${JSON.stringify(raw.index)})`,
			);
		}
		locator.index = raw.index;
	}
	if (raw.in !== undefined) {
		if (raw.in !== "app" && raw.in !== "window" && raw.in !== "menubar" && raw.in !== "statusbar") {
			throw new StepListError(
				`${where} has an invalid "in" (got ${JSON.stringify(raw.in)}; allowed: app, window, menubar, statusbar)`,
			);
		}
		locator.in = raw.in;
	}
	if (raw.path !== undefined) {
		if (
			!Array.isArray(raw.path) ||
			raw.path.length === 0 ||
			!raw.path.every(isNonNegativeInteger)
		) {
			throw new StepListError(
				`${where} has an invalid "path" (must be a non-empty array of non-negative integers; ` +
					`got ${JSON.stringify(raw.path)})`,
			);
		}
		locator.path = [...raw.path];
	}
	if (raw.point !== undefined) {
		const p = raw.point;
		if (!isPlainObject(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
			throw new StepListError(`${where} has an invalid "point" (needs finite "x" and "y")`);
		}
		locator.point = { x: p.x as number, y: p.y as number };
	}
	return locator;
}

/** Reverse-DNS bundle id: at least two dot-separated segments of letters, digits, "-" and "_". */
const BUNDLE_ID = /^[A-Za-z0-9-_]+(\.[A-Za-z0-9-_]+)+$/;

const NATIVE_ONLY_TYPES = new Set(["hover", "activate"]);

function validateOptionalDisplayLabel(
	value: unknown,
	label: string,
	stepType: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new StepListError(`${label} (type "${stepType}") has a non-string "label"`);
	}
	return value;
}

function validateNativeStep(
	raw: Record<string, unknown>,
	index: number,
	listedApps: Set<string>,
): NativeStep {
	const label = stepLabel(index);
	const { type, app } = raw;
	const typeName = typeof type === "string" ? type : JSON.stringify(type);
	if (typeof app !== "string" || !BUNDLE_ID.test(app)) {
		throw new StepListError(
			`${label} (type "${typeName}") has an invalid "app" (must be a reverse-DNS bundle id; got ${JSON.stringify(app)})`,
		);
	}
	if (!listedApps.has(app)) {
		throw new StepListError(
			`${label} (type "${typeName}") has an "app" ${JSON.stringify(app)} that is not listed in the top-level "apps"`,
		);
	}
	if (raw.selector !== undefined) {
		throw new StepListError(
			`${label} (type "${typeName}") has both "app" and "selector" — they are exclusive`,
		);
	}
	if (raw.targets !== undefined) {
		throw new StepListError(
			`${label} (type "${typeName}") has "targets" — targets are web selectors in v1 (native steps cannot use them)`,
		);
	}
	const step = validateNativeStepShape(raw, label, typeName, app);
	const shot = validateOptionalShot(raw.shot, label, typeName);
	if (shot !== undefined) step.shot = shot;
	return step;
}

function validateNativeStepShape(
	raw: Record<string, unknown>,
	label: string,
	typeName: string,
	app: string,
): NativeStep {
	const { type } = raw;
	const displayLabel = validateOptionalDisplayLabel(raw.label, label, typeName);
	const say = validateOptionalSay(raw.say, label, typeName);

	if (type === "click" || type === "hover") {
		const ax = validateLocator(raw.ax, `${label} (type "${type}") "ax"`);
		const step = { type, app, ax } as NativeClickStep | NativeHoverStep;
		if (raw.expect !== undefined)
			step.expect = validateLocator(raw.expect, `${label} (type "${type}") "expect"`);
		if (displayLabel !== undefined) step.label = displayLabel;
		if (say !== undefined) step.say = say;
		const timeoutMs = validateOptionalTimeoutMs(raw.timeoutMs, label, type);
		if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;
		return step;
	}

	if (type === "type") {
		const hasText = raw.text !== undefined;
		const hasTextFrom = raw.textFrom !== undefined;
		if (hasText === hasTextFrom) {
			throw new StepListError(
				`${label} (type "type") must have exactly one of "text" or "textFrom" ` +
					`(got ${hasText ? "both" : "neither"})`,
			);
		}
		const timeoutMs = validateOptionalTimeoutMs(raw.timeoutMs, label, "type");
		const ax =
			raw.ax === undefined ? undefined : validateLocator(raw.ax, `${label} (type "type") "ax"`);
		let step: NativeTypeStep;
		if (hasText) {
			if (typeof raw.text !== "string") {
				throw new StepListError(`${label} (type "type") has a non-string "text"`);
			}
			step = { type: "type", app, text: raw.text };
		} else {
			const textFrom = raw.textFrom;
			if (!isPlainObject(textFrom)) {
				throw new StepListError(`${label} (type "type") has a non-object "textFrom"`);
			}
			const keychain = textFrom.keychain;
			if (!isPlainObject(keychain)) {
				throw new StepListError(
					`${label} (type "type") has a "textFrom" with a missing or invalid "keychain" object`,
				);
			}
			const { service, account } = keychain;
			if (typeof service !== "string" || service.length === 0) {
				throw new StepListError(
					`${label} (type "type") has a "textFrom.keychain" with a missing or empty "service"`,
				);
			}
			if (typeof account !== "string" || account.length === 0) {
				throw new StepListError(
					`${label} (type "type") has a "textFrom.keychain" with a missing or empty "account"`,
				);
			}
			step = { type: "type", app, textFrom: { keychain: { service, account } } };
		}
		if (ax !== undefined) step.ax = ax;
		if (displayLabel !== undefined) step.label = displayLabel;
		if (say !== undefined) step.say = say;
		if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;
		return step;
	}

	if (type === "key") {
		try {
			parseKeys(raw.keys);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new StepListError(`${label} (type "key") has an invalid "keys": ${message}`);
		}
		const keys = Array.isArray(raw.keys) ? [...(raw.keys as string[])] : (raw.keys as string);
		const step: KeyStep = { type: "key", app, keys };
		if (raw.zoom !== undefined)
			step.zoom = validateLocator(raw.zoom, `${label} (type "key") "zoom"`);
		if (displayLabel !== undefined) step.label = displayLabel;
		if (say !== undefined) step.say = say;
		const timeoutMs = validateOptionalTimeoutMs(raw.timeoutMs, label, "key");
		if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;
		return step;
	}

	if (type === "activate") {
		const step: ActivateStep = { type: "activate", app };
		if (displayLabel !== undefined) step.label = displayLabel;
		if (say !== undefined) step.say = say;
		return step;
	}

	if (type === "wait") {
		if (raw.ms !== undefined) {
			throw new StepListError(
				`${label} (type "wait") has both "ms" and "app" — a wait is either "ms" or "app" + "until" + "timeoutMs"`,
			);
		}
		if (raw.until === undefined) {
			throw new StepListError(`${label} (type "wait") has "app" but no "until" locator`);
		}
		const until = validateLocator(raw.until, `${label} (type "wait") "until"`);
		if (raw.timeoutMs === undefined) {
			throw new StepListError(`${label} (type "wait") has "app" but no positive "timeoutMs"`);
		}
		const timeoutMs = validateOptionalTimeoutMs(raw.timeoutMs, label, "wait") as number;
		const step: NativeWaitStep = { type: "wait", app, until, timeoutMs };
		if (say !== undefined) step.say = say;
		return step;
	}

	throw new StepListError(
		`${label} has an unknown "type" (got ${JSON.stringify(type)}) — ` +
			`expected "click", "hover", "type", "key", "activate", or "wait"`,
	);
}

function validateRect(
	raw: unknown,
	where: string,
): { x: number; y: number; width: number; height: number } {
	if (!isPlainObject(raw)) throw new StepListError(`${where} must be an object`);
	const { x, y, width, height } = raw;
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new StepListError(`${where} needs finite "x" and "y"`);
	}
	if (
		!Number.isFinite(width) ||
		(width as number) <= 0 ||
		!Number.isFinite(height) ||
		(height as number) <= 0
	) {
		throw new StepListError(`${where} needs positive finite "width" and "height"`);
	}
	return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function validateApps(raw: unknown): AppSpec[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		throw new StepListError('the step list\'s "apps" must be an array when present');
	}
	const seen = new Set<string>();
	return raw.map((entry, i) => {
		const where = `the step list's "apps" entry at index ${i}`;
		if (!isPlainObject(entry)) throw new StepListError(`${where} is not an object`);
		const { bundleId, frame, args } = entry;
		if (typeof bundleId !== "string" || !BUNDLE_ID.test(bundleId)) {
			throw new StepListError(
				`${where} has an invalid "bundleId" (must be a reverse-DNS bundle id; got ${JSON.stringify(bundleId)})`,
			);
		}
		if (seen.has(bundleId)) {
			throw new StepListError(
				`${where} repeats "bundleId" ${JSON.stringify(bundleId)} — bundle ids must be unique`,
			);
		}
		seen.add(bundleId);
		const spec: AppSpec = { bundleId };
		if (frame !== undefined) spec.frame = validateRect(frame, `${where} "frame"`);
		if (args !== undefined) {
			if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
				throw new StepListError(`${where} has a non-string-array "args"`);
			}
			spec.args = [...args];
		}
		return spec;
	});
}

function validateCapture(raw: unknown): CaptureSpec | undefined {
	if (raw === undefined) return undefined;
	if (raw === "auto" || raw === "window" || raw === "screen") return raw;
	if (isPlainObject(raw) && raw.region !== undefined) {
		const region = validateRect(raw.region, 'the step list\'s "capture.region"');
		if (Math.abs(region.width / region.height - 16 / 9) >= 0.001) {
			throw new StepListError(
				`the step list's "capture.region" must be 16:9 (got ${region.width}x${region.height})`,
			);
		}
		return { region };
	}
	throw new StepListError(
		`the step list's "capture" must be "auto", "window", "screen" or { "region": {...} } (got ${JSON.stringify(raw)})`,
	);
}

/**
 * Validates a step list that may mix native steps (with `app`) and web steps. A step without `app`
 * goes through the web validator unchanged. Throws {@link StepListError} naming the first problem.
 */
export function validateDriveStepList(parsed: unknown): DriveStepList {
	if (!isPlainObject(parsed)) {
		throw new StepListError('the step list must be an object with "steps"');
	}
	const { url, steps, minViewportWidth, apps, capture } = parsed;
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new StepListError('the step list\'s "steps" must be a non-empty array');
	}
	if (url !== undefined && (typeof url !== "string" || url.length === 0)) {
		throw new StepListError('the step list\'s "url" must be a non-empty string when present');
	}
	if (
		minViewportWidth !== undefined &&
		(typeof minViewportWidth !== "number" ||
			!Number.isFinite(minViewportWidth) ||
			minViewportWidth <= 0)
	) {
		throw new StepListError(
			`the step list's "minViewportWidth" must be a positive finite number when present ` +
				`(got ${JSON.stringify(minViewportWidth)})`,
		);
	}
	const validatedApps = validateApps(apps);
	const validatedCapture = validateCapture(capture);
	const listedApps = new Set((validatedApps ?? []).map((a) => a.bundleId));

	let hasSelector = false;
	const validatedSteps: DriveStep[] = steps.map((raw, index) => {
		if (isPlainObject(raw) && raw.app !== undefined) {
			return validateNativeStep(raw, index, listedApps);
		}
		if (isPlainObject(raw) && typeof raw.type === "string" && NATIVE_ONLY_TYPES.has(raw.type)) {
			throw new StepListError(`${stepLabel(index)} (type "${raw.type}") needs an "app"`);
		}
		// CR-LENSMITH-A011-5: a `key` without `app` is a web key — it needs a page to focus.
		if (isPlainObject(raw) && raw.type === "key" && url === undefined) {
			throw new StepListError(
				`${stepLabel(index)} (type "key") has no "app", and a web "key" needs the step list's ` +
					`"url" (a page to focus)`,
			);
		}
		const step = validateStep(raw, index);
		if ("selector" in step) hasSelector = true;
		return step;
	});
	if (hasSelector && url === undefined) {
		throw new StepListError(
			'the step list\'s "url" must be a non-empty string when any step has a "selector"',
		);
	}

	const result: DriveStepList = { steps: validatedSteps };
	if (url !== undefined) result.url = url as string;
	if (minViewportWidth !== undefined) result.minViewportWidth = minViewportWidth as number;
	if (validatedApps !== undefined) result.apps = validatedApps;
	if (validatedCapture !== undefined) result.capture = validatedCapture;
	return result;
}

/** Reads and validates a mixed native/web step list. Throws {@link StepListError} for bad JSON or shape. */
export function readDriveStepList(rawJson: string, sourcePath: string): DriveStepList {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new StepListError(`"${sourcePath}" is not valid JSON: ${message}`);
	}
	return validateDriveStepList(parsed);
}

function locatorsOf(step: DriveStep): AxLocator[] {
	const out: AxLocator[] = [];
	const s = step as { ax?: AxLocator; expect?: AxLocator; zoom?: AxLocator; until?: AxLocator };
	for (const l of [s.ax, s.expect, s.zoom, s.until]) if (l !== undefined) out.push(l);
	return out;
}

/** One warning per `point` locator: points break across app versions. */
export function stepListWarnings(list: DriveStepList): string[] {
	const warnings: string[] = [];
	list.steps.forEach((step, index) => {
		for (const locator of locatorsOf(step)) {
			if (locator.point !== undefined) {
				warnings.push(
					`${stepLabel(index)} uses a "point" locator — point locators break across app versions`,
				);
			}
		}
	});
	return warnings;
}

/** CR-LENSMITH-A011-9: the step types that act on the page or app (the default rule's "action"). */
const ACTION_TYPES = new Set(["click", "type", "key", "hover"]);

/**
 * CR-LENSMITH-A011-9: one shot per step, by the shot grammar's default rule. An explicit `shot`
 * always wins. Otherwise: a step with an action (`click`, `type`, `key`, `hover`) is `close`; the
 * last narrated step that only shows is `hold` (unless it names `targets`); any other step that only
 * shows (a narrated `wait`, or one with `targets`) is `wide`; a silent step that only shows is
 * `hold` (the camera keeps whatever it was doing). Pure.
 */
export function resolveShots(stepList: { steps: readonly DriveStep[] }): ShotName[] {
	const { steps } = stepList;
	let lastNarrated = -1;
	steps.forEach((step, index) => {
		if (step.say !== undefined) lastNarrated = index;
	});
	return steps.map((step, index): ShotName => {
		if (step.shot !== undefined) return step.shot;
		if (ACTION_TYPES.has(step.type)) return "close";
		const targets = (step as { targets?: unknown }).targets;
		if (index === lastNarrated && targets === undefined) return "hold";
		if (step.say !== undefined || targets !== undefined) return "wide";
		return "hold";
	});
}

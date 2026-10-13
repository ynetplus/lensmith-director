import { type Command, InvalidArgumentError } from "commander";
import {
	CursorChoreographer,
	CursorChoreographerError,
	type Point,
} from "../lib/cursorChoreographer.js";
import { NativeHelperMissingError } from "../lib/nativeHelpers.js";
import { DEFAULT_MOVE_DURATION_MS } from "../lib/timing.js";

/**
 * Coordinates are top-left origin, in points (== CSS pixels). They are NOT
 * multiplied by `devicePixelRatio`. Negative values are legitimate: a second
 * display can sit at a negative origin, and the desktop coordinate space is
 * signed and continuous across displays, so nothing here clamps.
 */
export function parseCoordinate(raw: string, axis: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new InvalidArgumentError(
			`<${axis}> must be a number of points from the top-left of the desktop (got "${raw}"). Negative values are allowed.`,
		);
	}
	return value;
}

/**
 * `--duration-ms 0` is REJECTED rather than treated as an instant move. An
 * instant jump posts a single event and reads on video exactly like the
 * teleport this tool exists to avoid; a caller that wants one is almost always
 * a caller that meant something else.
 */
export function parseDurationMs(raw: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new InvalidArgumentError(
			`--duration-ms must be a positive whole number of milliseconds (got "${raw}"). 0 is rejected: an instant jump is a teleport, not a move.`,
		);
	}
	return value;
}

export class MacOSRequiredError extends Error {
	readonly platform: NodeJS.Platform;

	constructor(platform: NodeJS.Platform) {
		super(`lensmith-director cursor needs macOS (got ${platform})`);
		this.name = "MacOSRequiredError";
		this.platform = platform;
	}
}

/** Cursor subcommands use the macOS native helper and must fail before it starts. */
export function ensureMacOS(platform: NodeJS.Platform = process.platform): void {
	if (platform !== "darwin") {
		throw new MacOSRequiredError(platform);
	}
}

function formatPoint(point: Point, asJson: boolean): string {
	return asJson ? JSON.stringify(point) : `x: ${point.x}, y: ${point.y}`;
}

function reportFailure(error: unknown): never {
	if (
		error instanceof MacOSRequiredError ||
		error instanceof NativeHelperMissingError ||
		error instanceof CursorChoreographerError
	) {
		console.error(error.message);
		process.exit(1);
	}
	throw error;
}

const EXCLUSIVE_MACHINE_NOTICE =
	"Posting real input events — they go to whatever window is under the cursor. Do not touch the machine.";

export function registerCursorCommand(program: Command): void {
	const cursor = program
		.command("cursor")
		.description("read, move and click the real macOS cursor");

	cursor
		.command("position")
		.description("print the current cursor position (read-only — posts no events)")
		.option("--json", "print the position as JSON")
		.action(async (options: { json?: boolean }) => {
			try {
				ensureMacOS();
				const choreographer = new CursorChoreographer();
				await choreographer.start();
				try {
					const point = await choreographer.position();
					console.log(formatPoint(point, options.json === true));
				} finally {
					choreographer.stop();
				}
			} catch (error) {
				reportFailure(error);
			}
		});

	cursor
		.command("move")
		.description("move the real cursor along an eased path (posts real motion events)")
		.argument("<x>", "target x, in points from the left of the desktop", (raw) =>
			parseCoordinate(raw, "x"),
		)
		.argument("<y>", "target y, in points from the top of the desktop", (raw) =>
			parseCoordinate(raw, "y"),
		)
		.option(
			"--duration-ms <ms>",
			`move duration in milliseconds (default: ${DEFAULT_MOVE_DURATION_MS})`,
			parseDurationMs,
			DEFAULT_MOVE_DURATION_MS,
		)
		.option("--json", "print the result as JSON")
		.action(async (x: number, y: number, options: { durationMs: number; json?: boolean }) => {
			try {
				ensureMacOS();
				console.error(EXCLUSIVE_MACHINE_NOTICE);
				const choreographer = new CursorChoreographer();
				await choreographer.start();
				try {
					const result = await choreographer.moveTo(x, y, options.durationMs);
					for (const warning of result.warnings) {
						console.error(`warning: ${warning}`);
					}
					if (options.json === true) {
						console.log(JSON.stringify(result));
					} else {
						console.log(
							`moved to x: ${result.to.x}, y: ${result.to.y} in ${Math.round(result.elapsedMs)}ms (${result.steps} events)`,
						);
					}
				} finally {
					choreographer.stop();
				}
			} catch (error) {
				reportFailure(error);
			}
		});

	cursor
		.command("click")
		.description("click at the current cursor position (posts a real, trusted click)")
		.option("--json", "print the result as JSON")
		.action(async (options: { json?: boolean }) => {
			try {
				ensureMacOS();
				console.error(EXCLUSIVE_MACHINE_NOTICE);
				const choreographer = new CursorChoreographer();
				await choreographer.start();
				try {
					const point = await choreographer.click();
					console.log(
						options.json === true
							? JSON.stringify(point)
							: `clicked at x: ${point.x}, y: ${point.y}`,
					);
				} finally {
					choreographer.stop();
				}
			} catch (error) {
				reportFailure(error);
			}
		});
}

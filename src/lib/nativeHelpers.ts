import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Compiled output lives at dist/lib/nativeHelpers.js — the repo root is two
// directories up. `bin/` is a gitignored build artifact (see
// `npm run build:native:mac`); CI builds it fresh on every run.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const binDir = path.join(repoRoot, "bin");

export const CURSOR_CHOREOGRAPHER_NAME = "lensmith-cursor-choreographer";
export const SCREEN_CAPTURE_PREFLIGHT_NAME = "lensmith-screen-capture-preflight";
export const NATIVE_DRIVER_NAME = "lensmith-native-driver";

export class NativeHelperMissingError extends Error {}

/**
 * `baseDir` is injectable for tests only — production callers resolve against
 * the repo's real `bin/` directory via the default.
 *
 * A missing binary must fail with a sentence naming the build step, not with a
 * spawn ENOENT stack trace: "not built yet" is the single most likely first-run
 * state, and it has an exact fix.
 */
export function resolveCursorChoreographerPath(baseDir: string = binDir): string {
	const helperPath = path.join(baseDir, CURSOR_CHOREOGRAPHER_NAME);
	try {
		accessSync(helperPath, fsConstants.X_OK);
	} catch {
		throw new NativeHelperMissingError(
			`Native helper "${CURSOR_CHOREOGRAPHER_NAME}" not found or not executable at ${helperPath}. ` +
				'Run "npm run build:native:mac" first (macOS, requires Apple\'s Command Line Tools).',
		);
	}
	return helperPath;
}

/** Same missing-binary discipline as {@link resolveCursorChoreographerPath}, for the other helper. */
export function resolveScreenCapturePreflightPath(baseDir: string = binDir): string {
	const helperPath = path.join(baseDir, SCREEN_CAPTURE_PREFLIGHT_NAME);
	try {
		accessSync(helperPath, fsConstants.X_OK);
	} catch {
		throw new NativeHelperMissingError(
			`Native helper "${SCREEN_CAPTURE_PREFLIGHT_NAME}" not found or not executable at ${helperPath}. ` +
				'Run "npm run build:native:mac" first (macOS, requires Apple\'s Command Line Tools).',
		);
	}
	return helperPath;
}

/** Same missing-binary discipline as {@link resolveCursorChoreographerPath}, for the AX driver (CR-LENSMITH-A010-5). */
export function resolveNativeDriverPath(baseDir: string = binDir): string {
	const helperPath = path.join(baseDir, NATIVE_DRIVER_NAME);
	try {
		accessSync(helperPath, fsConstants.X_OK);
	} catch {
		throw new NativeHelperMissingError(
			`Native helper "${NATIVE_DRIVER_NAME}" not found or not executable at ${helperPath}. ` +
				'Run "npm run build:native:mac" first (macOS, requires Apple\'s Command Line Tools).',
		);
	}
	return helperPath;
}

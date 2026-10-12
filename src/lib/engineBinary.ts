/**
 * Resolves the `lensmith` engine's built CLI entrypoint (`dist/cli.js`)
 * explicitly — never assumed to be on PATH. CR-LENSMITH-A002-7, CR-LENSMITH-A009-3.
 *
 * Resolution order (first hit wins):
 *   1. `LENSMITH_ENGINE_BIN` — an explicit override. When set it is final: a bad
 *      path is an error naming that path, never a silent fall-through.
 *   2. The installed `lensmith` npm dependency — its `package.json` is resolved
 *      from this module with `createRequire`, then its `bin.lensmith` entry. This
 *      is what an `npm install -g lensmith-director` user gets: the engine comes
 *      with the director, no sibling checkout, no environment variable.
 *   3. The sibling checkout `../lensmith/dist/cli.js` — contributors working on
 *      both repos side by side.
 *
 * Why spawn `process.execPath` against a resolved file instead of the `lensmith`
 * command on PATH: measured 2026-09-12, the npm-linked `lensmith` executable
 * exited 0 with zero output. That was the engine's own main-module check failing
 * through npm's bin symlink, fixed in CR-LENSMITH-A009-2 — but resolving the file
 * explicitly still keeps `demo` independent of whatever is (or is not) on PATH,
 * the same way `nativeHelpers.ts` resolves this repo's own compiled helpers.
 */

import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_BIN_ENV_VAR = "LENSMITH_ENGINE_BIN";
export const ENGINE_PACKAGE_NAME = "lensmith";

export class EngineBinaryMissingError extends Error {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled output lives at dist/lib/engineBinary.js — the repo root is two
// directories up (mirrors nativeHelpers.ts's own derivation).
const directorRepoRoot = path.resolve(__dirname, "..", "..");
const defaultSiblingEngineBinPath = path.resolve(
	directorRepoRoot,
	"..",
	"lensmith",
	"dist",
	"cli.js",
);

/** Returns the absolute path of the installed engine's `package.json`; throws when not installed. */
function defaultResolveEnginePackageJson(): string {
	return createRequire(import.meta.url).resolve(`${ENGINE_PACKAGE_NAME}/package.json`);
}

export interface EngineBinaryResolveOptions {
	/** Absolute path of the installed `lensmith` package.json, or throws if absent. */
	resolveEnginePackageJson?: () => string;
	/** The contributor sibling-checkout path. */
	siblingPath?: string;
}

function isReadable(file: string): boolean {
	try {
		accessSync(file, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The installed dependency's CLI path, or a sentence saying why there is none.
 * `bin` may be a string or a `{ lensmith: "dist/cli.js" }` map (npm allows both).
 */
function fromInstalledDependency(
	resolveEnginePackageJson: () => string,
): { path: string } | { reason: string } {
	let packageJsonPath: string;
	try {
		packageJsonPath = resolveEnginePackageJson();
	} catch {
		return { reason: `the "${ENGINE_PACKAGE_NAME}" npm package is not installed` };
	}
	let bin: unknown;
	try {
		bin = (JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { bin?: unknown }).bin;
	} catch {
		return { reason: `${packageJsonPath} could not be read` };
	}
	const rel =
		typeof bin === "string"
			? bin
			: bin && typeof bin === "object"
				? (bin as Record<string, unknown>)[ENGINE_PACKAGE_NAME]
				: undefined;
	if (typeof rel !== "string") {
		return { reason: `${packageJsonPath} has no "bin.${ENGINE_PACKAGE_NAME}" entry` };
	}
	const cliPath = path.resolve(path.dirname(packageJsonPath), rel);
	if (!isReadable(cliPath)) {
		return { reason: `the installed "${ENGINE_PACKAGE_NAME}" package has no CLI at ${cliPath}` };
	}
	return { path: cliPath };
}

/**
 * `env` and `options` are injectable for tests only — production callers resolve
 * against `process.env`, the real installed dependency and the real sibling path.
 */
export function resolveEngineBinaryPath(
	env: NodeJS.ProcessEnv = process.env,
	options: EngineBinaryResolveOptions = {},
): string {
	const resolveEnginePackageJson =
		options.resolveEnginePackageJson ?? defaultResolveEnginePackageJson;
	const siblingPath = options.siblingPath ?? defaultSiblingEngineBinPath;

	const override = env[ENGINE_BIN_ENV_VAR];
	if (override !== undefined) {
		if (isReadable(override)) return override;
		throw new EngineBinaryMissingError(
			`Lensmith engine CLI not found at ${override} (set by ${ENGINE_BIN_ENV_VAR}). ` +
				`Point ${ENGINE_BIN_ENV_VAR} at the engine's dist/cli.js, or unset it to use the ` +
				`installed "${ENGINE_PACKAGE_NAME}" npm package.`,
		);
	}

	const installed = fromInstalledDependency(resolveEnginePackageJson);
	if ("path" in installed) return installed.path;

	if (isReadable(siblingPath)) return siblingPath;

	throw new EngineBinaryMissingError(
		"Lensmith engine CLI not found. Tried, in order:\n" +
			`  1. ${ENGINE_BIN_ENV_VAR}: not set\n` +
			`  2. the installed "${ENGINE_PACKAGE_NAME}" npm package: ${installed.reason}\n` +
			`  3. a sibling checkout: nothing at ${siblingPath}\n` +
			`Fix: reinstall lensmith-director (it brings "${ENGINE_PACKAGE_NAME}" with it), or set ` +
			`${ENGINE_BIN_ENV_VAR} to the engine's dist/cli.js, or build the engine ("npm run build" ` +
			"in the lensmith repo) next to this checkout.",
	);
}

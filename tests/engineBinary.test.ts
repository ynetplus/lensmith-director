import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ENGINE_BIN_ENV_VAR,
	EngineBinaryMissingError,
	resolveEngineBinaryPath,
} from "../src/lib/engineBinary.js";

// Resolution order (CR-LENSMITH-A009-3): LENSMITH_ENGINE_BIN -> the installed
// `lensmith` npm dependency -> the sibling checkout. Every source is injected,
// so no test depends on what happens to be in node_modules or next to the repo.

const testsDir = path.dirname(fileURLToPath(import.meta.url));

const notInstalled = () => {
	throw new Error("Cannot find module 'lensmith/package.json'");
};

describe("resolveEngineBinaryPath", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-engine-bin-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A fake installed `lensmith` package with `bin` as given; returns its package.json path. */
	function fakeEnginePackage(bin: unknown, writeCli = true): string {
		const pkgDir = path.join(dir, "node_modules", "lensmith");
		mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
		const pkgJson = path.join(pkgDir, "package.json");
		writeFileSync(pkgJson, JSON.stringify({ name: "lensmith", version: "0.1.0", bin }));
		if (writeCli) writeFileSync(path.join(pkgDir, "dist", "cli.js"), "// fake engine cli\n");
		return pkgJson;
	}

	function fakeSibling(): string {
		const cliPath = path.join(dir, "sibling", "lensmith", "dist", "cli.js");
		mkdirSync(path.dirname(cliPath), { recursive: true });
		writeFileSync(cliPath, "// fake sibling engine cli\n");
		return cliPath;
	}

	describe("step 1: LENSMITH_ENGINE_BIN", () => {
		it("wins over both the installed dependency and the sibling checkout", () => {
			const overridePath = path.join(dir, "override-cli.js");
			writeFileSync(overridePath, "// fake engine cli\n");
			const pkgJson = fakeEnginePackage({ lensmith: "dist/cli.js" });
			expect(
				resolveEngineBinaryPath(
					{ [ENGINE_BIN_ENV_VAR]: overridePath },
					{ resolveEnginePackageJson: () => pkgJson, siblingPath: fakeSibling() },
				),
			).toBe(overridePath);
		});

		it("a bogus override is a clean error naming that exact path, with no silent fall-through", () => {
			const overridePath = path.join(dir, "nonexistent-override.js");
			const pkgJson = fakeEnginePackage({ lensmith: "dist/cli.js" });
			const resolve = () =>
				resolveEngineBinaryPath(
					{ [ENGINE_BIN_ENV_VAR]: overridePath },
					{ resolveEnginePackageJson: () => pkgJson, siblingPath: fakeSibling() },
				);
			expect(resolve).toThrow(EngineBinaryMissingError);
			expect(resolve).toThrow(overridePath);
			expect(resolve).toThrow(ENGINE_BIN_ENV_VAR);
		});
	});

	describe("step 2: the installed lensmith dependency", () => {
		it("resolves bin.lensmith relative to the package's own package.json", () => {
			const pkgJson = fakeEnginePackage({ lensmith: "dist/cli.js" });
			expect(
				resolveEngineBinaryPath(
					{},
					{ resolveEnginePackageJson: () => pkgJson, siblingPath: fakeSibling() },
				),
			).toBe(path.join(path.dirname(pkgJson), "dist", "cli.js"));
		});

		it("accepts a string bin as well as a bin map", () => {
			const pkgJson = fakeEnginePackage("dist/cli.js");
			expect(
				resolveEngineBinaryPath(
					{},
					{ resolveEnginePackageJson: () => pkgJson, siblingPath: path.join(dir, "none.js") },
				),
			).toBe(path.join(path.dirname(pkgJson), "dist", "cli.js"));
		});

		it("falls through to the sibling checkout when the installed package has no CLI file", () => {
			const pkgJson = fakeEnginePackage({ lensmith: "dist/cli.js" }, false);
			const sibling = fakeSibling();
			expect(
				resolveEngineBinaryPath(
					{},
					{ resolveEnginePackageJson: () => pkgJson, siblingPath: sibling },
				),
			).toBe(sibling);
		});

		it("the real default resolver finds this repo's own lensmith dependency", () => {
			const resolved = resolveEngineBinaryPath({}, { siblingPath: path.join(dir, "none.js") });
			expect(resolved).toBe(
				path.resolve(testsDir, "..", "node_modules", "lensmith", "dist", "cli.js"),
			);
		});
	});

	describe("step 3: the sibling checkout", () => {
		it("resolves the sibling path when the dependency is not installed", () => {
			const sibling = fakeSibling();
			expect(
				resolveEngineBinaryPath(
					{},
					{ resolveEnginePackageJson: notInstalled, siblingPath: sibling },
				),
			).toBe(sibling);
		});
	});

	it("all three missing: a clean error naming every source it tried", () => {
		const sibling = path.join(dir, "does-not-exist", "cli.js");
		const resolve = () =>
			resolveEngineBinaryPath({}, { resolveEnginePackageJson: notInstalled, siblingPath: sibling });
		expect(resolve).toThrow(EngineBinaryMissingError);
		try {
			resolve();
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain(ENGINE_BIN_ENV_VAR);
			expect(message).toContain('the installed "lensmith" npm package');
			expect(message).toContain(sibling);
		}
	});
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// These tests exercise the BUILT CLI (`dist/cli.js`), not the TypeScript source
// — `npm run build` must run before `npm test` (CI does exactly that). The point
// is to prove the artifact an operator actually runs.
//
// ⚠️ Nothing here ever invokes `cursor move` or `cursor click` with valid
// arguments. Those take over the machine: they post real input events to
// whatever window happens to be under the cursor. Every move/click case below
// is an argument-validation case that fails before a single event is posted.
//
// ⚠️ Nothing here ever invokes `drive` with a step list that would reach
// Playwright either. Every `drive` case below fails at `--steps` file-read /
// step-list validation, which `registerDriveCommand`'s action handler runs
// BEFORE `chromium.launch()` — no browser window opens, nothing drives the
// real cursor. CR-LENSMITH-A002-2's own real-browser, real-cursor run is
// exercised by hand, announced, in a machine window nobody else is using —
// same discipline as `cursor move`/`cursor click` above.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const CLI_PATH = path.join(repoRoot, "dist", "cli.js");
const HELPER_PATH = path.join(repoRoot, "bin", "lensmith-cursor-choreographer");

function runCli(args: string[]) {
	return spawnSync("node", [CLI_PATH, ...args], { encoding: "utf-8" });
}

describe("lensmith-director CLI", () => {
	it("--version exits 0 and prints a version string", () => {
		const result = runCli(["--version"]);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("--version through a symlink still prints (npm's bin shim is a symlink; no silent exit)", () => {
		// CR-LENSMITH-A009-3: `npm install -g` links <prefix>/bin/lensmith-director ->
		// .../dist/cli.js. A string compare of argv[1] against import.meta.url is false
		// through that link, and the CLI used to exit 0 with no output.
		const linkDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-symlink-"));
		try {
			const link = path.join(linkDir, "lensmith-director");
			symlinkSync(CLI_PATH, link);
			const result = spawnSync("node", [link, "--version"], { encoding: "utf-8" });
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
		} finally {
			rmSync(linkDir, { recursive: true, force: true });
		}
	});

	it("--help exits 0 and lists the cursor, drive, demo and worker commands", () => {
		const result = runCli(["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("cursor");
		expect(result.stdout).toContain("drive");
		expect(result.stdout).toContain("demo");
		expect(result.stdout).toContain("worker");
	});

	it("no arguments prints usage to stderr and exits non-zero (not a crash)", () => {
		const result = runCli([]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Usage: lensmith-director");
	});

	it("an unknown command is a clean error, not a stack trace", () => {
		const result = runCli(["teleport"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).not.toContain("at Object.");
	});

	describe("cursor", () => {
		it.runIf(process.platform !== "darwin")(
			"fails before starting the native helper on non-macOS",
			() => {
				for (const args of [
					["cursor", "position"],
					["cursor", "move", "100", "200"],
					["cursor", "click"],
				]) {
					const result = runCli(args);
					expect(result.status).not.toBe(0);
					expect(result.stderr).toContain(
						`lensmith-director cursor needs macOS (got ${process.platform})`,
					);
				}
			},
		);

		it("--help lists position, move and click", () => {
			const result = runCli(["cursor", "--help"]);
			expect(result.status).toBe(0);
			for (const sub of ["position", "move", "click"]) {
				expect(result.stdout).toContain(sub);
			}
		});

		it("move --help documents --duration-ms and its default", () => {
			const result = runCli(["cursor", "move", "--help"]);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("--duration-ms");
			expect(result.stdout).toContain("500");
		});

		it("rejects --duration-ms 0 with an explanation, posting nothing", () => {
			const result = runCli(["cursor", "move", "100", "200", "--duration-ms", "0"]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("positive whole number");
		});

		it("rejects a fractional or non-numeric duration", () => {
			expect(runCli(["cursor", "move", "1", "2", "--duration-ms", "12.5"]).status).not.toBe(0);
			expect(runCli(["cursor", "move", "1", "2", "--duration-ms", "soon"]).status).not.toBe(0);
		});

		it("rejects a non-numeric coordinate and says what a coordinate is", () => {
			const result = runCli(["cursor", "move", "left", "200", "--duration-ms", "500"]);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("top-left");
		});

		it("requires both coordinates", () => {
			const result = runCli(["cursor", "move", "100"]);
			expect(result.status).not.toBe(0);
		});
	});

	describe("drive", () => {
		let dir: string;

		beforeEach(() => {
			dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-cli-drive-"));
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		function outPaths() {
			return { out: path.join(dir, "log.json"), zooms: path.join(dir, "zooms.json") };
		}

		it("--help lists --steps, --out, --zooms and --keep-open", () => {
			const result = runCli(["drive", "--help"]);
			expect(result.status).toBe(0);
			for (const flag of ["--steps", "--out", "--zooms", "--keep-open"]) {
				expect(result.stdout).toContain(flag);
			}
		});

		it("requires --steps, --out and --zooms", () => {
			expect(runCli(["drive"]).status).not.toBe(0);
			expect(runCli(["drive", "--steps", "x.json"]).status).not.toBe(0);
			expect(runCli(["drive", "--steps", "x.json", "--out", "o.json"]).status).not.toBe(0);
		});

		it("a nonexistent --steps file is a clean error, exit 1, and writes neither output file", () => {
			const { out, zooms } = outPaths();
			const result = runCli([
				"drive",
				"--steps",
				path.join(dir, "does-not-exist.json"),
				"--out",
				out,
				"--zooms",
				zooms,
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).not.toContain("at Object.");
			expect(existsSync(out)).toBe(false);
			expect(existsSync(zooms)).toBe(false);
		});

		it("malformed JSON in --steps is a clean error naming the path, exit 1, and writes neither output file", () => {
			const stepsPath = path.join(dir, "bad.json");
			writeFileSync(stepsPath, "{not valid json");
			const { out, zooms } = outPaths();
			const result = runCli(["drive", "--steps", stepsPath, "--out", out, "--zooms", zooms]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(stepsPath);
			expect(existsSync(out)).toBe(false);
			expect(existsSync(zooms)).toBe(false);
		});

		it('an empty "steps" array is a clean error, exit 1, and writes neither output file (positive control)', () => {
			const stepsPath = path.join(dir, "empty.json");
			writeFileSync(stepsPath, JSON.stringify({ url: "http://localhost/x.html", steps: [] }));
			const { out, zooms } = outPaths();
			const result = runCli(["drive", "--steps", stepsPath, "--out", out, "--zooms", zooms]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("non-empty array");
			expect(existsSync(out)).toBe(false);
			expect(existsSync(zooms)).toBe(false);
		});

		it("an unknown step type names the offending step's index, exit 1, and writes neither output file", () => {
			const stepsPath = path.join(dir, "bad-step.json");
			writeFileSync(
				stepsPath,
				JSON.stringify({ url: "http://localhost/x.html", steps: [{ type: "scroll" }] }),
			);
			const { out, zooms } = outPaths();
			const result = runCli(["drive", "--steps", stepsPath, "--out", out, "--zooms", zooms]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("index 0");
			expect(existsSync(out)).toBe(false);
			expect(existsSync(zooms)).toBe(false);
		});
	});

	// CR-LENSMITH-A002-7: `demo` sequences record/drive/compose/process. Every
	// case below fails at commander's own required-option check, before the
	// action handler runs — so before the engine binary is resolved and
	// before any subprocess is spawned. `runDemo`'s own stage-sequencing
	// logic (including a real engine binary and a real recorder/driver) is
	// exercised against fakes in `tests/demo.test.ts`, never here.
	describe("demo", () => {
		it("--help lists --steps and --out-dir", () => {
			const result = runCli(["demo", "--help"]);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("--steps");
			expect(result.stdout).toContain("--out-dir");
		});

		it("requires --steps and --out-dir", () => {
			expect(runCli(["demo"]).status).not.toBe(0);
			expect(runCli(["demo", "--steps", "x.json"]).status).not.toBe(0);
		});
	});

	// CR-LENSMITH-A002-8: `worker` watches a job directory and runs `demo` for
	// each job found. Every case below fails at commander's own required-option
	// / argument-parser check, before the action handler runs — so before the
	// startup preflight (which would refuse to run in this SSH/no-GUI-session
	// test environment anyway) and before any job directory is even touched.
	// The loop's own orchestration (claiming, execution, heartbeat, shutdown)
	// is exercised against fakes in `tests/worker.test.ts`, never here.
	describe("worker", () => {
		it("--help lists --jobs and --poll, with poll's default", () => {
			const result = runCli(["worker", "--help"]);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("--jobs");
			expect(result.stdout).toContain("--poll");
			expect(result.stdout).toContain("5");
		});

		it("requires --jobs", () => {
			expect(runCli(["worker"]).status).not.toBe(0);
		});

		it("rejects a non-positive --poll before touching the job directory", () => {
			const dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-cli-worker-"));
			try {
				const result = runCli(["worker", "--jobs", dir, "--poll", "0"]);
				expect(result.status).not.toBe(0);
				expect(result.stderr).toContain("--poll must be a positive number");
				expect(existsSync(path.join(dir, "queue"))).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("rejects a non-numeric --poll", () => {
			expect(runCli(["worker", "--jobs", "/tmp", "--poll", "soon"]).status).not.toBe(0);
		});
	});

	// Read-only: `position` never posts an event, so it is safe to run
	// unattended and while somebody is using the machine.
	describe.runIf(process.platform === "darwin" && existsSync(HELPER_PATH))(
		"cursor position (real helper)",
		() => {
			it("prints the real cursor position", () => {
				const result = runCli(["cursor", "position"]);
				expect(result.status).toBe(0);
				expect(result.stdout.trim()).toMatch(/^x: -?\d+(\.\d+)?, y: -?\d+(\.\d+)?$/);
			});

			it("--json prints a parseable point", () => {
				const result = runCli(["cursor", "position", "--json"]);
				expect(result.status).toBe(0);
				const point = JSON.parse(result.stdout.trim()) as { x: number; y: number };
				expect(Number.isFinite(point.x)).toBe(true);
				expect(Number.isFinite(point.y)).toBe(true);
			});
		},
	);
});

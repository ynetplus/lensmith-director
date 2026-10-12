#!/usr/bin/env node
// Builds every native macOS helper into bin/ (gitignored — CI and operators
// build it fresh; see README.md "Development").
//
// Plain `swiftc -O` on a single file per helper, deliberately: no helper has
// dependencies beyond Apple's system frameworks, so a SwiftPM package
// would add a manifest, a .build/ tree and a search-for-the-product step to
// buy nothing. Command Line Tools are enough — full Xcode is not required.
//
// Two modes (CR-LENSMITH-A009-3, mirroring the engine's CR-LENSMITH-A009-2):
//   node scripts/build-native-mac.mjs              host arch only (contributors, CI tests)
//   node scripts/build-native-mac.mjs --universal  arm64 + x86_64, merged with `lipo`
//                                                  into one universal binary per helper.
//                                                  This is what the npm tarball ships, so
//                                                  a user's machine never compiles Swift.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const binDir = path.join(root, "bin");
const universal = process.argv.includes("--universal");
const UNIVERSAL_ARCHS = ["arm64", "x86_64"];

const HELPERS = [
	{
		name: "lensmith-cursor-choreographer",
		source: path.join(root, "src", "native", "cursor-choreographer", "main.swift"),
	},
	{
		name: "lensmith-screen-capture-preflight",
		source: path.join(root, "src", "native", "screen-capture-preflight", "main.swift"),
	},
	{
		// CR-LENSMITH-A010-3: native-mode Accessibility driver (find/inspect, no input events).
		name: "lensmith-native-driver",
		source: path.join(root, "src", "native", "native-driver", "main.swift"),
	},
];

if (process.platform !== "darwin") {
	// Not an error: the TypeScript side builds and tests on any platform, and CI
	// runs the whole gate on macOS. Only the native-backed commands need these.
	console.log("Skipping native macOS helper build: host platform is not macOS.");
	process.exit(0);
}

const swiftcVersion = spawnSync("swiftc", ["--version"], { cwd: root, encoding: "utf8" });
if (swiftcVersion.status !== 0) {
	const message = `${swiftcVersion.stderr ?? ""}${swiftcVersion.stdout ?? ""}`.trim();
	console.error(
		[
			"Unable to build the native macOS helpers: no working Swift compiler was found.",
			"",
			message,
			"",
			"Install Apple's Command Line Tools, then run this again:",
			"  xcode-select --install",
		].join("\n"),
	);
	process.exit(1);
}

function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) {
		console.error(`Failed to start ${command}: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function assertUniversal(file) {
	const result = spawnSync("lipo", ["-archs", file], { encoding: "utf8" });
	const archs = (result.stdout ?? "").trim().split(/\s+/);
	const missing = UNIVERSAL_ARCHS.filter((a) => !archs.includes(a));
	if (result.status !== 0 || missing.length > 0) {
		console.error(
			`${file} is not universal (lipo -archs: "${archs.join(" ")}", missing: ${missing.join(", ")}).`,
		);
		process.exit(1);
	}
}

fs.mkdirSync(binDir, { recursive: true });

for (const helper of HELPERS) {
	if (!fs.existsSync(helper.source)) {
		console.error(`Source file not found: ${helper.source}`);
		process.exit(1);
	}

	const dest = path.join(binDir, helper.name);

	if (universal) {
		// One swiftc per arch into a temp slice, then one lipo merge. The slices never
		// land in bin/, so a later host-only build can never pick one up.
		const sliceDir = fs.mkdtempSync(path.join(os.tmpdir(), `${helper.name}-`));
		const slices = UNIVERSAL_ARCHS.map((arch) => {
			const slice = path.join(sliceDir, `${helper.name}-${arch}`);
			console.log(`Building ${helper.name} (${arch})...`);
			run("swiftc", ["-O", "-target", `${arch}-apple-macos11`, "-o", slice, helper.source]);
			return slice;
		});
		run("lipo", ["-create", "-output", dest, ...slices]);
		fs.rmSync(sliceDir, { recursive: true, force: true });
		fs.chmodSync(dest, 0o755);
		assertUniversal(dest);
		console.log(
			`Built ${helper.name} -> bin/${helper.name} (universal: ${UNIVERSAL_ARCHS.join(" + ")})`,
		);
		continue;
	}

	console.log(`Building ${helper.name}...`);
	run("swiftc", ["-O", "-o", dest, helper.source]);
	fs.chmodSync(dest, 0o755);
	console.log(`Built ${helper.name} -> bin/${helper.name}`);
}

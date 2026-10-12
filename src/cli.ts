#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerCursorCommand } from "./commands/cursor.js";
import { registerDemoCommand } from "./commands/demo.js";
import { registerDriveCommand } from "./commands/drive.js";
import { registerWorkerCommand } from "./commands/worker.js";

// Keep in sync with package.json "version" — there is deliberately no runtime
// package.json read, to avoid ESM JSON-import behaviour drifting across Node
// releases for something this small.
export const LENSMITH_DIRECTOR_VERSION = "0.1.0";

export function buildProgram(): Command {
	const program = new Command();

	program
		.name("lensmith-director")
		.description("Lensmith Director — drives a running app and directs a demo recording.")
		.version(LENSMITH_DIRECTOR_VERSION, "-v, --version", "output the current version");

	registerCursorCommand(program);
	registerDriveCommand(program);
	registerDemoCommand(program);
	registerWorkerCommand(program);

	return program;
}

// Compare real paths: an npm install runs the CLI through a bin symlink
// (`<prefix>/bin/lensmith-director` -> `.../lensmith-director/dist/cli.js`), so
// argv[1] is the symlink while import.meta.url is the resolved file — a plain
// string compare is false and the installed CLI exits silently. Mirrors the
// engine's isInvokedDirectly() (CR-LENSMITH-A009-2); CR-LENSMITH-A009-3.
function isInvokedDirectly(): boolean {
	const invoked = process.argv[1];
	if (!invoked) return false;
	try {
		return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

const isMainModule = isInvokedDirectly();

if (isMainModule) {
	buildProgram().parse(process.argv);
}

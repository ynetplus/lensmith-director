#!/usr/bin/env node
// Fake `lensmith-native-driver serve` for tests (CR-LENSMITH-A010-5). Posts no events.
//
// Prints {"type":"ready"}, then answers one JSON command per line:
//   - FAKE_NATIVE_SCRIPT: path to a JSON file mapping cmd -> reply, or cmd -> array of
//     replies consumed in order (the last one repeats). A reply's "type"/"cmd" default to
//     "ok"/<cmd>. Two sentinels: "silent" (never answer) and "exit" (exit code 3). A reply
//     with "delayMs" is sent that late; replies stay in request order, like the real
//     helper's serial loop.
//   - Unscripted commands get a built-in default reply for the full protocol
//     (trust, prepare, find, hit, focus, press, key, type, settle, tree, quit).
//   - FAKE_NATIVE_LOG: path a JSON line per received command is appended to, with
//     `text` replaced by its length (no echo, even in the test log).
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const script = process.env.FAKE_NATIVE_SCRIPT
	? JSON.parse(readFileSync(process.env.FAKE_NATIVE_SCRIPT, "utf8"))
	: {};
const logPath = process.env.FAKE_NATIVE_LOG;
const cursor = {};
let chain = Promise.resolve();

const element = {
	ref: "e1",
	pid: 412,
	role: "AXButton",
	title: "Save",
	label: "",
	identifier: "save",
	enabled: true,
	frame: { x: 800, y: 430, width: 64, height: 24 },
};

function defaultReply(cmd) {
	switch (cmd.cmd) {
		case "trust":
			return { accessibility: true, secureInput: false };
		case "prepare":
			return { pid: cmd.pid, frame: cmd.frame ?? { x: 0, y: 25, width: 1280, height: 800 } };
		case "find":
			return { element: { ...element, pid: cmd.pid } };
		case "hit":
			return { element, pid: element.pid };
		case "focus":
		case "press":
		case "quit":
			return {};
		case "key":
			return { posted: Array.isArray(cmd.chords) ? cmd.chords.length : 0 };
		case "type":
			return { count: typeof cmd.text === "string" ? cmd.text.length : 0 };
		case "settle":
			return { settleMs: cmd.quietMs ?? 0, reason: "quiet" };
		case "tree":
			return {
				nodes: [
					{ path: [0], role: "AXWindow", title: "Doc", label: "", identifier: "", frame: null },
				],
			};
		default:
			return { type: "error", code: "bad_request", message: "Unknown command." };
	}
}

function emit(fields) {
	process.stdout.write(`${JSON.stringify(fields)}\n`);
}

emit({ type: "ready" });

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
	if (line.trim() === "") return;
	let cmd;
	try {
		cmd = JSON.parse(line);
	} catch {
		emit({ type: "error", cmd: "?", code: "bad_request", message: "Malformed command line." });
		return;
	}
	if (logPath) {
		const logged = { ...cmd };
		if (typeof logged.text === "string") logged.text = logged.text.length;
		appendFileSync(logPath, `${JSON.stringify(logged)}\n`);
	}
	let reply;
	if (Object.hasOwn(script, cmd.cmd)) {
		const entry = script[cmd.cmd];
		if (Array.isArray(entry)) {
			const i = cursor[cmd.cmd] ?? 0;
			cursor[cmd.cmd] = i + 1;
			reply = entry[Math.min(i, entry.length - 1)];
		} else {
			reply = entry;
		}
	} else {
		reply = defaultReply(cmd);
	}
	if (reply === "silent") return;
	chain = chain.then(async () => {
		if (reply === "exit") process.exit(3);
		const { delayMs, ...fields } = reply;
		if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
		emit({ type: "ok", cmd: cmd.cmd, ...fields });
		if (cmd.cmd === "quit") process.exit(0);
	});
});
reader.on("close", () => chain.then(() => process.exit(0)));

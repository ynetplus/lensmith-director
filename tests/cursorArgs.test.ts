import { describe, expect, it } from "vitest";
import { ensureMacOS, MacOSRequiredError } from "../src/commands/cursor.js";

describe("cursor platform guard", () => {
	it("allows cursor commands on macOS", () => {
		expect(() => ensureMacOS("darwin")).not.toThrow();
	});

	it.each(["linux", "win32"] as const)("rejects cursor commands on %s", (platform) => {
		expect(() => ensureMacOS(platform)).toThrowError(new MacOSRequiredError(platform));
	});
});

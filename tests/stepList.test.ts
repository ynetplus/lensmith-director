import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isNativeStep,
	KEY_NAMES,
	MODIFIER_NAMES,
	parseKeys,
	readDriveStepList,
	readStepList,
	StepListError,
	stepListWarnings,
	validateDriveStepList,
	validateStepList,
} from "../src/lib/stepList.js";

describe("validateStepList", () => {
	it("accepts a well-formed step list", () => {
		const result = validateStepList({
			url: "http://localhost:4173/page.html",
			steps: [
				{ type: "click", selector: "#a", label: "click a" },
				{ type: "wait", ms: 500 },
				{ type: "click", selector: "#b" },
			],
		});
		expect(result.url).toBe("http://localhost:4173/page.html");
		expect(result.steps).toHaveLength(3);
		expect(result.steps[0]).toEqual({ type: "click", selector: "#a", label: "click a" });
		expect(result.steps[1]).toEqual({ type: "wait", ms: 500 });
		// no "label" key at all when omitted — not `label: undefined`
		expect(result.steps[2]).toEqual({ type: "click", selector: "#b" });
		expect(Object.hasOwn(result.steps[2] as object, "label")).toBe(false);
	});

	// CR-LENSMITH-A002-6 — the `type` step.
	describe("type step", () => {
		it("accepts a well-formed type step, with and without a label", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [
					{ type: "type", selector: "#field", text: "hello", label: "type a greeting" },
					{ type: "type", selector: "#other", text: "" },
				],
			});
			expect(result.steps[0]).toEqual({
				type: "type",
				selector: "#field",
				text: "hello",
				label: "type a greeting",
			});
			expect(result.steps[1]).toEqual({ type: "type", selector: "#other", text: "" });
			expect(Object.hasOwn(result.steps[1] as object, "label")).toBe(false);
		});

		it("names the offending step's index for a missing or empty selector", () => {
			expect(() =>
				validateStepList({ url: "http://x", steps: [{ type: "type", text: "hi" }] }),
			).toThrow(/index 0.*selector/);
			expect(() =>
				validateStepList({
					url: "http://x",
					steps: [{ type: "type", selector: "", text: "hi" }],
				}),
			).toThrow(/index 0.*selector/);
		});

		it("names the offending step's index for a missing text", () => {
			expect(() =>
				validateStepList({ url: "http://x", steps: [{ type: "type", selector: "#a" }] }),
			).toThrow(/index 0.*text/);
			expect(() =>
				validateStepList({
					url: "http://x",
					steps: [{ type: "type", selector: "#a", text: 42 }],
				}),
			).toThrow(/index 0.*text/);
		});

		it("names the offending step's index for a non-string label", () => {
			expect(() =>
				validateStepList({
					url: "http://x",
					steps: [{ type: "type", selector: "#a", text: "hi", label: 42 }],
				}),
			).toThrow(/index 0.*label/);
		});

		// CR-LENSMITH-A002-10 — `textFrom.keychain`, the alternative to a literal `text`.
		describe("textFrom (CR-LENSMITH-A002-10)", () => {
			it("accepts a well-formed textFrom step, with and without a label", () => {
				const result = validateStepList({
					url: "http://x",
					steps: [
						{
							type: "type",
							selector: "#code",
							textFrom: { keychain: { service: "svc", account: "acct" } },
							label: "type the code",
						},
					],
				});
				expect(result.steps[0]).toEqual({
					type: "type",
					selector: "#code",
					textFrom: { keychain: { service: "svc", account: "acct" } },
					label: "type the code",
				});
			});

			it("rejects a step with both text and textFrom, naming the step index", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [
							{
								type: "type",
								selector: "#a",
								text: "hi",
								textFrom: { keychain: { service: "svc", account: "acct" } },
							},
						],
					}),
				).toThrow(/index 0.*exactly one.*"text".*"textFrom"/);
			});

			it("rejects a step with neither text nor textFrom, naming the step index", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a" }],
					}),
				).toThrow(/index 0.*exactly one.*"text".*"textFrom"/);
			});

			it("rejects a non-object textFrom", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: "svc/acct" }],
					}),
				).toThrow(/index 0.*"textFrom"/);
			});

			it("rejects a textFrom missing the keychain object", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: {} }],
					}),
				).toThrow(/index 0.*keychain/);
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: { keychain: "svc/acct" } }],
					}),
				).toThrow(/index 0.*keychain/);
			});

			it("rejects a missing or empty service", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: { keychain: { account: "acct" } } }],
					}),
				).toThrow(/index 0.*"service"/);
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [
							{
								type: "type",
								selector: "#a",
								textFrom: { keychain: { service: "", account: "acct" } },
							},
						],
					}),
				).toThrow(/index 0.*"service"/);
			});

			it("rejects a missing or empty account", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: { keychain: { service: "svc" } } }],
					}),
				).toThrow(/index 0.*"account"/);
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [
							{
								type: "type",
								selector: "#a",
								textFrom: { keychain: { service: "svc", account: "" } },
							},
						],
					}),
				).toThrow(/index 0.*"account"/);
			});

			it("passes a service value containing shell metacharacters through unmodified — validation never executes anything", () => {
				const dangerous = "svc-$(touch /tmp/pwned)-`echo hi`";
				const result = validateStepList({
					url: "http://x",
					steps: [
						{
							type: "type",
							selector: "#a",
							textFrom: { keychain: { service: dangerous, account: "acct" } },
						},
					],
				});
				const step = result.steps[0] as { textFrom: { keychain: { service: string } } };
				expect(step.textFrom.keychain.service).toBe(dangerous);
			});
		});
	});

	it("rejects a non-object top level", () => {
		expect(() => validateStepList(null)).toThrow(StepListError);
		expect(() => validateStepList([1, 2])).toThrow(StepListError);
		expect(() => validateStepList("nope")).toThrow(StepListError);
	});

	it("rejects a missing or empty url", () => {
		expect(() => validateStepList({ steps: [{ type: "wait", ms: 1 }] })).toThrow(/"url"/);
		expect(() => validateStepList({ url: "", steps: [{ type: "wait", ms: 1 }] })).toThrow(/"url"/);
		expect(() => validateStepList({ url: 123, steps: [{ type: "wait", ms: 1 }] })).toThrow(/"url"/);
	});

	it("rejects a missing, empty, or non-array steps", () => {
		expect(() => validateStepList({ url: "http://x" })).toThrow(/"steps"/);
		expect(() => validateStepList({ url: "http://x", steps: [] })).toThrow(/"steps"/);
		expect(() => validateStepList({ url: "http://x", steps: "nope" })).toThrow(/"steps"/);
	});

	it("names the offending step's index for an unknown type", () => {
		expect(() =>
			validateStepList({
				url: "http://x",
				steps: [{ type: "wait", ms: 1 }, { type: "scroll" }],
			}),
		).toThrow(/index 1/);
	});

	it("names the offending step's index for a malformed click step", () => {
		expect(() => validateStepList({ url: "http://x", steps: [{ type: "click" }] })).toThrow(
			/index 0.*selector/,
		);
		expect(() =>
			validateStepList({ url: "http://x", steps: [{ type: "click", selector: "" }] }),
		).toThrow(/index 0.*selector/);
		expect(() =>
			validateStepList({
				url: "http://x",
				steps: [{ type: "click", selector: "#a", label: 42 }],
			}),
		).toThrow(/index 0.*label/);
	});

	it("names the offending step's index for a malformed wait step", () => {
		expect(() => validateStepList({ url: "http://x", steps: [{ type: "wait" }] })).toThrow(
			/index 0.*ms/,
		);
		expect(() => validateStepList({ url: "http://x", steps: [{ type: "wait", ms: 0 }] })).toThrow(
			/index 0.*ms/,
		);
		expect(() => validateStepList({ url: "http://x", steps: [{ type: "wait", ms: -5 }] })).toThrow(
			/index 0.*ms/,
		);
	});

	it("rejects a step that isn't an object", () => {
		expect(() => validateStepList({ url: "http://x", steps: [null] })).toThrow(/index 0/);
		expect(() => validateStepList({ url: "http://x", steps: ["click"] })).toThrow(/index 0/);
	});

	// CR-LENSMITH-A002-13 (BF-8) — the per-step `timeoutMs` override on `click`
	// and `type` steps, validated exactly like `wait`'s `ms` above.
	describe("timeoutMs (CR-LENSMITH-A002-13)", () => {
		it("is omitted entirely from a click step when not present (same discipline as an omitted label)", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [{ type: "click", selector: "#a" }],
			});
			expect(Object.hasOwn(result.steps[0] as object, "timeoutMs")).toBe(false);
		});

		it("accepts a positive finite number on a click step and carries it through unchanged", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [{ type: "click", selector: "#a", timeoutMs: 2000 }],
			});
			expect(result.steps[0]).toEqual({ type: "click", selector: "#a", timeoutMs: 2000 });
		});

		it("rejects zero, negative, non-finite, and non-numeric timeoutMs on a click step, naming the step index", () => {
			for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "fast", null, true]) {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "click", selector: "#a", timeoutMs: bad }],
					}),
				).toThrow(/index 0.*timeoutMs/);
			}
		});

		it("accepts a positive finite number on a literal-text type step and carries it through unchanged", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [{ type: "type", selector: "#a", text: "hi", timeoutMs: 2000 }],
			});
			expect(result.steps[0]).toEqual({
				type: "type",
				selector: "#a",
				text: "hi",
				timeoutMs: 2000,
			});
		});

		it("accepts a positive finite number on a textFrom type step and carries it through unchanged", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [
					{
						type: "type",
						selector: "#a",
						textFrom: { keychain: { service: "svc", account: "acct" } },
						timeoutMs: 2000,
					},
				],
			});
			expect(result.steps[0]).toEqual({
				type: "type",
				selector: "#a",
				textFrom: { keychain: { service: "svc", account: "acct" } },
				timeoutMs: 2000,
			});
		});

		it("rejects zero, negative, non-finite, and non-numeric timeoutMs on a type step, naming the step index", () => {
			for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "fast", null, true]) {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", text: "hi", timeoutMs: bad }],
					}),
				).toThrow(/index 0.*timeoutMs/);
			}
		});
	});

	// [[CR-LENSMITH-A002-4]] fix round, item 5 — the window-width precondition.
	describe("minViewportWidth", () => {
		it("is omitted entirely from the result when not present in the input (same discipline as an omitted click label)", () => {
			const result = validateStepList({ url: "http://x", steps: [{ type: "wait", ms: 1 }] });
			expect(Object.hasOwn(result, "minViewportWidth")).toBe(false);
		});

		it("accepts a positive finite number and carries it through unchanged", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [{ type: "wait", ms: 1 }],
				minViewportWidth: 1024,
			});
			expect(result.minViewportWidth).toBe(1024);
		});

		it("rejects zero, negative, non-finite, and non-numeric values, naming the field", () => {
			for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1024", null, true]) {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "wait", ms: 1 }],
						minViewportWidth: bad,
					}),
				).toThrow(/"minViewportWidth"/);
			}
		});
	});
});

describe("readStepList", () => {
	it("parses and validates valid JSON", () => {
		const result = readStepList(
			JSON.stringify({ url: "http://x", steps: [{ type: "wait", ms: 10 }] }),
			"steps.json",
		);
		expect(result.steps).toEqual([{ type: "wait", ms: 10 }]);
	});

	it("rejects invalid JSON, naming the source path", () => {
		expect(() => readStepList("{not json", "steps.json")).toThrow(StepListError);
		expect(() => readStepList("{not json", "steps.json")).toThrow(/steps\.json/);
	});
});

describe("validateStepList: say (CR-LENSMITH-A008-2)", () => {
	const url = "http://localhost:4173/page.html";

	it("keeps a say line on click, type and wait steps", () => {
		const result = validateStepList({
			url,
			steps: [
				{ type: "click", selector: "#a", say: "Open the [[story]] Buildr story" },
				{ type: "type", selector: "#f", text: "x", say: "Type it" },
				{ type: "wait", ms: 500, say: "A [[pause_1]] pause" },
			],
		});
		expect(result.steps.map((s) => s.say)).toEqual([
			"Open the [[story]] Buildr story",
			"Type it",
			"A [[pause_1]] pause",
		]);
	});

	it("leaves say absent when not given", () => {
		const result = validateStepList({ url, steps: [{ type: "click", selector: "#a" }] });
		expect("say" in (result.steps[0] ?? {})).toBe(false);
	});

	it("rejects a non-string or empty say", () => {
		expect(() =>
			validateStepList({ url, steps: [{ type: "click", selector: "#a", say: 3 }] }),
		).toThrow(/step at index 0 \(type "click"\) has a non-string or empty "say"/);
		expect(() => validateStepList({ url, steps: [{ type: "wait", ms: 5, say: "  " }] })).toThrow(
			StepListError,
		);
	});

	it("rejects more than one mark", () => {
		expect(() =>
			validateStepList({ url, steps: [{ type: "click", selector: "#a", say: "[[a]] and [[b]]" }] }),
		).toThrow(/2 \[\[mark\]\] tags/);
	});

	it("accepts the engine's mark names: letters, digits and underscore", () => {
		for (const good of ["[[Story]]", "[[pause_1]]", "[[s2]]"]) {
			expect(() =>
				validateStepList({
					url,
					steps: [{ type: "click", selector: "#a", say: `go ${good} now` }],
				}),
			).not.toThrow();
		}
	});

	it("rejects a mark name outside the engine's \\w+ rule (a hyphen included)", () => {
		for (const bad of ["[[pause-1]]", "[[two words]]", "[[]]", "[[a.b]]"]) {
			expect(() =>
				validateStepList({
					url,
					steps: [{ type: "type", selector: "#f", text: "x", say: `go ${bad} now` }],
				}),
			).toThrow(/invalid \[\[mark\]\] name/);
		}
	});
});

describe("validateDriveStepList (CR-LENSMITH-A010-2 native steps)", () => {
	const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
	const APPS = [{ bundleId: "com.example.tinycast" }];
	const nativeList = (step: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		apps: APPS,
		steps: [{ type: "activate", app: "com.example.tinycast" }, step],
		...extra,
	});
	const refuses = (list: unknown, ...fragments: string[]) => {
		let message = "";
		try {
			validateDriveStepList(list);
		} catch (error) {
			expect(error).toBeInstanceOf(StepListError);
			message = (error as Error).message;
		}
		expect(message, "expected a StepListError").not.toBe("");
		for (const f of fragments) expect(message).toContain(f);
	};

	it("accepts the native fixture (the three design-note examples merged)", () => {
		const raw = readFileSync(join(fixturesDir, "native-steps.json"), "utf8");
		const list = readDriveStepList(raw, "native-steps.json");
		expect(list.url).toBeUndefined();
		expect(list.steps).toHaveLength(14);
		expect(list.apps).toHaveLength(5);
		expect(list.capture).toEqual({ region: { x: 800, y: 150, width: 1600, height: 900 } });
		expect(list.steps.every((s) => isNativeStep(s))).toBe(true);
		expect(stepListWarnings(list)).toEqual([]);
	});

	it("every existing web fixture validates identically through both entry points", () => {
		const files = readdirSync(fixturesDir).filter(
			(f) => f.endsWith(".json") && f !== "native-steps.json",
		);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const raw = readFileSync(join(fixturesDir, file), "utf8");
			expect(readDriveStepList(raw, file)).toEqual(readStepList(raw, file));
		}
	});

	it("accepts a mixed native + web list with a url", () => {
		const list = validateDriveStepList({
			url: "http://localhost:4173/page.html",
			apps: APPS,
			steps: [
				{ type: "click", selector: "#a" },
				{ type: "activate", app: "com.example.tinycast" },
				{ type: "wait", ms: 200 },
			],
		});
		expect(list.steps.map((s) => isNativeStep(s))).toEqual([false, true, false]);
	});

	it("a native-only list without url passes the drive validator but fails validateStepList as today", () => {
		const list = nativeList({ type: "key", app: "com.example.tinycast", keys: "cmd+shift+v" });
		expect(validateDriveStepList(list).url).toBeUndefined();
		expect(() => validateStepList(list)).toThrow(
			'the step list\'s "url" must be a non-empty string',
		);
	});

	it("refuses app + selector together, naming the index", () => {
		refuses(
			nativeList({
				type: "click",
				app: "com.example.tinycast",
				selector: "#a",
				ax: { role: "AXButton" },
			}),
			"index 1",
			'"selector"',
		);
	});

	it("refuses hover, key and activate without app, naming the index", () => {
		for (const type of ["hover", "key", "activate"]) {
			refuses(
				nativeList({ type, ax: { role: "AXButton" }, keys: "return" }),
				"index 1",
				`"${type}"`,
				'"app"',
			);
		}
	});

	it("refuses an app that is not a reverse-DNS bundle id", () => {
		refuses(
			{ apps: [{ bundleId: "tinycast" }], steps: [{ type: "activate", app: "tinycast" }] },
			'"bundleId"',
		);
		refuses(nativeList({ type: "activate", app: "Tinycast" }), "index 1", '"app"');
	});

	it("refuses an app that is not listed in top-level apps", () => {
		refuses(
			nativeList({ type: "activate", app: "com.example.other" }),
			"index 1",
			'"app"',
			'"apps"',
		);
	});

	it("refuses duplicate bundle ids in apps", () => {
		refuses(
			{ apps: [...APPS, ...APPS], steps: [{ type: "activate", app: "com.example.tinycast" }] },
			"index 1",
			'"bundleId"',
			"unique",
		);
	});

	it("refuses a locator with no locating key", () => {
		refuses(
			nativeList({ type: "click", app: "com.example.tinycast", ax: { match: "exact" } }),
			"index 1",
			'"ax"',
			"at least one of",
		);
	});

	it("refuses a bad match or in enum", () => {
		refuses(
			nativeList({
				type: "click",
				app: "com.example.tinycast",
				ax: { role: "AXButton", match: "fuzzy" },
			}),
			"index 1",
			'"match"',
		);
		refuses(
			nativeList({
				type: "click",
				app: "com.example.tinycast",
				ax: { role: "AXButton", in: "dock" },
			}),
			"index 1",
			'"in"',
		);
	});

	it("refuses a negative or fractional index and path item", () => {
		refuses(
			nativeList({
				type: "click",
				app: "com.example.tinycast",
				ax: { role: "AXButton", index: -1 },
			}),
			"index 1",
			'"index"',
		);
		refuses(
			nativeList({ type: "click", app: "com.example.tinycast", ax: { path: [0, 1.5] } }),
			"index 1",
			'"path"',
		);
		refuses(
			nativeList({ type: "click", app: "com.example.tinycast", ax: { path: [0, -2] } }),
			"index 1",
			'"path"',
		);
	});

	it("refuses a wait with both ms and app, and an app wait without until or positive timeoutMs", () => {
		refuses(
			nativeList({
				type: "wait",
				app: "com.example.tinycast",
				ms: 100,
				until: { role: "AXList" },
				timeoutMs: 100,
			}),
			"index 1",
			'"ms"',
		);
		refuses(
			nativeList({ type: "wait", app: "com.example.tinycast", timeoutMs: 100 }),
			"index 1",
			'"until"',
		);
		refuses(
			nativeList({ type: "wait", app: "com.example.tinycast", until: { role: "AXList" } }),
			"index 1",
			'"timeoutMs"',
		);
		refuses(
			nativeList({
				type: "wait",
				app: "com.example.tinycast",
				until: { role: "AXList" },
				timeoutMs: 0,
			}),
			"index 1",
			'"timeoutMs"',
		);
	});

	it("requires url iff a step has a selector", () => {
		refuses({ apps: APPS, steps: [{ type: "click", selector: "#a" }] }, '"url"', '"selector"');
		refuses(
			{ url: "", apps: APPS, steps: [{ type: "activate", app: "com.example.tinycast" }] },
			'"url"',
		);
	});

	it("refuses a non-16:9 capture region and accepts 1600x900", () => {
		const region = (width: number, height: number) =>
			nativeList(
				{ type: "activate", app: "com.example.tinycast" },
				{ capture: { region: { x: 0, y: 0, width, height } } },
			);
		refuses(region(1600, 1000), '"capture.region"', "16:9");
		refuses(region(0, 0), '"capture.region"', '"width"');
		expect(validateDriveStepList(region(1600, 900)).capture).toEqual({
			region: { x: 0, y: 0, width: 1600, height: 900 },
		});
		refuses(
			nativeList({ type: "activate", app: "com.example.tinycast" }, { capture: "fullscreen" }),
			'"capture"',
		);
	});

	it("reuses the timeoutMs and say validators on native steps", () => {
		refuses(
			nativeList({
				type: "click",
				app: "com.example.tinycast",
				ax: { role: "AXButton" },
				timeoutMs: -5,
			}),
			"index 1",
			'"timeoutMs"',
		);
		refuses(
			nativeList({
				type: "hover",
				app: "com.example.tinycast",
				ax: { role: "AXButton" },
				say: "[[a]] [[b]]",
			}),
			"index 1",
			'"say"',
		);
	});

	it("refuses a key step whose keys is a printable key with no modifier (no free text in keys)", () => {
		refuses(
			nativeList({ type: "key", app: "com.example.tinycast", keys: "h" }),
			"index 1",
			'"keys"',
			"printable",
		);
		refuses(
			nativeList({ type: "key", app: "com.example.tinycast", keys: ["shift+a"] }),
			"index 1",
			'"keys"',
			"printable",
		);
		refuses(
			nativeList({ type: "key", app: "com.example.tinycast", keys: "space" }),
			"index 1",
			'"keys"',
			"printable",
		);
	});

	it("refuses an unknown key or modifier name", () => {
		refuses(
			nativeList({ type: "key", app: "com.example.tinycast", keys: "cmd+enter" }),
			"index 1",
			'"keys"',
			"unknown key",
		);
		refuses(
			nativeList({ type: "key", app: "com.example.tinycast", keys: "super+a" }),
			"index 1",
			'"keys"',
			"unknown modifier",
		);
	});

	it("accepts cmd+shift+v and [return, down]", () => {
		for (const keys of ["cmd+shift+v", ["return", "down"]]) {
			const list = validateDriveStepList(
				nativeList({ type: "key", app: "com.example.tinycast", keys }),
			);
			expect(list.steps[1]).toEqual({ type: "key", app: "com.example.tinycast", keys });
		}
	});

	it("accepts a native type step from the keychain", () => {
		const step = {
			type: "type",
			app: "com.example.tinycast",
			textFrom: { keychain: { service: "s", account: "a" } },
		};
		expect(validateDriveStepList(nativeList(step)).steps[1]).toEqual(step);
	});
});

describe("parseKeys", () => {
	it("parses chords into key + modifiers", () => {
		expect(parseKeys("cmd+shift+v")).toEqual([{ key: "v", mods: ["cmd", "shift"] }]);
		expect(parseKeys(["return", "f12"])).toEqual([
			{ key: "return", mods: [] },
			{ key: "f12", mods: [] },
		]);
	});

	it("exposes the fixed modifier and key sets", () => {
		expect([...MODIFIER_NAMES]).toEqual(["cmd", "shift", "opt", "ctrl", "fn"]);
		expect(KEY_NAMES).toContain("grave");
		expect(KEY_NAMES).toContain("f1");
		expect(KEY_NAMES).not.toContain("enter");
	});

	it("refuses printable keys without cmd, ctrl or opt", () => {
		expect(() => parseKeys("h")).toThrow(StepListError);
		expect(() => parseKeys("shift+1")).toThrow(StepListError);
		expect(parseKeys("ctrl+a")).toEqual([{ key: "a", mods: ["ctrl"] }]);
	});
});

describe("stepListWarnings", () => {
	it("warns once per point locator", () => {
		const list = validateDriveStepList({
			apps: [{ bundleId: "com.example.tinycast" }],
			steps: [
				{
					type: "click",
					app: "com.example.tinycast",
					ax: { point: { x: 10, y: 20 } },
					expect: { point: { x: 1, y: 2 } },
				},
				{ type: "hover", app: "com.example.tinycast", ax: { role: "AXButton" } },
			],
		});
		const warnings = stepListWarnings(list);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("point locators break across app versions");
	});
});

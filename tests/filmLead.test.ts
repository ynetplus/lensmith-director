import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CursorTelemetrySample,
	type FilmLeadLogEntry,
	measureFilmLead,
} from "../src/lib/filmLead.js";

const FIXTURES = path.join(__dirname, "fixtures");
const PERIOD_MS = 40;

/** A cursor resting at `from` that eases to `to` over 400 ms starting at each onset (film clock). */
function telemetryWithTravels(
	travels: Array<{ onsetMs: number; to: [number, number] }>,
	endMs: number,
): CursorTelemetrySample[] {
	const samples: CursorTelemetrySample[] = [];
	let pos: [number, number] = [0.5, 0.5];
	let travel = 0;
	// The grid starts at 30 so a sample lands on each onset (1310, 3310, 5310 are 30 mod 40).
	for (let t = 30; t <= endMs; t += PERIOD_MS) {
		const next = travels[travel];
		let x = pos[0];
		let y = pos[1];
		if (next && t > next.onsetMs) {
			const f = Math.min(1, (t - next.onsetMs) / 400);
			const e = f < 0.5 ? 4 * f ** 3 : 1 - (-2 * f + 2) ** 3 / 2;
			x = pos[0] + (next.to[0] - pos[0]) * e;
			y = pos[1] + (next.to[1] - pos[1]) * e;
			if (f === 1) {
				pos = next.to;
				travel++;
			}
		}
		samples.push({ timeMs: t, cx: x, cy: y, visible: true });
	}
	return samples;
}

describe("measureFilmLead (BF-27 round 2)", () => {
	it("recovers a 310 ms picture-to-log offset from the first three travels", () => {
		const log: FilmLeadLogEntry[] = [
			{ type: "wait" },
			{ type: "click", startedAtMs: 1000 },
			{ type: "type", startedAtMs: 3000 },
			{ type: "point", travelStartMs: 5000 },
			{ type: "click", startedAtMs: 7000 },
		];
		const samples = telemetryWithTravels(
			[
				{ onsetMs: 1310, to: [0.3, 0.4] },
				{ onsetMs: 3310, to: [0.6, 0.2] },
				{ onsetMs: 5310, to: [0.2, 0.7] },
				{ onsetMs: 7310, to: [0.5, 0.5] },
			],
			9000,
		);
		const lead = measureFilmLead(log, { samples });
		expect(lead).toBeDefined();
		expect(Math.abs((lead?.leadMs ?? 0) - 310)).toBeLessThanOrEqual(5);
		expect(lead?.samples).toHaveLength(3);
		expect(lead?.samples.map((s) => s.logMs)).toEqual([1000, 3000, 5000]);
	});

	it("is undefined when fewer than two travels can be matched", () => {
		const still = telemetryWithTravels([], 9000);
		expect(
			measureFilmLead(
				[
					{ type: "click", startedAtMs: 1000 },
					{ type: "click", startedAtMs: 3000 },
				],
				{ samples: still },
			),
		).toBeUndefined();
		expect(
			measureFilmLead([{ type: "wait" }, { type: "key" }], { samples: still }),
		).toBeUndefined();
		expect(measureFilmLead([{ type: "click", startedAtMs: 1000 }], undefined)).toBeUndefined();
	});

	it("measures about 303 ms on the real DBX round-9 log and telemetry", () => {
		const log = JSON.parse(
			readFileSync(path.join(FIXTURES, "action-logs", "dbx-v9.json"), "utf-8"),
		) as FilmLeadLogEntry[];
		const telemetry = JSON.parse(
			readFileSync(path.join(FIXTURES, "telemetry", "dbx-v9-first-15s.json"), "utf-8"),
		) as { samples: CursorTelemetrySample[] };
		const lead = measureFilmLead(log, telemetry);
		expect(lead).toBeDefined();
		expect(lead?.samples.length).toBeGreaterThanOrEqual(2);
		expect(Math.abs((lead?.leadMs ?? 0) - 303)).toBeLessThanOrEqual(15);
	});
});

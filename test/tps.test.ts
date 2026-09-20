import { describe, expect, test } from "bun:test";
import { formatElapsed } from "../extensions/tps.ts";

describe("formatElapsed", () => {
	test("skips leading zero units but always keeps seconds", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(9)).toBe("9s");
		expect(formatElapsed(65)).toBe("1m 5s");
		expect(formatElapsed(3600)).toBe("1h 0m 0s");
		expect(formatElapsed(3725)).toBe("1h 2m 5s");
		expect(formatElapsed(90061)).toBe("1d 1h 1m 1s");
	});

	test("clamps negative and fractional input to whole seconds", () => {
		expect(formatElapsed(-5)).toBe("0s");
		expect(formatElapsed(59.9)).toBe("59s");
	});
});

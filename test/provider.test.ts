import { describe, expect, test } from "bun:test";
import { FastState, ModelRefreshCoordinator } from "../extensions/provider.ts";
import { computeElapsedMs, isPrimaryUiSession } from "../extensions/tps.ts";

describe("FastState", () => {
	test("is effective only when globally enabled and the catalog advertises the tier", () => {
		const state = new FastState(false);
		state.setSupportedModelIds(["gpt-5.5"]);
		expect(state.isEffectiveFor("gpt-5.5")).toBe(false);

		state.setEnabled(true);
		expect(state.isEffectiveFor("gpt-5.5")).toBe(true);
		expect(state.isEffectiveFor("deepseek-v4.1-flash")).toBe(false);
	});

	test("replaces the capability set wholesale and ignores blank ids", () => {
		const state = new FastState(true);
		state.setSupportedModelIds(["gpt-5.5", "  "]);
		expect(state.isModelSupported("gpt-5.5")).toBe(true);

		state.setSupportedModelIds(["gpt-6-astra"]);
		expect(state.isModelSupported("gpt-5.5")).toBe(false);
		expect(state.isModelSupported("gpt-6-astra")).toBe(true);
	});

	test("trims the queried id, matching how CPA ids arrive", () => {
		const state = new FastState(true);
		state.setSupportedModelIds(["gpt-5.5"]);
		expect(state.isEffectiveFor(" gpt-5.5 ")).toBe(true);
	});
});

describe("ModelRefreshCoordinator", () => {
	test("invalidates the superseded generation when a newer refresh starts", () => {
		const coordinator = new ModelRefreshCoordinator();
		const first = coordinator.begin();
		expect(coordinator.isCurrent(first.generation)).toBe(true);

		const second = coordinator.begin();
		expect(coordinator.isCurrent(first.generation)).toBe(false);
		expect(coordinator.isCurrent(second.generation)).toBe(true);
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
	});
});

describe("tps run accounting", () => {
	test("only the interactive parent TUI session owns the footer", () => {
		const base = { hasUI: true, mode: "tui" } as const;
		expect(isPrimaryUiSession(base as never)).toBe(true);
		expect(isPrimaryUiSession({ hasUI: true, mode: "rpc" } as never)).toBe(false);
		expect(isPrimaryUiSession({ hasUI: false, mode: "print" } as never)).toBe(false);
	});

	test("excludes gate waiting that was already in effect when the run started", () => {
		const pause = { isPaused: () => true, getPausedDurationMs: () => 5_000 };
		expect(
			computeElapsedMs({
				startMs: 5_000,
				now: 10_000,
				pausedDurationAtStartMs: 4_000,
				pauseWasEnabledAtStart: true,
				pause,
			}),
		).toBe(4_000);
	});

	test("keeps counting when the pause began mid-run, since it only gates the next request", () => {
		const pause = { isPaused: () => true, getPausedDurationMs: () => 2_000 };
		expect(
			computeElapsedMs({
				startMs: 5_000,
				now: 8_000,
				pausedDurationAtStartMs: 2_000,
				pauseWasEnabledAtStart: false,
				pause,
			}),
		).toBe(3_000);
	});

	test("never reports negative elapsed time", () => {
		const pause = { isPaused: () => false, getPausedDurationMs: () => 0 };
		expect(
			computeElapsedMs({
				startMs: 9_000,
				now: 1_000,
				pausedDurationAtStartMs: 0,
				pauseWasEnabledAtStart: false,
				pause,
			}),
		).toBe(0);
	});
});

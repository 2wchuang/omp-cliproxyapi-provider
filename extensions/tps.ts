/**
 * Elapsed-time footer and TPS summary for CLIProxyAPI turns.
 *
 * Registered as its own extension entry (`omp.extensions`), so this module runs
 * in a separate module graph from `index.ts` and cannot import its state.
 * Everything shared with the rest of the plugin therefore comes from the host —
 * omp's process-global `agentPauseGate`, which is the same object the main entry
 * engages.
 */

import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const STATUS_KEY = "tps";
const REFRESH_INTERVAL_MS = 1000;

/**
 * Only the interactive parent TUI session owns the footer timer and TPS toast.
 * Subagent sessions load global extensions too but run with a quiet UI, so a
 * shared binding must never let a child clear the parent footer.
 */
export function isPrimaryUiSession(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

export function formatElapsed(totalSeconds: number): string {
	const safeSeconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(safeSeconds / 86400);
	const hours = Math.floor((safeSeconds % 86400) / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const seconds = safeSeconds % 60;

	const units: Array<{ value: number; suffix: string }> = [
		{ value: days, suffix: "d" },
		{ value: hours, suffix: "h" },
		{ value: minutes, suffix: "m" },
		{ value: seconds, suffix: "s" },
	];

	// Skip leading zero units; always keep at least seconds.
	const parts: string[] = [];
	let started = false;
	for (let i = 0; i < units.length; i++) {
		const unit = units[i]!;
		if (!started) {
			if (unit.value === 0 && i < units.length - 1) continue;
			started = true;
		}
		parts.push(`${unit.value}${unit.suffix}`);
	}
	return parts.join(" ");
}

/** Structural subset of omp's process pause gate this module observes. */
export interface PauseGateSource {
	readonly paused: boolean;
	readonly pausedAt: number | undefined;
	onChange(listener: (paused: boolean) => void): () => void;
}

/** Read side of {@link PauseAccounting}, injectable so elapsed math is testable. */
export interface PauseTotals {
	getPausedDurationMs(now?: number): number;
	isPaused(): boolean;
}

/**
 * Total time the process gate has been engaged. omp's gate exposes only the
 * current pause start, so completed intervals are accumulated from transitions.
 */
export class PauseAccounting implements PauseTotals {
	#completedMs = 0;
	#pausedAt: number | undefined;
	readonly #now: () => number;

	constructor(source: PauseGateSource, now: () => number = Date.now) {
		this.#now = now;
		this.#pausedAt = source.pausedAt;
		source.onChange((paused) => {
			const at = this.#now();
			if (paused) {
				this.#pausedAt = at;
			} else if (this.#pausedAt !== undefined) {
				this.#completedMs += Math.max(0, at - this.#pausedAt);
				this.#pausedAt = undefined;
			}
		});
	}

	getPausedDurationMs(now = this.#now()): number {
		if (this.#pausedAt === undefined) return this.#completedMs;
		return this.#completedMs + Math.max(0, now - this.#pausedAt);
	}

	isPaused(): boolean {
		return this.#pausedAt !== undefined;
	}
}

/**
 * Elapsed run time, excluding gate waiting.
 *
 * A pause issued during an active run only gates the *next* provider request, so
 * the current run keeps counting until it settles. A pause already engaged when
 * the run started has its waiting time deducted, which is why the caller passes
 * the totals captured at run start.
 */
export function computeElapsedMs(options: {
	startMs: number;
	now: number;
	pausedDurationAtStartMs: number;
	pauseWasEnabledAtStart: boolean;
	pause: PauseTotals;
}): number {
	const { startMs, now, pausedDurationAtStartMs, pauseWasEnabledAtStart, pause } = options;
	if (!pauseWasEnabledAtStart) return Math.max(0, now - startMs);
	const pausedSinceStartMs = Math.max(0, pause.getPausedDurationMs(now) - pausedDurationAtStartMs);
	return Math.max(0, now - startMs - pausedSinceStartMs);
}

export default function (pi: ExtensionAPI): void {
	const pauses = new PauseAccounting(agentPauseGate);

	let requestStartMs: number | null = null;
	let pausedDurationAtStartMs = 0;
	let pauseWasEnabledAtStart = false;
	let refreshTimer: ReturnType<ExtensionContext["setInterval"]> | undefined;
	/** Context that owns `refreshTimer`; `clearTimer` is scoped to its runner. */
	let timerCtx: ExtensionContext | null = null;
	let statusCtx: ExtensionContext | null = null;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;

	function clearRefreshTimer(): void {
		if (refreshTimer === undefined) return;
		timerCtx?.clearTimer(refreshTimer);
		refreshTimer = undefined;
		timerCtx = null;
	}

	function getElapsedMs(now = Date.now()): number {
		if (requestStartMs === null) return 0;
		return computeElapsedMs({
			startMs: requestStartMs,
			now,
			pausedDurationAtStartMs,
			pauseWasEnabledAtStart,
			pause: pauses,
		});
	}

	function setElapsedStatus(ctx: ExtensionContext, totalSeconds: number): void {
		if (!isPrimaryUiSession(ctx)) return;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `Elapsed ${formatElapsed(totalSeconds)}`));
	}

	function refreshStatus(): void {
		if (requestStartMs === null || !statusCtx) return;
		setElapsedStatus(statusCtx, Math.floor(getElapsedMs() / 1000));
	}

	function clearStatus(ctx?: ExtensionContext): void {
		const target = ctx ?? statusCtx;
		if (!target || !isPrimaryUiSession(target)) return;
		target.ui.setStatus(STATUS_KEY, undefined);
	}

	pi.on("before_agent_start", (_event, ctx) => {
		// Subagents / print sessions must not own the footer timer.
		if (!isPrimaryUiSession(ctx)) return;

		// Keep the same timer across retries and tool continuations within one run.
		if (requestStartMs !== null) {
			statusCtx = ctx;
			return;
		}

		const startMs = Date.now();
		requestStartMs = startMs;
		pauseWasEnabledAtStart = pauses.isPaused();
		pausedDurationAtStartMs = pauses.getPausedDurationMs(startMs);
		statusCtx = ctx;
		input = 0;
		output = 0;
		cacheRead = 0;
		cacheWrite = 0;
		totalTokens = 0;
		refreshStatus();

		clearRefreshTimer();
		// `ctx.setInterval` contains throws, unrefs the handle, and clears it on
		// session shutdown — a raw interval here could pin the event loop or take
		// the process down from a render error.
		refreshTimer = ctx.setInterval(() => refreshStatus(), REFRESH_INTERVAL_MS);
		timerCtx = ctx;
	});

	pi.on("agent_end", (event, ctx) => {
		if (requestStartMs === null) return;
		// Ignore usage from subagent / non-TUI sessions.
		if (!isPrimaryUiSession(ctx)) return;

		// A non-terminal settle is a scheduled continuation (auto-retry, empty-stop
		// retry, …). Its usage belongs to a replayed attempt and would double-count
		// once the continuation re-enters `before_agent_start`.
		if (event.willContinue === true) return;

		// omp hands the extension the whole active transcript, not just this run, so
		// messages from earlier turns must not be counted again.
		const runStartMs = requestStartMs;
		for (const message of event.messages) {
			if (message.role !== "assistant") continue;
			if (typeof message.timestamp !== "number" || message.timestamp < runStartMs) continue;
			const usage = message.usage;
			input += usage.input || 0;
			output += usage.output || 0;
			cacheRead += usage.cacheRead || 0;
			cacheWrite += usage.cacheWrite || 0;
			totalTokens += usage.totalTokens || 0;
		}

		const elapsedMs = getElapsedMs();
		const elapsedSecondsExact = elapsedMs / 1000;

		requestStartMs = null;
		clearRefreshTimer();
		statusCtx = ctx;
		// Keep the final total time in the footer after the run settles.
		setElapsedStatus(ctx, Math.floor(elapsedSecondsExact));

		if (elapsedMs <= 0) return;

		const tps = output > 0 ? (output / elapsedSecondsExact).toFixed(1) : "--";
		ctx.ui.notify(
			`TPS ${tps} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSecondsExact.toFixed(1)}s`,
			"info",
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearRefreshTimer();
		clearStatus(ctx);
		requestStartMs = null;
		pausedDurationAtStartMs = 0;
		pauseWasEnabledAtStart = false;
		statusCtx = null;
	});
}

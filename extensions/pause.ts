/**
 * Bridge the plugin's persisted pause preference to omp's process-global pause
 * gate.
 *
 * The gate is the only correct freeze point: agent loops poll it at their two
 * action boundaries, so a paused request parks indefinitely. An extension event
 * handler cannot serve this purpose — handlers are capped at 30s, after which
 * omp swallows the result and the request proceeds anyway.
 */

import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolvePauseDefault, saveConfigFile } from "./lib.ts";
import { logWarn } from "./provider.ts";

export function persistPause(agentDir: string, paused: boolean): void {
	saveConfigFile(agentDir, { pause: paused });
}

/**
 * Restore the persisted pause on session start and mirror every later gate
 * transition back to disk, so `cliproxyapi.json` stays truthful even when the
 * freeze is driven by omp's built-in `/pause` / `/resume`.
 */
export function registerPauseBinding(pi: ExtensionAPI, agentDir: string): void {
	pi.on("session_start", () => {
		let paused = false;
		try {
			paused = resolvePauseDefault(agentDir);
		} catch (error) {
			logWarn(`invalid pause configuration (${error instanceof Error ? error.message : String(error)}); using pause=false`);
		}
		if (paused) agentPauseGate.pause();
	});

	agentPauseGate.onChange((paused) => {
		try {
			persistPause(agentDir, paused);
		} catch (error) {
			logWarn(`failed to persist pause state: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

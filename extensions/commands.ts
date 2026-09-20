/**
 * Slash commands for the CLIProxyAPI provider.
 *
 * Every command lives under this plugin's own `cpa-` namespace. omp ships ~90
 * built-in commands and silently skips an extension command whose name collides
 * (`fast`, `pause`, `login`, `logout`, `model`, `compact`, …), so an unprefixed
 * name would be dropped without a visible error. The `cpa-` prefix is also free
 * of collisions with built-ins today and stays free as omp adds commands.
 */

import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveConnection, resolveFastDefault, saveConfigFile } from "./lib.ts";
import {
	type FastState,
	logWarn,
	type ModelRefreshCoordinator,
	type RegistrationTarget,
	readStoredConnection,
	refreshAndRegister,
} from "./provider.ts";

export interface CommandDeps extends RegistrationTarget {
	fastState: FastState;
	refreshCoordinator: ModelRefreshCoordinator;
}

/** Publish the Fast/pause status segments for the active session. */
export function publishStatus(ctx: ExtensionContext, deps: CommandDeps): void {
	const model = ctx.model;
	const fastSupported = model?.provider === deps.providerId && deps.fastState.isModelSupported(model.id);
	const fastLabel = deps.fastState.isEnabled() ? (fastSupported ? "Fast: on" : "Fast: on (unsupported)") : "Fast: off";
	ctx.ui.setStatus(
		"cliproxyapi-fast",
		deps.fastState.isEnabled() ? ctx.ui.theme.fg("accent", fastLabel) : ctx.ui.theme.fg("dim", fastLabel),
	);
	ctx.ui.setStatus(
		"cliproxyapi-pause",
		agentPauseGate.paused ? ctx.ui.theme.fg("warning", "Paused") : undefined,
	);
}

export function clearStatus(pi: ExtensionAPI): void {
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("cliproxyapi-fast", undefined);
		ctx.ui.setStatus("cliproxyapi-pause", undefined);
	});
}

function registerRefreshCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("cpa-refresh", {
		description: "Force refresh CLIProxyAPI models from the remote catalog.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /cpa-refresh", "error");
				return;
			}

			const connection = resolveConnection(deps.agentDir, readStoredConnection(deps.agentDir, deps.providerId));
			if (!connection) {
				ctx.ui.notify(
					`CLIProxyAPI is not configured. Use /login ${deps.providerName} or /login ${deps.providerId}.`,
					"error",
				);
				return;
			}

			const refresh = deps.refreshCoordinator.begin();
			try {
				const result = await refreshAndRegister(
					deps,
					{ baseUrlInput: connection.baseUrlInput, apiKey: connection.apiKey },
					{ forceRefresh: true, refresh },
				);
				if (!result) return;
				publishStatus(ctx, deps);
				ctx.ui.notify(`Refreshed ${result.modelCount} CLIProxyAPI models from ${result.modelsUrl}.`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to refresh CLIProxyAPI models: ${message}`, "error");
			}
		},
	});
}

function registerFastCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	let modeChangeInProgress = false;

	pi.registerCommand("cpa-fast", {
		description: "Toggle CLIProxyAPI Fast mode (catalog-gated priority service tier).",
		handler: async (args, ctx) => {
			if (modeChangeInProgress) {
				ctx.ui.notify("Fast mode is already being refreshed. Try again when it finishes.", "warning");
				return;
			}

			const requested = args.trim().toLowerCase();
			if (requested === "status") {
				publishStatus(ctx, deps);
				ctx.ui.notify(`Fast mode is ${deps.fastState.isEnabled() ? "enabled" : "disabled"} globally.`, "info");
				return;
			}
			if (requested && requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /cpa-fast [on|off|status]", "error");
				return;
			}

			const previousEnabled = deps.fastState.isEnabled();
			const enabled = requested ? requested === "on" : !previousEnabled;
			if (enabled === previousEnabled) {
				publishStatus(ctx, deps);
				ctx.ui.notify(`Fast mode is already ${enabled ? "enabled" : "disabled"} globally.`, "info");
				return;
			}

			modeChangeInProgress = true;
			try {
				try {
					saveConfigFile(deps.agentDir, { fast: enabled });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save Fast mode: ${message}`, "error");
					return;
				}
				deps.fastState.setEnabled(enabled);

				// Re-register so model cost cards reflect the Fast rate tier. A failure
				// rolls back all three views: in-memory behavior, the persisted
				// preference, and the registered catalog.
				try {
					const connection = resolveConnection(
						deps.agentDir,
						readStoredConnection(deps.agentDir, deps.providerId),
					);
					if (connection) {
						await refreshAndRegister(
							deps,
							{ baseUrlInput: connection.baseUrlInput, apiKey: connection.apiKey },
							{ forceRefresh: true },
						);
					}
				} catch (error) {
					deps.fastState.setEnabled(previousEnabled);
					const rollbackErrors: string[] = [];
					try {
						saveConfigFile(deps.agentDir, { fast: previousEnabled });
					} catch (rollbackError) {
						rollbackErrors.push(
							`config rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
						);
					}
					const message = error instanceof Error ? error.message : String(error);
					const suffix = rollbackErrors.length > 0 ? ` (${rollbackErrors.join("; ")})` : "";
					ctx.ui.notify(`Failed to refresh model pricing: ${message}${suffix}`, "warning");
					publishStatus(ctx, deps);
					return;
				}

				publishStatus(ctx, deps);
				const currentModel = ctx.model;
				if (
					enabled &&
					(!currentModel || currentModel.provider !== deps.providerId || !deps.fastState.isModelSupported(currentModel.id))
				) {
					ctx.ui.notify("Fast mode is enabled globally, but the current model does not support it.", "warning");
				} else {
					ctx.ui.notify(enabled ? "Fast mode is enabled globally." : "Fast mode is disabled globally.", "info");
				}
			} finally {
				modeChangeInProgress = false;
			}
		},
	});
}

function registerContinueCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("cpa-continue", {
		description: "Release paused CLIProxyAPI requests (omp's process pause gate).",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /cpa-continue", "error");
				return;
			}
			if (agentPauseGate.paused) agentPauseGate.resume();
			try {
				saveConfigFile(deps.agentDir, { pause: false });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to save pause mode: ${message}`, "error");
			}
			publishStatus(ctx, deps);
			ctx.ui.notify("Requests are continued.", "info");
		},
	});
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
	registerRefreshCommand(pi, deps);
	registerFastCommand(pi, deps);
	registerContinueCommand(pi, deps);
	clearStatus(pi);
}

/** Resolve the persisted Fast preference, falling back to disabled. */
export function resolveFastPreference(agentDir: string): boolean {
	try {
		return resolveFastDefault(agentDir);
	} catch (error) {
		logWarn(`invalid Fast configuration (${error instanceof Error ? error.message : String(error)}); using fast=false`);
		return false;
	}
}

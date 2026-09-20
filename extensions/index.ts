/**
 * CLIProxyAPI dynamic model provider for oh-my-pi.
 *
 * Setup via `/login`: the provider is registered OAuth-only so `/login
 * CLIProxyAPI` (or `/login cliproxyapi`) skips omp's API-key-vs-account selector
 * and goes straight to multi-field prompts, then validates the credentials
 * against `/v1/models` and registers the discovered catalog. `/cpa-refresh`
 * re-pulls the catalog, `/cpa-fast` toggles the catalog-gated priority tier, and
 * `/cpa-continue` releases a paused request gate.
 *
 * Non-interactive setup works too, via env vars or `~/.omp/agent/cliproxyapi.json`.
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { registerCommands, publishStatus, resolveFastPreference } from "./commands.ts";
import { CONFIG_FILE_NAME, isUnauthorizedModelsError, resolveConnection, resolveIdentity } from "./lib.ts";
import { registerPauseBinding } from "./pause.ts";
import {
	FastState,
	logInfo,
	logWarn,
	ModelRefreshCoordinator,
	type RegistrationTarget,
	readStoredConnection,
	refreshAndRegister,
	registerCliproxyProvider,
	registerFastMode,
	resolveDefaultBaseUrl,
} from "./provider.ts";

export { resolveEndpoints, toOmpModel } from "./lib.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const identity = resolveIdentity(agentDir);

	const fastState = new FastState(resolveFastPreference(agentDir));
	const refreshCoordinator = new ModelRefreshCoordinator();
	const defaultBaseUrl = resolveDefaultBaseUrl({ agentDir, providerId: identity.providerId });

	const target: RegistrationTarget = {
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		fastState,
		refreshCoordinator,
	};

	registerPauseBinding(pi, agentDir);
	registerFastMode(pi, identity.providerId, fastState);
	registerCommands(pi, target);

	pi.on("session_start", (_event, ctx: ExtensionContext) => publishStatus(ctx, target));

	// Register before any network await so a fresh install can `/login <id>`
	// immediately, with the provider already visible in the login list.
	registerCliproxyProvider(target, { baseUrlInput: defaultBaseUrl });

	const stored = readStoredConnection(agentDir, identity.providerId);
	const connection = resolveConnection(agentDir, stored);
	if (!connection) {
		logInfo(
			`not configured yet. Use /login ${identity.providerName} or /login ${identity.providerId}. ` +
				`Or set ${CONFIG_FILE_NAME} / CLIPROXYAPI_API_KEY.`,
		);
		return;
	}

	try {
		const result = await refreshAndRegister(target, {
			baseUrlInput: connection.baseUrlInput,
			apiKey: connection.apiKey,
		});
		if (result?.fromCache) {
			// Two-phase startup: the cached catalog is live immediately, and a slow or
			// unreachable CPA only delays the background refresh, never omp's startup.
			logInfo(`loaded ${result.modelCount} cached CLIProxyAPI models from ${result.modelsUrl}`);
			void refreshAndRegister(
				target,
				{ baseUrlInput: connection.baseUrlInput, apiKey: connection.apiKey },
				{ forceRefresh: true, refresh: refreshCoordinator.begin() },
			).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				logWarn(`failed to refresh cached models (${message}); keeping the cached model list.`);
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isUnauthorizedModelsError(error)) {
			logWarn(`models request unauthorized (${message}). Use /login ${identity.providerName} to reconfigure.`);
		} else {
			logWarn(
				`failed to load models (${message}). Use /login ${identity.providerName} or check ${CONFIG_FILE_NAME} / CLIPROXYAPI_* env vars.`,
			);
		}
	}
}

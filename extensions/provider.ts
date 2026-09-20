/**
 * Provider registration, Fast (priority service tier) injection, `/login`
 * handlers, and catalog refresh for the CLIProxyAPI provider.
 */

import { Database } from "bun:sqlite";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import {
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import {
	CONFIG_FILE_NAME,
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	decodeRefreshMeta,
	encodeRefreshMeta,
	firstNonEmpty,
	loadConfigFile,
	type MappedModels,
	resolveEndpoints,
	resolveMappedModels,
	saveConfigFile,
} from "./lib.ts";

/** CPA serves every vendor's models over the codex Responses wire protocol. */
export const CODEX_API = "openai-codex-responses" as const;

export type CliproxyProviderModel = ProviderModelConfig;

export interface StoredConnection {
	baseUrl?: string;
	apiKey?: string;
}

export interface RefreshResult {
	modelCount: number;
	modelsUrl: string;
	fromCache: boolean;
}

export interface RegistrationTarget {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	fastState: FastState;
	refreshCoordinator: ModelRefreshCoordinator;
}

/**
 * Global Fast preference plus the capability set the CPA catalog advertises.
 *
 * The catalog, not omp's `identity.class`, decides which models support the
 * priority tier: CPA reports no service tiers for ids omp classifies as
 * OpenAI-shaped, and Fast must stay off for those.
 */
export class FastState {
	#enabled: boolean;
	#supported = new Set<string>();

	constructor(enabled: boolean) {
		this.#enabled = enabled;
	}

	setEnabled(value: boolean): void {
		this.#enabled = value;
	}

	isEnabled(): boolean {
		return this.#enabled;
	}

	setSupportedModelIds(ids: Iterable<string>): void {
		const next = new Set<string>();
		for (const id of ids) {
			const trimmed = id.trim();
			if (trimmed.length > 0) next.add(trimmed);
		}
		this.#supported = next;
	}

	isModelSupported(modelId: string): boolean {
		return this.#supported.has(modelId.trim());
	}

	isEffectiveFor(modelId: string): boolean {
		return this.#enabled && this.isModelSupported(modelId);
	}
}

/**
 * Serializes catalog refreshes: starting one aborts the in-flight request, and a
 * superseded generation must not commit its cache write or re-registration.
 */
export class ModelRefreshCoordinator {
	#generation = 0;
	#active: AbortController | undefined;

	begin(): { generation: number; signal: AbortSignal } {
		this.#active?.abort();
		const controller = new AbortController();
		this.#active = controller;
		this.#generation += 1;
		return { generation: this.#generation, signal: controller.signal };
	}

	isCurrent(generation: number): boolean {
		return this.#generation === generation;
	}
}

export class ConfigPersistenceError extends Error {
	constructor(cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to save ${CONFIG_FILE_NAME}: ${message}`, { cause });
		this.name = "ConfigPersistenceError";
	}
}

export function logWarn(message: string): void {
	console.warn(`[omp-cliproxyapi-provider] ${message}`);
}

export function logInfo(message: string): void {
	console.info(`[omp-cliproxyapi-provider] ${message}`);
}

/**
 * Read the `/login`-stored credential for this provider.
 *
 * omp keeps credentials in the agent SQLite database, addressed by the *active*
 * agent directory. The legacy `readStoredCredential` shim hardcodes the default
 * directory, so it would miss (or cross-wire) a `--profile` login; reading the
 * store directly also keeps callers synchronous.
 */
export function readStoredConnection(agentDir: string, providerId: string): StoredConnection | null {
	let store: SqliteAuthCredentialStore | undefined;
	try {
		store = new SqliteAuthCredentialStore(new Database(getAgentDbPath(agentDir)));
		const credential = store.listAuthCredentials(providerId)[0]?.credential;
		if (credential?.type === "oauth" && credential.access.trim()) {
			return { apiKey: credential.access.trim(), baseUrl: decodeRefreshMeta(credential.refresh)?.baseUrl };
		}
		if (credential?.type === "api_key" && credential.key.trim()) {
			return { apiKey: credential.key.trim() };
		}
		return null;
	} catch {
		return null;
	} finally {
		store?.close();
	}
}

export function resolveDefaultBaseUrl(target: Pick<RegistrationTarget, "agentDir" | "providerId">): string {
	let fileBaseUrl: string | undefined;
	try {
		fileBaseUrl = loadConfigFile(target.agentDir).baseUrl;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			logWarn(`failed to read ${CONFIG_FILE_NAME}: ${err.message}`);
		}
	}
	let storedBaseUrl: string | undefined;
	try {
		storedBaseUrl = readStoredConnection(target.agentDir, target.providerId)?.baseUrl;
	} catch (error) {
		logWarn(`failed to read stored credentials: ${error instanceof Error ? error.message : String(error)}`);
	}
	return firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, fileBaseUrl, storedBaseUrl, DEFAULT_BASE_URL)!;
}

/**
 * Load the catalog (cache-first unless forced) and publish its Fast capability
 * set. A superseded refresh returns `undefined` and skips its cache write, so a
 * stale catalog can never overwrite a newer one.
 */
export async function loadCatalog(
	target: RegistrationTarget,
	request: {
		baseUrlInput: string;
		apiKey: string;
		forceRefresh?: boolean;
		refresh?: { generation: number; signal: AbortSignal };
	},
): Promise<{ loaded: MappedModels; fromCache: boolean } | undefined> {
	const refresh = request.refresh;
	const shouldCommit = () => refresh === undefined || target.refreshCoordinator.isCurrent(refresh.generation);
	const result = await resolveMappedModels(target.agentDir, request.baseUrlInput, request.apiKey, {
		forceRefresh: request.forceRefresh,
		fastMode: target.fastState.isEnabled(),
		signal: refresh?.signal,
		shouldCommit,
	});
	if (!shouldCommit()) return undefined;
	target.fastState.setSupportedModelIds(result.loaded.fastModelIds);
	return result;
}

/**
 * Fetch the catalog and register the provider with it.
 *
 * The ambient API key is installed only when no `/login` credential exists: an
 * extension-supplied `apiKey` outranks OAuth in `AuthStorage.getApiKey`'s
 * cascade, so passing both would silently ignore a stored login. `oauthOnly`
 * forces it off for the `/login` path, where the credential being stored does
 * not exist yet and a detected one may belong to a previous account.
 */
export async function refreshAndRegister(
	target: RegistrationTarget,
	connection: { baseUrlInput: string; apiKey: string },
	options: {
		forceRefresh?: boolean;
		oauthOnly?: boolean;
		refresh?: { generation: number; signal: AbortSignal };
	} = {},
): Promise<RefreshResult | undefined> {
	const result = await loadCatalog(target, {
		baseUrlInput: connection.baseUrlInput,
		apiKey: connection.apiKey,
		forceRefresh: options.forceRefresh,
		refresh: options.refresh,
	});
	if (!result) return undefined;

	const ambientApiKey =
		options.oauthOnly || readStoredConnection(target.agentDir, target.providerId)?.apiKey
			? undefined
			: connection.apiKey;
	registerCliproxyProvider(target, {
		baseUrlInput: connection.baseUrlInput,
		apiKey: ambientApiKey,
		models: result.loaded.models,
	});
	return {
		modelCount: result.loaded.models.length,
		modelsUrl: result.loaded.modelsUrl,
		fromCache: result.fromCache,
	};
}

/**
 * Register or re-register the provider.
 *
 * `api` must be the built-in codex id: `registerCustomApi` reserves built-in
 * names, and a custom id whose `streamSimple` delegates back to pi-ai's
 * dispatcher resolves to itself and overflows the stack.
 */
export function registerCliproxyProvider(
	target: RegistrationTarget,
	options: { baseUrlInput: string; apiKey?: string; models?: readonly CliproxyProviderModel[] },
): void {
	const endpoints = resolveEndpoints(options.baseUrlInput);
	const config: ProviderConfig = {
		baseUrl: endpoints.inferenceBaseUrl,
		api: CODEX_API,
		oauth: createOAuthHandlers(target),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.models && options.models.length > 0 ? { models: [...options.models] } : {}),
	};

	// Replace any previous registration so an earlier ambient apiKey cannot linger
	// through registerProvider's merge semantics and mask a stored login.
	target.pi.unregisterProvider(target.providerId);
	target.pi.registerProvider(target.providerId, config);
}

/**
 * Validate the credentials, persist the connection, then register OAuth-only
 * with the fresh catalog. Persistent state is written before anything live is
 * mutated, so a failed save cannot leave the session pointed at unpersisted
 * credentials.
 */
export async function configureAndRegister(
	target: RegistrationTarget,
	connection: { baseUrlInput: string; apiKey: string },
): Promise<RefreshResult> {
	const refresh = target.refreshCoordinator.begin();
	const result = await loadCatalog(target, {
		baseUrlInput: connection.baseUrlInput,
		apiKey: connection.apiKey,
		forceRefresh: true,
		refresh,
	});
	if (!result) {
		throw new Error("Model refresh was superseded by a newer request.");
	}

	try {
		saveConfigFile(target.agentDir, {
			baseUrl: connection.baseUrlInput,
			providerId: target.providerId,
			providerName: target.providerName,
		});
	} catch (error) {
		throw new ConfigPersistenceError(error);
	}

	registerCliproxyProvider(target, {
		baseUrlInput: connection.baseUrlInput,
		models: result.loaded.models,
	});
	return {
		modelCount: result.loaded.models.length,
		modelsUrl: result.loaded.modelsUrl,
		fromCache: result.fromCache,
	};
}

function createOAuthHandlers(target: RegistrationTarget): ProviderConfig["oauth"] {
	return {
		name: target.providerName,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			let promptDefaultBaseUrl = resolveDefaultBaseUrl(target);

			// Final login step: validate by calling /v1/models.
			// HTTP 200 (even with an empty catalog) means success; otherwise re-prompt.
			while (true) {
				const { baseUrlInput, apiKey } = await promptConnection(callbacks, { baseUrl: promptDefaultBaseUrl });

				callbacks.onProgress?.("Validating credentials via models endpoint...");
				try {
					const result = await configureAndRegister(target, { baseUrlInput, apiKey });
					logInfo(`login ok: registered ${result.modelCount} models from ${result.modelsUrl}`);
					return buildOAuthCredentials(baseUrlInput, apiKey);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logWarn(`login validation failed: ${message}`);
					if (error instanceof ConfigPersistenceError) {
						callbacks.onProgress?.(message);
						throw error;
					}
					callbacks.onProgress?.(`Login validation failed: ${message}\nPlease re-enter base URL and API key.`);
					// Keep the last baseUrl as the next default so retyping is easier.
					promptDefaultBaseUrl = baseUrlInput || promptDefaultBaseUrl;
				}
			}
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			// API keys do not expire; keep the stored payload as-is.
			return { ...credentials, expires: Date.now() + CREDENTIAL_TTL_MS };
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}

export function buildOAuthCredentials(baseUrlInput: string, apiKey: string): OAuthCredentials {
	return {
		refresh: encodeRefreshMeta(baseUrlInput),
		access: apiKey,
		expires: Date.now() + CREDENTIAL_TTL_MS,
	};
}

async function promptConnection(
	callbacks: OAuthLoginCallbacks,
	defaults: { baseUrl: string },
): Promise<{ baseUrlInput: string; apiKey: string }> {
	callbacks.onProgress?.("Configure CLIProxyAPI. Preferred baseUrl form: host:port (e.g. http://127.0.0.1:8317).");

	const baseUrlRaw = await callbacks.onPrompt({
		message: `CLIProxyAPI base URL [${defaults.baseUrl}]:`,
		placeholder: defaults.baseUrl,
		allowEmpty: true,
	});
	const baseUrlInput = firstNonEmpty(baseUrlRaw, defaults.baseUrl)!;

	// Validate early so users get a clear error before typing the API key.
	resolveEndpoints(baseUrlInput);

	// Masked, always: a host that cannot hide input must reject the prompt rather
	// than echo the key (omp's RPC mode documents exactly that), and this login is
	// unavailable headlessly anyway — its non-secret prompts are rejected until a
	// provider emits an auth URL.
	const apiKey = (
		await callbacks.onPrompt({
			message: "CLIProxyAPI API key:",
			placeholder: "sk-...",
			allowEmpty: false,
			secret: true,
		})
	).trim();
	if (!apiKey) {
		throw new Error("API key cannot be empty.");
	}

	return { baseUrlInput, apiKey };
}

/**
 * Inject OpenAI's `priority` service tier for CPA-advertised Fast models.
 *
 * The payload hook is the only correct seam: omp applies its own `service_tier`
 * inside the codex request builder, and this handler runs before that builder,
 * with its return value replacing the request body.
 */
export function registerFastMode(pi: ExtensionAPI, providerId: string, fastState: FastState): void {
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== providerId) return;
		if (!fastState.isEffectiveFor(model.id)) return;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		return { ...(payload as Record<string, unknown>), service_tier: "priority" };
	});
}

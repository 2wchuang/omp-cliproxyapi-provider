import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	buildThinking,
	CONFIG_FILE_NAME,
	codexModelId,
	decodeRefreshMeta,
	encodeRefreshMeta,
	loadModelsCache,
	MODELS_CACHE_FILE_NAME,
	resolveEndpoints,
	resolveIdentity,
	saveModelsCache,
	toOmpModel,
	parseBooleanSetting,
	resolveFastDefault,
	resolvePauseDefault,
	saveConfigFile,
	supportsFastServiceTier,
} from "../extensions/lib.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cliproxyapi-lib-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.CLIPROXYAPI_CLIENT_VERSION;
	delete process.env.CLIPROXYAPI_FAST;
	delete process.env.CLIPROXYAPI_PROVIDER_ID;
});

describe("resolveEndpoints", () => {
	test("maps every documented baseUrl shape onto the CPA inference and models endpoints", () => {
		const cases: Array<{ input: string; inference: string; models: string }> = [
			{
				input: "http://127.0.0.1:8317",
				inference: "http://127.0.0.1:8317/backend-api/",
				models: "http://127.0.0.1:8317/v1/models?client_version=omp",
			},
			{
				input: "https://cpa.example.com/v1",
				inference: "https://cpa.example.com/backend-api/",
				models: "https://cpa.example.com/v1/models?client_version=omp",
			},
			{
				input: "https://cpa.example.com/backend-api",
				inference: "https://cpa.example.com/backend-api/",
				models: "https://cpa.example.com/v1/models?client_version=omp",
			},
			{
				input: "https://cpa.example.com/backend-api/",
				inference: "https://cpa.example.com/backend-api/",
				models: "https://cpa.example.com/v1/models?client_version=omp",
			},
			{
				input: "https://cpa.example.com/",
				inference: "https://cpa.example.com/backend-api/",
				models: "https://cpa.example.com/v1/models?client_version=omp",
			},
			{
				input: "cpa.example.com:8317",
				inference: "http://cpa.example.com:8317/backend-api/",
				models: "http://cpa.example.com:8317/v1/models?client_version=omp",
			},
			{
				input: "https://cpa.example.com/proxy/v1/",
				inference: "https://cpa.example.com/proxy/backend-api/",
				models: "https://cpa.example.com/proxy/v1/models?client_version=omp",
			},
		];

		for (const { input, inference, models } of cases) {
			const resolved = resolveEndpoints(input);
			expect({ input, inference: resolved.inferenceBaseUrl, models: resolved.modelsUrl }).toEqual({
				input,
				inference,
				models,
			});
		}
	});

	test("rejects an empty base URL", () => {
		expect(() => resolveEndpoints("   ")).toThrow("baseUrl is empty");
	});

	test("honors CLIPROXYAPI_CLIENT_VERSION so a deployment can reject the default", () => {
		process.env.CLIPROXYAPI_CLIENT_VERSION = "pi";
		expect(resolveEndpoints("http://127.0.0.1:8317").modelsUrl).toBe(
			"http://127.0.0.1:8317/v1/models?client_version=pi",
		);
	});
});

describe("buildThinking", () => {
	test("keeps only omp's effort ladder, in canonical order, dropping CPA's ultra", () => {
		const thinking = buildThinking(["high", "ultra", "low", "medium"]);
		expect(thinking?.mode).toBe("effort");
		expect(thinking?.efforts.map(String)).toEqual(["low", "medium", "high"]);
	});

	test("returns undefined when no CPA level maps onto an omp effort", () => {
		expect(buildThinking(["ultra"])).toBeUndefined();
		expect(buildThinking([])).toBeUndefined();
	});

	test("normalizes case and duplicates", () => {
		expect(buildThinking(["HIGH", "high", " High "])?.efforts.map(String)).toEqual(["high"]);
	});
});

describe("toOmpModel", () => {
	const base = {
		slug: "gpt-5.6-luna",
		display_name: "Luna",
		context_window: 272000,
		input_modalities: ["text", "image"],
	};

	test("maps a CPA model onto an omp provider model", () => {
		const mapped = toOmpModel({ ...base, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] });
		expect(mapped?.id).toBe("gpt-5.6-luna");
		expect(mapped?.name).toBe("Luna");
		expect(mapped?.reasoning).toBe(true);
		expect(mapped?.input).toEqual(["text", "image"]);
		expect(mapped?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(mapped?.contextWindow).toBe(272000);
		expect(mapped?.maxTokens).toBe(16384);
		expect(mapped?.thinking?.mode).toBe("effort");
		expect(mapped?.thinking?.efforts.map(String)).toEqual(["low", "high"]);
	});

	test("treats a model whose only level is none as non-reasoning without an effort ladder", () => {
		const mapped = toOmpModel({ ...base, supported_reasoning_levels: ["none"] });
		expect(mapped?.reasoning).toBe(false);
		expect(mapped?.thinking).toBeUndefined();
	});

	test("skips hidden models and empty slugs", () => {
		expect(toOmpModel({ ...base, visibility: "hide" })).toBeNull();
		expect(toOmpModel({ ...base, slug: "  ", id: "" })).toBeNull();
	});

	test("falls back to max_context_window, then the default window", () => {
		expect(toOmpModel({ slug: "a", max_context_window: 400000 })?.contextWindow).toBe(400000);
		expect(toOmpModel({ slug: "a" })?.contextWindow).toBe(128000);
	});

	test("always includes text input even when CPA omits the modality", () => {
		expect(toOmpModel({ slug: "a", input_modalities: ["image"] })?.input).toEqual(["text", "image"]);
	});
});

describe("codexModelId", () => {
	test("prefers slug over id and trims", () => {
		expect(codexModelId({ slug: " s ", id: "i" })).toBe("s");
		expect(codexModelId({ id: "i" })).toBe("i");
		expect(codexModelId({})).toBe("");
	});
});

describe("supportsFastServiceTier", () => {
	test("is true only for a non-empty service_tiers array", () => {
		expect(supportsFastServiceTier({ service_tiers: [{ id: "priority" }] })).toBe(true);
		expect(supportsFastServiceTier({ service_tiers: [] })).toBe(false);
		expect(supportsFastServiceTier({ additional_speed_tiers: ["fast"] })).toBe(false);
	});
});

describe("refresh metadata", () => {
	test("round-trips the baseUrl and rejects junk", () => {
		expect(decodeRefreshMeta(encodeRefreshMeta("http://127.0.0.1:8317"))).toEqual({
			baseUrl: "http://127.0.0.1:8317",
		});
		expect(decodeRefreshMeta("not json")).toBeNull();
		expect(decodeRefreshMeta(JSON.stringify({ baseUrl: "  " }))).toBeNull();
		expect(decodeRefreshMeta(undefined)).toBeNull();
	});
});

describe("config file", () => {
	test("merges partial writes instead of dropping unspecified keys", () => {
		saveConfigFile(dir, { baseUrl: "http://127.0.0.1:8317", apiKey: "k" });
		saveConfigFile(dir, { fast: true });
		const written = JSON.parse(readFileSync(join(dir, CONFIG_FILE_NAME), "utf8"));
		expect(written).toEqual({ baseUrl: "http://127.0.0.1:8317", apiKey: "k", fast: true });
	});

	test("resolves fast and pause preferences from the config file", () => {
		expect(resolveFastDefault(dir)).toBe(false);
		expect(resolvePauseDefault(dir)).toBe(false);
		saveConfigFile(dir, { fast: true, pause: true });
		expect(resolveFastDefault(dir)).toBe(true);
		expect(resolvePauseDefault(dir)).toBe(true);
	});

	test("rejects a non-boolean preference rather than silently defaulting", () => {
		saveConfigFile(dir, { fast: "yes" as unknown as boolean });
		expect(() => resolveFastDefault(dir)).toThrow('field "fast" must be a boolean');
	});

	test("lets CLIPROXYAPI_FAST override the file", () => {
		saveConfigFile(dir, { fast: true });
		process.env.CLIPROXYAPI_FAST = "off";
		expect(resolveFastDefault(dir)).toBe(false);
		process.env.CLIPROXYAPI_FAST = "maybe";
		expect(() => resolveFastDefault(dir)).toThrow("CLIPROXYAPI_FAST must be one of");
	});

	test("resolves provider identity from the file, else the defaults", () => {
		expect(resolveIdentity(dir)).toEqual({ providerId: "cliproxyapi", providerName: "CLIProxyAPI" });
		saveConfigFile(dir, { providerId: "cpa", providerName: "CPA" });
		expect(resolveIdentity(dir)).toEqual({ providerId: "cpa", providerName: "CPA" });
	});
});

describe("models cache", () => {
	const loaded = {
		models: [],
		fastModelIds: ["gpt-5.5"],
		inferenceBaseUrl: "https://cpa.example.com/backend-api/",
		modelsUrl: "https://cpa.example.com/v1/models?client_version=omp",
		fastMode: false,
	};

	test("round-trips a matching catalog", () => {
		saveModelsCache(dir, loaded, 1234);
		expect(loadModelsCache(dir, "https://cpa.example.com/v1")).toEqual({ ...loaded, fetchedAt: 1234 });
	});

	test("invalidates when the baseUrl changes", () => {
		saveModelsCache(dir, loaded);
		expect(loadModelsCache(dir, "https://other.example.com/v1")).toBeNull();
	});

	test("returns null for a malformed cache file instead of throwing", () => {
		writeFileSync(join(dir, MODELS_CACHE_FILE_NAME), "{not json");
		expect(loadModelsCache(dir, "https://cpa.example.com/v1")).toBeNull();
	});
});

describe("parseBooleanSetting", () => {
	test("accepts the documented spellings and rejects anything else", () => {
		for (const value of ["1", "true", "yes", "on", " TRUE "]) expect(parseBooleanSetting(value)).toBe(true);
		for (const value of ["0", "false", "no", "off"]) expect(parseBooleanSetting(value)).toBe(false);
		expect(parseBooleanSetting("maybe")).toBeUndefined();
	});
});

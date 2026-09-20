import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerCommands } from "../extensions/commands.ts";
import { CONFIG_FILE_NAME } from "../extensions/lib.ts";
import { FastState, ModelRefreshCoordinator, type RegistrationTarget } from "../extensions/provider.ts";

interface CapturedCommand {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Minimal harness: capture registered commands and the UI calls handlers make. */
function createHarness(agentDir: string) {
	const commands = new Map<string, CapturedCommand>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];

	const pi = {
		registerCommand: (name: string, options: CapturedCommand) => {
			commands.set(name, options);
		},
		on: () => {},
	} as unknown as RegistrationTarget["pi"];

	const ctx = {
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
			theme: { fg: (_color: string, text: string) => text },
		},
		model: undefined,
	} as unknown as Parameters<CapturedCommand["handler"]>[1];

	const deps: RegistrationTarget = {
		pi,
		agentDir,
		providerId: "cliproxyapi",
		providerName: "CLIProxyAPI",
		fastState: new FastState(false),
		refreshCoordinator: new ModelRefreshCoordinator(),
	};

	registerCommands(pi, deps);
	return { commands, notifications, statuses, deps, ctx };
}

function readConfig(agentDir: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8"));
	} catch {
		return {};
	}
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cliproxyapi-cmd-"));
	// Keep the harness offline: with no API key anywhere, resolveConnection() returns
	// null and the handler skips its (networked) catalog re-registration.
	delete process.env.CLIPROXYAPI_API_KEY;
	delete process.env.CLIPROXYAPI_BASE_URL;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("cpa-fast command", () => {
	test("registers the cpa- prefixed name and not an unprefixed built-in collision", () => {
		const { commands } = createHarness(dir);
		expect([...commands.keys()].sort()).toEqual(["cpa-continue", "cpa-fast", "cpa-refresh"]);
	});

	test("on persists fast:true and enables the in-memory state", async () => {
		const { commands, deps, ctx } = createHarness(dir);
		await commands.get("cpa-fast")?.handler("on", ctx);

		expect(readConfig(dir).fast).toBe(true);
		expect(deps.fastState.isEnabled()).toBe(true);
	});

	test("off persists fast:false and disables the in-memory state", async () => {
		const { commands, deps, ctx } = createHarness(dir);
		await commands.get("cpa-fast")?.handler("on", ctx);
		await commands.get("cpa-fast")?.handler("off", ctx);

		expect(readConfig(dir).fast).toBe(false);
		expect(deps.fastState.isEnabled()).toBe(false);
	});

	test("toggling with no argument flips the current value", async () => {
		const { commands, deps, ctx } = createHarness(dir);
		await commands.get("cpa-fast")?.handler("", ctx);
		expect(deps.fastState.isEnabled()).toBe(true);

		await commands.get("cpa-fast")?.handler("", ctx);
		expect(deps.fastState.isEnabled()).toBe(false);
	});

	test("rejects an unrecognized argument without touching persisted state", async () => {
		const { commands, notifications, deps, ctx } = createHarness(dir);
		await commands.get("cpa-fast")?.handler("maybe", ctx);

		expect(readConfig(dir).fast).toBeUndefined();
		expect(deps.fastState.isEnabled()).toBe(false);
		expect(notifications.at(-1)).toEqual({ message: "Usage: /cpa-fast [on|off|status]", type: "error" });
	});

	test("status reports without changing state", async () => {
		const { commands, notifications, deps, ctx } = createHarness(dir);
		await commands.get("cpa-fast")?.handler("status", ctx);

		expect(readConfig(dir).fast).toBeUndefined();
		expect(deps.fastState.isEnabled()).toBe(false);
		expect(notifications.at(-1)?.message).toBe("Fast mode is disabled globally.");
	});

	test("re-applying the current value reports it without disturbing state", async () => {
		const { commands, notifications, deps, ctx } = createHarness(dir);
		await commands.get("cpa-fast")?.handler("on", ctx);

		await commands.get("cpa-fast")?.handler("on", ctx);
		expect(readConfig(dir).fast).toBe(true);
		expect(deps.fastState.isEnabled()).toBe(true);
		expect(notifications.at(-1)).toEqual({ message: "Fast mode is already enabled globally.", type: "info" });
	});
});

describe("cpa-continue command", () => {
	test("persists pause:false and reports that requests continued", async () => {
		const { commands, notifications, ctx } = createHarness(dir);
		await commands.get("cpa-continue")?.handler("", ctx);

		expect(readConfig(dir).pause).toBe(false);
		expect(notifications.at(-1)).toEqual({ message: "Requests are continued.", type: "info" });
	});

	test("rejects stray arguments", async () => {
		const { commands, notifications, ctx } = createHarness(dir);
		await commands.get("cpa-continue")?.handler("now", ctx);

		expect(readConfig(dir).pause).toBeUndefined();
		expect(notifications.at(-1)).toEqual({ message: "Usage: /cpa-continue", type: "error" });
	});
});

describe("cpa-refresh command", () => {
	test("reports the unconfigured state instead of attempting a fetch", async () => {
		const { commands, notifications, ctx } = createHarness(dir);
		await commands.get("cpa-refresh")?.handler("", ctx);

		expect(notifications.at(-1)).toEqual({
			message: "CLIProxyAPI is not configured. Use /login CLIProxyAPI or /login cliproxyapi.",
			type: "error",
		});
	});

	test("rejects stray arguments", async () => {
		const { commands, notifications, ctx } = createHarness(dir);
		await commands.get("cpa-refresh")?.handler("force", ctx);

		expect(notifications.at(-1)).toEqual({ message: "Usage: /cpa-refresh", type: "error" });
	});
});

# omp-cliproxyapi-provider

CLIProxyAPI dynamic model provider for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`).

Port of [`@router-for-me/pi-cliproxyapi-provider`](https://github.com/router-for-me/pi-cliproxyapi-provider)
(MIT) to the omp extension API. It discovers the models your CLIProxyAPI (CPA)
deployment serves, registers them as a provider, and adds a Fast-mode priority
tier, request pausing, catalog refresh, and an elapsed/TPS footer.

## Features

| Feature | Command / behavior |
| --- | --- |
| Dynamic catalog | Models from `/v1/models` register as `cliproxyapi/<slug>`; hidden CPA models are skipped, and prices come from [models.dev](https://models.dev). |
| Login flow | `/login CLIProxyAPI` prompts for the base URL and API key, validates them against the models endpoint, then persists and registers them. |
| Fast mode | `/cpa-fast [on\|off\|status]` injects `service_tier: "priority"` — only for models whose CPA catalog entry advertises a service tier. |
| Pause | `/cpa-continue` releases omp's process pause gate; `/pause` (omp built-in) engages it. Both mirror to `cliproxyapi.json`. |
| Catalog refresh | `/cpa-refresh` re-pulls the catalog, bypassing the cache. |
| Elapsed / TPS | The TUI shows a live `Elapsed Ns` footer per run and a `TPS … tok/s. out …, in …, cache r/w …/…, total …, …s` summary when it settles. |

## Install

```bash
omp plugin install omp-cliproxyapi-provider
```

Or unpack the package into `~/.omp/plugins/node_modules/omp-cliproxyapi-provider/` (the
directory `omp plugin install` targets — note this is `~/.omp/plugins`, not under
`agent/`). Pointing `extensions:` in `~/.omp/agent/config.yml` at the package directory
works too; `package.json`'s `omp.extensions` field is the install contract.

### Before you install: remove any existing `cliproxyapi` provider

If `~/.omp/agent/models.yml` already defines a provider named `cliproxyapi`, that
static entry **collides** with this plugin. Both claim the same provider id, so the
plugin's registration replaces the static one at runtime — but the static catalog's
models can survive on their original transport, leaving you with a mixed provider.
Measured on a deployment whose `models.yml` used `api: openai-completions`:

| Configuration | Registered `cliproxyapi` models |
| --- | --- |
| `models.yml` only | 41, all `openai-completions` |
| plugin + `models.yml` | 35 on `openai-codex-responses` **plus 6 stale `openai-completions`** |
| plugin, `models.yml` provider renamed | 35, all `openai-codex-responses` |

The stale entries are exactly the models the plugin filters out as hidden, so they are
both unusable and outside the plugin's Fast gating and catalog refresh.

Remove the provider from `models.yml`, or rename it to keep it while avoiding the id:

```yaml
providers:
  cliproxyapi-static:      # renamed: no longer collides with the plugin
    baseUrl: https://cpa.example.com/v1
    api: openai-completions
```

The plugin's own configuration is independent of `models.yml` — it reads
`~/.omp/agent/cliproxyapi.json` and omp's credential store.

## Configure

### Interactive

```bash
omp
/login CLIProxyAPI      # or /login cliproxyapi
```

Prompts for the CPA base URL (default `http://127.0.0.1:8317`, or whatever is already
configured) and the API key. The key prompt is masked; a host that cannot mask input
rejects it rather than echoing the key.

The credentials are stored in omp's credential database at `~/.omp/agent/agent.db`,
so `/logout cliproxyapi` removes them (this differs from pi's `auth.json`).

### Non-interactive

`~/.omp/agent/cliproxyapi.json` (see `cliproxyapi.example.json`):

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "12345",
  "fast": false,
  "pause": false
}
```

Environment overrides, highest precedence first:

| Variable | Purpose |
| --- | --- |
| `CLIPROXYAPI_BASE_URL` | CPA base URL. |
| `CLIPROXYAPI_API_KEY` | Ambient request auth. |
| `CLIPROXYAPI_FAST` | `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`. |
| `CLIPROXYAPI_PROVIDER_ID` / `CLIPROXYAPI_PROVIDER_NAME` | Override the provider id / display name. |
| `CLIPROXYAPI_CLIENT_VERSION` | `client_version` sent to `/v1/models` (default `omp`), for deployments that reject it. |

`baseUrl` accepts `host:port`, `http(s)://host:port`, `…/v1`, or `…/backend-api`; all
forms normalize to the `…/backend-api/` inference root with the models catalog at
`…/v1/models`.

## Commands

All plugin commands live under the `cpa-` namespace, because omp silently skips an
extension command whose name collides with a built-in (there are ~90, including
`fast`, `pause`, `login`, `logout`, `model`, `compact`, `resume`, `retry`).

| Command | Description |
| --- | --- |
| `/cpa-refresh` | Force-refresh models from the remote catalog. |
| `/cpa-fast [on\|off\|status]` | Toggle catalog-gated Fast mode. |
| `/cpa-continue` | Release paused requests. |

### Fast mode, `/fast`, and `/cpa-fast`

omp has its own `/fast`, which sets `service_tier` for models omp's classifier reads
as OpenAI. This plugin's `/cpa-fast` is gated by the **CPA catalog** instead, which
differs in two ways:

- CPA ids omp does not classify as OpenAI (`hy4-preview`, `doubao-*`) still get Fast.
- CPA ids omp *does* classify as OpenAI but that CPA reports with no service tiers
  (`gpt-5.6-*`, `gpt-6-astra`) correctly do **not**.

Both ultimately send the same `service_tier: "priority"` on the wire, so either
command works where omp's classifier and the CPA catalog agree.

### Pause

`/pause` (omp built-in) freezes every agent loop in the process; the plugin persists
that state to `cliproxyapi.json` and restores it on the next start. `/cpa-continue`
and omp's `/resume` release it. The gate parks at request boundaries, so an in-flight
stream finishes before the run stops.

## Behavior notes

- **Wire protocol.** CPA serves every vendor's models over the codex Responses
  protocol, so the provider registers the built-in `openai-codex-responses` API and
  does not ship a custom transport. omp tolerates non-JWT CPA keys, so no source
  patching is needed.
- **Thinking levels.** CPA's `low|medium|high|xhigh|max` map onto omp's effort
  ladder. CPA's `ultra` has no omp equivalent and is dropped.
- **Startup.** A cached catalog is published immediately and refreshed in the
  background, so an unreachable CPA never delays omp's startup. The cache is keyed by
  both the base URL and the inference URL, so changing `baseUrl` invalidates it.
- **Compaction.** omp compacts on its own threshold (`contextWindow − max(15%,
  16384)`); this plugin does not add a second one.

## Differences from the pi version

- No `streamSimple` transport patch and no synthetic `context_length_exceeded`
  preemption — omp owns compaction, and registering a custom API id that delegates to
  pi-ai's own dispatcher recurses until the stack overflows.
- Transient-network-error retry is **not** reimplemented: omp classifies retryable
  errors inside its own stream pipeline, and extension `message_end` / `turn_end`
  handlers are notification-only (their return values are discarded), so the
  upstream normalization hook has no equivalent seam. omp already retries stream
  drops and 5xx/429 responses natively.
- Commands use the `cpa-` namespace: `/cpa-refresh`, `/cpa-fast`, `/cpa-continue`.
- Secrets live in `~/.omp/agent/agent.db`, not `auth.json`.

## Development

```bash
bun install
bun run check      # typecheck + unit tests
```

Verify against a live deployment:

```bash
omp --no-extensions -e ./extensions/index.ts -e ./extensions/tps.ts \
  -p "Reply with exactly: OK" --model cliproxyapi/gpt-5.6-luna
```

## License

MIT. Portions derived from `@router-for-me/pi-cliproxyapi-provider`, also MIT.

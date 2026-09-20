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

Or drop the package under `~/.omp/agent/plugins/node_modules/` (or point `extensions:`
in `~/.omp/config.yml` at this directory) — `package.json`'s `omp.extensions`
field is the install contract.

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

# omp-cliproxyapi-provider

[oh-my-pi](https://github.com/can1357/oh-my-pi)（`omp`）的 CLIProxyAPI 动态模型 provider。

本项目是 [`@router-for-me/pi-cliproxyapi-provider`](https://github.com/router-for-me/pi-cliproxyapi-provider)
（MIT）向 omp 扩展 API 的移植。它发现你的 CLIProxyAPI（CPA）部署所提供的模型，注册为
provider，并附带 Fast 模式优先级档位、请求暂停、目录刷新，以及耗时/TPS 页脚。

> English README: [README.md](./README.md)

## 功能

| 功能 | 命令 / 行为 |
| --- | --- |
| 动态目录 | 来自 `/v1/models` 的模型注册为 `cliproxyapi/<slug>`；CPA 标记为隐藏的模型会被跳过，价格取自 [models.dev](https://models.dev)。 |
| 登录流程 | `/login CLIProxyAPI` 依次提示 base URL 与 API key，向 models 端点校验，然后持久化并注册。 |
| Fast 模式 | `/cpa-fast [on\|off\|status]` 注入 `service_tier: "priority"` —— 仅对 CPA 目录中确实声明了该档位的模型生效。 |
| 暂停 | `/cpa-continue` 释放 omp 的进程级暂停门控；`/pause`（omp 内置）启用之。两者都会同步到 `cliproxyapi.json`。 |
| 目录刷新 | `/cpa-refresh` 绕过缓存重新拉取目录。 |
| 耗时 / TPS | TUI 在每轮运行期间显示实时 `Elapsed Ns` 页脚，结束后给出 `TPS … tok/s. out …, in …, cache r/w …/…, total …, …s` 结算提示。 |

## 安装

```bash
omp plugin install omp-cliproxyapi-provider
```

也可以手动解包到 `~/.omp/plugins/node_modules/omp-cliproxyapi-provider/`（这正是
`omp plugin install` 的目标目录，注意路径是 `~/.omp/plugins`，**不在** `agent/` 下）。
把 `~/.omp/agent/config.yml` 里的 `extensions:` 指向该包目录同样可行；安装契约始终是
`package.json` 的 `omp.extensions` 字段。

> **Windows 注意**：`omp plugin install` 需要系统 PATH 中存在 `bun` 命令，而 omp 本身
> 不会自动安装它。请先执行 `irm bun.sh/install.ps1 | iex`，**完全关闭再重开**终端，然后
> 用 `bun --version` 确认可用；否则请改用手动解包，并务必在
> `~/.omp/plugins/package.json` 的 `dependencies` 中声明本包，未声明的条目会被静默跳过。

### 安装前：移除已有的 `cliproxyapi` provider

如果 `~/.omp/agent/models.yml` 中已经定义了名为 `cliproxyapi` 的 provider，该静态条目会
与本插件**冲突**。两者占用同一个 provider id，插件的注册会在运行时替换掉静态注册 ——
但静态目录中的模型可能仍以原有传输方式残留，最终得到一个混合状态的 provider。以下是
在一个使用 `api: openai-completions` 的部署上实测的结果：

| 配置 | 注册的 `cliproxyapi` 模型 |
| --- | --- |
| 仅 `models.yml` | 41 个，全部为 `openai-completions` |
| 插件 + `models.yml` | 35 个走 `openai-codex-responses`，**外加 6 个残留的 `openai-completions`** |
| 插件 + 重命名后的 `models.yml` provider | 35 个，全部为 `openai-codex-responses` |

那 6 个残留条目恰好是插件过滤掉的隐藏模型，因此它们既不可用，也不在插件的 Fast 门控与
目录刷新范围之内。

请从 `models.yml` 中删除该 provider，或重命名以避免占用同一 id：

```yaml
providers:
  cliproxyapi-static:      # 已重命名：不再与插件冲突
    baseUrl: https://cpa.example.com/v1
    api: openai-completions
```

插件自身的配置独立于 `models.yml` —— 它读取 `~/.omp/agent/cliproxyapi.json` 与 omp 的
凭据存储。

## 配置

### 交互式

```bash
omp
/login CLIProxyAPI      # 或 /login cliproxyapi
```

依次提示 CPA base URL（默认 `http://127.0.0.1:8317`，或已配置的值）与 API key。密钥输入
是遮蔽的；无法遮蔽输入的宿主会直接拒绝该提示，而不是回显密钥。

凭据存放在 omp 的凭据数据库 `~/.omp/agent/agent.db` 中，因此 `/logout cliproxyapi` 即可
将其移除（这一点与 pi 的 `auth.json` 不同）。

### 非交互式

`~/.omp/agent/cliproxyapi.json`（参见 `cliproxyapi.example.json`）：

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "12345",
  "fast": false,
  "pause": false
}
```

环境变量覆盖，优先级由高到低：

| 变量 | 用途 |
| --- | --- |
| `CLIPROXYAPI_BASE_URL` | CPA base URL。 |
| `CLIPROXYAPI_API_KEY` | 请求所用的环境密钥。 |
| `CLIPROXYAPI_FAST` | `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`。 |
| `CLIPROXYAPI_PROVIDER_ID` / `CLIPROXYAPI_PROVIDER_NAME` | 覆盖 provider id / 显示名。 |
| `CLIPROXYAPI_CLIENT_VERSION` | 发送给 `/v1/models` 的 `client_version`（默认 `omp`），用于拒绝该值的部署。 |

`baseUrl` 接受 `host:port`、`http(s)://host:port`、`…/v1`、`…/backend-api` 等形式；所有
形式都会归一化为 `…/backend-api/` 推理根路径，模型目录位于 `…/v1/models`。

## 命令

本插件的所有命令都位于 `cpa-` 命名空间下。原因是 omp 会静默跳过与内置命令同名的扩展
命令（内置命令约 90 个，其中包含 `fast`、`pause`、`login`、`logout`、`model`、
`compact`、`resume`、`retry`）。

| 命令 | 说明 |
| --- | --- |
| `/cpa-refresh` | 从远端目录强制刷新模型列表。 |
| `/cpa-fast [on\|off\|status]` | 切换受目录门控的 Fast 模式。 |
| `/cpa-continue` | 释放被暂停的请求。 |

### Fast 模式、`/fast` 与 `/cpa-fast`

omp 自带的 `/fast` 会为 omp 分类器判定为 OpenAI 的模型设置 `service_tier`。本插件的
`/cpa-fast` 则以 **CPA 目录** 为门控依据，差异体现在两点：

- omp 未判定为 OpenAI 的 CPA id（如 `hy4-preview`、`doubao-*`）依然可以启用 Fast。
- omp *确实*判定为 OpenAI、但 CPA 报告无任何 service tier 的 id（如 `gpt-5.6-*`、
  `gpt-6-astra`）会被正确地**拒绝**。

两者最终在协议层发送的都是同一个 `service_tier: "priority"`，因此在 omp 分类器与 CPA
目录判断一致的情况下，用哪个命令都可以。

### 暂停

`/pause`（omp 内置）会冻结进程内所有 agent loop；本插件把该状态持久化到
`cliproxyapi.json`，并在下次启动时恢复。`/cpa-continue` 与 omp 的 `/resume` 均可释放它。
门控在请求边界处停靠，因此正在进行的流式响应会先完成，运行才会停下。

## 行为说明

- **线协议。** CPA 通过 codex Responses 协议提供所有厂商的模型，因此本 provider 直接
  注册内置的 `openai-codex-responses` API，不自带传输层。omp 能容忍非 JWT 的 CPA 密钥，
  所以无需给依赖打补丁。
- **思考等级。** CPA 的 `low|medium|high|xhigh|max` 映射到 omp 的 effort 阶梯；CPA 的
  `ultra` 在 omp 中没有对应档位，会被丢弃。
- **启动。** 缓存的目录会立即发布，并在后台刷新，因此 CPA 不可达时不会拖慢 omp 启动。
  缓存同时以 base URL 与推理 URL 为键，所以更改 `baseUrl` 会使其失效。
- **压缩。** omp 使用自身的阈值进行上下文压缩（`contextWindow − max(15%, 16384)`），
  本插件不会再加一套。

## 与 pi 版本的差异

- 不带 `streamSimple` 传输层补丁，也不再用合成的 `context_length_exceeded` 抢占压缩 ——
  omp 自行掌管压缩；而以自定义 API id 注册一个转发回 pi-ai 自身分发器的 `streamSimple`
  会无限递归直至爆栈。
- **未**重新实现瞬时网络错误重试：omp 在自己流式管道内部完成可重试错误的分类，且扩展的
  `message_end` / `turn_end` 处理器是纯通知（返回值会被丢弃），上游的归一化钩子在此没有
  等价接缝。omp 本身已原生重试流中断与 5xx/429 响应。
- 命令统一使用 `cpa-` 命名空间：`/cpa-refresh`、`/cpa-fast`、`/cpa-continue`。
- 密钥存放于 `~/.omp/agent/agent.db`，而非 `auth.json`。

## 开发

```bash
bun install
bun run check      # 类型检查 + 单元测试
```

对真实部署进行验证：

```bash
omp --no-extensions -e ./extensions/index.ts -e ./extensions/tps.ts \
  -p "Reply with exactly: OK" --model cliproxyapi/gpt-5.6-luna
```

## 发布

推送 `v*` tag 触发 GitHub Actions 全自动发布：类型检查与测试、校验 tag 与
`package.json` 版本一致、校验该版本尚未发布，随后通过 npm 可信发布（OIDC，无需任何
长期密钥）发布并附带 provenance，最后创建 GitHub Release 并附带同一份 tarball。

```bash
npm version patch      # 或 minor / major
git push --follow-tags
```

本包以**源码形式**分发（`extensions/*.ts`，无编译产物）：omp 是 Bun 运行时，直接加载
TypeScript，因此不需要构建步骤，也不需要按架构区分产物。

## 许可证

MIT。部分内容派生自 `@router-for-me/pi-cliproxyapi-provider`，同为 MIT。

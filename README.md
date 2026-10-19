# opencode-agy-guard

[![tests](https://github.com/hdzw1155/opencode-agy-guard/actions/workflows/test.yml/badge.svg)](https://github.com/hdzw1155/opencode-agy-guard/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把本机 `agy`（Google Antigravity CLI）接入 OpenCode V2：底座来自 `dsh-agy-safe` 的 agy CLI 接入方式，核心是**作者独立设计的限流器**（与 4–5 个 AI 协作实现）。

> **English:** A local OpenCode V2 plugin that exposes your own `agy` CLI as a helper tool. The agy CLI adapter is based on `dsh-agy-safe`; the rate limiter is the author's original design, built in collaboration with several AIs. Not a model provider, and not affiliated with Google, Antigravity, or OpenCode. Built with AI assistance; review the code before trusting it. Use at your own risk.

> **免责声明：** 非官方项目，与 Google / Antigravity / OpenCode 均无关。它只调用你本机安装的 `agy`，不代替登录、不绕过配额和风控，也不代理或转售 Google AI 服务——每个使用者运行自己的 `agy` 和自己的账号。你需要自己的可用账号和网络环境，并自行承担 Google 服务条款、账号风控与本机权限风险。默认 `yolo: true` 会传 `--dangerously-skip-permissions`，agy 能读写 `dir` 里的文件、执行命令；建议只做只读或低风险任务。限流器降低频率风险，但不构成任何账号安全保证。

> **AI 声明：** 本项目由人类提出需求、定义边界、设计限流规则并做最终验收；代码、测试和文档主要由 AI（OpenCode 智能体 / DeepSeek V4.1 Flash）编写。限流器的方案来自作者本人，AI 负责协助实现与测试。请在依赖它之前自行审阅代码，重点看 `src/guard.js`（限流逻辑）和 `src/runner.js`（怎么调用 agy）。

它**不是**模型提供商：不会出现在 OpenCode 的模型选择器里。它注册 `agy` / `agy_status` 两个工具和 `/agy`、`/agy-status` 两个命令，让主模型或子代理按需把任务交给本机 `agy`。

## 这个项目的构成

| 部分 | 来源 |
| --- | --- |
| agy CLI 接入底座（`stream-json` / NDJSON / host tool 协议思路） | **[dsh-agy-safe](https://github.com/Jonah-Wu23/dsh-agy-safe)**（MIT） |
| **限流器设计**：1 并发、≥1.5s 间隔 + 抖动、10 次/60s 滑动窗口、500 次/日、连续失败或 429 熔断、半开探测、排队超时 | **作者原创**，与 4–5 个 AI 协作实现 |
| OpenCode V2 工具/命令适配、模型自动同步、`agy_status`、超时/传输重试、测试与 CI | 本项目 |

`dsh-agy-safe` 只提供底座，上游**没有**限流器。限流器最初是作者的 DSH 个人补丁，本项目把它移植到 OpenCode，并重写、修正了半开探测泄漏、UTC 日期、非原子写入等问题。

## 特性

- **限流器（本项目核心）**：作者原创设计——进程级串行 + 最小间隔 + 滑动窗口 + 每日上限 + 熔断/半开 + 排队超时，降低触发 429 / 风控的概率。
- **工具形态，不是 provider**：不注册模型、不接管对话、不丢工具历史；agy 只负责你交给它的那一段任务。
- **本地 CLI**：直接调用本机 `agy` 的 headless `stream-json` 协议，不经过任何第三方 HTTP 服务。
- **模型自动同步**：启动时从 `agy models` 拉取当前模型列表，支持友好别名和原始 ID。
- **可观测**：`agy_status` 查看状态、`reset` 清除熔断；超时/传输失败自动重试一次。
- **零依赖**：纯 ESM JavaScript + Node 内置模块，`npm test` 即可跑测试。

## 底座与设计取舍

`dsh-agy-safe` 提供的是 agy CLI 的接入底座。OpenCode V2 没有等价的“进程内自定义 provider + 宿主工具回调”插件 API；现有的 `@ichisay/opencode-agy-plugin` 是 V1 的 AI SDK provider，会把 OpenCode 的工具历史丢掉，而且每次调用都跳过权限，不适合直接搬到 V2。

所以本项目保留底座、换成更窄的形态：**把 agy 当成一个独立的 helper/subagent 工具**，工具执行和权限由 OpenCode 自己负责，把主要精力放在作者原创的限流器和 OpenCode V2 适配上。

## 环境要求

- OpenCode V2（在 v2.0.32 上测试）；
- Node.js >= 20；
- 已登录、可用的 `agy` CLI（在 1.4.2 上测试）；
- 能正常访问 Antigravity 的网络环境。

## 安装

1. 确认 `agy` 在 PATH 中，或设置 `AGY_PATH`：

   ```powershell
   Get-Command agy
   # 可选
   $env:AGY_PATH = (Get-Command agy).Source
   ```

2. 克隆本仓库到任意目录，然后在 `%USERPROFILE%\.config\opencode\opencode.json` 的 `plugins` 数组里加入该目录的绝对路径：

   ```json
   {
     "plugins": [
       "file:///<仓库绝对路径>"
     ]
   }
   ```

   - 目录里必须包含 `server.js`（本仓库已提供）；OpenCode V2 对目录插件先找 `server`，再找 `index`。
   - 不要写成 `src/index.js` 的文件 URL，配置层会拒绝文件路径。
   - Windows 路径里的空格要写成 `%20`，例如 `file:///D:/My%20Plugins/opencode-agy-guard`。

3. 重启 OpenCode Desktop，或执行 `opencode reload`。

4. 验证：本地目录插件不一定出现在 `opencode plugin list` 里，以会话中能否调用为准：

   ```text
   /agy 用一句话解释这个仓库的目录结构
   ```

   或者让模型调用 `agy` 工具；也可以输入 `/agy-status`，能返回限流器状态即加载成功。

## 工具参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `prompt` | 必填 | 自包含任务；agy 看不到当前对话 |
| `tier` | `flash-3.8-med` | 友好别名或 agy 模型 ID；启动时从 `agy models` 自动同步。别名包括 `flash-3.8`（等于 `flash-3.8-med`）、`flash-3.8-hi/med/lo`、`sonnet-4.6`、`opus-4.6-thinking`、`gpt-oss-120b` |
| `model` | — | 精确覆盖 agy 模型 ID 或显示名，优先级高于 `tier` |
| `dir` | 当前项目 | agy 的工作目录 |
| `timeout` | `15m` | `90s` / `15m` / `900000ms`，最大 4h |
| `yolo` | `true` | 是否传 `--dangerously-skip-permissions`；headless 环境无 TTY，默认开启 |
| `sandbox` | `false` | 是否传 `--sandbox` |
| `project` | — | 可选 `--project` |
| `continue` | `false` | 继续最近的 agy 会话 |
| `conversation` | — | 恢复指定 conversation ID |

## 模型自动同步

插件加载时会在后台执行 `agy models`，把当前模型列表缓存起来，并用它生成 `agy` 工具的 `tier` / `model` 说明：

- 每 30 分钟最多同步一次；失败后 5 分钟内不重试，保留上一次成功列表；
- `agy models` 退出码是 1 时也照样解析 stdout（agy 的已知行为）；
- 同步失败则退回内置的 6 个已知模型，不影响工具使用；
- `tier` 同时接受友好别名（`flash-3.8-med` 等）和 agy 原始模型 ID，`model` 直接透传 ID 或显示名；
- 解析发生在每次工具调用前，所以新模型无需重启 OpenCode 就能通过 `model` / `tier` 使用；工具说明里的清单会在插件重新加载后刷新。

## 限流器（降低风控 / 429 风险）

所有调用（工具和 `/agy` 命令）都经过同一个进程级 `RequestGuard`。规则全部来自作者的设计：

- 同一时刻只允许 1 个 agy 进程；
- 两次启动至少间隔 1.5 秒，再加 0–500ms 抖动；
- 60 秒滑动窗口最多 10 次启动；
- 每天最多 500 次，按**本地日期**重置；
- 连续 4 次失败，或出现 429/quota/rate-limit，立即熔断 5 分钟；
- 熔断结束后只放一个半开探测，成功才恢复；
- 排队超过 120 秒会失败，不会无限堆积。

状态保存在：

```text
%USERPROFILE%\.local\share\opencode\agy-guard-state.json
```

环境变量可覆盖：

| 变量 | 默认 |
| --- | --- |
| `AGY_GUARD_ENABLED` | `true` |
| `AGY_GUARD_STATE` | 上面的状态文件 |
| `AGY_GUARD_MIN_INTERVAL_MS` | `1500` |
| `AGY_GUARD_JITTER_MS` | `500` |
| `AGY_GUARD_WINDOW_MS` | `60000` |
| `AGY_GUARD_MAX_PER_WINDOW` | `10` |
| `AGY_GUARD_BREAKER_THRESHOLD` | `4` |
| `AGY_GUARD_BREAKER_COOLDOWN_MS` | `300000` |
| `AGY_GUARD_DAILY_CAP` | `500` |
| `AGY_GUARD_QUEUE_TIMEOUT_MS` | `120000` |

## 失败重试

对应 dsh 的 `retryPolicy: { mode: "normal", maxRetries: 1, retryableCodes: ["TIMEOUT","TRANSPORT"] }`：

- 只有超时和进程启动/传输失败会再试 1 次；429、地区限制、认证失败、模型错误、空响应都不会重试；
- 每次重试同样经过限流器，所以会正常排队、计间隔和计每日次数；
- 用 `AGY_RETRY_ATTEMPTS` 调整额外次数（0–3，默认 1），或单次调用时传 `retryAttempts`。

## 检查 / 重置限流器

`agy_status` 工具（或 `/agy-status` 命令）用来查看当前状态：

- `action: "status"`：显示熔断器、队列、滑动窗口、每日用量、错误连击、模型来源和状态文件路径；
- `action: "reset"`：立即清掉已经跳闸的熔断器和错误连击，不用重启 OpenCode。它**不会**绕过每日上限和滑动窗口。

典型用法：熔断跳闸后先看看 `agy_status`，确认不是持续 429，再 `reset` 继续。

## 安全说明

限流器不是安全沙箱。`yolo` 默认开启，agy 可以读写 `dir` 里的文件、执行命令。建议：

- 优先让它做只读分析；
- 不要传 API key、密码、token；
- 需要限制终端操作时设置 `sandbox: true`；
- 不要把 `agy` 设成主模型，只当作 helper/subagent；
- 系统级 VPN 负责出口 IP，插件不会自行切节点。

`agy` 的 `--dangerously-skip-permissions` 仍然意味着它拥有本机工具权限。

## 目录结构

```text
server.js       OpenCode V2 本地插件入口
src/index.js    插件定义、工具与命令注册
src/runner.js   agy 调用、参数构建、NDJSON 解析、错误分类、重试
src/guard.js    进程级限流器（作者原创设计）
src/models.js   模型列表同步与别名
src/env.js      传给 agy 的环境变量过滤
test/           node --test 测试
```

## 开发与测试

```powershell
npm test        # 等价于 node --test
```

测试覆盖串行化、最小间隔、滑动窗口、每日上限、熔断/半开、排队取消、状态持久化、超时/传输重试、状态工具与重置、模型同步/解析、参数构建、NDJSON 解析和工具注册。

## 底座与致谢

- **底座**：[Jonah-Wu23/dsh-agy-safe](https://github.com/Jonah-Wu23/dsh-agy-safe)（MIT）——agy CLI 接入方式、`stream-json` / NDJSON / host tool 协议思路。它只提供底座，上游没有限流器。
- **限流器（本项目核心）**：由作者原创设计，并与 4–5 个 AI 协作编写。1 并发、最小间隔 + 抖动、滑动窗口、每日上限、熔断/半开、排队超时等全部规则都来自作者的方案。最初用于作者的 DSH 个人补丁，本项目移植到 OpenCode 并做了修正与重写。
- **OpenCode V2 注册写法**：参考 [chigarow/antigravity-for-opencode](https://github.com/chigarow/antigravity-for-opencode)（MIT）。
- 本项目不是 fork，没有从上述项目复制粘贴代码。

### 同类项目

| 路线 | 项目 | 与本项目的区别 |
| --- | --- | --- |
| OAuth provider | [NoeFabris/opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth)、[shekohex/opencode-google-antigravity-auth](https://github.com/shekohex/opencode-google-antigravity-auth) | 登录后直接消耗 Antigravity 配额，支持多账号轮换；本项目只用本机已登录的 `agy` CLI |
| Provider bridge | [raultov/opencode-agy-bridge](https://github.com/raultov/opencode-agy-bridge)、[berndof/opencode-agy-bridge](https://github.com/berndof/opencode-agy-bridge) | 把 agy 当成模型路由；本项目不注册模型，避免工具历史丢失 |
| 本地 HTTP 桥 | [batteryshark/opencode-agy](https://github.com/batteryshark/opencode-agy) | 需要额外维护一个 HTTP 服务；本项目只做本地 CLI 工具 |
| 委派 / 子代理 | [chigarow/antigravity-for-opencode](https://github.com/chigarow/antigravity-for-opencode)、[DanielHetz/opencode-agy-delegate](https://github.com/DanielHetz/opencode-agy-delegate)、[kazimshah39/opencode-agy-subagent](https://github.com/kazimshah39/opencode-agy-subagent)、[louisfghbvc/opencode-agy-skill](https://github.com/louisfghbvc/opencode-agy-skill) | 形态最接近；本项目走 `stream-json`，并带作者原创的限流器 |
| 多账号 / 配额管理 | [zcop/agy-cli-manager](https://github.com/zcop/agy-cli-manager) | 管账号和配额；本项目管单账号的调用频率，可以配合使用 |
| 同名但无关 | [zyekhabdul/agy-guard](https://github.com/zyekhabdul/agy-guard) | Python 项目，和本仓库没有关系 |

本项目是独立实现，不是 fork；底座思路来自 `dsh-agy-safe`，限流器为作者原创，其余为本项目自行实现。

## License

[MIT](LICENSE)

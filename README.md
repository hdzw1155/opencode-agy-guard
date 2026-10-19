# opencode-agy-guard

OpenCode V2 的本地 `agy` 助手，按 `dsh-agy-safe` 的 CLI 方式工作，并加了一层防封号限流器。

> **English:** A local OpenCode V2 plugin that exposes your own `agy` CLI as a helper tool, with a polite rate limiter (1 concurrent, ≥1.5s spacing, 10/min, 500/day, circuit breaker). Not a provider, and not affiliated with Google, Antigravity, or OpenCode. Use at your own risk.
>
> **免责声明：** 非官方项目，与 Google / Antigravity / OpenCode 均无关。它只调用你本机安装的 `agy`，不代替登录、不绕过配额和风控。你需要自己的可用账号和网络环境，并自行承担 Google 服务条款、账号风控与本机权限风险。默认 `yolo: true` 会传 `--dangerously-skip-permissions`，agy 能读写 `dir` 里的文件、执行命令；建议只做只读或低风险任务。限流器降低频率风险，但不构成任何账号安全保证。

它**不是**模型提供商：不会出现在 OpenCode 的模型选择器里。它注册 `agy` / `agy_status` 两个工具和 `/agy`、`/agy-status` 两个命令，让主模型或子代理按需把任务交给本机 `agy`。

## 为什么不做成 provider

`dsh-agy-safe` 的价值是它注入宿主的工具协议，让 `agy` 通过宿主执行工具。OpenCode V2 没有等价的“自定义进程内 provider + 宿主工具回调”插件 API；现有 `@ichisay/opencode-agy-plugin` 是 V1 的 AI SDK provider，会把 OpenCode 的工具历史丢掉，而且每次调用都 `--dangerously-skip-permissions`，不适合直接搬到 V2。

所以这里采用更窄、更安全的形态：**把 agy 当成一个独立的 helper/subagent 工具**。工具由 OpenCode 自己执行，agy 只负责它擅长的那一段任务。

## 安装

1. 确认 `agy` 在 PATH 中，或设置 `AGY_PATH`：

   ```powershell
   Get-Command agy
   # 可选
   $env:AGY_PATH = (Get-Command agy).Source
   ```

2. 在 `%USERPROFILE%\.config\opencode\opencode.json` 的 `plugins` 数组加入本地路径：

   ```json
   {
     "plugins": [
       "opencode2-tasks",
       "opencode-dir-tree-tui@1.0.6",
       "opencode-plugin-browser@1.0.0-alpha.6",
       "billion-context",
       "file:///<工作区路径>/opencode/agy-guard"
     ]
   }
   ```

   目录里必须有一个 `server.js` 入口（本仓库已包含）。OpenCode V2 对配置里的**目录**插件会先找 `server`，再找 `index`；不要改成 `src/index.js` 文件 URL，配置层会拒绝文件路径。

   > 把 `<工作区路径>` 换成实际路径。这是本机全局配置，OpenCode 需要绝对路径；项目代码和文档里不要写死具体工作区路径。

3. 重启 OpenCode Desktop，或执行 `opencode reload`。

4. 验证。本地目录插件不一定出现在 `opencode plugin list` 里，以会话中能否调用为准：

   重启 Desktop 后，在新会话里直接输入：

   ```text
   /agy 用一句话解释这个仓库的目录结构
   ```

   或者让模型调用 `agy` 工具。工具调用返回文本即加载成功。也可以输入 `/agy-status`，能返回限流器状态即加载成功。

## 工具参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `prompt` | 必填 | 自包含任务；agy 看不到当前对话 |
| `tier` | `flash-3.8-med` | 友好别名或 agy 模型 ID；启动时从 `agy models` 自动同步。别名包括 `flash-3.8`（等于 `flash-3.8-med`）、`flash-3.8-hi/med/lo`、`sonnet-4.6`、`opus-4.6-thinking`、`gpt-oss-120b` |
| `model` | — | 精确覆盖 agy 模型 ID 或显示名，优先级高于 `tier` |
| `dir` | 当前项目 | agy 的工作目录 |
| `timeout` | `15m` | `90s` / `15m` / `900000ms`，最大 4h |
| `yolo` | `true` | 是否传 `--dangerously-skip-permissions`，与 dsh-agy-safe 一致 |
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

## 防封号限流器

所有调用（工具和 `/agy` 命令）都经过同一个进程级 `RequestGuard`：

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

`agy` 的 `--dangerously-skip-permissions` 仍然意味着它拥有本机工具权限；这一点与 dsh-agy-safe 相同。

## 测试

```powershell
cd opencode\agy-guard   # 从工作区根目录进入
node --test
```

测试覆盖串行化、最小间隔、滑动窗口、每日上限、熔断/半开、排队取消、状态持久化、超时/传输重试、状态工具与重置、模型同步/解析、参数构建、NDJSON 解析和工具注册。

# Changelog

## 0.2.0 — 2026-10-20

- 限流器升级为跨进程全局串行：原子 `mkdir` 文件锁 + 心跳 + 超时接管；同一状态文件下，Desktop / TUI / 多终端同时只有一个 agy 进程。
- 新增本地等待队列上限 `AGY_GUARD_MAX_QUEUE`（默认 4），满时快速失败 `AGY_GUARD_QUEUE_FULL`。
- 每日计数 / 滑动窗口 / 熔断状态改为锁内重新读取，跨进程共享；`agy_status` 显示队列上限与锁模式。
- 新增 `src/lock.js`、`src/util.js`，以及锁、队列上限、共享状态测试（40 项）。

## 0.1.0 — 2026-10-19

- 首个版本：OpenCode V2 本地 `agy` 助手，注册 `agy` 工具和 `/agy` 命令。
- 防封号限流器：全局串行、最小间隔 + 抖动、滑窗、每日上限、失败熔断与半开探测。
- 使用 dsh 的 `--input-format stream-json --output-format stream-json` 单次调用协议。
- 模型列表启动时从 `agy models` 自动同步，失败时回退到内置 6 个模型。
- `agy_status` 工具和 `/agy-status` 命令：查看状态、重置熔断器。
- 超时 / 传输失败自动重试 1 次（对应 dsh 的 `TIMEOUT`/`TRANSPORT` 策略）。

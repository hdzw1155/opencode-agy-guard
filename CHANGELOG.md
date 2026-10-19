# Changelog

## 0.1.0 — 2026-10-19

- 首个版本：OpenCode V2 本地 `agy` 助手，注册 `agy` 工具和 `/agy` 命令。
- 防封号限流器：全局串行、最小间隔 + 抖动、滑窗、每日上限、失败熔断与半开探测。
- 使用 dsh 的 `--input-format stream-json --output-format stream-json` 单次调用协议。
- 模型列表启动时从 `agy models` 自动同步，失败时回退到内置 6 个模型。
- `agy_status` 工具和 `/agy-status` 命令：查看状态、重置熔断器。
- 超时 / 传输失败自动重试 1 次（对应 dsh 的 `TIMEOUT`/`TRANSPORT` 策略）。

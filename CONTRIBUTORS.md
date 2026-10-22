# 贡献者与致谢

## 作者

- **jimku233**（GitHub）—— 设计、实现与维护

## 第三方代码

**无。** 本包零运行时依赖，没有 vendor 任何代码，只用 Node.js 内建模块：
`node:fs` / `node:os` / `node:path` / `node:url`。

判定规则是阅读 `@deepseek-ai/dsh-workspace-changes` 的源码与 README 推导出来的
（它的目录怎么建、什么时候删、为什么磁盘上查不到 owner），但**没有任何一行代码来自该包**。

## 参与测试与反馈

真实会话试跑、误删风险评估、跨 Host 场景验证都欢迎。提出 issue 或 PR 时请附上：

- 你的 `last-run.json`（其中只有随机目录名、体积、判定原因与错误串）；
- 当时用的是默认配置还是自定义 `patterns` / `maxIdleHours` / `protectMinutes`。

提交前请跑 `node --test tests/` 与 `node tools/check-release.mjs`。
不接受放宽删除范围的改动 —— 清单见 [SECURITY.md](SECURITY.md)。

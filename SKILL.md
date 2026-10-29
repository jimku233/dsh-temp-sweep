---
name: dsh-temp-sweep
description: 安装、验证或卸载 dsh-temp-sweep —— 一个 DSH Host 插件，在宿主启动时自动回收「属于已死进程」的会话快照残留目录（dsh-workspace-changes-*），解决 C 盘被 Temp 吃满的问题。当用户要求「根治 DSH 残留 / 自动清理 / 别再手动跑脚本」时使用。
whenToUse: 用户想把 DSH 快照残留清理自动化、询问插件安装/验证/卸载、或需要一个不依赖手工执行的根治方案时使用；只想临时清一次目录时用 dsh-temp-doctor 技能即可。
---

# dsh-temp-sweep

一个 Host 插件（无 UI、无路由、无运行时依赖），在 `dsh` 启动时清掉属于已死 Host 进程的
会话快照目录，并按间隔继续清扫。

## 它解决什么

`@deepseek-ai/dsh-workspace-changes` 每个会话首轮把工作区里「未跟踪且未被 .gitignore 排除」
的文件整份写成 git 对象，落在 `%TEMP%\dsh-workspace-changes-<码>\`；目录只在
`session/disposed` 时删除。Host 崩溃、被杀、重启 → 目录永久留存 → 可累积数十 GB。

本插件用**可证明的判据**清理它：目录创建时间早于所有存活 Host 的启动时间 ⇒ 不可能有活进程
拥有它 ⇒ 删。第二个更宽的条件是「闲置超过 maxIdleHours」。两条都要求目录静默超过保护窗口。

## 什么时候用它，什么时候不用

- 用户要「一劳永逸 / 自动化 / 别再手动跑脚本」→ 用本插件。
- 用户只想现在清一次、或不想装东西 → 用 `dsh-temp-doctor` 技能的 PowerShell 脚本。
- 用户的痛点是「每个会话都要复制 950 MB」→ 插件治不了，要改 `.gitignore` 或把大文件移出工作区，
  根治需上游加共享对象池。

## 安装前必须确认

- Node 22.19+；DSH 0.2.0-rc.2 与 0.2.1-rc.3（Electron 版）均已实测可用。
- 目标 profile 已经启动过一次（`~/.dsh/profiles/<profile>` 存在）。
- **必须在 dsh 沙箱之外执行**：安装写 `~/.dsh/profiles/<profile>`，workspace-write 沙箱会拒绝。
  先向用户说明再动，不要在会话里尝试提权绕过。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

**不要手写 `-Profile`**：脚本自动探测——`profiles\desktop` 存在且含
`@deepseek-ai/dsh-web-app`（Electron 版）就用 `desktop`，否则用 `web`。装错 profile 的表现
是「装完什么都没发生」。

脚本只做三件事：复制包进 profile 的 `node_modules`、把 `dsh-temp-sweep` 加进
`dsh.profile.bundles`（插在带 UI patch 的包之前）、记录安装前 manifest 以便卸载。
它**不改** DSH 安装目录。

`desktop` 由应用独占管理，`dsh --profile desktop --dump-config` 必然报
`managed exclusively` —— 属预期，脚本会识别并提示「完全退出应用再启动」。

装完通常**不需要重启**：`desktop` 需退出应用再启动；`patchReload: live` 的 CLI profile 会在
几秒内加载插件并完成第一次清扫。需要重启的只有两种情况：profile 没有 live reload；或者是在
**升级**已经加载过的旧版本（内存里的旧代码不会被替换）。

不要被「升级前就在跑的 Host 没有标记」吓住：插件写标记时用 `process.uptime()` 反推 Host 的
真实启动时间，所以晚加载也能正确判断「谁在加载前就已经死了」。

## 验证

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
```

检查包与 bundle 行、对真实 temp 根跑只读 dry run、并显示
`<DSH_HOME>/temp-sweep/last-run.json` 里最近一次清扫记录。

单独看规则（不重启）：

```bash
node bin/sweep.mjs          # dry run
node bin/sweep.mjs --json
```

## 配置

让用户改 profile 自己的 `cordis.patch.yml`（`id: temp-sweep`），不要改包内文件，否则升级被覆盖：

```yaml
- id: temp-sweep
  config:
    maxIdleHours: 48
    dryRun: true
```

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1
```

## 边界（不要做）

- 不要用 `--assume-no-host --apply` 在 DSH 还运行时删目录：那会把活会话的快照当死目录。
- 不要把 `patterns` 放宽到 `dsh-*`：会把 `dsh-acl-*`、`dsh-spill-*` 等正在使用的目录卷进来。
- 不要把 `roots` 指到盘根；脚本会拒绝，但不要试图绕过。
- 不要把 `protectMinutes` 调到 0。它防的是「目录刚创建就被判定」的竞态。

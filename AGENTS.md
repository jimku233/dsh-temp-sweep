# AGENTS.md — 给任何 coding agent 的入口

这是一个 DSH **Host 插件**：回收 `@deepseek-ai/dsh-workspace-changes` 留下的会话快照残留。
判定用「创建时间早于所有存活 Host 的启动时间」这种可证明的条件，而不是猜闲置时长。

先读 [`SKILL.md`](SKILL.md)（技能定义：`name` / `description` / `whenToUse` + 用法 + 边界）。
本文件只给不认 `SKILL.md` 的 agent 指路。

## 你要做什么

用户说「C 盘被 Temp 吃满 / 自动清理 / 别再手动跑脚本 / 根治残留」时：

1. **先确认是不是这个问题**：`%TEMP%` 下有多个 `dsh-workspace-changes-<6位码>` 目录，
   每个只有 `objects\xx\<40位sha1>`。不是这个形态就别动 —— 见 README「它治什么」。
2. **只读预检**：`node bin/sweep.mjs`（默认 dry run，不删任何东西）。
3. **安装**：`powershell -ExecutionPolicy Bypass -File scripts/install.ps1`。
   写 `~/.dsh/profiles/<profile>`，**必须在 dsh 沙箱之外执行**；`patchReload: live` 的 profile
   会即时生效，其余需重启。
4. **验证**：`scripts/verify.ps1`；或看 `<DSH_HOME>/temp-sweep/last-run.json`。

## 不要做的事（硬约束）

- **不要读文件内容**。判定只用 `stat`/`lstat` 元数据；加任何「打开文件看一眼」的逻辑都不接受。
- **不要放宽删除范围**：只处理配置根的直接子目录，且名字必须匹配 `dsh-<family>-*`。
  `safePatterns` / `safeRoots` 是护栏，不许绕。
- **不要跟随 junction / symlink**。目录里的链接一律不下降。
- **不要加运行时依赖或联网**。只用 `node:` 内建模块；`dependencies` 必须保持为空。
- **不要在 `protectMinutes` 窗口内删任何东西**，也不要把默认值调成 0。
- **不要用 `git add -A` / `git add .`**。这个仓库曾经因为 `-A` 把本机路径带进公开提交。
  规矩：先 `git status` 看未跟踪文件，再 `git add <具体文件>`。

## 改完必须自证

```bash
node --test tests/                 # 34 例（Node 22+）
node tools/check-release.mjs       # 四道门：生成物 / 敏感串（含全历史）/ 版本一致 / 测试
```

- 沙箱里 `node --test` 可能因禁止子进程管道而失败，改跑 `node tests/sweep.test.mjs` 等单文件。
- `check-release.mjs` 需要能调用 `git`，请在普通终端或 CI 里跑。
- 改规则必须同时改 `tests/sweep.test.mjs` 里的边界用例；改配置必须同步 README 两张表与
  README.en.md。

## 版本号

`package.json` 与 `CHANGELOG.md` 最新一节必须同号，`check-release.mjs` 守这一层。

## 仓库结构

```
dsh-temp-sweep/               ← 仓库根
├── SKILL.md                  # 技能定义（frontmatter + 用法 + 边界）
├── AGENTS.md                 # 本文件
├── README.md                 # 中文说明（安装 / 配置 / 安全与隐私）
├── README.en.md              # 英文版（与中文版对应）
├── CONTRIBUTORS.md
├── CHANGELOG.md
├── SECURITY.md               # 触碰范围 / 护栏 / 威胁模型边界
├── LICENSE                   # MIT
├── lib/
│   ├── index.js              # Cordis 插件：启动扫一次 + 按间隔扫
│   ├── sweep.js              # 判定核心（纯函数，可注入时钟）
│   └── markers.js            # Host 标记：写入 / 读取 / 剪枝
├── bin/sweep.mjs             # CLI：默认 dry run
├── scripts/                  # install / uninstall / verify
├── tests/                    # 34 例
├── tools/check-release.mjs   # 发布前四道门
└── .github/workflows/test.yml
```

## 文档地图

| 文件 | 给谁看 |
|---|---|
| [`SKILL.md`](SKILL.md) | agent：技能定义、用法、边界 |
| [`README.md`](README.md) | 人（中文）：安装、配置、安全与隐私 |
| [`README.en.md`](README.en.md) | 人（英文） |
| [`SECURITY.md`](SECURITY.md) | 安全审查：触碰范围、护栏、威胁模型 |
| [`CHANGELOG.md`](CHANGELOG.md) | 使用者可见的变化 |

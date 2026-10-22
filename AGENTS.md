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
node tools/test.mjs                # 34 例；默认进程内加载，本地/CI/沙箱行为一致
node tools/test.mjs --fork         # 逐文件隔离（`node --test`），只在普通环境可用
node tools/check-release.mjs       # 四道门：生成物 / 敏感串（含全历史）/ 版本一致 / 测试
```

- **不要用 `node --test tests/`**：Node 22/24 会把 `tests` 当模块加载，报 `MODULE_NOT_FOUND`
  —— 2026-10-22 那次推送因此四个 CI job 全红，改用 `tools/test.mjs` 后才绿。
- `tools/test.mjs` 默认在本进程内 import 各测试文件，因为 `node --test` 会 fork 子进程，
  而受限沙箱禁止子进程管道（EPERM）。
- `check-release.mjs` 需要能调用 `git`，请在普通终端或 CI 里跑。
- 改规则必须同时改 `tests/sweep.test.mjs` 里的边界用例；改配置必须同步 README 两张表与
  README.en.md。

## 版本号

`package.json` 与 `CHANGELOG.md` 最新一节必须同号，`check-release.mjs` 守这一层。

## 发布与上传（下次换仓库照这条走）

### 0. 前置：发布门必须先过

```bash
node tools/test.mjs
node tools/check-release.mjs        # 生成物 / 敏感串（含全历史）/ 版本一致 / 测试
```

版本号两处同步：`package.json` 与 `CHANGELOG.md` 最新一节。`check-release.mjs` 会拦。

**连推会被取消。** 工作流带 `concurrency.group: test-${{ github.ref }}` +
`cancel-in-progress: true`：同一 ref 只保留最新一次运行，被取代的停在 `cancelled`。
这不是失败，也不会发告警邮件。因此：

- 只在 **CI 绿的提交** 上打标签与发 Release（`v0.1.2` 打在 `e806770`，就是绿的那个）；
- 快速连推后看到旧运行变灰、结论 `cancelled` 属预期，不是配置写错；
- 取消不是瞬时的：可能挂一两分钟才收敛；已经跑完的作业保留 `success`，其余变 `cancelled`；
- 被取代的提交拿不到完整结论 —— 别对它发版。

### 1. 仓库描述（直接用）

- 英文：`Reclaim DSH Session scratch residue at Host start: deletes dsh-workspace-changes-* directories that provably belong to a dead Host process.`
- 中文：`在 Host 启动时回收 DSH 会话快照残留：只删那些能证明属于已死 Host 进程的 dsh-workspace-changes-* 目录。`

### 2. topics

```
dsh, deepseek-harness, cordis, agent-skills, disk-cleanup, windows, temp-directory, nodejs
```

### 3. public 还是 private

- **默认 public**：与既有仓库（`dsh-copy-file`、`workflow-visualizer`）保持一致。
- **private 只给两种情况**：还没准备好给人看；或内容涉及客户/真实数据。
- **public 是不可撤回的**：提交历史一旦公开，删文件也删不掉历史。所以
  「敏感串含全历史」那道门不能跳 —— 它就是用这个代价换来的。
- 公开前确认：没有本机绝对路径、没有用户名、没有内网 IP、没有 token。本仓库的
  `tools/check-release.mjs` 已把这四类做成一等公民。

### 4. 建仓库 + 推送

`gh` 没装也能做。本机凭证在 Windows 凭据管理器（GCM，`gho_` token），
**不要**把它写进 URL 或提交进任何文件。

```powershell
$env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
Set-Location <仓库目录>

# 建空仓库（已存在会 422，忽略即可）
$cred = ("protocol=https`nhost=github.com`n`n" | git -c http.sslBackend=openssl credential fill 2>$null)
$tok  = ($cred | Select-String '^password=').Line -replace '^password=',''
$hdr  = @{ Authorization = "token $tok"; 'User-Agent' = 'setup'; Accept = 'application/vnd.github+json' }
$body = @{ name='<repo>'; description='<上面那句英文>'; private=$false; has_issues=$true; has_wiki=$false } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' -Headers $hdr -Body $body -ContentType 'application/json'

# 推送
git -c http.sslBackend=openssl push -u origin main

# 标签（需要 committer 身份；只写本仓库，别动全局）
git config user.name '<name>'; git config user.email '<email>'
git tag -f -a v<版本> -m 'v<版本>: <一句话>'
git -c http.sslBackend=openssl push origin v<版本>

# topics（Accept 头要 mercy-preview）
$hdr.Accept = 'application/vnd.github.mercy-preview+json'
Invoke-RestMethod -Method Put -Uri 'https://api.github.com/repos/<owner>/<repo>/topics' -Headers $hdr `
  -Body (@{ names=@('dsh','cordis','disk-cleanup','windows') } | ConvertTo-Json) -ContentType 'application/json'
```

### 5. Release

用 `CHANGELOG.md` 对应小节做 notes，再补一段**实测数字**（没有实测就写“未实测”，别编）：

```powershell
$body = @' ... '@
$payload = @{ tag_name='v<版本>'; name='v<版本> — <一句话>'; body=$body; draft=$false; prerelease=$false } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/<owner>/<repo>/releases' -Headers $hdr -Body $payload -ContentType 'application/json'
```

标签建完才发现内容要补：`git tag -f -a ...` 后 `push --force origin v<版本>`（仅在标签尚未被任何人引用时；
被引用过就发新补丁版本，别改历史）。

### 6. 卡点对照表（这台机器的真实报错）

| 报错 | 原因 | 处理 |
|---|---|---|
| `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` | 默认 TLS 后端在这条链路取不到凭证 | 所有 git 网络命令加 `-c http.sslBackend=openssl` |
| `couldn't create signal pipe, Win32 error 5` | 受限沙箱禁止命名管道，credential helper 的 `sh.exe` 起不来 | 在普通终端跑；或对单条命令临时提权 |
| `could not read Username for 'https://github.com'` | 没有可用凭证且不允交互 | 确认 GCM 里有 github.com 条目；`GCM_INTERACTIVE=never` 时不会弹 GUI |
| `Repository not found`（认证已通） | 仓库还没建（GitHub 对无权限/不存在都回 404） | 先按第 4 步建仓库 |
| `src refspec v0.1.1 does not match any` | 没配 committer 身份，标签没建成 | `git config user.name/email`（本仓库即可）后再打标签 |
| `Committer identity unknown` | 同上（Git 用主机名兜底成 `user@host.(none)`） | 同上 |

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
├── tools/test.mjs            # 可移植测试入口（npm test 走它）
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

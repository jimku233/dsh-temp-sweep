# dsh-temp-sweep

回收 DSH 会话快照残留的 Host 插件。装在 `dsh` 里，Host 启动时自动清理「属于已死进程」的
`dsh-workspace-changes-*` 目录，不用再手动跑脚本、也不用等「今天变昨天」。

```text
[temp-sweep] reclaimed 39.25 GiB from 32 scratch directories (startup); kept 8
```

实测（Windows 11 / DSH 0.2.0-rc.2 / `patchReload: live`）：装完即时生效，第一次清扫把
11 个目录降到 4 个，回收 **7.08 GB**，C 盘可用从 38.8 GB 到 45.9 GB。

## 它治什么，不治什么

| | 内容 | 谁负责 |
|---|---|---|
| ✅ 治 | 崩溃 / 强杀 / 重启留下的会话快照目录（44.9 GB 那类） | **本插件** |
| ✅ 治 | 长跑 Host 里孤儿会话目录慢慢堆积 | **本插件** |
| ❌ 不治 | 每个会话首轮仍会整份复制工作树（每次 ~950 MB 的 IO 与临时占用） | 上游 `dsh-workspace-changes` |
| ❌ 不治 | 会话之间不去重、scratch 目录写死在 `os.tmpdir()` | 上游 |

要压「每会话成本」只能靠 `.gitignore` / 把大文件移出工作区；要真正根治得等上游加
共享对象池与可配置 scratch root。本插件只做一件事：**让残留不累积**。

## 为什么能安全判断「死目录」

上游用 `mkdtemp()` 建目录，名字随机、磁盘上没有任何 owner 标记，所以「这个目录属于哪个进程」
在外部无法直接回答。但有一个问题可以严格回答：

> 这个目录的创建时间，是否早于**当前所有存活 Host** 的启动时间？

如果早于，那么能创建它的进程全部已经结束，**它必然是死目录**。这需要每个 Host 报一次
「我在跑、我是什么时候启动的」——这就是标记文件：

```text
<DSH_HOME>/temp-sweep/hosts/<pid>-<startedAt>.json
```

判定规则因此有两条，强的在前：

| 规则 | 条件 | 依据 |
|---|---|---|
| `dead-owner` | 目录创建时间 < 最早存活 Host 的启动时间 − 时钟偏移 | 不可能有活进程拥有它 |
| `stale` | 目录下任何位置 24 小时（可配）无写入 | 活会话每轮都会写对象，不会静默这么久 |

两条都额外要求目录**静默超过 `protectMinutes`**（默认 10 分钟），所以刚创建、正在写入的目录
永远轮不到。规则只会「少删」，不会「多删」：pid 被复用、标记读不到、`birthtime` 不可用，
都退化为更保守的判定。

## 安装

要求 Node 22.19+、一个已经启动过一次的 profile。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

安装脚本只做三件事：把包复制进 profile 的 `node_modules`、把 `dsh-temp-sweep` 加进
`dsh.profile.bundles`、记录安装前的 manifest 以便卸载还原。**它不改 DSH 安装目录。**
包本身没有运行时依赖（只用 node 内置模块），不需要 npm/pnpm 安装步骤。

> 必须在 dsh 沙箱之外运行：它写的是 `~/.dsh`，workspace-write 沙箱会拒绝。

### 装完是否要重启

看 profile 的 `patchReload`：

- `live`（DSH 默认）：**即时生效，不用重启**。实测在 `patchReload: live` 的 web profile 上，
  安装脚本跑完几秒内插件就加载并完成了第一次清扫（11 个目录 → 4 个，回收 7.08 GB）。
- 其他值：需要重启 Host，新的 bundle 行才会被组合进去。

两点仍然成立，别混：

1. 插件写标记时用的是 `process.uptime()` 反推的 **Host 真实启动时间**，不是加载时间——所以即使
   Host 已经跑了 3 小时才加载插件，判定「谁在插件加载前就死了」依然准确。
2. **升级包本身**（不是首次安装）需要重启：已经加载在内存里的旧代码不会被替换。

## 验证

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
```

它会检查包与 bundle 行、对真实 temp 根跑一次**只读** dry run、并显示 Host 最近一次清扫记录
（`<DSH_HOME>/temp-sweep/last-run.json`）。

## 配置

在 profile 自己的 `cordis.patch.yml` 里覆盖 `id: temp-sweep` 那一行，不要改包内的
`cordis.patch.yml`（升级会覆盖）：

```yaml
- id: temp-sweep
  config:
    maxIdleHours: 48        # 闲置兜底阈值，默认 24
    protectMinutes: 15      # 保护窗口，默认 10
    intervalMinutes: 60     # 周期清扫间隔，默认 60；0 不支持
    dryRun: true            # 只看日志、不真删
    maxDeletePerRun: 50     # 单次删除上限
    patterns:               # 只清这一类目录
      - dsh-workspace-changes-*
    roots:                  # 默认 = TMP/TEMP + %LOCALAPPDATA%\Temp
      - D:\Temp
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉整个插件 |
| `roots` | TMP/TEMP + 平台默认 | 盘根会被拒绝 |
| `patterns` | `dsh-workspace-changes-*` | glob，`*` 与 `?`；必须是 `dsh-<family>-*`，`*` / `dsh-*` 会被拒绝 |
| `maxIdleHours` | `24` | 闲置兜底（1–8760） |
| `protectMinutes` | `10` | 保护窗口（0–1440） |
| `intervalMinutes` | `60` | 周期清扫（1–1440） |
| `maxDeletePerRun` | `50` | 单次上限（1–10000） |
| `dryRun` | `false` | 只记录不删 |
| `sweepOnStart` | `true` | 启动即扫一次 |
| `logWhenClean` | `false` | 没有可回收时也打一条 info（默认只在真删时打） |
| `markerDir` | `<DSH_HOME>/temp-sweep/hosts` | 标记目录 |

## 安全与隐私

这个工具会**删目录**，所以边界要能被逐条复核：

| 承诺 | 实现方式 |
|---|---|
| **不读文件内容** | 只用 `stat`/`lstat` 元数据（大小、mtime、birthtime、条目类型）；不打开、不解析、不哈希、不外传 |
| **不跟随链接** | junction/symlink 一律跳过；目录内的链接不会下降进去，所以指向 `C:\Windows` 的链接无法放大删除范围 |
| **不越界** | 只处理配置根目录的**直接子目录**，且名字必须匹配模式；盘根、共享根被拒绝 |
| **不会变成"清空 Temp"** | `patterns` 必须形如 `dsh-<family>-*`；`*`、`**`、`dsh-*` 被显式拒绝（`safePatterns`） |
| **不会误删活会话** | 双规则 + 保护窗口 + 单次上限；`dead-owner` 规则要求有存活标记作证据，没有标记就退化而不是猜 |
| **不联网、无遥测** | 零运行时依赖，只 import `node:fs`/`node:os`/`node:path`/`node:url` |

本地只写两个文件，都不含机器名、用户名或会话内容：

| 路径 | 内容 |
|---|---|
| `<DSH_HOME>/temp-sweep/hosts/<pid>-<startedAt>.json` | `pid`、`startedAt`、`writtenAt` |
| `<DSH_HOME>/temp-sweep/last-run.json` | 目录名（随机码）、体积、判定原因、错误信息 |

删掉 `<DSH_HOME>/temp-sweep` 就等于清掉全部本地痕迹，代价只是多一次保守判定。

威胁模型边界：能写 `~/.dsh` 的本地进程可以伪造标记、让旧目录被判成无主。那已经等同于
「以当前用户身份执行任意代码」，不在本工具的防护范围内；即便如此，护栏仍把破坏面限制在
「临时根下、匹配 DSH 草稿模式的直接子目录」。请看 [SECURITY.md](SECURITY.md)。

## 命令行

不重启也能看结果，默认只读：

```bash
node bin/sweep.mjs                       # dry run
node bin/sweep.mjs --apply               # 真删
node bin/sweep.mjs --max-idle-hours 168  # 更保守
node bin/sweep.mjs --json                # 机器可读
node bin/sweep.mjs --assume-no-host      # 明确知道没有 Host 在跑时才用
```

`--assume-no-host` 会把「没有存活标记」解释成「没有存活 Host」。默认**不**这么解释，
因为升级前就在跑的 Host 同样没有标记——那会把它的活目录判成死目录。

## 测试

```bash
node tools/test.mjs          # 等价于 npm test
node tools/test.mjs --fork   # 逐文件隔离（走 node --test），仅普通环境可用
```

34 个用例，覆盖两条规则与边界、保护窗口优先级、删除上限、junction 跳过、只读 git 对象、
标记剪枝与坏文件容错、缺失 root、盘根拒绝、catch-all 拒绝、CLI 参数校验。
测试全部在临时目录里造真实树，绝不触碰真实 `%TEMP%`。

> 不要用 `node --test tests/`：Node 22/24 会把 `tests` 当模块加载并报 `MODULE_NOT_FOUND`。
> 统一入口是 `tools/test.mjs`（显式文件列表，默认进程内加载，所以沙箱里也能跑）。

## 已知限制

- **每会话复制成本不变**：这是上游行为，插件只能在事后回收。
- **多 Host 升级窗口**：升级前已在运行的 Host 没有标记，装完请重启全部实例。
- `birthtime` 不可用的文件系统（部分 Linux）上 `dead-owner` 会自动退化为 `stale`。
- 已在 Windows 11 实测；Linux/macOS 未实测，规则本身与平台无关。
- 删除目标必须是临时根的**直接子目录**，不会递归进更深层；junction/symlink 一律跳过。

## 许可

MIT，见 [LICENSE](LICENSE)。

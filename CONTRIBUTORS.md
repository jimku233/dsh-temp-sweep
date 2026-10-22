# Contributors

## 作者

| 角色 | 名字 |
|---|---|
| 设计与实现、发布 | jimku233 |

## 致谢

- **DeepSeek**：`@deepseek-ai/dsh-workspace-changes` 的实现与 README 把「快照怎么写、
  什么时候删」写得很清楚，本插件的判定规则就是照着那份文档与源码推出来的。
- **Cordis**：插件生命周期（`apply(ctx, config)` + `ctx.effect`）足够简单，让一个
  「只在启动和定时做一件事」的插件不必碰任何框架内部。
- **dsh-copy-file**：本仓库的安装三件套（`install` / `uninstall` / `verify`）、MIT + NOTICE
  的写法、以及「不改 DSH 安装目录」的原则，沿用了同一个作者另一个包的工程约定。

## 贡献

欢迎 issue 与 PR。提交前请跑：

```bash
node --test tests/
node tools/check-release.mjs
```

不接受会放宽删除范围的改动 —— 见 [SECURITY.md](SECURITY.md) 末尾的清单。

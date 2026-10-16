# dsh-auto-update 0.1.6

> 这一份就是 GitHub Release 页面（tag `v0.1.6`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版没有改动插件在运行时的行为**（`lib/` 一个字节没动）。它补的是「怎么发布」这件事本身：发布流程、一条能被机器检查的一致性预检、以及更新记录。升级它的风险只在文档与工具上。

## 装 / 升

```
cd <这个仓库的检出目录>
dsh plugin --profile web add "file:$PWD"
```

`file:` 装进去的是**拷贝**，不是链接：改了源码必须 `Remove-Item` 掉 profile 里那份副本再重新 `add`，然后**重启 harness** 才会生效（细节见 README 的「`file:` 装的是副本」）。

## 这一版多了什么

- **`npm run release:check`** —— 发版前的一致性预检，只读不写。它查四件事：版本号是 `x.y.z`、`git status --porcelain` 为空、profile 里那份**副本**的版本与仓库一致、**正在跑**的实例通过 `/auto-update/api/v1/status` 报的 `pluginVersion` 与仓库一致。
  最后两条是这次的重点：`file:` 安装最容易出现的坏状态就是「仓库里改了、副本没换」，此时插件会一直以旧代码运行而**不报任何错**。预检把这件事变成长度为一行的红字：

  ```text
  FAIL  installed copy matches the repo
          C:\Users\…\profiles\web\node_modules\dsh-auto-update → 0.1.5, repo → 0.1.6: re-install (…) and restart before tagging
  ```

  它明确区分三种「没通过」，避免把正常状态当成故障：**没装副本** = 警告（这台机器上本来就没装）、**装了但版本对不上** = 失败、**harness 没在端口上应答** = 跳过。`--json` 给脚本消费，`--profile` / `--port` 换目标。
- **`CHANGELOG.md`** —— 从这一版起，每个版本都在发版当时写一节：用户看得见的变化、验证怎么做的、以及降级/回滚需要知道的事。
- **README 的「Releases」一节** —— 版本号怎么走（只用 `x.y.z`、一次发布一次版本号、`[dsh-auto-update <版本>] <一句话>` 的提交格式、`v` 前缀 tag）、五步发布清单、发布渠道表、以及发出去之后发现不对怎么处置。
- README 还补了两处此前只存在于对话里的坑：`file:` 依赖是拷贝（`pnpm` 按 `files` 字段拷，无 junction 无硬链接，改 `lib/*.js` 不会生效也不报错），以及 profile 里的副本**没有 `test/`**，所以 `npm test` 全绿只说明仓库里的代码是绿的。

## 发布渠道

| 渠道 | 现状 |
| --- | --- |
| GitHub Release（tag `v0.1.6`） | ✅ 唯一渠道。产物就是仓库本身，不额外上传归档 |
| `file:` 装进 profile | ✅ 用户拿到的字节和仓库逐字节相同 |
| npm registry | ❌ 刻意不发 —— 这个插件会无人值守地替宿主做全局安装并重启宿主，放到 npm 上必须先单独设计（scope、`publishConfig`、撤销路径） |

## 验证

- `npm test` → `9/9 test files passed`（本机 Windows，node v24）。整套测试只 import `node:` 内置模块与本仓库文件，没有第三方依赖、没有安装步骤。
- `release:check` 的四条路径（通过 / 失败 / 警告 / 跳过）都用真实状态与构造场景实走过。
- 未重跑 README 里那份 2026-10-15 的真机审计，也未重新打包桌面端 —— 那些结论属于 `0.1.5` 那条时间线。

## 降级 / 回滚

无需降级：`lib/` 未改动，配置键、状态文件形状、助手协议（`lib/protocol.js`）都没有变化，依赖面也没变。退回 `0.1.5` 与这一版的行为完全一致，差别只在文档与 `scripts/release-check.mjs`。

**完整记录**（含 `0.1.5` 的基线）：[`CHANGELOG.md`](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/CHANGELOG.md) · **发布流程**：[README 的「Releases」一节](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/README.md#releases)

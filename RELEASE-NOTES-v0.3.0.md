# dsh-auto-update 0.3.0

> 这一份就是 GitHub Release 页面（tag `v0.3.0`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版让频道可以自己选**：面板上多了 `latest / next / alpha` 的选择器，切换即生效，并且会被记住。

在此之前想从 `next` 换回 `latest`，唯一的路是改 profile 的 `cordis.patch.yml` 再等热重入。一个「自动更新」插件的发布策略要开编辑器才能改 —— 这是设计上的缺口，不是使用习惯问题。

## 装 / 升

```powershell
cd <检出目录>
# 先删旧副本再装：`file:` 依赖是拷贝，不是链接
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-auto-update" -Recurse -Force
dsh plugin --profile web add "file:$PWD"
```

装完**重启一次 harness**（插件是 `import` 进来的模块，热重载不会重读模块图）。

## 你会看到什么变化

打开面板 `http://127.0.0.1:3080/auto-update/`，按钮那一行下面多出「频道 / Channel」：

- `latest（只收正式版）` —— 只接受 npm 的 `latest` 这个 tag
- `next（含预发布）` —— 接受 `{latest, next}` 的并集，所以不会因为待在 next 上漏掉正式版
- `alpha（含内部版）` —— 再加上 `alpha`

选完约 20 秒内自动重新检查一次（下一次 tick 就是重新判定点）。这个选择写进状态文件的 `channelOverride`，**重启后仍然生效**。

如果你后来改了 profile 那一行的 `channel`，以**文件为准**：面板上早先那次点击会被退休（`channelOverride` 归 `null`）。

## 两个容易踩空的地方，这一版都处理了

- **切换会作废旧频道的判断**：`check` 与「等空闲」的 `deferral` 一起清空。否则一个已按 `next` 排队、只因等空闲而推迟的版本，会在你切回 `latest` 之后照样被装上 —— 那是「用户刚说不想要，插件却照旧执行」。
- **`latest` 就是 `stable`**：面板上写 `latest`（用户嘴里的名字），配置里也能写 `latest`；状态文档统一存 `stable`，因为它是「读取 `latest` 这个 dist-tag」的频道名，而不是 tag 本身。

## 它是什么

`dsh-auto-update` 是一个 DSH harness 插件：定时问 npm registry 有没有新的 `@deepseek-ai/dsh`，按频道筛选、按发布年龄过滤，等到 harness 空闲时无人值守地装好并重启，起不来就回滚。它只动**全局安装**的 harness，不碰 profile 里的其他插件，不自动降级，也不在检出目录里装。

## 验证

- **真实路由的用例**（`test/plugin.test.mjs`）：切到 `next` → 状态文件 `channel=next`、`channelOverride=next`、`configuredChannel=stable`、`check=null`；写 `latest` 得到 `stable`（别名）；写 `nightly` 得到 400 且状态不变；重启后仍是 `next`；把 profile 行改成 `alpha` 再启动 → `channel=alpha`、`channelOverride=null`。
- `node test/run.mjs` → `11/11 test files passed`（Windows，node v24）。

## 降级 / 回滚

退回 `0.2.2`：面板不再有选择器，`channel` 回到「只由配置文件决定」；状态文件里多出来的 `channelOverride` / `configuredChannel` 会被旧版本忽略，不影响启动，也不需要手工清理。

**完整记录**：[`CHANGELOG.md`](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/CHANGELOG.md) · **发布流程**：[README 的「Releases」一节](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/README.md#releases)

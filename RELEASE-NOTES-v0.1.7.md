# dsh-auto-update 0.1.7

> 这一份就是 GitHub Release 页面（tag `v0.1.7`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版改了插件在运行时的行为**，是 `0.1.5` 之后第一次改动 `lib/`。修的是一个安静但很吵的缺陷：一条早就结束的升级记录会被**每 20 秒**重新「和解」一次，把同一条 `reconciled: … is superseded` 写进 `update.log`、并重写一次 `state.json` —— 一天约 4300 次。

它不改变任何升级决策：该升还是升、该回滚还是回滚。代价是日志被灌满、真正的线索被埋掉，以及无谓的磁盘写入。

## 装 / 升

```
cd <这个仓库的检出目录>
dsh plugin --profile web add "file:$PWD"
```

`file:` 装进去的是**拷贝**，不是链接：改了源码必须 `Remove-Item` 掉 profile 里那份副本再重新 `add`，然后**重启 harness** 才会生效（细节见 README 的「`file:` 装的是副本」）。

## 你会看到什么变化

- **日志不再被刷屏**。已经灌满的 `update.log` **不会被这一版自动清理** —— 只是不再往上加。要收窄就自己清空该文件，或等日志轮转。
- **进行中的升级照旧能看到进度**：只有记录**尚未**定论时才从 `helper.json` 读回状态，所以面板上的实时进度没有变化。
- **不需要改配置、不需要重装 harness**。`lib/` 换掉并重启后即生效。

## 它是什么

在某个 2026-10-06 就结束的升级里，分离出去的助手进程写出了 `helper.json`（`phase: "failed"`、`target: "0.2.0-rc.2"`）然后退出。那个文件此后**永不改变** —— 它描述的永远是同一次已经结束的运行。而 `0.2.0-rc.2` 恰好就是当时正在跑的版本，于是「验证窗口过期、这条 failed 结论已被取代」这条既有判定被反复套用在同一份原始记录上：

```text
reconciled: 0.2.0-rc.2 is running — the earlier failed verdict for 0.2.0-rc.2 is superseded
```

本机上这条占了 `update.log`（324 KB）的约 45%，成对出现、间隔 10–20 秒。

原因有三层，缺一层都修不掉：

1. `tick()` 里一句 `state.helper = readHelper() ?? state.helper` 把 `reconcile()` 刚写好的结论用原始记录盖了回去；
2. `api.status`（面板轮询的那个读接口）里有**同样的一句**，于是结论在两次 tick 之间被清掉；
3. 用来让和解「只做一次」的守卫锚在上一 tick 的**内存标记**上，而前两层不停把它抹掉，守卫因此从未生效。

修法是让「已经和解过」这个事实来自能跨重启存活的地方（历史记录），并且**在跑的助手仍然照读**、已定论的记录不再被覆盖。

## 验证

- **真实事故记录回放**：把本机那份真实 `helper.json` 在一个报告相同版本号的合成 harness 下回放两次 —— 修复前两次启动分别写出 2 条、3 条（每次开机各加一条），修复后是 1 条、1 条。
- **归因实验**：只去掉 `tick()` 那处重读、保留状态接口那处守卫，缺陷独立复现 —— 证明线上刷屏的主因是 tick 也重读了文件。
- **回归测试**：新增两条用例，都**在未修复的代码上失败、在修复后通过**（用 `git stash push -- lib/index.js` 反证过）。其中一条用**两个独立进程共用一个 `DSH_HOME`**，跑的就是真实的重启场景。
- `npm test` → `9/9 test files passed`（本机 Windows，node v24）。

## 降级 / 回滚

退回 `0.1.6` 即回到「每 20 秒写一条日志」的行为，升级决策不受影响 —— 这个缺陷只产生噪音与写入，不产生错误的安装或回滚。状态文件形状、配置键、助手协议（`lib/protocol.js`）均未变化。

**完整记录**：[`CHANGELOG.md`](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/CHANGELOG.md) · **发布流程**：[README 的「Releases」一节](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/README.md#releases)

# dsh-auto-update 0.5.0

> 这一份就是 GitHub Release 页面（tag `v0.5.0`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版只换面板的样子**，检测、安装、重启、桌面端同步一条链路都没动，`lib/` 里只有 `lib/dashboard.js` 变了。

`0.4.0` 把信息架构理顺了——先回答「现在正常吗」，其余收进折叠区。但它的样子还是「深色卡片 + 一排指标」，挪到任何一台服务器面板上都成立，读完记不住这是谁。这一版换一个站得住的主题：**挂在机箱上的检修标签**。

这类机器在现实里真的会挂一块牌：修完写清谁修的、什么时候、下次什么时候查、结论合不合格。面板现在就是那块牌。

## 装 / 升

```powershell
cd <检出目录>
# 先删旧副本再装：`file:` 依赖是拷贝，不是链接
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-auto-update" -Recurse -Force
dsh plugin --profile web add "file:$PWD"
```

装完**重启一次 harness**（插件是 `import` 进来的模块，热重载不会重读模块图）。

## 你会看到什么变化

打开 `http://127.0.0.1:3080/auto-update/`：

- **一张纸**，不再是深色卡片堆。纸面的纹理、虚线撕口、顶上打出来那个孔和吊线、右下角的红章，全是 CSS 画的，没有一张图片，页面仍是零构建的单文件。
- **当前装载版本成为整页最大的一行**：这是这台机器此刻的身份，比任何指标都该先被看见。
- **结论是一枚橡皮章**：旋转、压色、和纸面相乘。「一切就绪」是常态；要你处理时印章上的字跟着换。
- **底下多了一条签名线**：`检修人 auto-update 自动执行 · 上次成功 01:08`——谁干的、最后一次成功是什么时候。
- **出错时焦点被送到那行错误**，不再是弹个 toast 就没了。
- **升级记录的筛选写进地址栏**：`?outcome=failed&trigger=auto&q=0.2`，筛完能收藏，也能直接发给别人。

深色底和 `theme-color` 没有变（`#0d1117`）：标签就是放在这张深色桌面上的一张纸。

## 它是什么

一个让 DSH harness 自己升级自己的插件：定时问 npm registry 有没有新版本，在**空闲时**无人值守安装、重启、确认新版本健康，失败自动回滚；另外顺带在每次升级后重打包桌面端分发件。频道（`latest` / `next` / `alpha`）可以在面板上直接切。

面板是零构建的单文件 HTML，由插件自己渲染并挂在 `/auto-update/` 下；它只读本机状态文件与 npm registry，不往外发任何数据。

## 验证

- `node test/run.mjs` → `12/12 test files passed`；`test/dashboard.test.mjs` 仍是 15 条用例。
- 用运行中实例的 `/auto-update/api/v1/status` 渲染同一份 `renderDashboard()`，Edge 无头按 1000px 与 520px 截图核对：两档都没有页面级横向滚动条（表格在自己的容器里滚），窄屏时红章落到标题下面、字段改成一列。
- 内联脚本整段取出跑 `node --check`：语法通过。这一页的交互全在那段脚本里，语法错误会静默毁掉整页行为。

## 降级 / 回滚

退回 `0.4.0` 只是回到旧外观。状态文件形状、配置键、路由、`auto_update` 工具一个都没变，不需要迁移。

**完整记录**：[`CHANGELOG.md`](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/CHANGELOG.md) · **发布流程**：[README 的「Releases」一节](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/README.md#releases)

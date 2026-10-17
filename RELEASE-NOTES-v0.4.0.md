# dsh-auto-update 0.4.0

> 这一份就是 GitHub Release 页面（tag `v0.4.0`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版仍然只改面板这一张页面**：检测、安装、重启、桌面端同步一条链路都没动。

`0.3.1` 解决的是「能不能用」——键盘、读屏、窄窗口、日志被弹走。这一版解决的是**「打开之后几秒钟内知不知道自己该做什么」**：面板不再把六张版本卡片、四个按钮、全部历史和 500 行日志一起摊出来。

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

- **首屏只剩三行**——`现在`（一句话结论，例如「正在运行 0.2.1-rc.2，已经是 next 通道的最新版」）、`上次检查`、`需要你动手`。六张版本卡片、宿主、重启方式、桌面端、插件市场这些读数都收进了「更多细节 / Details」，点开才看。
- **结论按情况写**，不再是枚举值：有新版本、兼容性闸门拦住、等空闲窗口、正在升级、上次失败、registry 连不上，各有各的说法，并给出下一步（「不需要」「点【立即更新】」等）。
- **升级记录能筛**——按结果、按触发者、按版本号模糊匹配；右上角 `显示 x / y`；超过 5 行收在「显示全部」后面。
- **日志默认 50 行**，可以「展开到 200 行」，可以只看判定或只看频道变更。页面写明了筛选只作用于已经取到的那一段。
- **动作失败停在原地**：错误内联在按钮下方（`role="alert"`），不再只有 6 秒就消失的 toast，读屏也能听到。

顺手修掉一个一直没人发现的缺陷：**「上次检查」以前永远显示 `—`** —— 页面读 `state.check.at`，而这个字段真实的名字是 `state.check.checkedAt`。现在两处都按真实字段取，并加了回归用例。

## 它是什么

一个让 DSH harness 自己升级自己的插件：定时问 npm registry 有没有新版本，在**空闲时**无人值守安装、重启、确认新版本健康，失败自动回滚；另外顺带在每次升级后重打包桌面端分发件。频道（`latest` / `next` / `alpha`）可以直接在面板上切换。

面板是零构建的单文件 HTML，由插件自己渲染并挂在 `/auto-update/` 下；它只读本机状态文件与 npm registry，不往外发任何数据。

## 验证

- `test/dashboard.test.mjs` 从 9 个用例涨到 **15 个**（三行摘要与折叠区、结论分支、频道不显示内部名、三个筛选器与 `data-*` 键、超出窗口的历史默认折叠、`显示 x / y`、日志只看与展开、失败内联、表格语义、`checkedAt` 时间来源）。
- `node test/run.mjs` → `12/12 test files passed`。
- 真机渲染核对：拿运行中实例的 `/auto-update/api/v1/status` 渲染同一份 `renderDashboard()`，Edge 无头按 1000px 与 430px 两档截图；504px 视口下 `scrollWidth` 同为 504px，无横向溢出。

## 降级 / 回滚

面板是每次请求现渲染的 HTML：退回 `0.3.1` 只是回到旧布局。状态文件形状、配置键、助手协议都没变，历史记录与日志不受影响。

**完整记录**：[`CHANGELOG.md`](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/CHANGELOG.md) · **发布流程**：[README 的「Releases」一节](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/README.md#releases)

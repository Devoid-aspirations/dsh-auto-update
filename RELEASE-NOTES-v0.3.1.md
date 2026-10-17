# dsh-auto-update 0.3.1

> 这一份就是 GitHub Release 页面（tag `v0.3.1`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版只改面板这一张页面**：检测、安装、重启、桌面端同步一条链路都没动。

改法是拿 [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)（`command.md`，8055 字节）把 `lib/dashboard.js` 逐条过了一遍，P0/P1 项全部处理。页面仍然是**零构建的单文件 HTML**，颜色排版基本没变；变的是键盘能不能用、读屏能不能听到、窄窗口会不会溢出、看日志会不会被弹走。

## 装 / 升

```powershell
cd <检出目录>
# 先删旧副本再装：`file:` 依赖是拷贝，不是链接
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-auto-update" -Recurse -Force
dsh plugin --profile web add "file:$PWD"
```

装完**重启一次 harness**（插件是 `import` 进来的模块，热重载不会重读模块图）。

## 你会看到什么变化

打开面板 `http://127.0.0.1:3080/auto-update/`，观感几乎不变，细节变了：

- **键盘**：Tab 到按钮/下拉时有 2px 蓝色焦点环；页面顶部有「跳到主要内容」；日志区可聚焦、可用方向键滚动。
- **读屏**：检查、更新、频道切换的结果通过 `role="status" aria-live="polite"` 宣布；频道选择器有真正的 `<label for>`。
- **时间**：按**你机器的时区**显示（以前显示宿主时区，在别的时区看会差几个小时）。
- **数字**：zip 大小写成 `155 MB`（以前是 `162578757B`），版本年龄写成 `12,346 分钟前`。
- **窄窗口**：五列的历史表自己横向滚动，不会再把整页撑开。
- **日志**：往上翻看时不再每 10 秒被拉回底部；切走标签页时停止轮询，切回来立刻补一次。
- **按钮**：请求期间显示「检查中…」「启动中…」「同步中…」，失败后恢复，不会因为一个卡住的请求永久变灰。
- **报错**：带上下一步（「可稍后重试，或看下方日志」）。

## 它是什么

一个装进 DSH web profile 的插件：定时问 npm registry 有没有 harness 的新版本，到点、空闲时无人值守地装掉并重启宿主，失败回滚；同时管桌面端分发产物的同步。面板是它唯一的可视化界面，由 `lib/dashboard.js` 直接渲染成一张自包含的 HTML —— 没有打包步骤，因为它存在的意义就是「不装工具链也能看一眼」。

## 验证

- `node test/run.mjs` → **12/12 test files passed**。
- 新增 `test/dashboard.test.mjs`（9 个用例），补上了以前完全没人盯的部分：所有状态字段的**转义**（把 `<img onerror>`、`</script>`、`<svg onload>` 塞进 `reason`/`candidate`/`history` 断言全部变成实体）、标签与 `aria` 契约、`<time>` 与服务端时区回退、`Intl` 格式化、空历史文案、四个条件块（兼容性闸门 / 推迟 / 助手裁决 / 桌面端漂移）、标识符的 `translate="no"`。
- 审计清单 P0/P1 共 10 条全部落地；P2 里顺带做了 `tabular-nums`、`translate="no"`、跳过链接、toast 预留高度。

## 降级 / 回滚

只动了 `lib/dashboard.js` 并新增一个测试文件：没有状态迁移、没有配置键、没有协议变更。要退回，重装 `0.3.0` 并重启即可，行为回到旧页面。

**完整记录**：[`CHANGELOG.md`](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/CHANGELOG.md) · **发布流程**：[README 的「Releases」一节](https://github.com/Devoid-aspirations/dsh-auto-update#releases)

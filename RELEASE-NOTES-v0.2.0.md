# dsh-auto-update 0.2.0

> 这一份就是 GitHub Release 页面（tag `v0.2.0`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版加了用户看得见的东西**：侧边栏底部多了一个「自动更新」按钮，点它在**新标签页**打开面板（`/auto-update/`）。

在此之前，面板只存在于一个 URL 上，而面板自己不会告诉任何人它在哪 —— 装了插件的人要用它，得先记住地址。按钮把「有一个面板」变成「看得到入口」。面板本身一个字节没改：当前版本、候选版本、判断理由、推迟原因、历史记录、日志尾部，以及「立即检查」「立即更新」「同步桌面端」三个按钮都在原处，仍然走同一套 HTTP API。

## 装 / 升

```
cd <这个仓库的检出目录>
dsh plugin --profile web add "file:$PWD"
```

`file:` 装进去的是**拷贝**，不是链接：改了源码必须 `Remove-Item` 掉 profile 里那份副本再重新 `add`，然后**重启 harness** 才会生效（细节见 README 的「`file:` 装的是副本」）。

这一版尤其要重启：浏览器半边的清单（`dsh.client`）是宿主**启动时**扫描的，热重载不会重读。

## 你会看到什么变化

- **侧边栏底部多出一个按钮**。宽栏时图标 + 「自动更新」文字，折叠栏时只剩图标；悬停有主题填充，点击打开新标签页，当前会话页不会被顶掉。
- **没有按钮 = 副本没重装，或 harness 没重启**。这是唯一的“安装步骤”，没有需要你手改的配置。
- 面板、状态接口、`auto_update` 工具、所有配置键、状态文件形状**都没有变化**。

## 它是什么

一个浏览器半边 `lib/client.js`，注册进宿主为插件包提供的模块表：

- 只 require 宿主已经提供的共享模块（`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`），所以**没有构建步骤**，也没有需要一起发布的打包产物 —— 文件装进副本就被宿主取到；
- 通过 `package.json` 的 `exports["./client"]` 与 `dsh.client = { platform: "web", inject: [...] }` 被宿主的插件表发现，`platform` 是必填项；
- 注册的是**槽位** `sidebar.footer.action`，不接管页面、不替换路由，因此和面板、状态接口互不干扰；
- 样式只有四行 CSS，用主题 token（`--dsw-alias-label-primary`、`--dsw-alias-interactive-bg-hover`），亮色暗色都不需要单独适配；重复 `apply` 只保留一份样式表。

## 验证

- **把 bundle 真跑一遍**（`test/client.test.mjs`，5 个用例）：假的 `window.__ModuleLoader__` 与只含四个 specifier 的模块表，`factory(require)` 走真实代码路径。断言覆盖：清单声明的路径在仓库里存在、`lib/` 在 `files` 里、loader id 等于包名、`require` 只碰模块表里的名字、`apply` 注册了字典与按钮、宽/折叠两种渲染、点击参数是 `('/auto-update/', '_blank', 'noopener,noreferrer')`、重复 `apply` 只留一份样式表。
- `npm test` → `10/10 test files passed`（本机 Windows，node v24）。

## 降级 / 回滚

退回 `0.1.7` 只会让按钮消失：宿主不再看到 `dsh.client` 声明，其余行为与 `0.2.0` 完全相同。没有状态迁移，也没有配置迁移。

**完整记录**：[`CHANGELOG.md`](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/CHANGELOG.md) · **发布流程**：[README 的「Releases」一节](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/README.md#releases)

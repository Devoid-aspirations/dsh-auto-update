# 更新记录

这个项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的形状，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。三件事按这个顺序每次发版都要做：

1. 在 `package.json` 里把 `version` 提上去，用 `[dsh-auto-update <版本>] <一句话>` 提交；
2. 在这里**补一节**（`## [<版本>] — YYYY-MM-DD`），写清用户看得见的变化、这一版的验证结论、以及任何降级/回滚需要的信息；
3. 打完 tag 再发 Release —— tag 指到的那份 `CHANGELOG.md` 里必须已经有这一节。

为什么把「更新记录」当成发布契约而不是事后纪要：这个插件的用户在装好之后**不会再关心版本**（这正是它的卖点），所以出问题时唯一能查的线索就是这里 —— 哪个版本改了什么、验证做到哪一步、要退回哪个版本。发布的完整清单见 `README.md` 的「Releases」一节。

> 这个文件是**补写**的：`0.1.5` 发出去的时候还没有「更新记录」这个环节，所以它那一节不是当时的发布说明，而是从提交历史（`57af5f8`）和 `README.md` 的实测记录里**追认**出的基线。
>
> 还有一件事要写清楚：`0.1.5` **从未打过 tag**，所以「`0.1.5`」今天指的是**那个版本号**（`57af5f8` 提交的状态），不是一个标好的发布点 —— 页脚的链接因此指向提交而不是 tag。`0.1.0`–`0.1.4` 连提交都没有留下，也不是本仓库里的发布。**要回退到那一版，退的是提交 `57af5f8`，不是某个 tag。** 从 `0.1.6` 起，每一节都在发版当时写，tag 也在那时才真正打上（`v0.1.6` 与 `v0.1.7` 都已存在）。

## [0.4.0] — 2026-10-18

这一版仍然只动**面板这一张页面**，检测、安装、重启一条链路都没改。上一版（`0.3.1`）解决的是「能不能用」，这一版解决的是「打开之后几秒钟内知不知道自己该做什么」。

### 现象

面板之前是平铺的：六张版本卡片、四个按钮、频道选择器、一大段「当前判断」详情、全部历史、以及 500 行日志一起摊在一屏里。读者打开页面，第一眼看到的是六张数字卡片，而真正的问题——**它现在正常吗、上一步成没成、有没有事等我做**——要自己拼。

### 改动（四条信息架构）

- **一句结论先行**。首屏只有三行：`现在`（一句话结论，带结论标签）、`上次检查`、`需要你动手`。版本、宿主、重启方式、桌面端、插件市场、日志位置这些读数全部收进「更多细节 / Details」折叠区；结论措辞按判定分支（`update` / `plugin-incompatible` / 等待空闲 / 升级中 / 失败 / `registry-unreachable`）分别写，不用枚举值充数。
- **历史可筛选**。结果（全部 / 成功 / 失败 / 推迟 / 已回滚）、触发者（全部 / 手动 / 自动）、版本号模糊匹配三个筛选器，右上角 `显示 x / y`，超过 5 行收在「显示全部」后面。原来只能从头读到尾。
- **日志默认截断且可筛**。默认 50 行、可「展开到 200 行」、可按判定或频道变更过滤；页面写明「过滤只作用于已经取到的那一段」——选「全部」之后显示的仍是最新 50 行，不会假装是全量。
- **动作失败内联**。失败不再只有 6 秒就消失的 toast：错误停在按钮下方（`role="alert"`，可被读屏听到），点下一次动作才清掉。四个动作共用这一块，不各写一套。

### 顺带修掉的缺陷

面板的「上次检查」一直显示 `—`：代码读 `state.check.at`，而状态文档里真正的字段是 **`state.check.checkedAt`**（`lib/index.js` 的检查结果写入）。已在两处取值处补上 `checkedAt ?? at`，并加了一条用真实字段名渲染的回归用例——这个 bug 之前一直在测试盲区里，因为测试的假状态自己用了 `at`。

### 验证

- `test/dashboard.test.mjs` 从 9 个用例涨到 **15 个**：三行摘要与折叠区、结论标签按判定分支、频道不显示内部名 `stable`、历史筛选器带齐 `data-outcome`/`data-trigger`/`data-version`、超出窗口的历史行默认 `hidden`、`显示 x / y`、日志 `只看` 与「展开到 200 行」、失败内联而不是只在 toast 里、3×5 表格不带 `scope` 但带 `caption` 与 `th`、以及 `checkedAt` 这两条时间来源。
- `node test/run.mjs` → `12/12 test files passed`（12 个测试文件、全部通过）。
- 真机渲染核对：用运行中实例的 `/auto-update/api/v1/status` 渲染同一份 `renderDashboard()`，在 Edge 无头里按 1000px 与 430px 两档截图；`window.innerWidth` 504px 时 `document.documentElement.scrollWidth` 也是 504px，没有横向溢出。

### 升级之后你会看到什么

`/auto-update/` 打开就是三行结论，其余按需展开；按钮、频道选择器、`release:check`、`auto_update` 工具的行为都没变。上一版（`0.3.1`）的键盘焦点环、`prefers-reduced-motion`、`aria-live` 也都还在。

### 降级 / 回滚

面板是每次请求渲染的单文件 HTML，退回 `0.3.1` 只是回到旧布局：没有状态文件形状变化、没有新配置键、没有助手协议改动。已经写下的历史记录与日志不受影响。

## [0.3.1] — 2026-10-18

这一版只改**面板这一张页面**，不动检测、安装、重启任何一条链路。改法是拿[Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)（`command.md`，8055 字节）把 `lib/dashboard.js` 逐条过了一遍，把 P0/P1 项全部处理。

页面仍然是零构建的单文件 HTML，颜色和排版基本没变（深色 `#0d1117`）；变的是**能不能用键盘操作、读屏能不能听到结果、窄窗口会不会溢出、看日志会不会被弹走**。

### 修复

- **日志每 10 秒把滚动位置清零**：轮询直接替换 `textContent`，正在往上翻看某一行的人会被弹回底部。现在先记滚动位置，除非读者本来就在底部，否则原地不动。
- **请求悬挂时按钮永久禁用**：`fetch` 没有超时，一个卡住的请求会让按钮一直停在 disabled。现在 POST 20 秒、日志 15 秒超时，失败后按钮恢复原样。
- **页面隐藏时仍在轮询**：切走标签页还每 10 秒打一次日志接口。现在 `document.hidden` 时跳过，切回来立刻补一次。
- **错误只报问题、不给下一步**：`检查失败：fetch failed` 之类改成带上「可稍后重试，或看下方日志」「原因见下方日志」。

### 变更

- **频道选择器有了真正的 `<label for>`**，说明文字用 `aria-describedby` 挂上；`<option>` 的频道名标 `translate="no"`，避免浏览器自动翻译把值改掉。
- **异步结果可被宣布**：toast 变成 `role="status" aria-live="polite" aria-atomic="true"`；日志区是 `role="log"` + `tabindex="0"`（可聚焦、可键盘滚动），但 `aria-live="off"` —— 每 10 秒念一遍日志尾没有意义。
- **时间戳变成 `<time datetime="…">`**：服务端按宿主时区渲染（无 JS 也能读），浏览器加载后按**读者本地时区**重写。以前在别的时区看，时间是宿主的时间。
- **数字走 `Intl`**：zip 字节从 `162578757B` 变成 `155 MB`，候选版本的年龄从 `12346` 变成 `12,346 分钟前`；数字列加 `font-variant-numeric: tabular-nums`。
- **布局不再被长内容撑破**：5 列表格套 `.scroll-x{overflow-x:auto}` 容器；`.row > *{min-width:0}` 让说明文字可以收缩；`pre` 加 `overflow-wrap:anywhere`。
- **键盘可见性**：`:focus-visible` 给 2px `#58a6ff` 焦点环（原先只有浏览器默认环）；加「跳到主要内容」跳过链接；`h1`/`h2` 用 `text-wrap: balance`；按钮/下拉加 `touch-action: manipulation`。
- **显式进行态**：检查/更新/同步三个按钮在请求期间显示「检查中…」「启动中…」「同步中…」，失败时恢复原标签。
- **`<meta name="theme-color" content="#0d1117">`**：桌面端窗口标题栏与页面背景一致。

### 验证

- `node test/run.mjs` → **12/12 test files passed**。
- 新增 `test/dashboard.test.mjs`（9 个用例），盯的是以前完全没人盯的东西：**转义**（把 `<img onerror>`、`</script>`、`<svg onload>` 塞进 reason/candidate/history 断言全部被转成实体）、标签与 `aria` 契约、`<time>` 与服务端时区回退、`Intl` 格式化、空历史文案、兼容性闸门/推迟/助手裁决/桌面端漂移四个条件块、标识符的 `translate="no"`。
- 审计范围的 P0/P1 共 10 条全部落地；P2 里顺带做了 `tabular-nums`、`translate="no"`、跳过链接、toast 预留高度（用 `min-height` 避免出现/消失时抖动）。

### 升级之后你会看到什么

页面观感几乎不变。变化在细节：键盘 Tab 能看见焦点、窄窗口里表格自己横向滚动而不是整页溢出、日志往上翻时不会再被拉回底部、时间按你机器的时区显示、`155 MB` 比 `162578757B` 好读。

### 降级 / 回滚

只动了 `lib/dashboard.js` 与新增的一个测试文件，没有状态迁移、没有配置键、没有协议变更。退回 `0.3.0` 只会回到旧的页面。

## [0.3.0] — 2026-10-18

这一版把**频道**从「只有配置文件能决定」变成「面板上自己选」，并且让这个选择记住。

在此之前想从 `next` 换回 `latest`，唯一的路是改 profile 的 `cordis.patch.yml` 再等热重入 —— 一个「自动更新」插件的发布策略要开编辑器才能改，这是设计上的缺口，不是使用习惯问题。

### 新增

- **面板上的频道选择器**：`latest（只收正式版）/ next（含预发布）/ alpha（含内部版）`，切换即生效，约 20 秒内重新检查一次（下一次 tick 就是重新判定点）。
- **选择会被记住**：写进状态文件的 `channelOverride`，重启后仍然生效，不必重新点。
- **`latest` 作为 `stable` 的同义写法**：面板上写的是 `latest`（用户嘴里的名字），配置里也能直接写 `latest`；状态文档里统一存 `stable`，因为它是「读取 `latest` 这个 dist-tag」的频道名，而不是 tag 本身。
- **`POST /auto-update/api/v1/channel`**（body `{"channel":"next"}`）：与面板同一个入口，`stable`/`latest`、`next`、`alpha` 都认，未知频道返回 400 且不改动任何状态。

### 变更

- **切换频道会作废旧频道留下的判断**：`check` 与 `deferral` 一起清空。不这么做的话，一个已经按 `next` 排队、只因等空闲而推迟的版本，会在用户切回 `latest` 之后照样被安装 —— 那是「用户刚说不想要，插件却照旧执行」。
- **配置文件仍然是基线，且优先级更高**：状态里的 `configuredChannel` 记着 profile 那一行的值；一旦它变了（操作者动了文件），面板上一次点击的覆盖就被退休（`channelOverride` 归 `null`）。规则是「更新的一次决定赢」，而改文件是更新的一次。

### 验证

- **`test/plugin.test.mjs` 新增用例**（走真实路由，不直接调函数）：切到 `next` 后状态文件里 `channel=next`、`channelOverride=next`、`configuredChannel=stable`、`check=null`；再写 `latest` 得到 `stable`（别名）；写 `nightly` 得到 400 且状态不变；重启（同一 `DSH_HOME` 再 `apply` 一次）后仍是 `next`；把 profile 行改成 `alpha` 再启动 → `channel=alpha`、`channelOverride=null`。
- `node test/run.mjs` → `11/11 test files passed`（本机 Windows，node v24）。

### 升级之后你会看到什么

面板上多了一行「频道 / Channel」，默认值就是你 profile 里那一行（本机是 `next`）。切到 `latest` 后，如果当前在跑的是 `0.2.0-rc.2`，判断会回到 `up-to-date`；之前那条为 `0.2.1-rc.2` 挂着的「等空闲」推迟记录会被清掉。状态接口里多了 `channelOverride` 与 `configuredChannel` 两个字段。

### 降级 / 回滚

退回 `0.2.2` 后面板不再有选择器，`channel` 回到「只由配置文件决定」；状态文件里多出来的两个字段会被旧版本忽略，不影响启动，也不需要手工清理。频道本身没有副作用，回滚不会造成已安装版本的变化。

## [0.2.2] — 2026-10-18

这一版修的是**兼容性闸门的误判**：它把一个完全正常的版本判成了会弄坏 GUI 的升级。

现象：`0.2.1` 跑起来之后，检查终于连上 registry、也找到了 `0.2.1-rc.2`，但判定是 `plugin-incompatible` —— 理由写「5 个 profile 插件硬依赖它移除的包」，列出的移除名单里有两百多个名字，从 `cordis-plugin-group`、`cosmokit`、`libreoffice-kit` 一直到 `dsh-client-ui-primitives`。这些包并没有消失。

根因是**两边比的不是同一层**：闸门拿「已安装的 `node_modules/@deepseek-ai/` 目录」（本机 250 个包，含全部传递依赖）去减「目标版本 `package.json` 的 `dependencies`」（86 条直接依赖）。宿主把客户端包传递地装进来，所以在那个减法里，每一个传递依赖都成了「目标版本不再提供」。闸门的真实信号——`@deepseek-ai/dsh-client-runtime` 这类**确实**被移掉的包——恰好是传递依赖，于是这个错误算法当初误打误撞拦对了一次，平时则一路误报；本机 profile 里装着 5 个硬依赖 `dsh-client-ui-primitives` 的客户端插件，于是升级被永久挡住。

### 修复

- **改问 registry「目标版本还发不发这个包」**：`@deepseek-ai/*` 与宿主锁步发版，所以 `@deepseek-ai/<名字>@<目标版本>` 存在就说明它随这次升级进树，不存在才是真的被移除。`missingFromTarget()` 就是这个判定，探针由调用方注入（测试可替身），探针自己出错时**不算移除**（沉默是安全方向）。
- **候选名单只取插件真正提到的包**：`collectClientReferences()` 读每个客户端插件的 `dsh.client.inject` 与 bundle 里**字面量**的 `require("@deepseek-ai/…")`。本机实测 8 个客户端插件共 14 个名字，每个一次轻量请求，不再去猜那 250 个包里的每一个。
- **运行期拼出来的名字不猜**：`["@deepseek-ai/dsh-client", "-store"].join("")` 只取片段会得到 `dsh-client` 这个从未存在的包名，它的「不存在」会被读成「被移除」，所以只认字面量 `require`。
- `check.js` 不再从 packument 的 `dependencies` 推算移除名单（那段逻辑删掉，`removedPackages` 保留为闸门的计算结果）。

### 验证

- **拿本机真实 profile 跑新判定**：8 个客户端插件、14 个引用（`dsh-client-ui-primitives`、`dsh-client-ui-sidebar`、`dsh-api-remotes` …），对 `0.2.1-rc.2` 与 `0.2.0-rc.2` 的结果都是 **removed: none** —— 与事实一致（`@deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.2` 确实存在，而 `@deepseek-ai/dsh-client-runtime` 最高只到 `0.1.x`，仍是可得出的真移除）。
- **`test/compat.test.mjs`（新增 3 个用例）**：引用收集只认 `require` 字面量与 `inject`（运行期拼接不猜）、`missingFromTarget` 只把目标版本不发布的包判成移除、探针抛错时不判移除。
- **`test/check.test.mjs`** 改断言：检查不再从依赖表推算移除名单，`removedPackages` 交给闸门。
- `node test/run.mjs` → `11/11 test files passed`（本机 Windows，node v24）。

### 升级之后你会看到什么

本机 profile 里那 5 个「硬依赖 primitives」的插件不再被当成阻断项，`0.2.1-rc.2` 的判定回到 `update`，按空闲策略自己安装。状态接口的 `check.compatibility.removed` 里应该只剩真正被移除的包（这次是空的）。

### 降级 / 回滚

退回 `0.2.1` 会回到「传递依赖被当成移除、闸门误拦」的行为。状态文件形状、配置键、助手协议都没有变化；被误拦过一次的机器上 `check.decision` 会一直是 `plugin-incompatible` 直到退回。

## [0.2.1] — 2026-10-17

这一版修的是**检测本身**：在能解析到 `undici` 的机器上，更新检查从来没连上过 registry。

现象是面板上「立即检查」永远给不出候选版本 —— 状态接口里只有 `{"ok": false, "error": "fetch failed", "decision": "registry-unreachable"}`，看着像网络断了，而同一台机器上 `Invoke-WebRequest`、`curl`、`node -e 'fetch(…)'` 全都 200。当时 `channel` 指向 `latest`（`0.2.0-rc.2`，正是已装版本），「检查成功但没有新版本」与「检查失败」在界面上一样，于是缺陷一直藏在「你已经是最新的」这句判断背后。

根因是一次**跨实现的代理交接**：插件按代理环境变量构造 `undici` 的 `ProxyAgent`，再塞进 Node 内置 `fetch` 的 `dispatcher` 选项。这个环境里 `undici` 能解析到（`C:\Users\<you>\.dsh\profiles\web\node_modules\undici`，8.10.0，`billion-context` / `dshmarket` / `@liustack/modlens` 的依赖），但它是**另一份实现**：它的 agent 与 Node 内置那份 `fetch` 的 handler 契约不同，请求在发出之前就被拒，抛 `UND_ERR_INVALID_ARG: invalid onRequestStart method`，上层只看见 `fetch failed`。同一份代码在仓库目录下能跑，因为那里解析不到 `undici`，走的是不带 dispatcher 的直连。

### 修复

- **借用 agent 的同时借用它的 `fetch`**：`proxyDispatcher()` 现在把 `undici.fetch` 一起带回来，请求由**同一份实现**的客户端与 agent 完成，handler 契约自然一致。
- **失败后退一步直连**：代理那条路仍然失败时（agent 不兼容、代理宕了、隧道抖了），再用不带 dispatcher 的普通请求试一次；两次都失败才报错，信息里带上两条原因。这样「有代理但直连也能通」的机器不会再被判成 registry 不可达 —— 这台机器正是如此。
- **`fetchTaggedVersion` 同样处理**：它原来也只在代理失败时静默返回 `null`，等于把 `channel: next` 这类 dist-tag 查询一起废掉；现在同样先代理后直连。

### 验证

- **在副本目录里复现并验证修复**（那里才有 `undici`）：修复前 `fetchPackument('@deepseek-ai/dsh')` 抛 `UND_ERR_INVALID_ARG: invalid onRequestStart method`；修复后读到 `{"latest":"0.2.0-rc.2","alpha":"0.2.1-alpha.5","next":"0.2.1-rc.2"}`，`fetchTaggedVersion('next')` → `0.2.1-rc.2`。
- **`test/registry.test.mjs`（新增，6 个用例）**：请求形状（URL 编码、`accept`、`user-agent`、不带 dispatcher）、404 的报错文案带上状态与 URL、非对象 packument 报错而不是静默 `null`、dist-tag 查询的正常/未发布/抛错三条路径、以及 fetch 失败必须冒泡给调用方（不允许再被吞成「没有新版本」）。
- `node test/run.mjs` → `11/11 test files passed`（本机 Windows，node v24）。

### 降级 / 回滚

退回 `0.2.0` 会回到「能解析 `undici` 的机器上检测恒失败」的行为：不影响安装与回滚链路，只是查不到新版本。状态文件形状、配置键、助手协议都没有变化。

## [0.2.0] — 2026-10-17

这一版**加了用户看得见的东西**，也是第一次改动插件在浏览器里的行为：侧边栏底部多了一个「自动更新」按钮，在**设置**与**远程访问**之间独占一行，点它打开面板（`/auto-update/`）—— 桌面端交给**系统默认浏览器**，普通浏览器里是新标签页。

在此之前，面板只存在于一个 URL 上，而面板自己不会告诉任何人它在哪 —— 装了插件的人要用它，得先记住地址。按钮把「有一个面板」变成「看得到入口」。面板本身（当前版本、候选版本、判断理由、日志尾部、立即检查/立即更新/同步桌面端）一个字节没改，所有按钮仍然走同一套 HTTP API。

### 新增

- **浏览器半边 `lib/client.js`**：按宿主给插件包的模块表注册（`window.__ModuleLoader__.load({ id, factory })`），只 require 宿主已经提供的共享模块（`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`）。没有构建步骤、没有打包产物 —— 文件装进副本就被宿主取到。
- **侧边栏底部按钮**（槽位 `sidebar.footer.action`）：宽栏显示图标 + 文字，折叠栏只剩图标；36 px 圆角、悬停填充来自主题 token，和宿主自己的底部徽标同一套尺寸。它在**设置**与**远程访问**之间自占一行，点击不会替换当前会话页。
- **桌面端走系统浏览器**：DSH Desktop 的 preload 桥接暴露 `window.dshDesktop.openExternal`，有它就交给系统默认浏览器 —— 桌面端里的 `window.open` 会被窗口打开处理器接住、变成 Electron 子窗口，而面板是只有回环能访问的页面，不该被关在应用窗口里。普通浏览器里仍然用新标签页。
- **双语文案**：`auto-update` 命名空间下中英两份字典，键集合一致。
- **`package.json` 声明**：`exports["./client"]` 指向 bundle，`dsh.client = { platform: "web", inject: [...] }` —— 宿主扫描 `dsh.client` 找到浏览器半边，`platform` 是必填项，缺了或类型不对会在启动时直接报错。

### 变更

- `README.md` 的「观察与控制」一节补上入口说明，并写明按钮要在**重装副本 + 重启 harness** 之后才出现（浏览器半边的清单是宿主启动时扫的）。
- 底部那一列由共享槽位排布：`footerActions` 与槽位锚点都是 `display:contents`，所以每个贡献都是 `footArea` 的直接子项，**只有 `order` 能决定顺序**。`@linxin666/dsh-remote-web-ui` 占用了 1/3/4（其他贡献 / 设置 / 它自己的入口），本插件取 4、把它的入口挤到 5，于是自上而下是「设置 → 自动更新 → 远程访问」。

### 验证

- **`test/client.test.mjs`（新增，6 个用例）把 bundle 真跑一遍**：假的 `window.__ModuleLoader__` + 只含四个 specifier 的模块表，`factory(require)` 走真实代码路径。断言：清单声明的路径在仓库里存在、`lib/` 在 `files` 里、loader id 等于包名、`require` 只碰模块表里的名字、`apply` 注册了字典与按钮、宽/折叠两种渲染、浏览器里点击参数是 `('http://127.0.0.1:3080/auto-update/', '_blank', 'noopener,noreferrer')`、有 `dshDesktop.openExternal` 时改走它且不调 `window.open`、样式表里有排布规则、重复 `apply` 只留一份样式表。
- `node test/run.mjs` → `10/10 test files passed`（本机 Windows，node v24）。

### 升级之后你会看到什么

- 侧边栏底部多出一个按钮，位置在「设置」与「远程访问」之间。**没有按钮 = 副本没重装，或 harness 没重启**：浏览器半边的清单在宿主启动时扫描，`file:` 副本是 import 进来的模块，热重载不会重读。
- 面板、状态接口、`auto_update` 工具、所有配置键、状态文件形状都没有变化。

### 降级 / 回滚

退回 `0.1.7` 只会让按钮消失：宿主不再看到 `dsh.client` 声明，其余行为与 `0.2.0` 完全相同。没有状态迁移，也没有配置迁移。

## [0.1.7] — 2026-10-16

这一版**改了插件在运行时的行为**，也是 `0.1.5` 之后第一次改动 `lib/`。修的是一个安静但很吵的缺陷：一条早就结束的升级记录会被每 20 秒（每次 tick）重新「和解」一次，把同一条 `reconciled: … is superseded` 写进 `update.log` 并重写一次 `state.json` —— 一天约 4300 次。它不改变任何升级决策（该升还是升、该回滚还是回滚），代价是日志被灌满、真正的线索被埋掉，以及无谓的磁盘写入。

发现经过：`0.1.6` 重启后跑发布预检时顺手看日志，发现 `update.log`（324 KB）里那条 `reconciled: 0.2.0-rc.2 is running — the earlier failed verdict for 0.2.0-rc.2 is superseded` 占了约 45%，成对出现、间隔 10–20 秒。触发它的是本机一份 **2026-10-06 就冻结的 `helper.json`**（`phase: "failed"`、`target: "0.2.0-rc.2"`、`restartMode: "exit-only"`），而 `0.2.0-rc.2` 正是当时在跑的版本 —— 即「验证窗口过期」这条既有判定被反复套用在同一份原始记录上。

### 修复

- **`reconcile()` 不再每条 tick 重新判定同一份记录**：判定改成锚定**历史**（`state.history` 里是否已有该记录 id），而不是上一 tick 的内存标记。`helper.json` 是被分离的助手进程在退出时写死的，此后永不改变 —— 它描述的永远是同一次已经结束的运行，所以「已经和解过」这个事实必须来自能跨重启存活的地方。
- **不再在读路径上覆盖已定的结论**：`tick()` 里 `state.helper = readHelper() ?? state.helper` 与 `api.status` 里同样的一行都去掉了。它们把 `reconcile()` 刚写好的 `settled` / `supersededBy` 用原始记录盖回去，于是下一次 tick 又把它当新记录处理；面板轮询 `status` 正好发生在这个空档里。
- **在跑的助手仍然照读**：只有记录**尚未**定论时（`state.helper?.settled !== true`）才从 `helper.json` 读回进度，所以进行中的升级照样能在面板上看到实时状态。
- **跨重启保留已定论的那条记录**：状态初始化从 `previousState.helper` 取回，而不是置 `null`。记录本身不跨越它触发的那次重启，但插件对它做出的结论应该跨越 —— 否则每次开机都会把同一份冻结记录再和解一次。

### 验证

- **真实事故记录回放**：把本机那份真实的 `helper.json`（目标 `0.2.0-rc.2`）在一个报告相同版本号的合成 harness 下回放两次。修复前：两次启动分别写出 2 条、3 条 `is superseded`（每次开机各加一条）。修复后：1 条、1 条（在和解它的那次启动上写一次，下一次静默）。
- **归因实验**：只去掉 `tick()` 那处重读、保留状态接口那处守卫，缺陷就独立复现 —— 证明线上刷屏的主因是 tick 也重读了文件，光靠状态接口的守卫不够。
- **回归测试**（`test/plugin.test.mjs`，新增用例）：`the settled failure is announced once, not on every tick` 与 `the settled verdict survives the restart that follows it`（两个**独立进程**共用一个 `DSH_HOME`，即真实的重启场景）。两条用例都**在未修复的代码上失败、在修复后通过**（用 `git stash push -- lib/index.js` 反证过）。
- 新增测试夹具 `test/support/reconcile-once.mjs`：把插件对着一个合成 harness 启动两次（可配 `DSH_AUTO_UPDATE_HARNESS_VERSION` 以回放真实目标版本），并支持在两次 tick 之间插一次 `status` 读，用来复现「面板轮询清掉结论」这条路径。
- `npm test` → `9/9 test files passed`（Windows 实跑）。

### 升级之后你会看到什么

- 已经灌满的 `update.log` **不会被自动清理** —— 这一版只是不再往上加。要收窄就自己清空该文件，或等日志轮转。
- 不需要改配置、不需要重装 harness：`lib/` 换掉并重启后即生效，`helper.json` 里那条旧记录会在下一次启动时被标记为已和解，且只写一次。

### 降级 / 回滚

- 退回 `0.1.6` 即回到「每 20 秒写一条日志」的行为，升级决策不受影响 —— 这个缺陷只产生噪音与写入，不产生错误的安装或回滚。
- 状态文件形状、配置键、助手协议均未变化；`state.helper` 新增的 `settled` / `supersededBy` 字段在 `0.1.6` 就已经会被写入，只是留不住。

## [0.1.6] — 2026-10-16

这一版**没有改动插件在运行时的行为**（`lib/` 一个字节没动）：它补的是「怎么发布」这件事本身 —— 发布流程、一份能被机器检查的一致性预检、以及更新记录。所以升级它不会改变升级 harness 的任何行为，风险只在文档与工具。

### 新增

- **发布流程（README「Releases」一节）**：版本号规则（只用 `x.y.z`、一次发布一次版本号、`[dsh-auto-update <版本>] <一句话>` 的提交格式、`v` 前缀 tag）、五步发布清单、发布渠道表（GitHub Release 是唯一渠道；npm 刻意不发，理由与代价写在表里）、以及发出去之后发现不对的四条处置路径。
- **`npm run release:check`（`scripts/release-check.mjs`）**：发布前一致性预检，只读不写。查四件事 —— 版本是 `x.y.z`、`git status --porcelain` 为空、profile 里那份 `file:` **副本**的版本与仓库一致、在跑的实例通过 `/auto-update/api/v1/status` 报的 `pluginVersion` 与仓库一致。区分「警告」与「失败」：没装副本是警告（这台机器上本来就没装），装了但版本对不上是失败 —— 那正是「以为发了、其实没跑」。`--json` / `--profile` / `--port` 可选。
- **`CHANGELOG.md`（本文件）**：把「哪个版本改了什么、验证做到哪一步、要退回哪个版本」固定成发布契约。
- **`RELEASE-NOTES-<tag>.md`**：GitHub Release 正文的仓库内留档，粘贴时不必再组织一次语言。

### 变更

- README 把 `file:` 依赖的真实行为写清：`pnpm` 按 `files` 字段**拷一份**进 profile，没有 junction 也没有硬链接（`fsutil hardlink list` 列出的是副本自己的路径，链接数 1），改 `lib/*.js` 只会让副本停留在旧代码且不报错；重装必须两步（先删旧副本再 `add`）且都在仓库根目录执行，之后还得重启 harness（`import` 进来的模块热重载不会重读）；并补上「怎么确认新代码在跑」的两处比对（启动横幅里的版本号、`Get-FileHash` 逐字节）。
- README 的「测试」一节补上一条边界：profile 里那份副本**没有 `test/`**（被 `files` 字段滤掉），`npm test` 只证明**仓库里的代码**是绿的，不代表运行中的插件已经是这份代码。
- README 的发版清单修正了因果顺序：`release:check` 要在**重装副本之后**跑，重启 harness 之前它必然报「在跑的实例」不匹配 —— 那是预期状态，不是失败。

### 修复（修的是仓库与 CI，不是插件行为）

- `2b49f5e` 补全仓库：LICENSE、CI（`tests.yml`）、行尾与编辑器约定。
- `8337943` 修正 CI 在 Linux 上的路径解析，并把 actions 升到 node24 运行时。
- `fd0019c` 让 zip 刷新按平台选归档器，Linux/macOS 上不再必失败。
- `31ea947` 断言归档器时按已解析路径匹配，而不要求裸名字。
- `6c613f7` 文档：写清归档器是按平台选的。

### 验证

- `npm test` → `9/9 test files passed`（本次改动后在 Windows 上实跑）。整套测试只 import `node:` 内置模块与本仓库文件，没有第三方依赖、没有安装步骤。
- `release:check` 的四条路径都实走过：通过（副本 `0.1.5`、运行实例 `0.1.5`）、失败（工作区未提交；`--profile` 指向一个不存在的 profile 时副本版本对不上）、警告（该 profile 下没有安装副本 → `ENOENT`）、跳过（端口无人应答 → `ECONNREFUSED`）。CI 侧的多平台结果以 `tests.yml` 的矩阵（ubuntu / windows × node 20 / 22 / 24）为准。
- 这一版**没有**重跑 README 里那份 2026-10-15 的真机审计，也没有重新打包桌面端；那些结论属于 `0.1.5` 那一条时间线，原样保留。

### 降级 / 回滚

- 无需降级：`lib/` 未改动，配置键、状态文件形状、助手协议（`lib/protocol.js`）都没有变化。要退回上一版就是 `0.1.5`，行为完全一致（差别只在文档与 `scripts/release-check.mjs`）。
- 依赖面没有变化：仍然没有第三方依赖，也不涉及 npm 上的发布。

## [0.1.5] — 2026-10-16

### 新增

- 插件领域：让 DSH harness 自己升级自己（提交 `57af5f8`，仓库的第一个提交，`0.1.5` 的基线）。
- 桌面端同步（`dsh-desktop` 那部分）的验收策略：**不看退出码，看产物** —— 产物版本必须等于目标版本，且产物的每个文件都要和项目逐字节对得上（asar 里的条目按 header 记的 offset 取字节比 hash），`build.files` 声明了、产物里却没有的文件同样算不一致。

### 修复

- **回滚判定**：只看「端口是否一直有应答」，不看「能否报出版本」。一次启动窗口里读不到版本时把一个健康的 `0.2.0-rc.2` 重新装回了旧版 —— 这是本项目最贵的一次教训，现在的策略是「起着但无法确认」（`verified: false`）**不回滚**。

### 已知限制（当时就存在的，写在这里免得被当成新发现）

- 升级 harness 需要重启，重启会中断正在进行的对话，所以默认策略是等空闲窗口，最长推迟 3 小时后强制执行。
- 端口被别的进程占用时无法做重启验证，此时结论是 `deferred`（已安装、下次重启生效），不会被误判为失败。

### 验证

- `npm test`：9 个文件全绿（`9/9 test files passed`），只依赖 `node:` 内置模块，没有第三方依赖、没有安装步骤。
- 真机实测记录（2026-10-15，插件 `0.1.3` 与 `0.1.5`，harness `0.2.0-rc.2`）：见 `README.md` 的「已验证的事实（本机实测）」—— 组合树包含插件行、状态接口 `globalInstall=true`、桌面端巡检与真机打包（`electron-builder 26.15.3 --win dir` exit 0）、以及两个真机撞出来的坑（产物 `package.json` 带 UTF-8 BOM 被 `JSON.parse` 拒绝；`DSH Desktop.exe` 正在运行时打包被跳过）。**这一节本身没有重新跑过那条真机审计**，记录的是这次审计当时的结论，原样保留在 README 里。

[未发布]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/57af5f8...v0.1.6
[0.1.5]: https://github.com/Devoid-aspirations/dsh-auto-update/compare/57af5f8...57af5f8

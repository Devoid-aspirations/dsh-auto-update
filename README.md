# dsh-auto-update

**DeepSeek Harness 自动更新插件**：自动检测 `@deepseek-ai/dsh` 新版本，在空闲窗口**无人值守**完成全局安装、自重启与健康检查；新版本起不来就自动回滚到旧版本。

> 装好之后你不需要再关心版本：它自己检查、自己等空闲、自己升级、自己重启、自己验证，失败了自己退回。

---

## 它做什么

| 阶段 | 行为 |
| --- | --- |
| **检测** | 按间隔（默认 30 分钟）查询 npm registry，比较「当前安装版本」和「频道指向的版本」（stable=`latest`，next=`latest,next`，alpha=`latest,next,alpha`） |
| **等待** | 发现新版本后不立刻动手，等一个空闲窗口：没有进行中的回合、会话文件也不再被写入（`turn/start`/`turn/end` 事件 + 会话记录 mtime 双信号）。最长推迟 3 小时后强制执行 |
| **安装** | 派发一个 **detached 更新助手进程**（比宿主的命长），执行 `npm install -g @deepseek-ai/dsh@<目标版本>`，并按磁盘上的真实版本校验 npm 到底装了什么 |
| **重启** | 请求当前宿主优雅退出（一次性 token 保护的内部路由），等端口释放后由助手拉起新进程；如果宿主是被 DSH Desktop 这类外壳托管的，就把重启交给外壳，外壳没接上时助手自己兜底拉起 |
| **验证** | 轮询状态接口，要求新进程**持续**（默认 8 秒）以目标版本应答 —— 一次应答不算数，因为崩在半路的启动也能先绑住端口 |
| **回滚** | 若新版本始终起不来：重新装回旧版本并再次拉起；整个事务的每一步都写进日志与状态文件 |

## 它不做什么（安全边界）

- **不会覆盖非全局安装**：只有在「正在运行的 harness 确实位于 npm 全局根目录」时才动手。源码 checkout / 本地开发目录一律拒绝安装，只保留检测与提示。
- **不自动降级**：安装版本比频道更新时只报告（`ahead-of-channel`），绝不回退。
- **不吃刚发布的版本**：默认 `minReleaseAgeMinutes: 60`，比这更新的版本会等待（供应链缓冲），只报告不安装。
- **不碰你的 profile 插件**：harness 归本插件管，插件归 dshmarket 管；装了市场时只**读取**它的公开更新接口，报告「还有 N 个插件可更新」，默认不代替它动手。
- **不在检出目录里装**：源码运行（`pnpm dev` / `tsx` 跑 bin.ts）时只检测。
- **不跨断插件兼容性的那条线**：见下面的「兼容性闸门」。

---

## 兼容性闸门（为什么必须有）

这不是假想的风险，是本插件真实踩过的坑：`0.2.0-rc.2` 把客户端运行时那批包**改名/拆分**了（`@deepseek-ai/dsh-client-runtime` 等被移除），而 profile 里的客户端插件还是 0.1.x 编译的产物，它们的浏览器 bundle 里硬写着 `require("@deepseek-ai/dsh-client-runtime/client")`。新宿主的客户端模块表没有这个包的工厂，于是升级完成后 GUI 直接报「插件加载失败 / 缺少模块表」。

所以升级前会做一次预检，**用已经拿到的 packument 算出目标版本会移除哪些包**（不额外请求 registry），再去读 profile 里每个客户端插件：

| 信号 | 含义 | 处理 |
| --- | --- | --- |
| bundle 里 `require("@deepseek-ai/<已移除包>")` 字面量 | 硬依赖，bundle 根本加载不了 | **block**：不自动安装，面板与工具里说明是哪个插件、哪个包 |
| bundle 里用片段拼出来的名字（`["@deepseek-ai/dsh-client","-store"].join("")`） | 新构建的兼容回退写法 | 只记录，不拦 |
| `dsh.client.inject` 里写了已移除的包 | 声明依赖一个宿主不再提供的服务 | 只记录（可能降级加载，不会直接失败） |

`compatibilityGate: block`（默认）时它**不会被 `force` 绕过** —— 会按到那个按钮的人，正是会被这个升级弄坏 GUI 的人。要强行升级就把闸门设成 `warn`（照装但一路留痕），或 `off`（不预检）。

插件更新到兼容版本后，预检自然就不再拦了（无需手工解除）。

### 顺带修掉的一件事：热更新会造成两个实例

profile 的 patch 层是**热加载**的，所以改一次配置会让本插件在**同一个进程里被重新 apply 一次**。老版本没管这件事，结果实测出现：

```
── boot 10428-…: plugin 0.1.0, harness 0.2.0-rc.2, pid 10428, port 3080 …   ← 新实例起来了
could not register the HTTP surface: webserver: duplicate prefix route "/auto-update"   ← 旧的还占着路由
```

于是状态接口仍由**旧闭包**应答（配置看着没变）、却有两个定时器在跑。现在 `apply()` 会先把上一个实例**退场**（停表、摘监听、把路由交还）再接管，并且 `test/plugin.test.mjs` 里那条用例专门模拟"服务器拒绝重复路由"来守住这个回归。

---

## 桌面端同步（打包的 dsh-desktop）

`dsh-desktop` 是 `dsh web` 外面那层 Electron 外壳，它的版本号是**故意**跟着 harness 走的（manifest 里写着「版本与 dsh 核心同步」），而 `dist/` 里躺着的是几百 MB 的打包产物。每次 harness 发布都手动改版本号 + 重打包 + 重压 zip，正是那种一定会忘的事 —— 忘了的结果，是一个声称自己是最新版、其实不是用它构建出来的分发包。

所以更新事务也会做这件事，位置在 **harness 已安装、已重启、已验证之后**，并且无论如何都不会把"harness 升级成功"变成"失败"：

| 阶段 | 动作 |
| --- | --- |
| 探测 | 只在 manifest 声明 `name: dsh-desktop` 且存在 `main.js` 时才动手（改错目录的后果太严重，所以先验身份）；默认找**本插件旁边**的 `dsh-desktop`，也可用 `desktop.projectDir` 指定 |
| 版本 | 只重写 `package.json` 里那一行 `version`，其余字节不动，并留一份 `.bak-<旧版本>` |
| 打包 | `npm run dist:dir`（可用 `desktop.buildCommand` 换成别的 argv）。**产物正被占用就不动手**：先问 `tasklist` 那个 `<productName>.exe` 在不在跑（Windows 不会让打包器替换正在运行的程序的文件）；同一项目同一时间只允许一次打包（`desktop-build.lock`），超时会连整棵进程树一起杀掉（`taskkill /T`）而不是只杀 `cmd.exe` |
| 验收 | **不看退出码，看产物**：产物版本必须等于目标版本，而且产物的每个文件都要和项目逐字节对得上（asar 里的条目按 header 记的 offset 取字节比 hash），反过来 `build.files` 声明要打进去、产物里却没有的文件也算不一致 —— "构建成功却打着旧包"、"版本对了但代码是旧的"都正是要抓的失败 |
| 分发 | 按平台选归档器（Windows：`tar -a`，没有就回退 PowerShell `Compress-Archive`；其他平台：`zip` —— macOS 的 `tar` 不能写 zip，GNU tar 要 1.35+ 才行，所以没有哪个工具能通吃），先写 `*.part.zip`、**验完是完整 zip 再改名**：刷新失败时上一版分发包原样留着 |
| 记录 | 结论写进 `helper.json` 与状态文件（含用的是哪个产物目录、哪些文件不一致、zip 是否完整），面板和 `auto_update` 工具都能看到；**失败只记录**，不影响 harness 的升级结论 |

产物不假设形状：输出目录取 manifest 的 `build.directories.output`（缺省 `dist`），产物按 electron-builder **真正会写出来的东西**发现 —— 默认 `--win dir` 写的是 `dist/win-unpacked/resources/app.asar`（打包成 asar，目录名跟的是 target 而不是 `productName`），设了 `asar: false` 才是未打包的 `resources/app/package.json`；同一输出目录里有多个产物时**最新的那个**说话（刚跑完的构建就是这次构建的结果），`desktop.zipSource` 可以钉住指定目录名。

判定还看 zip 与产物的先后：分发包必须**不比它该装的产物旧**。一次"产物写完、zip 之前就失败"的构建会留下一个完整却是上一版的 zip —— 只看"zip 存在且完整"会永远认为它是最新的。`desktop.refreshZip: false`（不维护 zip）时，zip 完全不参与判定，否则会变成每轮都要求重新打包。

成功与失败都是**返回值**，不是异常：`up-to-date` / `version-synced` / `packaged` / `packaged-no-zip` / `failed` / `no-project` / `skipped`。

三种力度（`desktop.mode`）：`off` 不管、`version` 只同步版本号（秒级，产物留给手动打包）、`package`（默认）连打包带 zip 一起刷。

也可以不等 harness 发布就手动同步：面板上的「同步桌面端」按钮，或 `POST /auto-update/api/v1/desktop`，或直接让助手做（`auto_update` 工具的 `desktop` 动作）。

### 外壳也要能打开 0.2 之后的界面

dsh 0.2 起，Web GUI 多了浏览器鉴权：**裸地址会回 401**，只有 `dsh web` 打印出来的那个带 `?token=…` 的地址才能种下会话 cookie（`dsh-web-app` 里的 `authenticatedUrl`）。而外壳为了不重复弹浏览器标签页，给 0.2 之后的核心传的是 `--no-open` —— 于是那行地址没人接，窗口直接加载裸地址，看到的就只有 401。

`dsh-desktop/main.js` 因此做了三件事：

| 位置 | 行为 |
| --- | --- |
| `captureLauncherUrl()` | 从子进程 stdout 里（按已累积的 `serverLog` 解析，跨 chunk 也能匹配）抓出 `dsh web: <url>`，**不用管道**，和插件里的做法一致 |
| `connect()` | 首个 `loadURL` 用抓到的地址（种 cookie）；此后裸地址也能正常打开。`probe()` 现在返回**状态码**而不是布尔值 —— 「服务在，但要鉴权」和「服务不在」是两回事 |
| 兜底 | 服务是**别人**启动的（拿不到令牌）时不再给一个空白 401，而是错误页 `AUTH401`，直接说明该去哪里拿带 token 的地址 |

---

## 安装

插件目录就在本仓库内，推荐用 DSH 自带的插件命令（会自动写入 `dsh.profile.bundles`）。在**本仓库根目录**执行：

```powershell
dsh plugin --profile web add "file:$PWD"
```

`$PWD` 是 PowerShell 的当前目录。如果换到别处执行，把 `"file:$PWD"` 换成仓库的绝对路径即可（Windows 路径请用正斜杠，或整个用引号包住）。

装完**重启一次 harness** 让它进入 profile 树（之后本插件就不需要再手动装了 —— 它会自己升级 harness）。

### `file:` 装的是副本 —— 改完源码必须重装

这是本项目最容易踩、且**在界面上看不出来**的一个坑：`file:` 依赖不是链接，`pnpm` 把仓库按 `package.json` 的 `files` 字段**拷一份**进 profile，之后两边再无关系。实测这份副本与仓库没有 junction、也没有硬链接（`fsutil hardlink list` 列出的是副本自己那个路径，链接数 1），而且它的时间戳停在当时拷贝的时刻、不跟随仓库。

| | 仓库（`D:\其他\deepseekharness\programone\dsh-auto-update`） | profile 里那份副本（各自独立） |
| --- | --- | --- |
| `lib/`、`cordis.patch.yml`、`package.json`、`README.md` | ✅ | ✅ 拷贝 |
| `test/`、`scripts/`、`.github/` | ✅ | ❌ 被 `files` 字段滤掉 |

所以：**在仓库里改了 `lib/*.js`，运行中的插件一点变化都没有**，而它也不会报错 —— 你会以为改动没效果，其实是根本没跑你的代码。装进去的 `lib/` 是**某一刻的快照**，改一个字节的 js 不会让 `pnpm` 重读目录；发布时把 `package.json` 的 `version` 也提上去（并且仍然照下面两步重装），才是不会猜错的做法。

重装的两步都不能省，顺序也不能反 —— **先删旧副本，再 add**（只 add 可能被当成「已经装过」而跳过拷贝）。两条都在**仓库根目录**执行，`$PWD` 才是仓库路径：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-auto-update" -Recurse -Force
dsh plugin --profile web add "file:$PWD"
```

然后**重启 harness**。副本变了还不足以生效：`file:` 拷贝是 `import` 进来的模块，热重载不会重读模块图，只有重启才会加载新副本（插件自己处理过的「热重入」说的是同一个进程里被重新 apply 两次时把上一个实例摘干净，不是让新代码生效）。

改完想确认生效了，看两处：

- 启动横幅（写在 `$DSH_HOME/auto-update/update.log` 里，格式见 `lib/index.js:909`）里的版本号，必须等于仓库当前 `package.json` 的 `version`：
  ```
  ── boot 8388-…: plugin 0.1.5, harness 0.2.0-rc.2, pid 8388, port 3080, supervisor none, restart respawn
  ```
  这个版本号是用 `ownVersion()` 从**副本自己的** `package.json` 读的（`lib/index.js:69-76`）—— 它显示旧版本号，就说明跑的还是旧副本。
- 逐字节比对（相同则副本就是当前代码）：
  ```powershell
  (Get-FileHash .\lib\index.js).Hash -eq (Get-FileHash "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-auto-update\lib\index.js").Hash
  ```

> 如果 `dsh` 走的是 PowerShell 包装脚本，而本机执行策略禁止脚本（`dsh.ps1 cannot be loaded because running scripts is disabled`），直接跑 CLI 本体即可，效果完全一样：
> ```powershell
> node "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add "file:$PWD"
> ```
> 装好后 `pnpm` 可能会顺手清掉几个它自己早先提升（hoist）出来的包 —— 那是 profile 依赖图的重算，不是插件影响：`package.json` 里声明的插件一个都不会少，装完照一眼 `dsh.profile.bundles` 就能确认。

### 脚本里的路径怎么来的

`scripts/` 下的诊断脚本不写死任何机器路径，统一从 `scripts/_env.mjs` 派生。想先确认它认对了本机环境：

```powershell
node --input-type=module -e "import('./scripts/_env.mjs').then(m => m.reportPaths())"
```

```
plugin dir   : <本仓库>
DSH home     : <$DSH_HOME 或 ~/.dsh>
profile      : <DSH home>/profiles/<profile>
harness dir  : <npm 全局根>/@deepseek-ai/dsh
pnpm         : <PATH 上找到的 pnpm>
```

派生顺序是「环境变量 → 从当前进程推导 → 平台默认值」。可用环境变量覆盖：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `DSH_HOME` | DSH 数据目录 | `~/.dsh` |
| `DSH_PROFILE` | 要检查的 profile 名 | `web` |
| `DSH_AUTO_UPDATE_GLOBAL_ROOT` | npm 全局根 | `npm root -g` 的输出 |
| `DSH_AUTO_UPDATE_HARNESS_DIR` | 已安装的 harness 包目录 | `<全局根>/@deepseek-ai/dsh` |
| `DSH_AUTO_UPDATE_DSH_BIN` | harness CLI 入口 | `<harness 目录>/lib/bin.js` |
| `DSH_AUTO_UPDATE_PNPM` | pnpm 可执行文件 | `PATH` / `PNPM_HOME` 上找到的 |

### 只检测不安装地先跑一轮

```powershell
node scripts\profile-mode.mjs detect-only --profile   # 写入 autoApply: false 覆盖
node scripts\profile-mode.mjs status                  # 看两层 patch 现在是什么
node scripts\profile-mode.mjs auto --profile          # 恢复全自动（只删自己那几行）
```

`auto` 是**外科式**删除：只删它自己写的标记、注释与 `auto-update` 行，标记区间里别人的配置一行不动（市场会往同一个文件里写它自己的行，早先那种「整段删除」的写法会把用户设置一起删掉）。`--dry-run` 可以先看结果不落盘。

### 不动正在运行的实例也能验证

`scripts/verify-in-harness.mjs` 会在**另一个端口**起第二个 `dsh web`（同一个 web profile），用 `scripts/safe-overlay.yml` 关掉自动安装，然后逐项检查：组合出来的 profile 树里有没有本插件的行、状态接口是否应答、面板页能不能打开、强制检查的结论是什么、日志说了什么，最后把实例停掉。

```powershell
node scripts/verify-in-harness.mjs
```

`scripts/repair-profile.mjs` 用来把 profile 里的依赖路径改回正确值（路径含中文时，某些工具会用错编码写成乱码）。

> 开发调试时也可以直接改 profile 的 `cordis.patch.yml`（该文件是热加载的），加一行：
> ```yaml
> - insert:
>     - id: auto-update
>       name: 'dsh-auto-update'
> ```
> 注意别和 `dsh.profile.bundles` 里的自动行重复（重复插入同一条路由会让 profile 启动失败）。

## 配置

在 profile 的 `cordis.patch.yml`（或 `$DSH_HOME/cordis.patch.yml`）里覆盖本插件那一行：

```yaml
- id: auto-update
  config:
    channel: next              # stable | next | alpha
    checkIntervalMinutes: 30
    applyPolicy: idle          # idle | immediate
    idleSeconds: 90
    maxDeferMinutes: 180
    minReleaseAgeMinutes: 60
    autoApply: true            # false = 只检测不安装
    restart: true              # false = 只安装，下次手动重启生效
    restartMode: auto          # auto | respawn | exit-only
    holdVersion: null          # 例如 '0.1.0-rc.6' 锁死版本
    profilePlugins: notify     # off | notify
    installArgs: []            # 追加给 npm install -g 的参数（可选）
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `package` | `@deepseek-ai/dsh` | 要更新的包 |
| `channel` | `stable` | 跟随的发布频道（映射到 npm dist-tag 集合） |
| `checkIntervalMinutes` | `30` | 检查间隔 |
| `startupCheckDelaySeconds` | `120` | 启动后多久做第一次检查 |
| `autoApply` | `true` | 是否自动安装（`false` 时只检测+提示，但 HTTP/工具仍可手动触发） |
| `applyPolicy` | `idle` | `idle` 等空闲；`immediate` 检测到就装 |
| `idleSeconds` | `90` | 「空闲」的定义：这么久没有任何回合/会话写入 |
| `maxDeferMinutes` | `180` | 最长推迟多久后强制执行 |
| `minReleaseAgeMinutes` | `60` | 发布不满这么久不安装（0 = 关闭） |
| `holdVersion` | `null` | 锁定版本，不自动越过 |
| `restart` | `true` | 安装后是否重启 |
| `restartMode` | `auto` | `auto`：被外壳托管（如 DSH Desktop）时交给外壳，否则自己拉起；`respawn` 永远自己拉起；`exit-only` 只退出 |
| `healthTimeoutSeconds` | `150` | 新版本必须在这个窗口内持续应答 |
| `rollbackOnFailure` | `true` | 起不来时回滚 |
| `maxAttemptsPerTarget` | `2` | 同一目标版本最多尝试次数 |
| `failureCooldownMinutes` | `360` | 用尽次数后的冷却时间（避免反复装上同一个坏版本） |
| `profilePlugins` | `notify` | 是否顺带汇报 profile 插件的可更新数量（`apply` 从未实现，写了也只按 `notify` 走，并在日志里说明） |
| `compatibilityGate` | `block` | 目标版本会移除本 profile 客户端插件硬依赖的包时：`block` 拦下（`force` 也不能绕过）/ `warn` 照装但留痕 / `off` 不预检 |
| `desktop.mode` | `package` | 桌面端同步力度：`off` / `version`（只改版本号）/ `package`（版本号 + 重打包 + 刷 zip） |
| `desktop.projectDir` | `null` | dsh-desktop 项目目录；`null` = 找本插件旁边的同名目录 |
| `desktop.refreshZip` | `true` | 重打包后是否重压绿色版 zip（`false` 时 zip 不参与"要不要重新打包"的判定） |
| `desktop.zipName` | `DSH-Desktop-绿色版.zip` | zip 在项目输出目录里的文件名（只接受纯文件名：带路径分隔符或 `..` 的值会被忽略，避免写出项目外） |
| `desktop.zipSource` | `null` | 钉住要同步/打包的产物目录名（输出目录里有多个产物时用）；`null` = 用最新的那个 |
| `desktop.buildCommand` | `null` | 覆盖打包命令（argv 数组）；`null` = `npm run dist:dir` |
| `desktop.timeoutMinutes` | `30` | 单次打包的上限 |
| `registry` / `npmBin` | `null` | 覆盖 registry 与 npm 可执行文件 |
| `installArgs` | `[]` | 追加给 `npm install -g` 的额外参数（作为独立 argv，排在 `--registry=` 之前，所以显式 registry 仍然优先；最多 16 条，含换行的会被丢弃） |

## 观察与控制

**面板页**（无需构建、直接打开）：`http://127.0.0.1:3080/auto-update/`
—— 当前版本、候选版本、判断理由、推迟原因、历史记录、日志尾部，以及「立即检查 / 立即更新」按钮。

**入口**：侧边栏底部有一个「自动更新」按钮（宽栏时带文字，折叠时只剩图标），点它会在**新标签页**打开上面这个面板 —— 当前会话页不会被顶掉。这个按钮是插件自己的浏览器半边（`lib/client.js`，走宿主给插件包的模块表注册，不需要构建），所以它只出现在 Web 界面里，并且要在**装好副本 + 重启 harness** 之后才会出现。

**HTTP API**（仅本机回环 + 同源）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/auto-update/api/v1/status` | 完整状态文档 |
| `POST` | `/auto-update/api/v1/check` | 立即检查一次 |
| `POST` | `/auto-update/api/v1/apply` | 立即更新（可选 body：`{"version":"0.2.0-rc.2"}`） |
| `POST` | `/auto-update/api/v1/desktop` | 立即做一次桌面端同步（面板上的「同步桌面端」按钮走的就是它） |
| `GET` | `/auto-update/api/v1/log?lines=200` | 日志尾部（`format=json` 可换成数组） |

**Agent 工具**：`auto_update`，`action` 取 `status | check | apply | log`。可以直接对助手说「检查一下 harness 有没有新版本」。

**状态与日志**（都在 `$DSH_HOME/auto-update/`）：

```
state.json              当前状态：版本、判断、推迟、历史、尝试次数
helper.json             更新助手的事务进度（installing → stopping → verifying → succeeded/deferred/…）
update.log              时间线日志（插件与助手共同写入）
helper.out.log / .err.log   助手进程自身的输出
harness-restart.out.log     重启后新宿主的输出
update.lock             进行中的更新锁（进程已死则自动失效）
```

## 工作流程

```
        ┌────────────── 宿主进程（插件本尊） ──────────────┐
每 20s  │ tick → 读 helper.json → 判断空闲 → 到期就检查   │
        └───────────────┬─────────────────────────────────┘
            发现新版本且空闲 │  写 plan-*.json，detached 启动
                            ▼
        ┌──────────── 更新助手（独立进程，比宿主命长） ────────┐
        │ 1 校验磁盘版本 == plan.fromVersion                  │
        │ 2 npm install -g @deepseek-ai/dsh@<目标>            │
        │ 3 校验磁盘版本 == 目标（npm 真的装了才算数）          │
        │ 4 POST /auto-update/api/v1/internal/shutdown（带 token）
        │ 5 等端口释放 → 拉起新宿主（或交给外壳）              │
        │ 6 轮询状态接口，需持续 8s 以目标版本应答             │
        │ 7 失败且允许回滚 → 装回旧版本 → 再拉起 → 再验证       │
        └────────────────────────────────────────────────────┘
```

宿主下次启动时会把助手的最终结论**并入历史**：谁装了什么、成没成、是回滚了还是只是「装好了但没生效」（`deferred`，例如宿主没退出）。

## 卸载 / 出问题怎么退

```powershell
dsh plugin --profile web remove dsh-auto-update
```

插件把 `apply()` 整体包在兜底里：初始化失败（例如 `$DSH_HOME` 不可写）只会让「自动更新不可用」并写进宿主日志，**不会**让 profile 启动失败。真要遇到启动异常，退路是编辑 `~/.dsh/profiles/web/package.json`，把 `dsh-auto-update` 从 `dependencies` 和 `dsh.profile.bundles` 里去掉（安装时留了两份备份：`package.json.bak-<时间戳>`、`cordis.patch.yml.bak-<时间戳>`）。

运行痕迹全部在 `$DSH_HOME/auto-update/`，删掉即可重置（锁、状态、历史、日志一起清空）。

## 已知限制

- 升级 harness 需要**重启**才能生效，重启会中断正在进行的对话 —— 所以默认策略是「等空闲」，并在 3 小时后强制执行。
- 端口被别的进程占用时无法重启验证，此时结论是 `deferred`（已安装、下次重启生效），不会误判为失败。
- **回滚只看「端口是否一直有应答」，不看「能否报出版本」**：新版本起着、但本插件的状态路由 404、或 200 却没带 `running` 字段时，判定是「起着但无法确认」（`verified: false`），**不会**回滚。曾经因为一次启动窗口里读不到版本，把一个健康的 0.2.0-rc.2 重新装回了旧版 —— 这是本插件最贵的一次教训，现在这条策略写在 `verifyRunning` 的注释里。
- 优雅停机走的是本插件自己的路由（要求同源 + 令牌）；路由不在或拒绝时只能退化成 `SIGTERM` —— 在 Windows 上那等于硬杀，会话没有机会落盘。日志会区分「路由拒绝（403）」「路由不存在」「已接受（202）」三种情况。
- 插件自身的 bare import（`@deepseek-ai/dsh-tools`）依赖 profile 的模块回退目录；以 `file:` 安装进 profile 时正常，纯粹 `link:` 到工作区时若报错会在日志里说明并跳过工具注册（其余功能不受影响）。

## 测试

```powershell
cd dsh-auto-update
npm test          # = node test/run.mjs
```

**测试只能在仓库里跑，而且测的必须是你刚改的那份源码。** 两件事容易混：

- profile 里那份副本**没有 `test/` 目录**（被 `package.json` 的 `files` 字段滤掉了），所以「从安装目录跑测试」这条路径根本不存在，任何在 `~\.dsh\profiles\web\node_modules\dsh-auto-update` 里做的验证都无从谈起。
- 反过来，`npm test` 只说明**仓库里的代码**是绿的，**不代表运行中的插件已经是这份代码** —— 测试通过和插件生效之间还差「删旧副本 → 重新 add → 重启 harness」这三步（见上面「`file:` 装的是副本」）。常见的一种自欺是：改完代码跑测试全绿，就以为升级逻辑已经改了，实际跑的还是上一份副本。

所以涉及行为改动的流程是：**仓库里改 → `npm test` 全绿 → 重装副本 → 重启 → 在启动横幅和状态接口上确认新代码在跑**。

- `version / check` —— 版本序、频道解析、发布年龄、冷却、不可达 registry 等判断分支
- `compat` —— 兼容性闸门：目标版本移除了客户端插件硬依赖的包时如何拦截/降级
- `desktop` —— 桌面端同步：识别项目、只改一行版本、产物版本验收（含「退出码 0 但打的是旧包」）、zip 完整性/新旧、**产物与项目逐文件比对（asar 与未打包两种形状、两个方向）**、同尺寸改动的 hash 捕获、刷新 zip 的原子性、并发打包锁、程序在跑时的跳过、`zipName` 路径穿越、asar 里读 manifest
- `npm` —— 交给 npm 的 argv（含 `installArgs` 的位置与顺序）
- `paths` —— 锁的归属与清理、plan 文件保留窗口、描述符关闭
- `routes-idle` —— 回环+同源守卫、路由分派、空闲双信号（含「状态文档可用缓存、升级决策必须现读」）
- `plugin` —— 用假 ctx 跑 `apply()`：路由、定时器、状态文件、工具注册、热重入时的实例交接
- `helper-e2e` —— **真过程树、真端口**的端到端：成功升级（含桌面端同步）/ 坏版本回滚 / 安装失败 / 「起着但报不出版本」不许回滚 / 带守卫的停机路由确实被正确调用，用假 npm 和假 harness 在临时目录里跑

共 9 个文件、全绿（`npm test` 末尾会打印 `9/9 test files passed`）。上面这条审计里补的回归用例集中在：
`helper-e2e`（0.2 时代**已确认启动**的版本不再回滚 / 停机请求带着 `Origin` 头）、
`routes-idle`（状态接口连读两次描述符不增长）、`paths`（持锁进程已死时能接管、`prunePlans` 的清点）、
`plugin`（热重入不重复接管、`installArgs`/`profilePlugins` 真的落进 plan 与 profile 决定、
「上一次的失败记录其目标版本已在运行」会被标记为已取代而不是一直挂在状态里）。

桌面端那一轮审计补的用例集中在 `desktop`（27 条）与 `helper-e2e`（端到端里那条真打包）：产物形状按 electron-builder 真实会写出的东西给（默认 `--win dir` 的 `win-unpacked/resources/app.asar`，以及未打包的 `resources/app/`），
asar 由 `test/support/asar.mjs` 按 Electron 的双层 pickle 格式真写出来再读回。
用例覆盖：产物版本等于/不等于目标、`build.files` 声明了却不在产物里（双向比对）、asar 内**同尺寸但内容不同**的文件能被 hash 抓到、
zip 缺 EOCD/被截断 → 不完整、zip 比产物旧 → 重新打包、`refreshZip: false` 时 zip 不参与判定、
刷新 zip 失败时上一个 zip 逐字节不变、产物目录不写死（跟随 manifest 的 `build.directories.output`）、
并发打包锁、`DSH Desktop.exe` 在跑时跳过、`zipName` 带 `..\` 被忽略。
最后一轮真机又暴露了一条：**打包产物的 `package.json` 带 UTF-8 BOM**（另一处用 PowerShell 写出来的），
`JSON.parse` 直接拒绝，整个产物被读成「没构建过」—— `desktop`（未打包与 asar 两种形状里都补了 BOM 用例）、`paths`、`compat` 各有一条回归用例，
凡是读外来 manifest 的地方现在都先剥掉 BOM。

> 注 1：`node --test` 会用管道启动子进程，在受限沙箱里会被拒绝（EPERM），所以仓库自带 `test/run.mjs`（以 `stdio: 'inherit'` 逐文件运行）。同理，插件内部**不使用管道捕获子进程输出**，而是落文件后再读。
>
> 注 2：`plugin.test.mjs` 里那条「工具注册成功」的用例需要 `@deepseek-ai/dsh-tools` 可解析。本仓库用一个目录联接（junction）指向 profile 共享的该包：
> `node_modules/@deepseek-ai/dsh-tools -> ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools`。没有这个联接时该用例会跳过（不算失败），其余用例不受影响。

## Releases

一次发布 = **一次提交 + 一个 tag + 一份 GitHub Release**。三件事里最容易做错的是「提交了但没重装副本」，因为那时仓库里的版本号和真正在跑的代码已经不是一回事了 —— 这一节把「什么算发出去」写死，再给一条命令替你把关。

### 版本号怎么走

`package.json` 的 `version` 是**唯一**的版本事实来源，tag、Release、启动横幅里的 `plugin 0.1.5`、状态接口的 `pluginVersion` 全部从它读出来（`lib/index.js:69-76` 的 `ownVersion()` 读的是**副本自己的** manifest）。规则只有三条：

| 改动 | 版本 | 例 |
| --- | --- | --- |
| 改行为、修 bug | 末位 +1 | `0.1.5 → 0.1.6` |
| 加功能、加配置项，旧的用法仍然成立 | 中位 +1，末位置 0 | `0.1.5 → 0.2.0` |
| 改配置语义、改状态文件形状、改助手协议（`lib/protocol.js` 的路径/schema/token） | 首位 +1 | `0.1.5 → 1.0.0` |

几条硬规定：

- **只用 `x.y.z`**，不带 `-rc.1` 之类后缀。`0.2.0-rc.2` 是 **harness** 的版本线，插件跟着它写同样是预发布号只会让「谁是预发布」变得说不清；`scripts/release-check.mjs` 会拒绝非 `x.y.z`。
- **一次发布一次版本号 + 一个 commit**。两次发版之间如果没动 `version`，两个不同的副本在界面上长得一模一样，出问题时无法指认是哪一个 —— 这是这个项目里最贵的排错成本。
- **版本号必须跟着提交走**。提交信息用发出这个版本时的既有格式：`[dsh-auto-update 0.1.5] <一句话>`（`git log` 里 `57af5f8` 就是这个形状），`fix:` / `test:` / `docs:` 这些前缀留给没发版的改动。
- tag 用 `v` 前缀：`v0.1.5`。**一个版本只打一次 tag**；tag 推错了就发下一个 patch，删除远程 tag 会让已经拉到它的人拿到一个「曾经存在过」的版本号。

### 一次发布的清单

**1. 改版本号并提交** —— 用 `[dsh-auto-update <版本>] …` 当提交信息：

```powershell
# 手工编辑 package.json 的 version（例如 0.1.5 → 0.1.6）
git add -A
git commit -m "[dsh-auto-update 0.1.6] <一句话说清这一版改了什么>"
```

**2. 重装副本** —— 让机器检查的那两处对齐（两条命令见上面「`file:` 装的是副本」）。必须先删旧副本再 `add`，两步都在仓库根目录执行。**只有这一步做完，`ownVersion()` 才会报新版本号**；跳过它，横幅和状态接口会一直显示旧版本，下一步的「副本」那条必然报失败。

**3. 跑测试和联动预检** —— 测试和预检分开是为了让「测试挂了」和「版本没对齐」在屏幕上就是两条不同的消息：

```powershell
npm test                  # 9 个文件全绿（= node test/run.mjs）
npm run release:check     # x.y.z / 工作区干净 / 副本 / 在跑的实例
```

预检读的是**磁盘状态**，所以顺序不能倒：它比较的「副本」是第 2 步刚装进去的那一份，「工作区干净」是第 1 步那个提交。此时它仍会报「在跑的实例」不匹配 —— 那是**正常的**，运行中的 harness 还加载着旧副本：

```text
FAIL  running plugin reports the same version
        pluginVersion = 0.1.5, repo → 0.1.6: the running instance still has the old copy loaded — restart the harness
```

所以最后一个动作是**重启 harness**（会中断正在进行的会话，选个时机自己做）。重启后再跑一次 `npm run release:check`，四条应该全绿 —— 那才是「这个版本真的在跑」的证据。

**4. 重启后确认** —— 启动横幅（`$DSH_HOME/auto-update/update.log`）和 `/auto-update/api/v1/status` 的 `pluginVersion` 都应是新版本，再跑 `npm run release:check` 应当四条全绿，然后才进第 5 步。

**5. 打 tag、推、发 Release**：

```powershell
git tag -a v0.1.6 -m "dsh-auto-update 0.1.6"
git push origin main
git push origin v0.1.6
```

（`git push` 要能认证到 `origin`；本机没装 `gh`，所以 Release 在 GitHub 网页上按 tag 创建即可 —— 正文写「这一版改了什么 + 验证怎么做的」，并附上本次 `npm test` 的结论。`RELEASE-NOTES-<tag>.md` 就是为这一步准备的：仓库里留一份，页面正文直接粘贴。）

`npm run release:check` 会明确分开「警告」和「失败」：**没装副本**只是警告（这台机器上本来就没装）；**装了副本但版本对不上**是失败，因为那正是「以为发了、其实没跑」的状态；harness 没在 3080 上应答是跳过（发版机上它可能根本没开）。`--json` 给脚本消费，`--profile` / `--port` 换目标：

```powershell
node scripts/release-check.mjs --profile web --port 3080 --json
```

### 发出去的是什么

| 渠道 | 现状 | 说明 |
| --- | --- | --- |
| GitHub Release（tag `v<x.y.z>`） | ✅ 唯一的发布渠道 | Release 正文写「这一版改了什么 + 验证怎么做的」，并附一行对应的 `npm test` 输出结论；产物就是仓库本身，不额外上传归档 |
| 装进 profile | `dsh plugin --profile web add "file:$PWD"` | 只认 `file:`，没有 npm 包 —— 用户拿到的字节和仓库逐字节相同（`files` 字段决定拷哪些） |
| npm registry | ❌ 刻意不发 | 这个插件会**无人值守地替宿主做全局安装并重启宿主**。把它放到 npm 上，等于给任何一条 `npm install` 装上一段能改写全局环境、并在空闲时自己动手的代码。要用就必须单独设计（scope、`publishConfig`、撤销路径），先不作为发布渠道 |
| `dsh-desktop` 分发件 | 由**插件在运行时**同步 | 桌面端的版本号跟着 harness 的版本走，不跟插件的版本走；它由 `desktop.mode` 在每次 harness 升级时自动刷新，插件发版不触发它（见上面「桌面端同步」） |

### 发布记录

**`CHANGELOG.md` 是发布契约的一部分**：每次发版追加一节 `## [x.y.z] — YYYY-MM-DD`，写清楚三件事 —— 用户看得见的行为变化、这一版的验证结论、以及任何**降级或回滚**所需的信息（配置键改名、状态文件形状变化、助手协议变化）。tag 指到的那个 commit 里的 `CHANGELOG.md` 必须已经包含该版本那一节。

**`RELEASE-NOTES-<tag>.md` 是给 GitHub 页面的正文**：`CHANGELOG.md` 是长期记录（每次追加一节、不删），Release 正文是**这一版单独的说明**（用户点开 Release 页面只看得到这一份）。所以两份都要写，但内容分工不同：Release 正文面向「要不要装/要不要升」，把这一版的变化、验证做法、以及需要用户动手的地方写在最前面；`CHANGELOG.md` 面向「几个月后回查哪个版本干了什么」。仓库里留一份正文（`RELEASE-NOTES-v<x.y.z>.md`），粘贴时不必再组织一次语言。

### 发出去之后发现不对怎么办

- **只是文档/文案错**：`CHANGELOG.md` 里更正，不回收版本号；下一个 patch 版本带上修正。
- **代码错、但装的人不多**：`git revert` 那个提交 → 按普通流程发下一个 patch。**不要**删 tag、也不要重推同名 tag。
- **代码会让装了它的人卡住**（起不来、回滚不了）：在 `CHANGELOG.md` 顶部写一节「已知问题」并给出 `holdVersion` 逃逸方式（配置里锁一个能用的版本，见上面配置表），然后尽快发修复版。
- 插件自己的更新走的是 harness 那套机制（频道 / `minReleaseAgeMinutes` / 冷却），所以**发版不会立刻推到所有人的机器上**；真要紧急停止扩散，靠的就是 `CHANGELOG.md` 的说明 + `holdVersion`。

## 已验证的事实（本机实测）

> 下面是**记录下来的实测输出**，里面的路径来自当时那台机器，换机器当然不一样 —— 值在于结论（哪一项通过），不在于那串路径。

在 3099 端口另起一个同 profile 的 `dsh web`（2026-10-15，插件 0.1.3 / harness 0.2.0-rc.2）：

| 检查 | 结果 |
| --- | --- |
| profile 组合树包含插件行 | ✅ `# == dsh-auto-update` / `- id: auto-update` |
| 宿主进程正常启动 | ✅ `── boot 4880-…: plugin 0.1.3, harness 0.2.0-rc.2, pid 4880, port 3099`，无异常 |
| 启动时清点遗留 plan 文件 | ✅ `pruned 1 finished plan file(s)`（真机清掉了 10 月升级留下的那一份） |
| 状态接口 `/auto-update/api/v1/status` | ✅ `running=installed=0.2.0-rc.2`、`channel=stable`、`restartMode=respawn`、`surfaces={"tool":true,"http":true}` |
| 面板页 `/auto-update/` | ✅ HTTP 200 |
| 全局安装判定 | ✅ `globalInstall=true`，`globalRoot=C:\Users\sheqi\AppData\Roaming\npm\node_modules` |
| 找到 npm | ✅ `D:\其他\Node.js\npm.cmd`（`source: node-dir`，即 node.exe 同目录） |
| 强制检查结论 | ✅ `up-to-date — running the newest stable release (0.2.0-rc.2)` |
| 桌面端巡检 | ✅ `{projectDir: …\dsh-desktop, projectVersion: 0.2.0-rc.2, packagedVersion: 0.2.0-rc.2, action: up-to-date}` |
| 按需桌面端同步接口 | ✅ `POST /api/v1/desktop` → HTTP 200 `status=up-to-date` |
| 全新宿主的浏览器鉴权 | ✅ 无令牌 `GET /` → **401**（dsh 0.2 起如此）；插件自己的路由不受影响（`/auto-update/…` → 200），外壳改为加载 `dsh web:` 打印的带令牌地址 |
| 上一次失败的更新记录 | ✅ 启动时记为 `superseded`（日志：`reconciled: 0.2.0-rc.2 is running — the earlier failed verdict for 0.2.0-rc.2 is superseded`），面板改显示「已被取代」而不是一直挂着失败 |
| 空闲策略 | ✅ 记录 `waiting for an idle window`，deadline = 检测时间 + 3 小时（早前实测） |

### 桌面端那一轮审计（2026-10-15 真机实测，插件 0.1.5）

拿真实的 `dsh-desktop` 项目（`build.directories.output = dist`、`build.files = [main.js, preload.js, renderer/**, assets/**, README.md]`、`productName = DSH Desktop`、版本 0.2.0-rc.2）跑巡检与打包：

| 检查 | 结果 |
| --- | --- |
| 产物发现 | ✅ 输出根 `dist`，认出**两个**产物：`win-unpacked`（asar 形状，`resources/app.asar` 53 280 B，2026-10-15 20:05）与 `DSH Desktop`（未打包形状，2026-10-06）；取最新的那个 |
| asar 读取 | ✅ `readAsar` 在真 asar 上读出 7 个条目 + manifest（`README.md / assets/dsh.ico / main.js / package.json / preload.js / renderer/error.html / renderer/wait.html`，版本 0.2.0-rc.2）—— 双层 pickle 的 header 解析是这一轮修掉的 |
| 产物与项目比对 | ✅ 真实报出 `["main.js","preload.js"]`：产物里 24 382 B 的 `main.js` / 802 B 的 `preload.js` 对不上项目当前的 47 396 B / 7 038 B。**两边版本号都写着 0.2.0-rc.2** —— 只看版本的旧逻辑在这里会说 `up-to-date`，而它其实是一个旧外壳配着一个新 README 的混合产物 |
| zip 完整性 | ✅ 真机 157 927 511 B 的绿色版 zip 判定为完整（EOCD 在尾部 22 B） |
| 真机打包 | ✅ `electron-builder 26.15.3 --win dir` exit 0，写出 `dist/win-unpacked`（`signing with signtool.exe` 是最后一条日志，之后静默成功）。⚠️ 从 PowerShell 里跑 `npm.cmd run dist:dir` 会因为 npm 打在 stderr 的告警被当成 `NativeCommandError` 而看不出真实退出码；插件自己用 `spawn` 读退出码，不受这个影响 |
| 程序在跑时的守卫 | ✅ 真机探测到 `DSH Desktop.exe` 正在运行 → `skipped`，`detail = "DSH Desktop is running; close it and sync again (its files are locked while it runs)"` —— 这条「打包中程序开着会写坏产物」的路真的会被走到 |
| 产物 manifest 带 BOM | ✅ 真机撞到：`DSH Desktop/resources/app/package.json` 以 `\uFEFF` 开头，`JSON.parse` 拒绝 → 产物被读成「没构建过」（版本 `null`）→ 每一轮同步都会重新打包且永远「不达标」。剥掉 BOM 后同一份产物读出 0.2.0-rc.2 |
| 当前真机结论 | ✅ 巡检 `action: package`，`drift = ["README.md (missing from the packaged build)"]`（本轮把 `README.md` 加进了 `build.files`，产物还没重新打），zip 157 927 511 B 完整但比产物旧 —— 三件事都指向「该重打一次」，而**旧逻辑会说 `up-to-date`** |

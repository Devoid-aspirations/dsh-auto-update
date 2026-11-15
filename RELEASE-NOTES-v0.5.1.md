# dsh-auto-update 0.5.1

> 这一份就是 GitHub Release 页面（tag `v0.5.1`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版只改一笔失败的记录，和失败之后机器被留在什么状态。** 检测、频道、面板、桌面端同步都没动。

如果你只在面板上看过一行「npm install exited with code 4294963214」，这一版是来把那行话变成人话的：那是 `-4082` 的无符号写法，真正的句子是 `EBUSY: resource busy or locked, rename '…\@deepseek-ai\dsh\lib' -> '…\.dsh-L8W43X9e\lib'`。

## 为什么会这样

插件原来的顺序是「先装、再请宿主停、最后起回来」。这个顺序在 Windows 上有一条隐藏前提：宿主不占自己的安装目录。

`0.2.2-rc.1 → 0.2.2-rc.3` 那次撞上了：正在运行的 harness 用目录句柄占着 `…\@deepseek-ai\dsh\lib`，npm 在 reify 阶段要把旧包挪开，于是四次尝试四次 `EBUSY`，版本一动没动，冷却到第二天凌晨。日志里唯一能指向真相的是那行 `EBUSY`，而面板上只有退出码。

## 这一版改了什么

- **装了才发现锁，就先停再重试一次。** npm 的失败文本里出现 `EBUSY` / `EPERM` / `resource busy` / `errno -4082` 这类形态时，先请求宿主退出、确认端口空了，再重试安装。
- **判定收窄。** 别的 npm 失败（版本不存在、registry 拒绝）**不会**触发停机：为一个跟锁无关的错误白停一次服务，比失败本身更糟。
- **重试也失败，就把旧版本拉起来。** 停过宿主之后如果安装仍然失败，把还在盘上的那个版本重新拉起、确认它在应答，然后才写 `phase: failed` 和「已重启回 X」。不会留下服务器停了、新版本没装上的半截状态。
- **失败原因写成 npm 自己的话。** 取最后三行 `npm error`（截断到 400 字）写进 `helper.json` 的 `error`，面板和日志都能看见 `EBUSY … rename …`。
- 顺带修正一处读取错误：`installGlobal` 的返回是 `{code, output, lines}`，没有 `stderr` —— 输出被直接流进日志文件了。匹配和摘要现在统一走一个 `failureText()`，不再回读不存在的字段。

## 怎么验证的

`test/helper-e2e.test.mjs` 是**真进程树、真端口**的端到端，假 npm 与假 harness 跑在临时目录里。新增两例：

| 用例 | 断言 |
| --- | --- |
| 锁一次 → 先停后装 | 第一次安装前 `host-stopped=no`，第二次 `host-stopped=yes`；最终 `succeeded`，假 npm 根里的版本是目标版本，端口上应答的是新进程 |
| 锁一次 + 第二次仍失败 | `phase: failed`，`error` 里是 npm 的原因，`detail` 写明「已停宿主重试、旧版本已重新服务」，端口上应答的是旧版本 |

既有的「装失败不改任何东西」一例加了两条断言：错误里要出现 npm 的原因（`E404 fake npm refuses`），并且宿主**从未**被请求停机 —— 这就是「判定收窄」的证据。

`12/12 test files passed`，helper 端到端 8/8。

## 升级方式

用 `dsh plugin --profile web add file:<仓库路径>` 重装副本后重启一次 harness。装好之后它自己会处理剩下的版本。

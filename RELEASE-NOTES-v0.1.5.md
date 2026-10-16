# dsh-auto-update 0.1.5

> GitHub Release 页面正文的仓库留档（与 `CHANGELOG.md` 的 `0.1.5` 一节配套：那一节是长期记录，这份是发布页面的文字）。
>
> **前置条件**：`0.1.5` 发布时**没有打 tag**（`git tag -l` 至今为空）。要在页面上发布这一版，得先补一个指向该版提交的 tag：
>
> ```
> git tag -a v0.1.5 57af5f8 -m "dsh-auto-update 0.1.5"
> git push origin v0.1.5
> ```
>
> 这是**追认**一个已经发出去的版本号，不是重新发布：`57af5f8` 这个提交本身不会改变。

## 这是什么

一个 DSH harness 插件：**让 harness 自己升级自己**。装上之后，升级不再需要你记得去跑什么命令 —— 它自己看频道里有没有新版、等一个不打断你的窗口、装完重启、再确认新版本真的起来了；起不来就回滚。

## 装

```
cd <这个仓库的检出目录>
dsh plugin --profile web add "file:$PWD"
```

`file:` 装进去的是**拷贝**，不是链接：改了源码要 `Remove-Item` 掉 profile 里那份副本再重新 `add`，然后重启 harness 才会生效。

## 它做什么

- **检测**：按频道（stable / 其它标签）看 npm 上的 `@deepseek-ai/dsh`，记录候选版本，并遵守最短发布年龄（默认 60 分钟）——刚发出来的版本不抢着装。
- **等窗口**：默认等到「空闲」才动手，最长推迟 3 小时；也可以配成 `autoApply` 自己选时机。
- **安装**：只动**全局**安装（`globalInstall=true` 才动手），绝不在插件自己的检出目录里装，也绝不自动降级。
- **重启**：装完重启 harness；`restartMode` 默认 `auto`，可选 `respawn` / `exit-only`。
- **验证**：重启后确认端口应答且**报出的版本**就是目标版本。
- **回滚**：验证不通过就装回旧版。

## 桌面端（`dsh-desktop`）

装了桌面包装的话，插件会在每次 harness 升级后把桌面产物同步到同一版本 —— 顺带把它打包出来。它的验收策略是**不看退出码、看产物**：产物版本必须等于目标版本，并且产物的每个文件都要和项目逐字节对得上（asar 里的条目按 header 记的 offset 取字节比 hash），`build.files` 里声明了、产物里却没有的文件同样算不一致。

## 面板与几个入口

- 面板：`/auto-update/`（就是「我现在是什么版本、有什么新版、上次发生了什么」这一页，无构建步骤）。
- 状态：`GET /auto-update/api/v1/status`；日志：`GET /auto-update/api/v1/log`。
- 立刻检查：`POST /auto-update/api/v1/check`；立刻升级：`POST /auto-update/api/v1/apply`；同步桌面端：`POST /auto-update/api/v1/desktop`。
- agent 工具：`auto_update`（`status` | `check` | `apply` | `log`）。
- 进程控制这几种写操作只接受来自本机 loopback、且 `Host` 也是 loopback 的请求（DNS 重绑定挡在外面）。

## 已知限制（当时就存在）

- 升级 harness 必须重启，重启会打断正在进行的对话 —— 所以默认策略是**等窗口**，最长推迟 3 小时。
- 端口被别的进程占用时无法做重启验证，这时结论是 `deferred`（已安装、下次重启生效），不会被误判成失败。
- 插件里的**兼容性闸门**默认是 `block`：`0.2.0-rc.2` 移除了 `@deepseek-ai/dsh-client-runtime`，`0.1.x` 时代的客户端 bundle 会因此 `require` 失败；闸门拦住这类升级，`force` 也绕不过去。这不是 bug，是刻意的。
- 同一个 profile 起两个实例时，第二个会报 `webserver: duplicate prefix route "/auto-update"` —— 面板路由是按前缀注册的，一个实例只能注册一次。

## 验证

- `npm test` → `9/9 test files passed`；整套测试只 import `node:` 内置模块与本仓库文件，没有第三方依赖、没有安装步骤。
- 2026-10-15 真机实测（插件 `0.1.3` / `0.1.5`，harness `0.2.0-rc.2`）：组合树里能看到插件行、状态接口报 `globalInstall=true`；桌面端巡检与真机打包 `electron-builder 26.15.3 --win dir` 退出码 0。两个真机撞出来的坑也记在 README 里：产物 `package.json` 带 UTF-8 BOM 会被 `JSON.parse` 拒绝；`DSH Desktop.exe` 正在运行时打包会被跳过。
- 最贵的一次教训（就是这一版修掉的）：早先的回滚判定只看「端口有没有一直应答」，一次启动窗口里读不到版本号，就把一个**健康的** `0.2.0-rc.2` 重新装回了旧版。现在的判定是「起着但无法确认」（`verified: false`）**不回滚**。

**完整记录**：[`CHANGELOG.md`](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/CHANGELOG.md) · **发布流程**：[README 的「Releases」一节](https://github.com/Devoid-aspirations/dsh-auto-update/blob/main/README.md#releases)

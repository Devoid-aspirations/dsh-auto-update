# dsh-auto-update 0.2.1

> 这一份就是 GitHub Release 页面（tag `v0.2.1`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版修的是检测本身**：在能解析到 `undici` 的机器上，更新检查从来没连上过 `registry.npmjs.org`。

`news` / `auto_update check` / 面板上的「立即检查」全都显示「registry 不可达」，而同一台机器上 `curl`、`Invoke-WebRequest`、`node -e fetch(...)` 都能正常取到元数据。真相是插件交给内置 `fetch` 的 `dispatcher` 来自**副本自己的** `undici`（profile 的 `node_modules` 里有 `undici@8.10.0`，被别的插件带进来的），而 Node 24 内置 `fetch` 用的是它**自带**的那份 undici —— 两份实现之间的 `ProxyAgent` 不被承认，请求在发出之前就被拒绝了：

```
TypeError: fetch failed
  cause: UND_ERR_INVALID_ARG: invalid onRequestStart method
```

于是所有检查都停在 `registry-unreachable`，也就永远发现不了新版本。

## 装 / 升

```
cd <这个仓库的检出目录>
dsh plugin --profile web add "file:$PWD"
```

`file:` 装进去的是**拷贝**：改了源码要删掉 profile 里那份副本再 `add`，然后重启 harness 才生效。

## 你会看到什么变化

- 检查会真的连上 registry。`check.ok` 变 `true`，`check.candidate` 里出现候选版本，状态接口的 `check.error` 消失。
- 代理仍然生效：有 `HTTPS_PROXY` 等环境变量时请求走代理；代理这条路失败时会**退一步直连**再试一次，两条路都失败才报错，错误信息里带上两条路各自的原因。
- 配置键、状态文件形状、助手协议、面板、按钮**都没有变化**。

## 它是什么

`lib/registry.js` 里那次「把代理配给 fetch」的改动：

- `proxyDispatcher()` 现在返回**一对**东西 —— 代理用的 dispatcher 和**同一份 undici 的** `fetch`，两者一起用；只有拿不到 undici 时才退回全局 `fetch`，此时不配 dispatcher（全局 `fetch` 自己会读 `NODE_USE_ENV_PROXY`）。
- `fetchPackument()` / `fetchTaggedVersion()` 在代理这条路失败后，会用全局 `fetch` 直连再试一次，并把两条路的原因拼进同一条错误信息 —— 之前代理配错就永远看不到「其实直连能通」。
- 包名按 npm 的规则编码（`@scope/name` → `@scope%2Fname`），与文档里写的一致。

## 验证

- 从 profile 副本目录（也就是真会出问题的那种布局）跑同一条路径：`dist-tags` 与 `@deepseek-ai/dsh@next` 都取到了 `0.2.1-rc.2`；修复前同样位置是 `UND_ERR_INVALID_ARG`。
- **`test/registry.test.mjs`（新增）**：代理成功时不碰直连、代理失败后退到直连、两条都失败时错误信息同时包含两条原因、包名编码、环境变量优先级（`HTTPS_PROXY` → `https_proxy` → `ALL_PROXY` → `all_proxy` → `HTTP_PROXY` → `http_proxy`）。
- `npm test` → `11/11 test files passed`（本机 Windows，node v24）。

## 降级 / 回滚

退回 `0.2.0` 就回到「检测永远失败」。没有状态迁移，也没有配置迁移。

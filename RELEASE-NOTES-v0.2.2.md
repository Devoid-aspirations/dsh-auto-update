# dsh-auto-update 0.2.2

> 这一份就是 GitHub Release 页面（tag `v0.2.2`）的正文，仓库里留档一份，粘贴时不必再组织一次语言。

**这一版修的是兼容性闸门的误判**：它把一个完全正常的版本判成了「会弄坏 GUI 的升级」。

`0.2.1` 让检测终于连上 registry、也找到了 `0.2.1-rc.2`，但判定是 `plugin-incompatible`，理由写着「5 个 profile 插件硬依赖它移除的包」，而那份移除名单里有两百多个名字 —— 从 `cordis-plugin-group`、`cosmokit` 一直到 `dsh-client-ui-primitives`。这些包并没有消失。

根因是**两边比的不是同一层**：闸门拿「已安装的 `node_modules/@deepseek-ai/`」（本机 250 个包，含全部传递依赖）去减「目标版本 `package.json` 的 `dependencies`」（86 条直接依赖）。宿主把客户端包**传递**地装进来，于是在这个减法里每一个传递依赖都成了「目标版本不再提供」。闸门真正该抓的信号 —— `@deepseek-ai/dsh-client-runtime` 这类确实被移掉的包 —— 恰好也是传递依赖，所以这个错误算法当初误打误撞拦对了一次，之后便一路误报。

## 装 / 升

```
cd <这个仓库的检出目录>
dsh plugin --profile web add "file:$PWD"
```

`file:` 装进去的是**拷贝**：改了源码要删掉 profile 里那份副本再 `add`，然后重启 harness 才生效。

## 你会看到什么变化

- 本机 profile 里那 5 个「硬依赖 `primitives`」的客户端插件不再被当成阻断项，`0.2.1-rc.2` 的判定回到 `update`，按空闲策略自己安装。
- 状态接口的 `check.compatibility.removed` 里只剩真正被移除的包（这次是空的）。
- 配置键、状态文件形状、助手协议、面板、按钮**都没有变化**。

## 它是什么

判定从「集合相减」换成「**问 registry：目标版本还发不发这个包**」：

- `@deepseek-ai/*` 与宿主锁步发版，所以 `@deepseek-ai/<名字>@<目标版本>` 存在，就等于它随这次升级进树；不存在才是真的被移除。`missingFromTarget()` 就是这个判定，探针由调用方注入（测试可替身），探针自己出错时**不算移除** —— 沉默是安全方向。
- 候选名单只取客户端插件真正提到的名字：`dsh.client.inject` 与 bundle 里**字面量**的 `require("@deepseek-ai/…")`。本机实测 8 个客户端插件共 14 个名字，每个一次轻量请求，不再去猜那 250 个包里的每一个。
- 运行期拼出来的名字（`["@deepseek-ai/dsh-client", "-store"].join("")`）只认字面量、不做猜测 —— 取片段会得到 `dsh-client` 这种从未存在的包名，它的「不存在」会被读成「被移除」。
- `check.js` 不再从 packument 的 `dependencies` 推算移除名单；`removedPackages` 保留为闸门的计算结果。

## 验证

- **拿本机真实 profile 跑新判定**：8 个客户端插件、14 个引用（`dsh-client-ui-primitives`、`dsh-client-ui-sidebar`、`dsh-api-remotes` …），对 `0.2.1-rc.2` 与 `0.2.0-rc.2` 都是 **removed: none**；而 `@deepseek-ai/dsh-client-runtime`（最高只到 `0.1.x`）仍然可得，真移除照样拦得住。
- **`test/compat.test.mjs`（新增 3 个用例）**：引用收集只认 `require` 字面量与 `inject`、`missingFromTarget` 只把目标版本不发布的包判成移除、探针抛错时不判移除。
- `npm test` → `11/11 test files passed`（本机 Windows，node v24）。

## 降级 / 回滚

退回 `0.2.1` 会回到「传递依赖被当成移除、闸门误拦」的行为。没有状态迁移，也没有配置迁移。

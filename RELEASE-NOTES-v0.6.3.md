## 一句话

`0.6.2` 的入口检查把「没写扩展名」当成了「文件不在」，于是一次**本来成功的安装被判成失败**，还白跑了一遍 npm。这一版按 Node 的规则解析入口。

## 这次修的是什么

11 月 27 日 19:43 那次升级（`0.2.2-rc.3` → `0.2.2-rc.5`）装是装上了，过程却很难看：

```
19:47:25  npm install @deepseek-ai/dsh@0.2.2-rc.5 exited with code 0
19:47:28  the tree is not complete yet: the entry file(s) are not on disk yet
          (@eslint-community/regexpp/index, ms/./index, ms/./index, …) — letting npm finish
19:49:48  npm install … exited with code 0        ← 白整装了一遍，两分钟
19:49:51  the install is incomplete: …; npm reported success anyway
          the harness was stopped for the install; 0.2.2-rc.3 is serving again  ← 假的
```

三个后果都能看出来：

1. `helper.json` 记成 `phase: failed`，而那一刻真正在服务的就是装好的 `rc.5`；
2. `detail` 里那句「`0.2.2-rc.3` 又在服务」是错的 —— 盘上已经是 `rc.5`；
3. 助手多起了一个替换进程（`pid 28792`），抢不到 3080 就退出了。

两个原因都在新代码里：`existsSync` 不会补扩展名（`ms` 声明 `"main": "./index"`、`@eslint-community/regexpp` 声明 `"main": "index"`，盘上都是 `index.js`），健康检查又拿错了要比对的版本号。

## 现在的判定

- 入口解析按 Node 来：原样 → `.js` / `.mjs` / `.cjs` / `.json` / `.node` → 目录则 `index.*`；
- 树根先用 `resolve()` 归一：调用方传正斜杠时，后面的路径前缀比较不再全部失配（那种情况下 470 个嵌套依赖会被误判成「没解包」）；
- 替换进程起来后按**盘上实际版本**验证，`detail` 写真正在服务的那个版本。

## 验证

- `test/tree.test.mjs` 10 → 11 例：`"main": "./index"` 与 `"main": "index"` 配 `index.js` 必须算完整；
- 真机只读复核：`inspectTree(<全局 dsh>, '@deepseek-ai/dsh', '0.2.2-rc.5')` → `ok=true`，639 个包、91 个直接依赖全部解析；
- 全量 `node test/run.mjs`：13/13 个测试文件通过。

## 升级方式

```powershell
dsh plugin --profile web add "file:D:\其他\deepseekharness\programone\dsh-auto-update"
```

然后重启一次 harness（新代码只在进程启动时加载）。

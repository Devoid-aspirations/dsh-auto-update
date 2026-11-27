## 一句话

装完不再只问「文件在不在」，而是**先让这棵树启动一次** —— 起不来就不去停那个还在服务的宿主。

## 这次修的是什么

11 月 27 日晚上，自动升级连失败两次。第一次（本地 18:24）是半棵树：替换进程 6 秒后死于 `ERR_MODULE_NOT_FOUND`。`0.6.1` 为此加了「按整棵树算」，但同一天第三次尝试（19:21）仍然没能拦住：

```
19:23:34  0.2.2-rc.5 is in the manifest but the tree is still being written
          (14 of 91 dependency package(s) are not unpacked yet …)
19:23:46  0.2.2-rc.5 is on disk while npm is still running — not waiting for npm to exit
19:23:57  boot 15436: plugin 0.6.1, harness 0.2.2-rc.5
19:24:01  the replacement exited with code 1
```

那一版留下的 428 KB 启动诊断里，致命行全是**嵌套依赖**缺失：

```
ERR_MODULE_NOT_FOUND … dsh-goal\node_modules\zod\v4\core\util.js
```

`dsh-goal` 在盘上，但 `dsh-goal` 自己依赖的 `zod` 还没解完 —— 而 `0.6.1` 只检查那 91 个直接依赖。同理，指纹只看 `dsh/node_modules` 的条目数和目录 mtime，npm 往更深处写的时候它一动不动。

## 现在的判定顺序

1. **递归**：每个已落盘的包，它自己声明的依赖都要按 Node 的规则能解析，声明的入口（`main` / `bin` / `exports`）都要在盘上；
2. **稳定**：这份遍历指纹连续两轮（约 8 秒）不变；
3. **能启动**：`node <安装目录>/lib/bin.js --version` 真的跑一次，加载与真实启动相同的模块图、不占端口。

三段都过才叫装完。任何一段没过就继续等 npm，日志写清卡在哪一段。等到 npm 退出还是起不来，助手**不会去停正在服务的宿主**，直接记 `phase: failed` 并写 `the installed tree does not boot: …`。

顺带把 `helper.json` 里一处自相矛盾也修了：回滚之后 `installedVersion` 曾经仍然写着那个装失败的版本号。

## 验证

- `test/tree.test.mjs`：6 → 10 例（嵌套缺失、hoist 解析、嵌套入口缺失、嵌套写入移动指纹）；
- `test/helper-e2e.test.mjs`：新增「装得上但起不来的树，宿主一次都不会被要求停」；
- 全量 `node test/run.mjs`：13/13 个测试文件通过。

## 升级方式

```powershell
dsh plugin --profile web add "file:D:\其他\deepseekharness\programone\dsh-auto-update"
```

然后重启一次 harness（新代码只在进程启动时加载）。

## 已知未做

`0.2.2-rc.5` 本身还没装上：它先前失败四次、冷却到本地 01:03。这一版把判定修对了，但能否装上仍要它自己跑一次才知道 —— 本版不做任何仓库或环境侧的绕行。

# Phase 5 交付手册（打包 + 安装式验收 + 分发通道）

## 交付定义

**「可发布」= 装进 profile 能跑，跑起来行为正确**——不是包打得出来。交付物 = 标准 bundle + 证据（静态校验 + 运行时证据 + QA-REPORT）。

## 标准 bundle 结构

```
<plugin>/
├── package.json            # name/version/type:module/main/files + dsh.bundle.patch
├── cordis.patch.yml        # 组合包层：行按包名引用入口（禁绝对路径）
├── index.js                # 入口（JS 直载；TS 项目为构建产物，源在 src/）
├── src/                    # TS 源码（npm 发布可不含；tarball / git 必含）
├── dev/cordis.yml          # 开发覆盖层（绝对路径直载源码）
├── README.md               # Quickstart：安装 → 启动 → 验证，命令可逐条复制执行
├── qa/                     # 证据附件（可选随包）
│   ├── cases.yaml          # 机读用例库（M3）
│   └── QA-REPORT.md        # 交付质量报告（合规 + 运行时 + 场景 + 未覆盖项声明）
└── LICENSE
```

## package_plugin.js 流程（M2；未就绪时按本手册手工等效执行）

校验（复用 validate_plugin.js，**单一真相源**）→ 构建（如 TS）→ 打包（tgz 或发布就绪目录）→ **打包后验收**：

### [E] 包干净度（五层）

1. 清单完整（`files` 所列全部存在）；
2. 无杂质（`.DS_Store` / `*.map` 视策略 / 备份文件 / 空目录）；
3. `package.json` 完备（`dsh.bundle` / `files` / `type: module` / version / license）；
4. 清单与 `files` 一致；
5. 构建产物与源码版本一致（version 戳一致）。

### [F] 安装式可发布性

1. 净目录临时 profile（`__verify_<name>`）；
2. `dsh plugin --profile __verify_<name> add <包>`；
3. `dsh --profile __verify_<name> --dump-config` 确认 `# == <包名>` 层出现；
4. （环境允许时）启动冒烟，捕获加载日志；
5. **强制清理**临时 profile——清理失败 = 报错留痕。

验收结论三档：**通过**（0 error 0 warn）/ **带警告通过**（0 error，warn 已列出）/ **不通过**（存在 error，附阻断清单，退出码 1 不可交付）。报告末尾强制「未覆盖项」段，禁止静默通过。

## 分发通道操作要点

| 通道 | 命令 | 要点 |
|---|---|---|
| npm 发布 | `pnpm publish`（先构建） | `files` 只含产物 + patch + README；用户 `dsh plugin add <pkg>` 无构建授权 |
| tarball | `pnpm pack` | 用户 `dsh plugin add ./<pkg>-<ver>.tgz`；检查 tgz 内容 = `files` 声明 |
| git 安装 | 用户 `dsh plugin --profile <p> add github:<you>/<repo>#<sha>` | 作者：自包含 `prepare`（不依赖 monorepo 上下文，参考 turtle-ui 的专用 tsdown 配置）；用户：`pnpm-workspace.yaml` 写 `allowBuilds: <pkg>: true` + 锁 commit。README 必须写明：授权 = 允许该包代码在安装时于本机执行（不在 agent 沙箱内），只对可信源码授权 |

## 常见假失败清单（先查这里，再怀疑包）

| 现象 | 真因 | 处置 |
|---|---|---|
| 校验器报「不在正确位置」 | 校验器位置约束只认安装目录；`/tmp` 解压校验必然失败 | 就地校验加 `--skip-path-check`；可发布性用 [F] 安装式证明 |
| git 安装后加载失败 | 拉的是源码，`prepare` 缺失 / 不自包含 | 补自包含 `prepare`；用户侧确认 `allowBuilds` |
| 首次 `add` 报错 | pnpm ≥10 默认拒绝运行 git 依赖构建脚本 | 按 dsh 提示把包键写进 `allowBuilds` 后重试 |
| dump-config 看不到自己的层 | 层序在后层被按行整体替换 | 检查更高优先级层是否重述了同一行 id；覆盖须重述整行 |
| 覆盖只改了部分键却整行失效 | patch 替换整个 `config` 值（非深合并） | 重述该行需要的每一个键 |
| 工具行为变了但代码没变 | 用户层 / home 层 patch 覆盖 | `--dump-config` 逐层比对 |

## 交付门禁

打包成功 + 打包后验收通过（前两档）+ 记账成功（`ledger.js add` 退出码 0）→ 交付。任一不满足 = 未交付，如实通报。

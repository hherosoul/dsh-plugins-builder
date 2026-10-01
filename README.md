# dsh-plugins-builder

DeepSeek Harness（dsh）元工程师插件：把「一个能力需求」通过五阶段门禁流水线
（构思 → 设计 → 开发 → 测试优化 → 打包交付）收敛为**可安装、可运行、行为正确的
dsh 插件（bundle）**，全程规则 ID 化质检 + 运行时证据链 + 安装式验收。
方法论 SSOT：[references/methodology.md](references/methodology.md)；
平台契约 SSOT：[references/dsh-spec.md](references/dsh-spec.md)。

## Quickstart

1. Install the checkout into a profile (first use initializes the profile with `@deepseek-ai/dsh-base`):

```sh
dsh plugin --profile demo add .
```

2. Verify the layer without booting (expect a `# == dsh-plugins-builder` layer):

```sh
dsh --profile demo --dump-config
```

3. Boot and verify (expect `[plugins-builder] registered 7 tools` in the terminal, and the seven `plugin_*` tools available in the session):

```sh
dsh --profile demo
```

Remove again with `dsh plugin --profile demo remove dsh-plugins-builder`.

## Development (no packaging)

The dev overlay loads the source entry directly by absolute path. First create the
overlay from the example (the example carries placeholder paths and a copy-me header;
`dev/cordis.yml` is gitignored so local edits never leak into commits):

```sh
cp dev/cordis.example.yml dev/cordis.yml   # then fix the absolute path inside to this checkout
```

Then boot with the overlay:

```sh
pnpm dsh web --patch ./dev/cordis.yml   # inside a dsh source checkout
dsh web --patch ./dev/cordis.yml        # with the dsh CLI installed
```

## Tools

| 工具 | 后端脚本 | 用途 | 状态 |
|------|----------|------|------|
| `plugin_init` | `scripts/init_plugin.js` | 脚手架：6 类模板生成 dsh bundle | M1 可用 |
| `plugin_validate` | `scripts/validate_plugin.js` | 静态规则 ID 质检（支持 `--policy`） | M1 可用 |
| `plugin_guide` | （读取 `references/`） | 按主题返回方法论细则 | M1 可用 |
| `plugin_verify` | `scripts/verify_plugin.js` | 运行时验证矩阵（L1–L3+L5 自动化，L4 手工协议），证据落 `qa/evidence/` | M2 可用 |
| `plugin_package` | `scripts/package_plugin.js` | 打包 + 打包后验收（[E]+[F]），三档结论 | M2 可用 |
| `plugin_ledger` | `scripts/ledger.js` | 交付台账（bootstrap/add/latest/align/advise） | M2 可用 |
| `plugin_qa_report` | `scripts/qa_report.js` | 聚合证据 → QA-REPORT.md（层矩阵 / 轮次回归 diff / 九维度待判定表 / 强制未覆盖项；判定归模型） | M3 可用 |

七个工具全部落地。六个脚本类工具按官方渲染意图契约声明 **terminal 卡片**
（`presentCall` / `presentResult` 返回 card 标签联合，`presentationMeta` 持久化退出码供
回放），均为 args(+result) 的纯函数；`plugin_guide` 走通用卡片回退。`plugin_verify` /
`plugin_package` 支持 `background: true`（经 `ctx.jobs.start` 转后台作业，规范值返回
`{ kind: 'background', jobId }` 句柄；无 jobs 服务时诚实报错，回退同步路径）。

## Configuration

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `workspaceRoot` | `''`（空 = 宿主进程 cwd） | 相对路径参数的锚点目录 |
| `dshBin` | `''`（空 = 自动定位） | `plugin_verify` / `plugin_package` 使用的 dsh CLI 路径 |

### dsh CLI 定位（为什么不是裸 `dsh`）

运行时层（L3 / L5 / [F]）需要 dsh CLI。桌面版是主要分发形态，它把 CLI 放在**应用包内**
（`<app>/Contents/Resources/runtime/cli/bin/dsh`），默认**不**放进 PATH——所以「PATH 上没有」
不等于「环境不支持」。定位顺序（`scripts/_run.js`）：

1. `--dsh <path>`（工具参数 `dshBin`）/ 环境变量 `$DSH_BIN`
2. PATH 上的 `dsh`
3. 由本进程推导的**应用内置 CLI**
4. 常见安装位置：`/usr/local/bin`、`~/.local/bin`、`~/Library/pnpm`、`/opt/homebrew/bin`

全部失败才降级（exit 3），并在证据里给出 `cli-not-found`（哪里都没有）或 `cli-broken`
（找到了但 `--version` 不成功）**以及每个候选路径的结果**。工具形态可直接传参：

```jsonc
// plugin_verify / plugin_package 的 dshBin 参数，或在 cordis.yml 里配 config.dshBin
{ "target": "<plugin-dir>", "dshBin": "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" }
```

## 里程碑诚实声明

- M3（`plugin_qa_report`）已落地：纯聚合脚本，机器可算的（层矩阵、轮次回归 diff、
  验收摘要）由脚本产出；九维度**判定**归模型，报告结论列留 ☐ 待判定；「未覆盖项」
  段强制存在（证据未覆盖项 + 已知盲区，永不静默）。
- M2 工具（`plugin_verify` / `plugin_package` / `plugin_ledger`）已可用，但运行时层
  （L3 / L5 / [F]）依赖 dsh CLI；**无可用 CLI** 的环境诚实降级（exit 3），运行时验证
  未执行、交付未达可发布标准，报告中显式声明「未覆盖项」+ 已探测的候选清单，
  并区分 `cli-not-found` 与 `cli-broken`（详见 Configuration → dsh CLI 定位）。
- `verify_plugin.js` 的 L4 行为项（工具调用 / 非法配置 / HMR / 取消）为手工协议，
  证据 JSON 内含步骤清单；判定归 LLM，脚本不冒充自动化。
- 后台模式（`background: true`）的 jobs 契约（`JobSpec` / `JobHandle` / `JobHooks`）
  依据官方 cookbook 与 jobs 子系统文档字面核对实现；**未在 dsh 宿主内做过运行时
  实测**，属于已知未覆盖项（同步路径已实测）。规范值永不截断；超长输出仅在
  render 层做展示截断（全文保留在规范值与证据 JSON 中）。

## Environment requirements

- Node ≥18（脚本为零构建 ESM，零第三方依赖；`package_plugin.js` 另用系统 `tar` 列包内容）；`dsh` CLI（安装与启动）。
- CLI 不在 PATH 上时（桌面版默认如此），用 `$DSH_BIN` 或工具参数 `dshBin` / 脚本参数 `--dsh <path>` 指定；应用也自带「安装命令行工具」把 `dsh` 装到 `/usr/local/bin`。
- 启动本插件无需 API key；对生成插件做模型级行为验证时需要已配置的模型。

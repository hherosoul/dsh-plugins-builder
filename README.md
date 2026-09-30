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

The dev overlay loads the source entry directly by absolute path:

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
| `plugin_qa_report` | `scripts/qa_report.js` | 聚合证据 → QA-REPORT.md | M3 未就绪 |

六个脚本类工具按官方渲染意图契约声明 **terminal 卡片**（`presentCall` / `presentResult`
返回 card 标签联合，`presentationMeta` 持久化退出码供回放），均为 args(+result) 的纯函数；
`plugin_guide` 走通用卡片回退。

## Configuration

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `workspaceRoot` | `''`（空 = 宿主进程 cwd） | 相对路径参数的锚点目录 |

## 里程碑诚实声明

- M3 工具（`plugin_qa_report`）当前如实返回结构化 `{"status":"unavailable",...}`
  （退出码 2），**不假装可用**。
- M2 工具（`plugin_verify` / `plugin_package` / `plugin_ledger`）已可用，但运行时层
  （L3 / L5 / [F]）依赖 dsh CLI；无 dsh CLI 的环境诚实降级（exit 3），运行时验证
  未执行、交付未达可发布标准，报告中显式声明「未覆盖项」。
- `verify_plugin.js` 的 L4 行为项（工具调用 / 非法配置 / HMR / 取消）为手工协议，
  证据 JSON 内含步骤清单；判定归 LLM，脚本不冒充自动化。

## Environment requirements

- Node ≥18（脚本为零构建 ESM，零第三方依赖；`package_plugin.js` 另用系统 `tar` 列包内容）；`dsh` CLI（安装与启动）。
- 启动本插件无需 API key；对生成插件做模型级行为验证时需要已配置的模型。

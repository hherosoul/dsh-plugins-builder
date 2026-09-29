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
| `plugin_init` | `scripts/init_plugin.py` | 脚手架：6 类模板生成 dsh bundle | M1 可用 |
| `plugin_validate` | `scripts/validate_plugin.py` | 静态规则 ID 质检（支持 `--policy`） | M1 可用 |
| `plugin_guide` | （读取 `references/`） | 按主题返回方法论细则 | M1 可用 |
| `plugin_verify` | `scripts/verify_plugin.py` | 运行时验证矩阵 L2–L5 | M2 未就绪 |
| `plugin_package` | `scripts/package_plugin.py` | 打包 + 打包后验收（[E]+[F]） | M2 未就绪 |
| `plugin_ledger` | `scripts/ledger.py` | 交付台账 | M2 未就绪 |
| `plugin_qa_report` | `scripts/qa_report.py` | 聚合证据 → QA-REPORT.md | M3 未就绪 |

## Configuration

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `pythonBin` | `python3` | 脚本解释器（脚本仅依赖 Python 标准库） |
| `workspaceRoot` | `''`（空 = 宿主进程 cwd） | 相对路径参数的锚点目录 |

## 里程碑诚实声明

- M2/M3 工具（`plugin_verify` / `plugin_package` / `plugin_ledger` / `plugin_qa_report`）
  当前如实返回结构化 `{"status":"unavailable",...}`（退出码 2），**不假装可用**。
- 运行时验证（L2–L5）依赖 dsh CLI / node / pnpm；无 dsh CLI 的环境仅静态校验可用，
  交付未达可发布标准，报告中显式声明「未覆盖项」。

## Environment requirements

- Python 3（脚本零第三方依赖）；`dsh` CLI（安装与启动）。
- 启动本插件无需 API key；对生成插件做模型级行为验证时需要已配置的模型。

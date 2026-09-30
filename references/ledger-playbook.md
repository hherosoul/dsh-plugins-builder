# 台账手册（ledger）

> 台账回答一个问题：**这个插件上次交付是什么状态、改了什么、验收结论如何**。
> `ledger.js` 为 M2 里程碑（已可用：bootstrap / add / latest / align / advise）。

## 存储：本地为主，云端为可选通道

- 本地根目录：`$DSH_HOME/dsh-plugin-ledger/`（未设置 `DSH_HOME` 时回退 `~/.dsh/dsh-plugin-ledger/`，运行时解析，**不依赖个人绝对路径**）。
  - `LEDGER.md`：人读账本（全量历史，一行一次动作）。
  - `ledger.jsonl`：机读事件流（与 LEDGER.md 互为镜像，供脚本聚合）。
- 云端（宿主团队空间能力）为**可选通道**：`bootstrap` 在宿主提供时绑定同名空间；未提供时本地台账完整可用，**不得谎称已同步云端**。

## 字段（每次记账必填）

| 字段 | 说明 |
|---|---|
| 时间 | 本地时区 ISO 时间 |
| 插件名 | 包名（`dsh-<name>`） |
| 版本 | package.json version |
| 动作 | `create` / `update` / `package` / `deliver` |
| 变更说明 | 引用 QA 轮次与通过率（如「Phase 4 第 2 轮，9/9 维度通过」） |
| 验收结论 | 通过 / 带警告通过 / 不通过（附阻断规则 ID） |
| 环境覆盖档 | 全量（L1–L5）/ 无密钥（L1–L3+L5）/ 无 CLI（L1–L2，未达可发布标准） |

## 命令（M2 形态）

优先调用本插件的 `plugin_ledger` 工具；CLI 回退：

```
node <dsh-plugins-builder 安装目录>/scripts/ledger.js bootstrap          # 首次召唤：绑定（幂等）
node <dsh-plugins-builder 安装目录>/scripts/ledger.js add --pkg <插件目录> --note "<改了什么>" --verdict 通过|带警告通过|不通过 --tier full|no-key|no-cli [--act create|update|package|deliver]
node <dsh-plugins-builder 安装目录>/scripts/ledger.js latest             # 当前态视图：每插件一行
node <dsh-plugins-builder 安装目录>/scripts/ledger.js align              # 双向并集对齐（幂等）
node <dsh-plugins-builder 安装目录>/scripts/ledger.js advise             # 契约巡检天数 + 待办
```

- `add` 七字段必填（时间 / 插件名 / 版本自动取自 package.json；动作默认 `update`），
  缺字段 = 用法错误（退出码 2）；写入后回读验证，失败退出码 1。
- `advise` 的巡检阈值天数 SSOT 在 `ledger.js` 的 `INSPECTION_THRESHOLD_DAYS` 常量，
  文档不写具体数字；巡检基准日期取 `validate_plugin.js` 的 `PLATFORM_CONTRACT_VERSION.last_inspected`。

## 纪律

1. **记账铁律**：任何创建 / 修改插件，交付前必须 `add`；`add` 退出码非 0 不得宣称交付完成。
2. **历史不删**：行数多了靠分层（archive）消化，不靠删历史——历史是账本唯一的价值。
3. **归属铁律**：只写本工具自己的台账空间；交付出去的插件**不代建台账**。
4. **契约巡检联动**：`advise` 每次召唤报告「距上次巡检天数」；超过阈值产出待办——对照 `dsh-spec.md` 附录页面清单逐页核对契约变化，产出「契约漂移报告」（变了什么 / 影响哪些已交付插件（台账反查）/ 待办清单）。

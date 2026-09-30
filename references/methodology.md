# 方法论 · 五阶段插件开发流水线

> 本文档是 dsh-plugins-builder 的方法论 SSOT。
> 本工具的宿主形态是 **DSH bundle 插件**：方法论通过插件注册的 7 个工具落地
> （`plugin_init` / `plugin_validate` / `plugin_verify` / `plugin_package` /
> `plugin_qa_report` / `plugin_ledger` / `plugin_guide`）；
> CLI 回退时直接调用 `<dsh-plugins-builder 安装目录>/scripts/` 下的脚本。
> 平台契约 SSOT 见 `dsh-spec.md`（带版本戳 + 巡检制度）。

## 角色定义

dsh-plugins-builder 是一名「元工程师」：交付物不是代码片段或报告，而是**另一个
DeepSeek Harness（dsh）插件（bundle）**——可安装、可运行、行为正确、证据可回放。
它把「一个能力需求」通过五阶段门禁流水线（构思 → 设计 → 开发 → 测试优化 → 打包交付）
收敛为交付物，全程带方法论、带阶段门禁、带规则 ID 化质检、带运行时证据链。
验收含义是「**装进 profile 能跑，跑起来行为正确**」，不是「包打得出来」。

## 工具与脚本对照

| 工具 | 后端脚本 | 用途 | 状态 |
|------|----------|------|------|
| `plugin_init` | `init_plugin.js` | 初始化插件目录（`kind=minimal\|tool\|config\|service\|event-hook\|seam-trio`） | M1 |
| `plugin_validate` | `validate_plugin.js` | 静态合规校验（规则 ID；`--policy` 自定义验收、`--skip-path-check` 就地校验、`--trust-append` 放行第三方 append） | M1 |
| `plugin_verify` | `verify_plugin.js` | 运行时验证矩阵编排（L1–L3+L5 自动化；L4 手工协议），证据 JSON 落 `<target>/qa/evidence/` | M2 可用 |
| `plugin_package` | `package_plugin.js` | 校验 → 构建 → 打包 → 打包后验收（[E] 干净度 + [F] 安装式） | M2 可用 |
| `plugin_qa_report` | `qa_report.js` | 聚合机读用例结果 + 运行时证据 → QA-REPORT.md（判定归 LLM，脚本只聚合） | M3 未就绪 |
| `plugin_ledger` | `ledger.js` | 交付台账：bootstrap / add / latest / align / advise | M2 可用 |
| `plugin_guide` | （直接读 `references/`） | 按主题返回方法论细则 | M1 |

未就绪脚本（当前仅 `qa_report.js`）输出结构化 `{"status":"unavailable",...}` 并以
退出码 2 结束——**如实告知用户该能力属于哪个里程碑，禁止用临时手段冒充**。

**调用纪律（路径）**：优先调用插件工具（脚本路径由插件运行时解析，杜绝相对路径与
硬编码绝对路径）；CLI 回退一律写 `<dsh-plugins-builder 安装目录>` 占位风格：

```
node <dsh-plugins-builder 安装目录>/scripts/init_plugin.js ...
```

## 五阶段 SOP

### Phase 1 — 构思
产出：一句话定位、**能力类型判定**（工具插件 / 服务插件 / 事件钩子 / LLM 适配器 /
命令或设置卡片 / seam 三件套）、目标 profile、包名（`dsh-` 前缀 kebab-case）、差异化说明。
先定「新行为归属」再定形态——归属表见 `design-spec.md`；命名规则见 `naming-playbook.md`；
平台契约速览见 `dsh-spec.md`。
**门禁**：定位清晰；能力类型与归属明确；包名合规；差异化明确。

### Phase 2 — 设计
产出：架构决策记录（单包 vs 三角色拆分，**默认单包**，拆分必须给独立演进理由）、
`inject` 依赖图、Config schema 设计、事件域选择（会话事件 vs Cordis 事件；waterfall
标注 `next()` 义务）、工具 DSL 设计（parameters / output.schema 规范值 / render /
presenters / 后台任务）、patch 行设计（行 id、insert 还是覆盖、默认值策略）、分发通道决策、
文档架构设计。详见 `design-spec.md`。
**门禁**：架构决策有理由；Config 覆盖全部可调参数（检验问句：能否只在 `cordis.yml`
改值而不改代码？）；工具契约五要素齐备；行 id 唯一且语义化。
**条件式卡点**：依赖外部能力（外部 API / 模型密钥 / 文件系统之外资源）时，设计稿必须附
「任务 → 归属（脚本 / LLM / 平台原生）」表 + 外部能力三档盘点（原生支持 / 可降级并写明
路径 / 做不到就明说），缺一不放行。

### Phase 3 — 开发
```
plugin_init(name=<name>, kind=tool, path=<工作目录>)
# CLI 回退：
node <dsh-plugins-builder 安装目录>/scripts/init_plugin.js <name> --kind minimal|tool|config|service|event-hook|seam-trio --path <工作目录>
```
填充 `index.js`（或 TS 源）、`package.json`、`cordis.patch.yml`、`dev/cordis.yml`、
README Quickstart。
本地闭环：`pnpm dsh web --patch ./dev/cordis.yml`（源码仓库内）或 `dsh web --patch ...`
（已装 CLI）→ 终端确认加载日志。
**门禁**：构建 0 错误；加载成功（有日志证据）；无占位符；无硬编码密钥与个人绝对路径；
`export const name` 与行设计一致。

### Phase 4 — 测试优化
```
plugin_validate(target=<插件目录>)          # 静态 · 规则 ID（M1 可用）
plugin_verify(target=<插件目录>)            # 运行时 · 分层实证（M2 可用）
```
静态合规 + 运行时验证矩阵（L1–L5）+ 9 维度场景质检 + 迭代（失败 → 定位代码 / 配置 /
文档 → 最小改动 → 复测，≤3 轮）+ 回归。详见 `qa-playbook.md`（含证据 JSON 格式与
「未覆盖项」规范）。每轮结果落成机读证据；**任何改动后重放全量用例并 diff 上一轮**。
**自定义验收标准**：`--policy <yaml>` 可覆盖 / 豁免方法论阈值（B 类，豁免须带 reason
且报告可见）；平台契约（A 类）拒绝覆盖。格式：`validate_plugin.js --policy-help`。
**门禁**：校验 0 error + 运行时矩阵（环境允许的全部层）通过 + 9 维度通过；未过回退
Phase 2/3。

### Phase 5 — 打包交付
```
plugin_package(target=<插件目录>)           # M2 可用
plugin_ledger(action=add, target=<插件目录>, note="<改了什么>", verdict=<通过|带警告通过|不通过>, tier=<full|no-key|no-cli>)
```
`package_plugin.js`（M2 可用）在打完包后**自动执行打包后验收**：
- **[E] 包干净度（五层）**：清单完整 → 无杂质 → `package.json` 完备（`dsh.bundle` /
  `files` / `type` / version / license）→ 清单与 `files` 一致 → 构建产物与源码版本一致。
- **[F] 安装式可发布性**：净目录临时 profile → `dsh plugin add <包>` →
  `dsh --profile <tmp> --dump-config` 确认层出现 →（环境允许时）启动冒烟 → 清理。
  **「可发布」= 装进去能用，不是包打得出来。**

验收结论三档：**通过**（0 error 0 warn）/ **带警告通过** / **不通过**（附阻断清单）。
报告末尾强制「未覆盖项」段，禁止静默通过。无 dsh CLI 时 [F] 无法执行，整次运行
环境降级（exit 3），不得宣称交付。
**门禁**：打包成功 + 打包后验收通过（前两档）+ 记账成功 → 交付。

### 收工 — 记账

任何创建 / 修改插件后，**交付前**必须记一行账：

```
plugin_ledger(action=bootstrap)
plugin_ledger(action=add, target=<插件包路径>, note="<改了什么>")
```

台账本地为主（`$DSH_HOME/dsh-plugin-ledger/`）：`LEDGER.md` 人读 + `ledger.jsonl`
机读事件流；字段、命令与诚实降级见 `ledger-playbook.md`。`add` 退出码非 0 不得宣称
交付完成。

## 退出码语义（全脚本统一）

| 码 | 含义 |
|----|------|
| 0 | 通过（含带警告通过） |
| 1 | 有 error / 验收不通过 |
| 2 | 用法错误 / 里程碑未就绪（unavailable） |
| 3 | 环境降级：运行时层未执行（无 dsh CLI；verify / package 专属）——未达可发布标准 |

## 铁律（决策前必读）

**平台铁律**（A 类，来自 dsh 契约，全文见 `dsh-spec.md`）：规范值铁律（`execute` 只返回
`output.schema` 声明的规范 JSON 值；内容块只出自 `render`；抛异常或非法返回 = `isError`）、
瀑布铁律（waterfall 监听器必须调用 `next()`）、纯函数铁律（render 与 presenters 无 I/O /
时钟 / 随机）、渲染意图铁律（`presentCall` / `presentResult` 返回 card 标签的封闭联合
——generic / terminal / diff；UI 格式不为 UI 进入规范值；回放绝不崩溃）、模型可见即已记录、
信号铁律（遵守 `exec.signal`；后台任务发布 id 后改用任务自有取消信号）、副作用铁律
（手动资源必须进 `ctx.effect()`）、配置铁律（无硬编码可调参数；配置错误要响亮；不导出
普通对象作 Config）、层序铁律（patch 按行整体替换；bundle 层按包名引用；绝对路径只许
出现在开发覆盖层）、manifest 铁律（`dsh.bundle` 与 `dsh.profile` 互斥，没有东西同时是
两者；应用参数不是 patch 层）、拆分铁律（不预防性拆分）、策略铁律（部署策略走
`tools/pre-execute` / `ctx.tools.guard()` 等钩子，不内建进工具）、PTC 铁律（PTC mode 经
`await tools.<name>(args)` 取得的是规范 JSON 值而非渲染文本，`output.schema` 必须设计成
实用的程序化 API）。

**工程铁律**（本工具自身纪律）：
- **SSOT**：任何规范只定义一次，其余位置只放指针；文档预算以 `validate_plugin.js` 的
  `DOC_BUDGET` 常量为唯一事实来源，文档中不写具体数字。
- **脚本化边界**：只脚本化「计算 / 变换」；「识别 / 匹配」（意图、实体、语义）留给
  LLM。判定问句与灰区裁决表见 `design-spec.md`。
- **路径纪律**：脚本一律由插件工具运行时解析调用；CLI 回退只写
  `<dsh-plugins-builder 安装目录>` 占位风格；杜绝相对路径与硬编码绝对路径。
- **凭据铁律**：包内严禁真实 Token / 密钥；一律配置字段或 `${VAR}` 占位。
- **记账铁律**：交付前必须 `ledger.js add`；退出码非 0 不得宣称交付完成。
- **发布卫生**：示例一律占位符；包内无个人绝对路径与账号标识；二进制剥元数据。
- **诚实降级**：环境做不到的验证显式声明「未覆盖」，禁止静默通过、禁止谎报。
- **Dogfooding**：里程碑收工用自身流水线校验自身；自身包过不了自己的校验 = 阻断发布。

## 契约漂移防线

dsh 处于技术预览期。开工前查 `dsh-spec.md` 版本戳；距上次巡检过久
（`ledger.js advise` 会报告天数）→ 按其附录页面清单逐页核对官方文档 → 发现漂移
同步改三处且只改三处：`dsh-spec.md`（契约）+ `validate_plugin.js`（规则）+ 受影响模板，
一次改动一个原子提交，账本记录。

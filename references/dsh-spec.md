# dsh 平台契约（SSOT · 带版本戳）

> **契约版本戳**（契约漂移防线；巡检后更新此处，规则与模板同步）
> - 官方文档根：`https://deepseek-harness.github.io/deepseek-harness/`
> - contract_version：**2026-10-01**（契约快照 = 官方文档巡检日期）
> - last_inspected：**2026-10-01**
> - 巡检页面清单：见文末附录（11 页）
> - 漂移处置：同步改三处且只改三处——本文档（契约）+ `validate_plugin.js`（规则）+ 受影响模板

dsh 的扩展体系建立在 Cordis 之上：**产品的每一部分都是插件**（模型适配器、工具注册表、会话日志、agent loop 本身），没有特权内核。

## 1. 插件形态（三种）

插件是导出 `apply` 的 TS 模块；框架加载时调用 `apply(ctx)`，`inject` 声明的必需服务就绪后才执行。

```ts
// ① 函数形式（大多数场景够用）
import type { Context } from '@deepseek-ai/cordis'
export const name = 'my-plugin'
export const inject = ['tools']
export function apply(ctx: Context) { /* 注册能力 */ }

// ② 对象形式
export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) { /* ... */ },
}

// ③ 类形式（需要向其他插件提供服务时用）
import { Service, type Context } from '@deepseek-ai/cordis'
export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) {
    super(ctx, 'myService')   // 第二参数 = 服务名
    // 构造函数里做同步初始化
  }
}
```

## 2. 副作用与自动清理

通过 `ctx` 注册的一切（`ctx.on` / `ctx.tools.register` / `ctx.llm.registerAdapter` / 定时器）在卸载时**自动逆序清理**，无需手动 removeListener。

手动资源（网络连接等）必须包进 `ctx.effect()` 并返回处置器：

```ts
ctx.effect(() => {
  const conn = openConnection()
  return () => conn.close()   // 卸载时执行
})
```

有顺序依赖的清理放进**同一个**处置器串行执行。

## 3. 生命周期

Fiber 状态机：`PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`（或 `FAILED`）。
- 必需服务（`inject`）消失 → 插件自动卸载，服务恢复后自动重载。
- 可选依赖用 `ctx.get('x')?.`，不进 `inject`。
- 支持 HMR 热替换；config 变更触发 HMR。

## 4. 工具 DSL（defineTool）

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'echo',
  description: '…让模型知道何时该调用、何时不该；写清边界…',
  parameters: {
    text: { type: 'string', required: true, description: '要回显的文本' },
  },
  output: {
    schema: { type: 'string' },                       // 规范值的形状
    render: (_args, value) => [{ type: 'text', text: value }],  // 模型可见内容
  },
  async execute(args, exec) {
    if (exec.signal.aborted) throw new Error('aborted')
    return '规范 JSON 值'                              // 必须符合 output.schema
  },
}))
```

硬契约：
- **规范值铁律**：`execute` 只返回 `output.schema` 声明的**规范 JSON 值**；内容块只出自 `render`；抛异常或非法返回 = `isError`。注册表把返回值快照为无损 JSON、校验并冻结后才传给 `render(args, value)`。成功的领域结果即使表示不理想状态（如进程非零退出）也写入规范值，由渲染器解释。
- **执行身份**：`arguments` 在策略开始前物化为冻结的无损 JSON；`callId` / `name` / `arguments` / `agent` / `exec.token` / `exec.signal` 全程不可变；`args` 是只读输入。异步通知用 `exec.agent.inject(...)`（须 try/catch 防已 dispose 的 agent）。
- **纯函数铁律**：`render` 与 UI 卡片 `presentCall` / `presentResult` / `presentationMeta` 是 args(+result) 的**纯函数**——无 I/O、无时钟、无随机（回放场景不得崩溃）。
- **渲染意图**：`presentCall(args)` / `presentResult(args, { content, isError, meta? })` 返回 **card 标签的可辨识联合**——调用侧 `generic`（title/kind/rawInput/content/locations）/ `terminal`（title/description?/cwd?）/ `diff`（diffs: [{path, oldText, newText}]）；结果侧 `generic` / `terminal`（output?/exitCode?/signal?）/ `diff` / `read` / `search` / `web`（文件读取、代码检索与网页抓取类工具的结果视图，事实经 `result.meta` 派生）。联合是封闭的；无展示方法回退通用卡片；畸形输入软校验回退（回放绝不崩溃）。UI 格式（```console 围栏、diff、相对化路径）不为 UI 进入规范值或 Native 内容；终端回退格式归 bridge。
- **presentationMeta**：`output.presentationMeta(args, value)` 从规范值派生可回放 JSON，核心持久化在 `tool/result` 并传给 `presentResult`——结果期卡片事实（如已应用 hunk、退出码）靠它在回放重现，无需持久化规范值。
- **信号铁律**：遵守 `exec.signal`；长任务在关键点检查 `aborted`；后台任务由 producer 配置控制 `run_in_background`，用 `ctx.jobs.start({ kind, label, owner: exec.agent, run })` 注册，成功分支返回规范句柄（如 `{ kind: 'background', jobId }`）；发布任务 id 后改用**任务自有取消信号**（外层信号只停止等待）。
- **参数形状**：显式对象节点必须声明 `additionalProperties: true|false`；隐式参数根对象保持开放。注册借用只读定义——注册后不得修改 schema 或替换回调。
- **策略铁律**：部署策略走钩子，**不内建进工具**——`tools/pre-execute`（允许/拒绝/询问）、`ctx.tools.guard()`（最终单调拒绝）、`tools/execute`（截止时间/重试/指标）、`tools/post-execute`（替换/阻止/附加上下文）、`tools/result`（观测不可变结果）。
- **PTC mode**：每个已注册工具自动经 `await tools.<name>(args)` 可达；成功解析为策略处理后的**规范 JSON 值**（非渲染文本），失败以 `ToolCallError` reject（只可查 name/toolName/message）。因此 `output.schema` 要设计成实用的程序化 API：直接返回句柄与字段；标量/数组/null 确是结果时允许相应根类型；人类解释归 `render`。

## 5. 配置（Config）

导出**同名** `Config` 接口 + Schemastery schema，成对出现；默认值写在 schema；加载时校验，**配置错误要响亮**；不导出普通对象作 Config。

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string; verbose?: boolean }
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) { /* ... */ }
```

- 链式 API：`.required()` / `.default(...)` / `.union([...])`。
- 纪律：**凡部署间可能不同的参数一律配置化，无硬编码可调参数**；默认值从宽，约束交 schema。
- config 变更触发 HMR。

## 6. 事件系统

四种模式：`ctx.emit`（广播）/ `ctx.bail`（否决）/ `ctx.serial`（串行链）/ `ctx.waterfall`（流水线）。

**瀑布铁律**：waterfall 监听器**必须调用 `next()`**，否则短路流水线：

```ts
ctx.waterfall('agent/pre-step', async (_input, next) => {
  const data = await next()      // 必须
  return { ...data }             // 返回处理后的值
})
```

- 事件名 = `namespace/action`（如 `tools/result`、`agent/pre-step`、`session/event`）。
- 类型合并（TS）：

```ts
declare module '@deepseek-ai/cordis' {
  interface Events { 'ns/action': (payload: P) => void }
}
```

- **持久会话事实**（模型可见的轮次 / 工具调用记录）走会话事件：监听 `session/event` 并按 `event.type` 分流（`turn/*`、`tool/call`、`tool/result`）；**实时扩展**走 Cordis 事件。
- **运行时不变量**：「模型可见即已记录」——新增模型可见输入必须新增会话事件并从日志渲染；投影必须走 `ctx.sessionProjections` seam。

## 7. 服务与依赖

- 必需依赖：`inject = ['tools']`（函数 / 对象）或 `static inject`（类）；框架保证就绪后才加载。
- 可选依赖：`ctx.get('x')?.`。
- 必需服务消失 → 自动 dispose，恢复后重载。
- 服务名由类形式 `super(ctx, '<serviceName>')` 注册；消费方 `inject` 同名服务。

## 8. 能力 seam（三角色）

Service **Definition**（拥有服务名 + Request/Result 类型）/ **Provider**（实现并发布）/ **Consumer**（注入使用）。

**拆分铁律**：不要预防性拆分——只有角色需要**独立演进**（不同发布节奏 / 不同复用面）时才拆三包；默认单包。

## 9. 打包与安装

两种 manifest，都由 `package.json` 描述，`dsh` 键下携带：
- **组合包（bundle）**：附带一个配置层的 npm 包，`dsh.bundle` 回答「这个包贡献什么」。
- **profile**：`$DSH_HOME/profiles/<name>` 下、描述一份可启动组合的目录，`dsh.profile` 回答「由哪些组合包按什么顺序组成」。没有东西同时是两者。

profile 目录含两个文件：`package.json`（树外插件依赖，交 pnpm 管理）+ `cordis.patch.yml`（用户自己的 patch 层，在所有组合包层之后应用）。profile manifest **从不需要手写**：`dsh --profile <name> --from-default-profile <template>` 从应用模板创建，`dsh plugin` 创建以 `@deepseek-ai/dsh-base` 为底的 profile 并维护 `dsh.profile.bundles` 有序列表。**应用参数不是另一层 patch**；表层组合包通过自有服务解析它们。内置组合包名称始终从 dsh 安装目录本身解析（pnpm 只管树外包），故组合包可放心依赖 `@deepseek-ai/dsh-base` 存在。

### 表层组合包持有自己的命令行

定义可运行应用的组合包挂载一个普通提供方插件（如 `name: '<pkg>/startup'`）：该插件导出 `inject = ['cmdlineArgs']`，用自己的 commander program 调用 `@deepseek-ai/dsh-cmdline` 的 `parseCmdline`，在 program 的 action 中把应用自有服务提供出去。启动器把自身 flag 之后的同一份**不可变参数**交给每个插件——添加应用专属 flag 无需改启动器。受这些参数配置的行注入提供方服务，在自己的 `!!js` 选项中读取它，并把部署取值写在旁边作回退（如 `port: !!js ctx.myAppStartup.port ?? 8080`）。遇到 `--help` 时提供方不发布服务，这些行不激活。

### 组合包形状（官方 hello 基线）

```
hello-plugin/
├── package.json          # declares dsh.bundle
├── cordis.patch.yml      # 被 profile 列出时应用的层
└── index.js              # patch 行引用的插件模块
```

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml —— 行按包名引用（Node 模块解析找到已安装代码）
- insert:
  - id: hello
    name: dsh-hello-plugin
```

无 `dsh.bundle` 声明的包仍可安装，但只作普通依赖（供插件包 import，不被用户启用）。

### 开发覆盖层（免打包直载源码）

```yaml
# <plugin>/dev/cordis.yml —— 路径必须绝对
- insert:
  - id: hello
    name: '/abs/path/to/<plugin>/src/index.ts'
```

```sh
pnpm dsh web --patch ./<plugin>/dev/cordis.yml   # 源码仓库内；装了 CLI 则 dsh web --patch ...
```

### 安装与层序

```sh
dsh plugin --profile demo add ./hello-plugin
dsh --profile demo --dump-config    # 出现 "# == dsh-hello-plugin" 层
dsh --profile demo                  # 启动
```

生效配置在空根之上按序逐层组合：
1. `dsh.profile.bundles` 所列各组合包 patch（先 `@deepseek-ai/dsh-base`，后按加入顺序）；
2. profile 自己的 `cordis.patch.yml`；
3. home 级 `$DSH_HOME/cordis.patch.yml`；
4. 每个 `--patch <path>` overlay（按 argv 顺序）。

**层序铁律**：后应用的层**按行整体替换**（替换目标行整个 `config` 值，非深度合并）→ 推论：
- 按 `id` 覆盖前层行时，必须**重述该行需要的每一个键**；
- 用户可在自己的 patch 层覆盖你的行 → 组合包给「用户大概率保留」的默认值，其余交 schema。

### 分发三通道

| 通道 | 要点 |
|---|---|
| npm 发布（预构建） | `pnpm publish` 前构建好产物；`dsh plugin add <pkg>` 装的是预构建代码，无需构建授权 |
| tarball | `pnpm pack` → `dsh plugin add ./<pkg>-<ver>.tgz`；同样无需构建授权 |
| git 安装 | 拉的是**源码**——作者必须提供**自包含** `prepare` 脚本（不依赖 monorepo 上下文）；用户须在 profile `pnpm-workspace.yaml` 写 `allowBuilds: <pkg>: true` 授权并**锁定 commit**（`github:you/x#<sha>`）；授权 = 允许该包代码在安装时于本机执行 |

## 10. 附录：官方文档索引（契约巡检范围）

| 页面 | 契约内容 |
|---|---|
| 第一个插件 `develop/basic/` | apply / ctx / inject / effect / 三种形态 / 覆盖层 |
| 开发一个 Tool `develop/basic/tool` | defineTool 基础 |
| 插件配置 `develop/basic/config` | Config / Schemastery / 设计原则 / HMR |
| 打包与安装 `develop/basic/publish` | bundle / profile / 层序 / 三通道 / prepare / allowBuilds |
| 插件与生命周期 `develop/framework/` | Fiber 状态机 / 自动清理 / 嵌套上下文 / HMR |
| 服务与依赖 `develop/framework/service` | Service / inject / 可选依赖 / 隔离 |
| 事件系统 `develop/framework/events` | emit / bail / serial / waterfall / 类型合并 |
| 能力分层 `develop/practice/` | seam 三角色 / 拆分判据 |
| 架构总览 `reference/` | ctx 键 / 事件域 / 轮次流程 / 新行为归属表 |
| 工具编写参考 `reference/cookbook/adding-a-tool` | execute 约定 / 后台任务 / 策略钩子 / PTC / 卡片 |
| Cordis 教程 `develop/cordis-tutorial/` | 无密钥动手环境（运行时验证备选路径） |

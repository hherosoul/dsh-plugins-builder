# 命名库（包名 / 行 id / 服务名 / 事件名）

> 命名单一事实来源。`init_plugin.py` 按本表自动派生；手工修改后须重跑校验。

## 包名（package.json `name`）

- 形态：`dsh-<plugin-name>`；`<plugin-name>` 为 kebab-case（`^[a-z0-9][a-z0-9-]*[a-z0-9]$`，≥2 字符）。
- 前缀 `dsh-` 是官方约定（校验器 PKG-004 检查）；作用域包（组织发布）可 `@scope/dsh-<name>`。
- 禁止：大写、下划线、尾随连字符、与内置组合包重名（`@deepseek-ai/dsh-base` 等）。

## 行 id（patch 行的 `id`）

- 语义化短名：`hello`、`echo-tool`、`github-tool-policy`。
- 全包唯一（用户层按 id 覆盖你的行；id 冲突 = 行为被静默替换）。
- 与包名的关系：包名 `dsh-<x>` → 行 id 惯用 `<x>` 或 `<x>-<role>`（表层组合包多行时按角色区分，如 `hello-startup`）。

## 插件名（`export const name`）

- 等于裸插件名（去 `dsh-` 前缀），如包 `dsh-hello-plugin` → `name = 'hello-plugin'`。
- 加载日志前缀用 `[<name>]`，便于 L3 加载验证时 grep。

## 服务名（类形式 `super(ctx, '<svc>')`）

- camelCase 名词：`myService`、`echoService`。
- 消费方 `inject = ['<svc>']` 或 `ctx.get('<svc>')?.` 用同一名字——服务名是跨包契约，改名 = 破坏性变更，须记账说明。

## 事件名（`namespace/action`）

- 小写，`/` 分层：`tools/result`、`agent/pre-step`、`session/event`。
- 自定义事件域用插件名做 namespace：`<plugin>/action`（类型合并声明进 `Events` 接口）。
- 持久会话事实用会话事件（`turn/*`、`tool/call`、`tool/result`，经 `session/event` 按 `event.type` 分流），不自造平行记录通道。

## 工具名（defineTool `name`）

- 动词开头、snake 或 kebab 全注册表一致；模型可见，必须自解释（`search_issues`、`render_chart`）。
- 与行 id 不必相同，但建议同源以便追踪。

## profile 与临时环境

- 开发 profile：`demo` / `dev-<plugin>`。
- 安装式验收临时 profile：`__verify_<name>`（双下划线前缀 = 机器所有，验证后强制清理）。

## 派生规则（init_plugin.py 实现）

| 输入 | 派生 |
|---|---|
| `<name>`（用户输入，自动 kebab 化） | 目录名 = `<name>` |
| | 包名 = `dsh-<name>`（已有 `dsh-` 前缀则不重复） |
| | 行 id = `<name>` |
| | 插件名（`export const name`）= `<name>` |
| | 类名（service 模板）= PascalCase(`<name>`) |

// DSH Plugin Validator - validates DeepSeek Harness plugins against the
// platform contract (also dogfoods on this meta-engineer package itself).
//
// Architecture (M1):
//     - dsh plugin mode only: target is a directory with package.json
//       (PKG/PATCH/TS/TOOL/CFG/DEP rule families + shared SEC/DOC).
//     - Rule identity layer: every checkpoint has a stable ID (CHECKS registry).
//       Output format: [ID][severity] message. IDs make waivers, precise
//       references, cross-version diffs and ledger records possible.
//     - Categories: A = platform contract (never overridable),
//                   B = methodology threshold (overridable via --policy),
//                   C = scenario dimensions (droppable with reason).
//     - Heuristic rules are warn-level and say so (semantic re-check belongs
//       to Phase 4); the validator never pretends certainty it does not have.
//       Source scanning uses the zero-dependency lexer in scripts/_analyze.js
//       (token-level, comment/string-safe, balanced-block scoped) — still a
//       lexer, not an AST; known approximations are documented there.
//     - Exit codes: 0 pass; 1 errors found; 2 usage error.
//
// Usage:
//     node validate_plugin.js <path/to/plugin-dir> [--policy <file>]
//                        [--skip-path-check] [--trust-append]
//     node validate_plugin.js --policy-help

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  balancedEnd, extractBlocks, memberAccesses, propValueBlock, stringValues, tokenize,
} from './_analyze.js'
import { isMain, runMain } from './_cli.js'

// ---------------------------------------------------------------------------
// 平台契约版本戳：校验器内置的 dsh 契约快照。每次官方规范巡检后更新此处，
// 巡检日期一并记录。校验输出以 info 级打印，供「契约漂移」审计。
// ---------------------------------------------------------------------------
export const PLATFORM_CONTRACT_VERSION = {
  spec_url: 'https://deepseek-harness.github.io/deepseek-harness/develop/basic/',
  contract_version: '2026-09-30',
  last_inspected: '2026-09-30',
  bundle_shape: 'package.json(dsh.bundle.patch) + cordis.patch.yml + index.js; type:module',
  layers: 'bundles 顺序 -> profile patch -> $DSH_HOME patch -> --patch overlay；按行整体替换',
  manifests: 'dsh.bundle 与 dsh.profile 互斥（没有东西同时是两者）；应用参数不是 patch 层',
  presentation: 'presentCall/presentResult 返回 card 标签渲染意图（generic/terminal/diff），纯函数',
}

// ---------------------------------------------------------------------------
// 文档预算（SSOT）。所有文档一律指针引用本常量，禁止在文档中写具体数字。
// 总量阈值：md_total_warn = 基数 + 单包增量；error = warn × 2。
// ---------------------------------------------------------------------------
const DOC_BUDGET = {
  md_total_base: 10,
  md_total_per_member: 4,
  resident_warn: 5000,
  resident_error: 10000,
}

// 占位符扫描（DOC-001）：命中即 error。scripts/ 与 templates/ 白名单豁免——
// 那里是占位符机制的实现与模板生成器所在，属「示例文件中的合法占位符」。
// '.py' 保留：被校验的第三方包可能仍是 Python 实现。
const PLACEHOLDER_PATTERNS = ['[TODO', '[TBD', 'FIXME', 'XXX', '<占位', '待补充']
const PLACEHOLDER_SCAN_EXTS = new Set(['.md', '.json', '.py', '.txt', '.yaml', '.yml'])
const SOURCE_EXTS = new Set(['.js', '.ts'])

// '__pycache__' 保留：被校验包可能含 Python 缓存目录。
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__'])

// 需要 inject 声明的已知服务键（TS-003 启发式；语义复核归 Phase 4）
const KNOWN_SERVICES = ['tools', 'llm', 'jobs', 'session', 'sessionProjections', 'cmdlineArgs']

// ---------------------------------------------------------------------------
// 规则身份层：CHECKS 是全部检查点的唯一注册表。
// 新增检查点必须先在这里领 ID。sev = 默认严重级；cat = A/B/C。
// ---------------------------------------------------------------------------
export const CHECKS = {
  // --- LOC-* / DET-* · 位置与识别 ---
  'LOC-002': { sev: 'error', cat: 'A', msg: 'Directory not found: {path}' },
  'LOC-003': { sev: 'error', cat: 'A', msg: 'Not a directory: {path}' },
  'DET-001': { sev: 'error', cat: 'A', msg: '无法识别目标：缺少 package.json（不是 dsh 插件目录）' },
  // --- PKG-* · package.json / manifest（dsh 模式） ---
  'PKG-001': { sev: 'error', cat: 'A', msg: 'package.json: {reason}' },
  'PKG-002': { sev: 'error', cat: 'A', msg: 'package.json: dsh.bundle.patch 缺失或文件不可达: {detail}' },
  'PKG-003': { sev: 'error', cat: 'A', msg: "package.json: name 须为 kebab-case（≥2 字符），got '{name}'" },
  'PKG-004': { sev: 'warn', cat: 'B', msg: "package.json: name '{name}' 缺 'dsh-' 前缀（官方约定 dsh-<plugin-name>）" },
  'PKG-005': { sev: 'error', cat: 'A', msg: "package.json: 'type' 必须为 'module'，got '{value}'" },
  'PKG-006': { sev: 'error', cat: 'A', msg: "package.json: 'files' 未覆盖 {missing}（patch 与入口产物必须随包发布）" },
  'PKG-007': { sev: 'warn', cat: 'B', msg: 'package.json: 建议字段缺失: {missing}（version/license/description/README）' },
  'PKG-008': { sev: 'error', cat: 'A', msg: "package.json: main 入口 '{main}' 不存在且无构建脚本（scripts.build/prepare）——组合包不可安装" },
  'PKG-009': { sev: 'warn', cat: 'B', msg: "package.json: main 入口 '{main}' 尚未构建（已声明构建脚本）——发布前先构建；开发期可用 dev/ 覆盖层直载源码" },
  'PKG-010': { sev: 'error', cat: 'A', msg: 'package.json: dsh.bundle 与 dsh.profile 不可同时声明——组合包与 profile 是两种互斥 manifest，没有东西同时是两者' },
  // --- PATCH-* · cordis.patch.yml / dev 覆盖层 ---
  'PATCH-001': { sev: 'error', cat: 'A', msg: '{file}: 不可解析或不是 patch 数组: {reason}' },
  'PATCH-002': { sev: 'error', cat: 'A', msg: '{file}: 行 id 重复: {row_id}' },
  'PATCH-003': { sev: 'error', cat: 'A', msg: '{file}: bundle 层禁止绝对源码路径（行 {row_id}: {name}）——bundle 层按包名引用；绝对路径只许出现在 dev/ 覆盖层' },
  'PATCH-004': { sev: 'warn', cat: 'B', msg: '{file}: 行 {row_id} 声明 config——层序按行整体替换（非深合并），覆盖方必须重述该行每个键' },
  'PATCH-005': { sev: 'warn', cat: 'B', msg: '{file}: 行 {row_id} 的 name 不是绝对路径（dev 覆盖层应绝对路径直载源码入口）' },
  'PATCH-006': { sev: 'warn', cat: 'B', msg: 'dev/ 覆盖层缺失（开发期建议 dev/cordis.yml 绝对路径直载源码，见 design-spec.md）' },
  'PATCH-007': { sev: 'error', cat: 'A', msg: "{file}: patch 行缺少 'id' 或 'name'（第 {index} 行）" },
  // --- TS-* · 入口模块静态 ---
  'TS-001': { sev: 'error', cat: 'A', msg: '入口 {path}: 未找到插件入口形态（导出 apply 函数 / 含 apply 的默认对象 / extends Service 类）' },
  'TS-002': { sev: 'warn', cat: 'B', msg: "入口 {path}: 未找到 'export const name'（建议显式声明插件名；类形式经 super(ctx, ...) 命名则忽略）" },
  'TS-003': { sev: 'warn', cat: 'B', msg: "入口 {path}: 使用 ctx.{svc} 但 inject 未见 '{svc}'（启发式；语义复核归 Phase 4）" },
  // --- TOOL-* · defineTool 约定 ---
  'TOOL-001': { sev: 'error', cat: 'A', msg: 'defineTool {path}: 五要素不齐，缺 {missing}（name/description/parameters/output/execute）' },
  'TOOL-002': { sev: 'error', cat: 'A', msg: 'defineTool {path}: output 缺 schema 或 render（规范值与渲染必须成对声明）' },
  'TOOL-003': { sev: 'warn', cat: 'B', msg: 'defineTool {path}: description 过短（{length} 字符 < 20）——模型依赖 description 判断调用时机' },
  'TOOL-004': { sev: 'warn', cat: 'B', msg: 'defineTool {path}: 显式对象节点未声明 additionalProperties（启发式；语义复核归 Phase 4）' },
  'TOOL-005': { sev: 'warn', cat: 'B', msg: 'defineTool {path}: execute 疑似返回内容块而非规范值（模式级；语义复核归 Phase 4）' },
  // --- CFG-* · 配置纪律 ---
  'CFG-001': { sev: 'error', cat: 'A', msg: '{path}: Config 接口与 Schema 必须成对导出（现仅见 {found}）' },
  'CFG-002': { sev: 'warn', cat: 'B', msg: '{path}: 疑似硬编码可调参数（{literal}）——部署间可能不同的参数一律配置化（语义复核归 Phase 4）' },
  'CFG-003': { sev: 'warn', cat: 'B', msg: "{path}: 必填配置 '{field}' 无默认值——README 必须说明用户如何提供" },
  // --- SEC-* · 安全与卫生 ---
  'SEC-001': { sev: 'error', cat: 'A', msg: '{path}: 疑似硬编码凭据（模式级命中: {pattern}）——包内严禁真实 Token / 密钥，须用配置字段或 ${{VAR}} 占位（语义级复核归 Phase 4 维度 9）' },
  'SEC-002': { sev: 'error', cat: 'A', msg: '{path}: 个人绝对路径（{literal}）——包内禁止；dev/ 覆盖层是唯一例外（平台契约要求绝对路径）' },
  'SEC-003': { sev: 'warn', cat: 'B', msg: '{path}: 疑似真实数据（邮箱模式: {literal}）——示例一律占位符（语义级复核归 Phase 4 维度 9）' },
  // --- DOC-* · 文档 ---
  'DOC-001': { sev: 'error', cat: 'A', msg: '文档含占位符: {path}:{line} 命中 {pattern}' },
  'DOC-002': { sev: 'warn', cat: 'B', msg: 'README 缺 Quickstart 段（安装 → 启动 → 验证，命令可逐条复制执行）' },
  'DOC-003': { sev: 'warn', cat: 'B', msg: '文档指针悬空: {path} 引用的 {target} 不存在' },
  'DOC-004': { sev: 'warn', cat: 'B', msg: '文档预算: md 文件 {total} 个 > 目标值 {limit}（SSOT：脚本 DOC_BUDGET）' },
  'DOC-005': { sev: 'error', cat: 'B', msg: '文档预算: md 文件 {total} 个 > 上限 {limit}（同一触发时机的文档应合并）' },
  // --- DEP-* · 依赖健康 ---
  'DEP-001': { sev: 'warn', cat: 'B', msg: '{path}: import 了 {pkg} 但 package.json 未声明（宿主提供的包应放 peerDependencies）' },
  'DEP-002': { sev: 'warn', cat: 'B', msg: 'package.json 声明 repository（git 分发）但缺自包含 prepare 脚本——git 安装拉源码不构建，用户侧会加载失败' },
  'DEP-003': { sev: 'warn', cat: 'B', msg: 'prepare 脚本疑似依赖 monorepo 上下文（{pattern}）——必须自包含' },
  'DEP-004': { sev: 'warn', cat: 'B', msg: "package.json: '@deepseek-ai/*' 位于 dependencies，建议移入 peerDependencies（宿主运行时提供，避免双份实例）" },
  'DEP-005': { sev: 'warn', cat: 'B', msg: 'package.json: 宿主包 {pkg} 范围 {range} 在 0.x 上锁定次版本——宿主升级（如 0.1→0.2）后即不满足（semver 下 ^0.1 只匹配 0.1.x），建议放宽或改用 *' },
  // --- APP-* · policy append ---
  'APP-001': { sev: 'error', cat: 'A', msg: 'policy append 脚本执行失败: {script}（{reason}）' },
  'APP-002': { sev: 'warn', cat: 'B', msg: 'policy append 已禁用：当前为第三方 / --skip-path-check 就地校验，执行被校验包内脚本属代码执行面。确需执行请加 --trust-append' },
}

// 未覆盖项：脚本没有规则覆盖的检查面，显式声明归属，禁止静默通过。
const UNCOVERED_ITEMS = [
  ['运行时行为（加载 / 调用 / HMR / 取消）', 'verify_plugin.js L2–L5（M2 已可用；L4 行为项为手工协议，见其证据报告的未覆盖项）'],
  ['调用准确性（混淆矩阵）', 'Phase 4 维度 1（LLM 层；无密钥环境降级为 description 语义评审）'],
  ['凭据 / 隐私语义级审计', 'Phase 4 维度 9（脚本只做模式级扫描）'],
  ['启发式规则语义复核（TS-003 / TOOL-004 / TOOL-005 / CFG-002）', 'Phase 4（LLM 层）'],
  ['安装式可发布性', 'package_plugin.js [F]（M2 已可用；无 dsh CLI 环境降级为 exit 3，未达可发布标准）'],
]

const VALID_SEVERITIES = ['error', 'warn', 'info']

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function isDict(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Python 真值语义：空数组 / 空对象亦为假。
function pyTruthy(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false
  if (typeof v === 'number' && Number.isNaN(v)) return false
  if (Array.isArray(v) && v.length === 0) return false
  if (isDict(v) && Object.keys(v).length === 0) return false
  return true
}

// Python str.format 子集：{key} 替换；{{ / }} 转义为字面 { / }。
function formatMsg(template, params) {
  let out = ''
  let i = 0
  const n = template.length
  while (i < n) {
    const ch = template[i]
    if (ch === '{') {
      if (template[i + 1] === '{') { out += '{'; i += 2; continue }
      const end = template.indexOf('}', i + 1)
      if (end < 0) { out += ch; i += 1; continue }
      const key = template.slice(i + 1, end)
      out += String(params[key])
      i = end + 1
      continue
    }
    if (ch === '}') {
      if (template[i + 1] === '}') { out += '}'; i += 2; continue }
      out += ch
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// Python 列表 repr：['a', 'b']
function pyList(items) {
  return `[${items.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ')}]`
}

function isFileSync(p) {
  try { return statSync(p).isFile() } catch { return false }
}

function isDirSync(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

function relPosix(root, p) {
  return relative(root, p).split(sep).join('/')
}

// 严格 UTF-8 读取：非法字节序列抛错（对齐 Python read_text(encoding='utf-8')
// 的 UnicodeDecodeError），调用方借此跳过二进制文件。
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
function readTextStrict(p) {
  return utf8Decoder.decode(readFileSync(p))
}

// str.partition(sep)
function partition(s, sepStr) {
  const idx = s.indexOf(sepStr)
  if (idx < 0) return [s, '']
  return [s.slice(0, idx), s.slice(idx + sepStr.length)]
}

// split(sep, maxsplit) 语义：至多 maxParts 段。
function splitMax(s, sepStr, maxParts) {
  const out = []
  let rest = s
  while (out.length < maxParts - 1) {
    const idx = rest.indexOf(sepStr)
    if (idx < 0) break
    out.push(rest.slice(0, idx))
    rest = rest.slice(idx + sepStr.length)
  }
  out.push(rest)
  return out
}

function compareParts(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.length - b.length
}

// 遍历 root 下全部文件（剪枝 prune 目录），按路径段字典序排序
//（对齐 Python sorted(root.rglob('*'))）。
function listFilesSorted(root, prune) {
  const out = []
  const walk = (dir, parts) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (prune.has(entry.name)) continue
        walk(join(dir, entry.name), [...parts, entry.name])
      } else if (entry.isFile()) {
        out.push({ abs: join(dir, entry.name), parts: [...parts, entry.name] })
      }
    }
  }
  walk(root, [])
  out.sort((a, b) => compareParts(a.parts, b.parts))
  return out
}

// ---------------------------------------------------------------------------
// Policy：白名单式配置。白名单之外即拒绝。
// ---------------------------------------------------------------------------
export class PolicyError extends Error {}

class Policy {
  constructor() {
    this.overrides = {}   // 'DOC-004.md_total_warn' -> value
    this.waived = {}      // id -> reason
    this.skip = new Set() // ids
    this.dimDrop = []
    this.dimReason = ''
    this.append = []      // [{id, desc, script}]
    this.plugin = ''
    this.reason = ''
  }

  param(checkId, name, defaultValue) {
    const key = `${checkId}.${name}`
    return key in this.overrides ? this.overrides[key] : defaultValue
  }
}

let POLICY = new Policy()

function policyCheckCat(checkId) {
  const rule = CHECKS[checkId]
  if (rule === undefined) {
    throw new PolicyError(`未知检查点 ID: ${checkId}（合法 ID 见脚本 CHECKS 注册表）`)
  }
  return rule.cat
}

export function loadPolicy(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new PolicyError(`无法读取 policy 文件: ${e.message}`)
  }
  const data = parseSimpleYaml(text)
  if (!isDict(data) || Object.keys(data).length === 0) {
    throw new PolicyError('policy 文件为空或不是键值映射')
  }

  const allowed = new Set(['version', 'plugin', 'reason', 'overrides', 'waive', 'skip',
    'dimensions', 'append'])
  const unknown = Object.keys(data).filter((k) => !allowed.has(k)).sort()
  if (unknown.length > 0) {
    throw new PolicyError(`policy 含未知字段（拒绝加载）: ${pyList(unknown)}；允许字段: ${pyList([...allowed].sort())}`)
  }

  if ('version' in data && data.version !== 1) {
    throw new PolicyError(`policy version 必须为 1，got ${data.version}`)
  }

  POLICY.plugin = String(data.plugin ?? '')
  POLICY.reason = String(data.reason ?? '')

  const overrides = data.overrides || {}
  if (!isDict(overrides)) {
    throw new PolicyError('overrides 必须是映射（<ID>.<param>: value）')
  }
  const overridableParams = new Set(['md_total_warn', 'severity'])
  for (const [key, value] of Object.entries(overrides)) {
    const keyS = String(key)
    if (!keyS.includes('.')) {
      throw new PolicyError(`overrides 键须为 <ID>.<param> 格式，got '${keyS}'`)
    }
    const [cid, pname] = splitMax(keyS, '.', 2)
    const cat = policyCheckCat(cid)
    if (cat === 'A') {
      throw new PolicyError(`A 类（平台契约）检查点不可覆盖: ${cid} —— 白名单之外即拒绝`)
    }
    if (cat === 'C') {
      throw new PolicyError(`C 类（场景判据）检查点无脚本参数可覆盖: ${cid}（维度裁剪请用 dimensions）`)
    }
    if (!overridableParams.has(pname)) {
      throw new PolicyError(`未知参数 '${pname}'（允许: ${pyList([...overridableParams].sort())}）`)
    }
    if (pname === 'severity' && !VALID_SEVERITIES.includes(value)) {
      throw new PolicyError(`${keyS}: severity 只能是 (${VALID_SEVERITIES.map((s) => `'${s}'`).join(', ')})`)
    }
    POLICY.overrides[keyS] = value
  }

  const waive = data.waive || []
  if (!Array.isArray(waive)) {
    throw new PolicyError('waive 必须是列表（- id: ... / reason: ...）')
  }
  for (const item of waive) {
    if (!isDict(item) || !('id' in item)) {
      throw new PolicyError(`waive 条目须含 id: ${JSON.stringify(item)}`)
    }
    const cid = String(item.id)
    const cat = policyCheckCat(cid)
    const reason = pyTruthy(item.reason) ? String(item.reason).trim() : ''
    if (!reason) {
      throw new PolicyError(`waive 无 reason，拒绝加载 policy: ${cid}（豁免必须带原因）`)
    }
    if (cat === 'A') {
      throw new PolicyError(`A 类（平台契约）检查点不可豁免: ${cid}`)
    }
    if (cat === 'C') {
      throw new PolicyError(`C 类（场景判据）请用 dimensions 裁剪并落账，不接受 waive: ${cid}`)
    }
    POLICY.waived[cid] = reason
  }

  const skip = data.skip || []
  if (!Array.isArray(skip)) {
    throw new PolicyError('skip 必须是 ID 列表')
  }
  for (const raw of skip) {
    const cid = String(raw)
    const cat = policyCheckCat(cid)
    if (cat === 'A') {
      throw new PolicyError(`A 类（平台契约）检查点不可跳过: ${cid}`)
    }
    POLICY.skip.add(cid)
  }

  const dims = data.dimensions
  if (dims !== null && dims !== undefined) {
    if (!isDict(dims) || !('drop' in dims)) {
      throw new PolicyError('dimensions 须为 {drop: [...], reason: "..."}')
    }
    const reason = pyTruthy(dims.reason) ? String(dims.reason).trim() : ''
    if (!reason) {
      throw new PolicyError('dimensions.reason 必填（维度裁剪必须写原因，不允许静默缺席）')
    }
    const drop = dims.drop || []
    if (!Array.isArray(drop)) {
      throw new PolicyError('dimensions.drop 必须是维度编号列表')
    }
    const ints = []
    for (const d of drop) {
      if (Number.isInteger(d)) { ints.push(d); continue }
      if (typeof d === 'string' && /^[+-]?\d+$/.test(d)) { ints.push(parseInt(d, 10)); continue }
      throw new PolicyError(`dimensions.drop 须为整数列表，got ${JSON.stringify(drop)}`)
    }
    POLICY.dimDrop = ints
    POLICY.dimReason = reason
  }

  const appends = data.append || []
  if (!Array.isArray(appends)) {
    throw new PolicyError('append 必须是列表')
  }
  for (const item of appends) {
    if (!isDict(item) || !pyTruthy(item.id) || !pyTruthy(item.script)) {
      throw new PolicyError(`append 条目须含 id 与 script: ${JSON.stringify(item)}`)
    }
    const script = String(item.script)
    if (isAbsolute(script) || script.split(/[\\/]/).includes('..')) {
      throw new PolicyError(`append 脚本路径含 '..' 或为绝对路径，拒绝: ${script}`)
    }
    POLICY.append.push({ id: String(item.id), desc: String(item.desc ?? ''), script })
  }
}

const POLICY_HELP = `policy 文件格式（YAML，随 --policy 传入；SSOT 见本帮助，文档只放指针）:

version: 1
plugin: dsh-my-plugin
reason: "说明为何需要覆盖 / 豁免"

overrides:            # 只允许 B 类；出现 A 类 ID 整体拒绝
  DOC-004.md_total_warn: 30
  PKG-004.severity: info     # B 类可降级

waive:                # 单条豁免，reason 必填
  - id: PATCH-006
    reason: "该插件仅在源码仓库内开发，不需要独立 dev 覆盖层"

skip:                 # 跳过检查
  - TOOL-003

dimensions:           # C 类（Phase 4 维度）裁剪，reason 必填；须落账
  drop: [1]
  reason: "无密钥环境，调用准确性降级为 description 语义评审"

append:               # 追加自定义检查（可选）
  - id: ORG-001
    desc: "禁止提交 *.log"
    script: "scripts/my_rules.js"   # 相对被校验包根目录；禁 '..' 与绝对路径

加载规则:
  - 未知字段拒绝；waive 无 reason 拒绝；dimensions 无 reason 拒绝
  - append 脚本路径含 '..' 或绝对路径拒绝
  - A 类（平台契约）ID 出现在任何可覆盖字段 -> 整体拒绝并报出 ID
  - append 脚本由被校验包根目录下执行: <node> <script> <包根目录>，
    每行输出 "SEVERITY|ID|message"（SEVERITY ∈ error/warn/info）

⚠️ 安全警示（append 是代码执行面）:
  append 脚本**内容来自被校验包**。对第三方包做 --skip-path-check 就地
  校验时，执行这些脚本等于运行不受信代码。因此：
  - 使用了 --skip-path-check 时，append 默认**禁用**（输出 APP-002 告警）；
  - 确已审查过被校验包、愿意承担执行风险时，显式加 --trust-append 开启。`

const HELP_TEXT = `DSH Plugin Validator - validates DeepSeek Harness plugins against the
platform contract (also dogfoods on this meta-engineer package itself).

Architecture (M1):
    - dsh plugin mode only: target is a directory with package.json
      (PKG/PATCH/TS/TOOL/CFG/DEP rule families + shared SEC/DOC).
    - Rule identity layer: every checkpoint has a stable ID (CHECKS registry).
      Output format: [ID][severity] message. IDs make waivers, precise
      references, cross-version diffs and ledger records possible.
    - Categories: A = platform contract (never overridable),
                  B = methodology threshold (overridable via --policy),
                  C = scenario dimensions (droppable with reason).
    - Heuristic rules are warn-level and say so (semantic re-check belongs
      to Phase 4); the validator never pretends certainty it does not have.
    - Exit codes: 0 pass; 1 errors found; 2 usage error.

Usage:
    node validate_plugin.js <path/to/plugin-dir> [--policy <file>]
                       [--skip-path-check] [--trust-append]
    node validate_plugin.js --policy-help`

// ---------------------------------------------------------------------------
// 极简 YAML 子集解析器（零第三方依赖）。支持嵌套 dict / 块列表 / 行内列表 /
// 行内流式映射 / 引号字符串 / 数字 / 布尔 / null。顶层可以是 dict 或 list。
// ---------------------------------------------------------------------------
function yamlStripComment(line) {
  let q = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (q) {
      if (ch === q) q = null
    } else if (ch === '"' || ch === "'") {
      q = ch
    } else if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i).replace(/\s+$/, '')
    }
  }
  return line
}

function splitInline(s) {
  const out = []
  let buf = ''
  let q = null
  let depth = 0
  for (const ch of s) {
    if (q) {
      buf += ch
      if (ch === q) q = null
    } else if (ch === '"' || ch === "'") {
      q = ch
      buf += ch
    } else if (ch === '[' || ch === '{') {
      depth += 1
      buf += ch
    } else if (ch === ']' || ch === '}') {
      depth -= 1
      buf += ch
    } else if (ch === ',' && depth === 0) {
      out.push(buf.trim())
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

function yamlScalar(s) {
  s = s.trim()
  if (s === '' || s === '~' || s.toLowerCase() === 'null') return null
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) {
    return s.slice(1, -1)
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    return inner ? splitInline(inner).map((x) => yamlScalar(x)) : []
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    const d = {}
    if (inner) {
      for (const part of splitInline(inner)) {
        const [k, v] = partition(part, ':')
        if (part.indexOf(':') < 0) continue
        d[yamlScalar(k)] = yamlScalar(v)
      }
    }
    return d
  }
  const low = s.toLowerCase()
  if (low === 'true') return true
  if (low === 'false') return false
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10)
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return parseFloat(s)
  return s
}

function looksLikeKv(s) {
  return /^[^\s"[\]{}#]+:(\s|$)/.test(s)
}

function yamlParseBlock(items, i, indent) {
  if (i >= items.length) return [null, i]
  if (items[i][1].startsWith('-')) {
    const lst = []
    while (i < items.length && items[i][0] === indent && items[i][1].startsWith('-')) {
      const content = items[i][1].slice(1).trim()
      if (content === '') {
        i += 1
        if (i < items.length && items[i][0] > indent) {
          let v
          ;[v, i] = yamlParseBlock(items, i, items[i][0])
          lst.push(v)
        } else {
          lst.push(null)
        }
      } else if (looksLikeKv(content)) {
        const d = {}
        let [k, v] = partition(content, ':')
        k = k.trim()
        v = v.trim()
        if (v === '') {
          if (i + 1 < items.length && items[i + 1][0] > indent) {
            let sub
            ;[sub, i] = yamlParseBlock(items, i + 1, items[i + 1][0])
            d[k] = sub
          } else {
            d[k] = null
            i += 1
          }
        } else {
          d[k] = yamlScalar(v)
          i += 1
        }
        while (i < items.length && items[i][0] > indent
          && !items[i][1].startsWith('- ')
          && looksLikeKv(items[i][1])) {
          let [k2, v2] = partition(items[i][1], ':')
          k2 = k2.trim()
          v2 = v2.trim()
          if (v2 === '') {
            if (i + 1 < items.length && items[i + 1][0] > items[i][0]) {
              let sub
              ;[sub, i] = yamlParseBlock(items, i + 1, items[i + 1][0])
              d[k2] = sub
            } else {
              d[k2] = null
              i += 1
            }
          } else {
            d[k2] = yamlScalar(v2)
            i += 1
          }
        }
        lst.push(d)
      } else {
        lst.push(yamlScalar(content))
        i += 1
      }
    }
    return [lst, i]
  }
  const d = {}
  while (i < items.length && items[i][0] === indent && !items[i][1].startsWith('-')) {
    const content = items[i][1]
    if (!looksLikeKv(content)) {
      i += 1
      continue
    }
    let [k, v] = partition(content, ':')
    k = k.trim()
    v = v.trim()
    if (v === '') {
      if (i + 1 < items.length && items[i + 1][0] > indent) {
        let sub
        ;[sub, i] = yamlParseBlock(items, i + 1, items[i + 1][0])
        d[k] = sub
      } else {
        d[k] = null
        i += 1
      }
    } else {
      d[k] = yamlScalar(v)
      i += 1
    }
  }
  return [d, i]
}

export function parseYamlDoc(text) {
  const items = []
  for (const raw of text.split('\n')) {
    const line = yamlStripComment(raw.replace(/\s+$/, ''))
    if (!line.trim()) continue
    const stripped = line.trim()
    if (stripped === '---') continue
    const indent = line.length - line.replace(/^ +/, '').length
    items.push([indent, stripped])
  }
  if (items.length === 0) return null
  const [val] = yamlParseBlock(items, 0, items[0][0])
  return val
}

export function parseSimpleYaml(text) {
  const val = parseYamlDoc(text)
  return isDict(val) ? val : {}
}

// ---------------------------------------------------------------------------
// 校验结果收集与规则发射
// ---------------------------------------------------------------------------
class ValidationResult {
  constructor() {
    this.errors = []
    this.warnings = []
    this.infos = []
    this.waived = []
    this.skipped = []
    this.notes = []
  }

  get isValid() {
    return this.errors.length === 0
  }

  summary() {
    const lines = []
    if (this.errors.length > 0) {
      lines.push(`❌ ${this.errors.length} error(s):`)
      for (const e of this.errors) lines.push(`   • ${e}`)
    }
    if (this.warnings.length > 0) {
      lines.push(`⚠️  ${this.warnings.length} warning(s):`)
      for (const w of this.warnings) lines.push(`   • ${w}`)
    }
    if (this.infos.length > 0) {
      lines.push(`ℹ️  ${this.infos.length} info:`)
      for (const x of this.infos) lines.push(`   • ${x}`)
    }
    if (this.waived.length > 0) {
      lines.push(`🔓 本轮豁免清单（policy，${this.waived.length} 条）:`)
      for (const [w, reason] of this.waived) {
        lines.push(`   • ${w}`)
        lines.push(`     [WAIVED by policy: ${reason}]`)
      }
    }
    if (this.skipped.length > 0) {
      lines.push(`⏭️  已跳过检查（policy skip）: ${this.skipped.length} 条`)
      for (const s of this.skipped) lines.push(`   • ${s}`)
    }
    for (const nt of this.notes) lines.push(`ℹ️  ${nt}`)
    if (POLICY.dimDrop.length > 0) {
      lines.push(`✂️  维度裁剪声明: 维度 [${POLICY.dimDrop.join(', ')}]（原因: ${POLICY.dimReason}）`)
      lines.push('   → 须写入 Phase 4 用例表，并随包记入账本（不允许静默缺席）')
    }
    lines.push('❓ 未覆盖项（脚本无规则覆盖，归属如下，禁止静默通过）:')
    for (const [item, owner] of UNCOVERED_ITEMS) lines.push(`   • ${item} → ${owner}`)
    if (this.isValid) {
      let tail = '✅ 校验通过！'
      if (this.warnings.length > 0) tail = '✅ 校验通过（带警告，见上）'
      lines.push(tail)
    }
    return lines.join('\n')
  }
}

function emit(result, checkId, params = {}) {
  const rule = CHECKS[checkId]
  const msg = formatMsg(rule.msg, params)
  if (POLICY.skip.has(checkId)) {
    result.skipped.push(`[${checkId}][${rule.sev}] ${msg}`)
    return
  }
  if (checkId in POLICY.waived) {
    result.waived.push([`[${checkId}][${rule.sev}] ${msg}`, POLICY.waived[checkId]])
    return
  }
  let sev = rule.sev
  const ov = POLICY.overrides[`${checkId}.severity`]
  if (VALID_SEVERITIES.includes(ov)) sev = ov
  const line = `[${checkId}][${sev}] ${msg}`
  if (sev === 'error') result.errors.push(line)
  else if (sev === 'warn') result.warnings.push(line)
  else result.infos.push(line)
}

// ---------------------------------------------------------------------------
// SEC-* 扫描模式（模式级；语义级复核归 Phase 4 维度 9）
// ---------------------------------------------------------------------------
const CREDENTIAL_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9\-_.]{20,}/, 'Bearer <长令牌>'],
  [/sk-[A-Za-z0-9]{20,}/, 'sk- 前缀密钥'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/xox[baprs]-[A-Za-z0-9\-]{10,}/, 'Slack token'],
  [/["']?(api[_-]?key|secret|access[_-]?token|password)["']?\s*[:=]\s*["'][A-Za-z0-9\-_.]{16,}["']/i, 'key/secret/token 字面量'],
]

// 个人绝对路径：要求 /Users/ 后跟真实形态的用户名段（占位写法
// 如 /Users/<username> 不命中）。dev/ 覆盖层在 dsh 模式按契约豁免。
const PERSONAL_PATH_PATTERNS = [
  [/\/Users\/[A-Za-z0-9_.-]{2,}/, 'macOS 个人目录'],
  [/[A-Za-z]:\\Users\\[A-Za-z0-9_.-]{2,}/, 'Windows 个人目录'],
]

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g
const EXAMPLE_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'localhost'])

function iterTextFiles(root, exts, exemptParts) {
  const prune = new Set([...SKIP_DIRS, ...exemptParts])
  return listFilesSorted(root, prune)
    .filter((f) => exts.has(extname(f.parts[f.parts.length - 1]).toLowerCase()))
}

function scanSecurity(root, result) {
  // SEC-001/002/003。scripts/ 与 templates/ 白名单豁免（占位符机制实现所在）；
  // SEC-002 另豁免 dev/（平台契约要求覆盖层绝对路径）。
  // 源码文件（.js/.ts）走 token 级扫描（注释 / 正则字面量免疫，见 _analyze.js）；
  // 文档与配置文件维持原文扫描。
  const exts = new Set([...PLACEHOLDER_SCAN_EXTS, ...SOURCE_EXTS])
  for (const f of iterTextFiles(root, exts, ['scripts', 'templates'])) {
    let text
    try {
      text = readTextStrict(f.abs)
    } catch {
      continue
    }
    const rel = f.parts.join('/')
    const isSource = SOURCE_EXTS.has(extname(f.abs).toLowerCase())
    if (isSource) scanSecuritySource(text, f, rel, result)
    else scanSecurityText(text, f, rel, result)
  }
}

function scanSecurityText(text, f, rel, result) {
  for (const [pattern, label] of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) emit(result, 'SEC-001', { path: rel, pattern: label })
  }
  // SEC-002 豁免 dev/ 与 qa/（同 scanSecuritySource：证据命令须如实记录绝对路径）。
  if (!f.parts.includes('dev') && !f.parts.includes('qa')) {
    for (const [pattern] of PERSONAL_PATH_PATTERNS) {
      const m = text.match(pattern)
      if (m) emit(result, 'SEC-002', { path: rel, literal: m[0] })
    }
  }
  for (const m of text.matchAll(EMAIL_PATTERN)) {
    const domain = m[1].toLowerCase()
    if (!EXAMPLE_DOMAINS.has(domain)) {
      emit(result, 'SEC-003', { path: rel, literal: m[0] })
      break
    }
  }
}

// SEC-001 的 key/secret/token 字面量模式（原文形态）：[key] [:=] ['16+ 字符']。
const KEYISH_NAME_RE = /^(api[_-]?key|secret|access[_-]?token|password)$/i
// 非全局变体：对单个字符串值做首次匹配（EMAIL_PATTERN 带 /g，exec 有状态）。
const EMAIL_MATCH_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/

function scanSecuritySource(text, f, rel, result) {
  const tokens = tokenize(text)
  const values = stringValues(tokens)
  // 值形态模式（Bearer / sk- / gh / xox）：命中字符串 / 模板串值。
  for (const [pattern, label] of CREDENTIAL_PATTERNS.slice(0, 4)) {
    for (const value of values) {
      if (pattern.test(value)) {
        emit(result, 'SEC-001', { path: rel, pattern: label })
        break
      }
    }
  }
  // key/secret/token 字面量：token 序列 [keyish] [:=] ['16+ 字符串值']。
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    const k = tokens[i]
    const op = tokens[i + 1]
    const v = tokens[i + 2]
    if ((k.type === 'ident' || k.type === 'string') && KEYISH_NAME_RE.test(k.value)
      && op.type === 'punct' && (op.value === ':' || op.value === '=')
      && v.type === 'string' && /^[A-Za-z0-9\-_.]{16,}$/.test(v.value)) {
      emit(result, 'SEC-001', { path: rel, pattern: 'key/secret/token 字面量' })
      break
    }
  }
  // SEC-002 豁免 dev/（平台契约要求绝对路径）与 qa/（verify_plugin.js 产出的
  // 本地证据目录，命令记录必须如实含绝对路径）；凭据类 SEC-001 不豁免。
  if (!f.parts.includes('dev') && !f.parts.includes('qa')) {
    for (const [pattern] of PERSONAL_PATH_PATTERNS) {
      for (const value of values) {
        const m = value.match(pattern)
        if (m) {
          emit(result, 'SEC-002', { path: rel, literal: m[0] })
          break
        }
      }
    }
  }
  for (const value of values) {
    const m = value.match(EMAIL_MATCH_RE)
    if (m && !EXAMPLE_DOMAINS.has(m[1].toLowerCase())) {
      emit(result, 'SEC-003', { path: rel, literal: m[0] })
      break
    }
  }
}

function scanPlaceholders(root, result) {
  // DOC-001：占位符扫描。白名单豁免 scripts/ 与 templates/。
  const exts = new Set([...PLACEHOLDER_SCAN_EXTS, ...SOURCE_EXTS])
  for (const f of iterTextFiles(root, exts, ['scripts', 'templates'])) {
    let text
    try {
      text = readTextStrict(f.abs)
    } catch {
      continue
    }
    const rel = f.parts.join('/')
    const lines = text.split('\n')
    for (let ln = 1; ln <= lines.length; ln += 1) {
      const line = lines[ln - 1]
      for (const pat of PLACEHOLDER_PATTERNS) {
        if (line.includes(pat)) emit(result, 'DOC-001', { path: rel, line: ln, pattern: pat })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// dsh 模式
// ---------------------------------------------------------------------------
function readSourceFiles(pluginDir) {
  // 收集源码文件（入口优先）：根 *.js/*.ts、src/、lib/ 下的 .js/.ts。
  const out = []
  const seen = new Set()
  for (const sub of ['', 'src', 'lib']) {
    const base = sub ? join(pluginDir, sub) : pluginDir
    if (!isDirSync(base)) continue
    const entries = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isFile() && SOURCE_EXTS.has(extname(e.name)))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const abs = resolve(base, e.name)
      if (seen.has(abs)) continue
      seen.add(abs)
      out.push(abs)
    }
  }
  return out
}

function resolveEntry(pluginDir, pkg) {
  const main = String(pkg.main || 'index.js')
  for (const cand of [main, 'index.js', 'index.ts', 'src/index.ts', 'lib/index.js']) {
    const p = join(pluginDir, cand)
    if (isFileSync(p)) return [p, cand]
  }
  return [null, main]
}

function validatePkg(pluginDir, pkg, result) {
  const name = pkg.name
  const version = pkg.version
  if (!name) emit(result, 'PKG-001', { reason: "缺少必填字段 'name'" })
  if (!version) emit(result, 'PKG-001', { reason: "缺少必填字段 'version'" })

  if (name) {
    const nameS = String(name)
    if (nameS.length < 2 || !/^[a-z0-9@][a-z0-9-/@.]*[a-z0-9]$/.test(nameS)) {
      emit(result, 'PKG-003', { name })
    }
    const bare = nameS.split('/').pop()
    if (!bare.startsWith('dsh-')) emit(result, 'PKG-004', { name })
  }

  if (pkg.type !== 'module') {
    emit(result, 'PKG-005', { value: String(pkg.type === undefined ? '(missing)' : pkg.type) })
  }

  const dsh = pkg.dsh
  const bundle = isDict(dsh) ? dsh.bundle : null
  if (isDict(dsh) && isDict(dsh.bundle) && isDict(dsh.profile)) {
    emit(result, 'PKG-010')
  }
  let patchRel = null
  if (isDict(bundle)) {
    patchRel = bundle.patch
    if (!patchRel) {
      emit(result, 'PKG-002', { detail: 'dsh.bundle 存在但未声明 patch' })
    } else {
      const patchPath = join(pluginDir, String(patchRel))
      if (!isFileSync(patchPath)) {
        emit(result, 'PKG-002', { detail: `patch 文件不存在: ${patchRel}` })
      }
    }
  }
  if (bundle === null && isDict(dsh) && !pyTruthy(dsh.profile)) {
    result.infos.push('未声明 dsh.bundle：按库包处理（供插件包 import，不被用户直接启用）')
  }

  const files = pkg.files
  const main = String(pkg.main || 'index.js')
  if (Array.isArray(files)) {
    const norm = files.map((f) => String(f).replaceAll('\\', '/'))
    const covered = (target) => {
      const t = String(target).replaceAll('\\', '/')
      for (const f of norm) {
        if (f === t || t.startsWith(`${f.replace(/\/+$/, '')}/`) || f === t.split('/')[0]) return true
      }
      return false
    }
    const missing = []
    if (!covered(main)) missing.push(`入口 ${main}`)
    if (patchRel && !covered(String(patchRel).replace(/^[./]+/, ''))) missing.push(`patch ${patchRel}`)
    if (missing.length > 0) emit(result, 'PKG-006', { missing: missing.join('、') })
  }

  const recMissing = []
  if (!version) recMissing.push('version')
  if (!pkg.license) recMissing.push('license')
  if (!pkg.description) recMissing.push('description')
  if (!existsSync(join(pluginDir, 'README.md'))) recMissing.push('README.md')
  if (recMissing.length > 0) emit(result, 'PKG-007', { missing: recMissing.join('、') })

  const mainPath = join(pluginDir, main)
  if (!isFileSync(mainPath)) {
    const scripts = pkg.scripts || {}
    if (isDict(scripts) && (scripts.build || scripts.prepare)) {
      emit(result, 'PKG-009', { main })
    } else {
      emit(result, 'PKG-008', { main })
    }
  }

  return patchRel
}

function patchRows(doc) {
  // 从 patch 文档提取 [opKey, rowDict, index] 序列。
  const rows = []
  if (!Array.isArray(doc)) return rows
  let idx = 0
  for (const op of doc) {
    if (!isDict(op)) {
      idx += 1
      continue
    }
    for (const key of ['insert', 'replace', 'override', 'remove']) {
      const entries = op[key]
      if (Array.isArray(entries)) {
        for (const row of entries) {
          idx += 1
          rows.push([key, isDict(row) ? row : {}, idx])
        }
      } else if (entries !== null && entries !== undefined) {
        idx += 1
        rows.push([key, isDict(entries) ? entries : {}, idx])
      }
    }
  }
  return rows
}

function validatePatchFile(pluginDir, patchRel, result) {
  // PATCH-001..004/007：bundle 层 patch。
  const display = patchRel || 'cordis.patch.yml'
  const patchPath = join(pluginDir, String(patchRel))
  let text
  try {
    text = readTextStrict(patchPath)
  } catch (e) {
    emit(result, 'PATCH-001', { file: display, reason: `不可读: ${e.message}` })
    return
  }
  const doc = parseYamlDoc(text)
  if (!Array.isArray(doc)) {
    emit(result, 'PATCH-001', { file: display, reason: '顶层必须是 patch 操作数组' })
    return
  }
  const seenIds = new Set()
  for (const [, row, idx] of patchRows(doc)) {
    const rowIdRaw = row.id
    const rowName = row.name
    if (!rowIdRaw || !rowName) {
      emit(result, 'PATCH-007', { file: display, index: idx })
      continue
    }
    const rowId = String(rowIdRaw)
    if (seenIds.has(rowId)) emit(result, 'PATCH-002', { file: display, row_id: rowId })
    seenIds.add(rowId)
    const nameS = String(rowName)
    if (nameS.startsWith('/') || /^[A-Za-z]:\\/.test(nameS) || nameS.includes('://')) {
      emit(result, 'PATCH-003', { file: display, row_id: rowId, name: nameS })
    }
    if ('config' in row) emit(result, 'PATCH-004', { file: display, row_id: rowId })
  }
}

function validateDevOverlay(pluginDir, result) {
  // PATCH-005/006：dev 覆盖层（绝对路径直载源码）。
  // `*.example.yml` / `*.sample.yml` / `*.template.yml` 是模式文档，不是生效的
  // 覆盖层：它们按设计只带占位路径，所以既不做绝对路径校验，也算「模式已文档化」
  // （真正的 dev/cordis.yml 常为机器本地、不入库——仓库里只留示例是预期做法）。
  const isExampleOverlay = (name) => /\.(example|sample|template)\.ya?ml$/i.test(name)
  const devDir = join(pluginDir, 'dev')
  let overlays = []
  let examples = []
  if (isDirSync(devDir)) {
    const entries = readdirSync(devDir, { withFileTypes: true }).filter((e) => e.isFile())
    const yml = entries.filter((e) => e.name.endsWith('.yml')).map((e) => e.name).sort()
    const yaml = entries.filter((e) => e.name.endsWith('.yaml')).map((e) => e.name).sort()
    const names = [...yml, ...yaml]
    examples = names.filter(isExampleOverlay)
    overlays = names.filter((nm) => !isExampleOverlay(nm)).map((nm) => join(devDir, nm))
  }
  if (overlays.length === 0) {
    if (examples.length > 0) {
      result.infos.push(`dev/ 仅含示例覆盖层（${examples.join('、')}）：模式已文档化，本地 dev/cordis.yml 不入库属预期，PATCH-006 不触发`)
    } else {
      emit(result, 'PATCH-006')
    }
    return
  }
  for (const ov of overlays) {
    const display = relPosix(pluginDir, ov)
    let doc
    try {
      doc = parseYamlDoc(readTextStrict(ov))
    } catch {
      continue
    }
    if (!Array.isArray(doc)) {
      emit(result, 'PATCH-001', { file: display, reason: '顶层必须是 patch 操作数组' })
      continue
    }
    for (const [, row, idx] of patchRows(doc)) {
      const rowId = 'id' in row ? String(row.id) : `#${idx}`
      const rowName = row.name
      if (!row.id || !rowName) {
        emit(result, 'PATCH-007', { file: display, index: idx })
        continue
      }
      const nameS = String(rowName)
      if (!(nameS.startsWith('/') || /^[A-Za-z]:\\/.test(nameS))) {
        emit(result, 'PATCH-005', { file: display, row_id: rowId })
      }
    }
  }
}

function stripJsComments(text) {
  // 移除 // 行注释与 /* */ 块注释；跟踪字符串状态，URL 等串内 // 不误伤。
  const out = []
  let inBlock = false
  for (const line of text.split('\n')) {
    const buf = []
    let i = 0
    const n = line.length
    let quote = null
    while (i < n) {
      const ch = line[i]
      if (inBlock) {
        if (ch === '*' && i + 1 < n && line[i + 1] === '/') {
          inBlock = false
          i += 2
          continue
        }
        i += 1
        continue
      }
      if (quote) {
        buf.push(ch)
        if (ch === '\\' && i + 1 < n) {
          buf.push(line[i + 1])
          i += 2
          continue
        }
        if (ch === quote) quote = null
        i += 1
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch
        buf.push(ch)
        i += 1
        continue
      }
      if (ch === '/' && i + 1 < n && line[i + 1] === '/') break
      if (ch === '/' && i + 1 < n && line[i + 1] === '*') {
        inBlock = true
        i += 2
        continue
      }
      buf.push(ch)
      i += 1
    }
    if (!inBlock) out.push(buf.join(''))
  }
  return out.join('\n')
}

function validateEntryTs(pluginDir, pkg, result) {
  // TS-001..003：入口模块静态检查（启发式一律 warn）。
  // 仅对 bundle 包执行：官方约定无 dsh.bundle 声明的包只作普通依赖
  //（纯库包，如 seam 的 definition），不要求插件入口形态。
  const dsh = pkg.dsh
  if (!(isDict(dsh) && isDict(dsh.bundle))) return
  const [entryPath, entryRel] = resolveEntry(pluginDir, pkg)
  if (entryPath === null) return // PKG-008/009 已报告入口缺失
  let raw
  try {
    raw = readTextStrict(entryPath)
  } catch {
    return
  }
  const text = stripJsComments(raw)

  const hasApplyFn = /export\s+(async\s+)?function\s+apply\b/.test(text)
    || /export\s+const\s+apply\b/.test(text)
  const hasDefaultApply = /export\s+default\b/.test(text) && /\bapply\s*\(/.test(text)
  const hasService = /extends\s+Service\b/.test(text)
  if (!(hasApplyFn || hasDefaultApply || hasService)) {
    emit(result, 'TS-001', { path: entryRel })
  }

  if (!hasService) {
    if (!(/export\s+const\s+name\s*=/.test(text) || /\bname\s*:\s*['"]/.test(text))) {
      emit(result, 'TS-002', { path: entryRel })
    }
  }

  // TS-003：token 级匹配（注释 / 字符串中的 "ctx.tools" 不再误报）。
  // inject 声明 = [inject, = 或 :] 后平衡 [ ] 块内的字符串值；
  // 使用点 = ctx.<svc> 标识符成员访问。
  const tokens = tokenize(raw)
  const declared = new Set()
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    const t = tokens[i]
    const op = tokens[i + 1]
    const arr = tokens[i + 2]
    if (t.type === 'ident' && t.value === 'inject'
      && op.type === 'punct' && (op.value === '=' || op.value === ':')
      && arr.type === 'punct' && arr.value === '[') {
      const end = balancedEnd(tokens, i + 2)
      for (const s of tokens.slice(i + 3, end - 1)) {
        if (s.type === 'string') declared.add(s.value)
      }
    }
  }
  const used = memberAccesses(tokens, 'ctx')
  for (const svc of KNOWN_SERVICES) {
    if (used.has(svc) && !declared.has(svc)) {
      emit(result, 'TS-003', { path: entryRel, svc })
    }
  }
}

// TOOL 检查的 token 级辅助（作用域精确，仍为启发式；语义复核归 Phase 4）。

function hasKeyForm(tokens, key) {
  // key 以属性（key:）或方法简写（key(）形态出现。
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.type !== 'ident' || t.value !== key) continue
    const next = tokens[i + 1]
    if (next.type === 'punct' && (next.value === ':' || next.value === '(')) return true
  }
  return false
}

function hasDirectProperty(nodeTokens, key, strValue) {
  // 对象节点自身深度（depth 0）上的直接属性。strValue 为 undefined 时做
  // 存在性检查（additionalProperties）；否则要求 [key : 'strValue']。
  let depth = 0
  for (let i = 0; i < nodeTokens.length; i += 1) {
    const t = nodeTokens[i]
    if (t.type === 'punct') {
      if ('([{'.includes(t.value)) depth += 1
      else if (')]}'.includes(t.value)) depth -= 1
      continue
    }
    if (depth !== 0) continue
    if (!(t.type === 'ident' || t.type === 'string') || t.value !== key) continue
    if (strValue === undefined) return true
    const colon = nodeTokens[i + 1]
    const v = nodeTokens[i + 2]
    if (colon && colon.type === 'punct' && colon.value === ':'
      && v && v.type === 'string' && v.value === strValue) return true
  }
  return false
}

function objectTypedNodes(regionTokens) {
  // 区域内所有声明了直接 `type: 'object'` 属性的对象字面量节点（含数组/
  // 调用参数内嵌套），返回各节点的内部 token 数组。
  const nodes = []
  const walk = (toks) => {
    for (let j = 0; j < toks.length; j += 1) {
      const v = toks[j]
      if (v.type !== 'punct') continue
      if (v.value === '{') {
        const end = balancedEnd(toks, j)
        const inner = toks.slice(j + 1, end - 1)
        if (hasDirectProperty(inner, 'type', 'object')) nodes.push(inner)
        walk(inner)
        j = end - 1
      } else if (v.value === '(' || v.value === '[') {
        const end = balancedEnd(toks, j)
        walk(toks.slice(j + 1, end - 1))
        j = end - 1
      }
    }
  }
  walk(regionTokens)
  return nodes
}

function returnsContentBlock(regionTokens) {
  // return { type: 'text' ... } 或 return [{ type: 'text' ... }]（token 序列级）。
  for (let i = 0; i + 4 < regionTokens.length; i += 1) {
    if (regionTokens[i].type !== 'ident' || regionTokens[i].value !== 'return') continue
    let j = i + 1
    const a = regionTokens[j]
    if (!a || a.type !== 'punct' || (a.value !== '{' && a.value !== '[')) continue
    if (a.value === '[') j += 1 // 数组形态：跳过包装的 '['
    const b = regionTokens[j]
    const k = regionTokens[j + 1]
    const colon = regionTokens[j + 2]
    const v = regionTokens[j + 3]
    if (b && b.type === 'punct' && b.value === '{'
      && k && k.type === 'ident' && k.value === 'type'
      && colon && colon.type === 'punct' && colon.value === ':'
      && v && v.type === 'string' && v.value === 'text') return true
  }
  return false
}

function validateTools(pluginDir, result) {
  // TOOL-001..005：defineTool 约定（token 级块作用域启发式，scripts/_analyze.js）。
  for (const src of readSourceFiles(pluginDir)) {
    let raw
    try {
      raw = readTextStrict(src)
    } catch {
      continue
    }
    if (!raw.includes('defineTool')) continue
    const rel = relPosix(pluginDir, src)
    const tokens = tokenize(raw)
    for (const blk of extractBlocks(tokens, 'defineTool')) {
      const block = blk.tokens
      const missing = ['name', 'description', 'parameters', 'output', 'execute']
        .filter((k) => !hasKeyForm(block, k))
      if (missing.length > 0) {
        emit(result, 'TOOL-001', { path: rel, missing: missing.join('、') })
      }
      if (!(hasKeyForm(block, 'schema') && hasKeyForm(block, 'render'))) {
        emit(result, 'TOOL-002', { path: rel })
      }
      const desc = propValueBlock(block, 'description')
      const descStr = desc && desc.length === 1 && desc[0].type === 'string' ? desc[0].value : null
      if (descStr !== null && descStr.length < 20) {
        emit(result, 'TOOL-003', { path: rel, length: descStr.length })
      }
      // TOOL-004：parameters 与 output.schema 中每个 type:'object' 节点独立检查，
      // 本节点无 additionalProperties 即报（不再被块内其他位置的声明掩护）。
      const params = propValueBlock(block, 'parameters')
      const output = propValueBlock(block, 'output')
      const schemaRegion = output ? propValueBlock(output, 'schema') : null
      for (const region of [params, schemaRegion]) {
        if (!region) continue
        for (const node of objectTypedNodes(region)) {
          if (!hasDirectProperty(node, 'additionalProperties')) {
            emit(result, 'TOOL-004', { path: rel })
          }
        }
      }
      // TOOL-005：仅扫描 execute 值域内的 return（execute 之后的代码不再误报）。
      const exec = propValueBlock(block, 'execute')
      if (exec && returnsContentBlock(exec)) {
        emit(result, 'TOOL-005', { path: rel })
      }
    }
  }
}

// CFG-002 可调参数名阈值（与原正则实现保持一致）。
const TUNABLE_NAME_RE = /(timeout|interval|port|limit|^max_|^min_|retr|delay|endpoint)/i

function validateConfig(pluginDir, result) {
  // CFG-001..003：配置纪律。
  let readmeText = ''
  const readme = join(pluginDir, 'README.md')
  if (existsSync(readme)) {
    try {
      readmeText = readTextStrict(readme)
    } catch { /* 保持空 */ }
  }
  for (const src of readSourceFiles(pluginDir)) {
    let text
    try {
      text = readTextStrict(src)
    } catch {
      continue
    }
    const rel = relPosix(pluginDir, src)

    if (/from\s+['"]@deepseek-ai\/schemastery['"]/.test(text) || text.includes('Schema.object(')) {
      const hasConst = /export\s+const\s+Config\b/.test(text)
      const hasIface = /export\s+(interface|type)\s+Config\b/.test(text)
      if (extname(src) === '.ts') {
        if (!(hasConst && hasIface)) {
          const found = []
          if (hasConst) found.push('const Config')
          if (hasIface) found.push('interface Config')
          emit(result, 'CFG-001', { path: rel, found: found.join('、') || '无' })
        }
      } else if (!hasConst) {
        emit(result, 'CFG-001', { path: rel, found: '无' })
      }
    }

    // CFG-002：token 级声明扫描（注释天然跳过；函数体内 let/var 也覆盖；
    // 模板串 URL 由漏报变命中）。可调参数名阈值与原实现一致。
    // seenLiterals 去重：同一字面量（如 URL）只报一次，避免声明形态与
    // 裸值形态双重告警。
    const tokens = tokenize(text)
    const seenLiterals = new Set()
    for (let i = 0; i + 3 < tokens.length; i += 1) {
      const kw = tokens[i]
      const nameTok = tokens[i + 1]
      const eq = tokens[i + 2]
      const val = tokens[i + 3]
      if (kw.type === 'ident' && (kw.value === 'const' || kw.value === 'let' || kw.value === 'var')
        && nameTok.type === 'ident' && eq.type === 'punct' && eq.value === '='
        && (val.type === 'number' || val.type === 'string')
        && TUNABLE_NAME_RE.test(nameTok.value)) {
        const literal = `${nameTok.value} = ${val.value}`
        seenLiterals.add(val.value)
        emit(result, 'CFG-002', { path: rel, literal })
      }
    }
    for (const value of stringValues(tokens)) {
      if (/^https?:\/\//.test(value) && !seenLiterals.has(value)) {
        seenLiterals.add(value)
        emit(result, 'CFG-002', { path: rel, literal: value })
      }
    }

    for (const m of text.matchAll(/(\w+)\s*:\s*(Schema\.[^\n]+)/g)) {
      const field = m[1]
      const chain = m[2]
      if (chain.includes('.required()') && !chain.includes('.default(')) {
        if (!readmeText.includes(field)) emit(result, 'CFG-003', { path: rel, field })
      }
    }
  }
}

function validateDeps(pluginDir, pkg, result) {
  // DEP-001..005：依赖健康。
  const depSections = {}
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
    const v = pkg[section]
    if (isDict(v)) depSections[section] = new Set(Object.keys(v))
  }
  const allDeclared = new Set()
  for (const s of Object.values(depSections)) {
    for (const k of s) allDeclared.add(k)
  }

  for (const src of readSourceFiles(pluginDir)) {
    let text
    try {
      text = readTextStrict(src)
    } catch {
      continue
    }
    const rel = relPosix(pluginDir, src)
    // DEP-001：token 级 import 收集（注释免疫；动态 import() 与裸导入由
    // 漏报变命中）。作用域仍限 @deepseek-ai/，不扩大到全外部包。
    const imps = new Set()
    const tokens = tokenize(text)
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const t = tokens[i]
      const s = tokens[i + 1]
      if (!s || s.type !== 'string' || !s.value.startsWith('@deepseek-ai/')) continue
      if (t.type === 'ident' && (t.value === 'from' || t.value === 'import')) {
        imps.add(s.value)
      } else if (t.type === 'punct' && t.value === '('
        && i >= 1 && tokens[i - 1].type === 'ident' && tokens[i - 1].value === 'import') {
        imps.add(s.value)
      }
    }
    for (const imp of imps) {
      if (!allDeclared.has(imp)) {
        emit(result, 'DEP-001', { path: rel, pkg: imp })
      } else if ((depSections.dependencies || new Set()).has(imp)) {
        emit(result, 'DEP-004')
      }
    }
  }

  if (pyTruthy(pkg.repository)) {
    const scripts = pkg.scripts || {}
    if (!(isDict(scripts) && scripts.prepare)) emit(result, 'DEP-002')
  }
  // DEP-005：宿主包范围钉死过窄。0.x 上 ^/~/精确/x-range 都锁定次版本，
  // 宿主 minor 升级（0.1→0.2）后即不满足——真实案例：dsh-smart-charts@8.4.0
  // 要求 dsh-skill-filesystem ^0.1.0-rc.6，与 DSH 0.2.0-rc.2 不兼容。
  const HOST_PKG_PREFIX = /^(@deepseek-ai\/|dsh-skill-)/
  const NARROW_ZERO_MINOR = /^[\^~]?0\.\d+\.(\d+([-+][\w.+-]*)?|[xX*])$/
  for (const section of ['peerDependencies', 'dependencies']) {
    const deps = isDict(pkg[section]) ? pkg[section] : {}
    for (const [name, range] of Object.entries(deps)) {
      if (!HOST_PKG_PREFIX.test(name)) continue
      const r = String(range).trim()
      if (NARROW_ZERO_MINOR.test(r)) emit(result, 'DEP-005', { pkg: name, range: r })
    }
  }
  const scripts = pkg.scripts || {}
  const prepare = isDict(scripts) ? String(scripts.prepare || '') : ''
  if (prepare) {
    const pm = prepare.match(/\.\.\/\.\.|--filter|\bturbo\b|\bnx\b/)
    if (pm) emit(result, 'DEP-003', { pattern: pm[0] })
  }
}

function validateDocsDsh(pluginDir, result) {
  // DOC-002/003：README Quickstart 与指针悬空。
  const readme = join(pluginDir, 'README.md')
  if (!existsSync(readme)) {
    emit(result, 'DOC-002')
    return
  }
  let text
  try {
    text = readTextStrict(readme)
  } catch {
    emit(result, 'DOC-002')
    return
  }
  if (!/^#+.*quickstart|^#+.*快速开始/im.test(text)) emit(result, 'DOC-002')
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)#\s]+)\)/g)) {
    const target = m[1]
    if (target.startsWith('http://') || target.startsWith('https://')
      || target.startsWith('mailto:') || target.includes('..')) continue
    if (!existsSync(join(pluginDir, target))) {
      emit(result, 'DOC-003', { path: 'README.md', target })
    }
  }
}

function validateDocBudget(pluginDir, result) {
  // DOC-004/005：md 文档总量预算。templates/ 是渲染产物（init 的输出源），
  // 非读物，不计入预算。
  let mdFiles
  try {
    mdFiles = listFilesSorted(pluginDir, new Set([...SKIP_DIRS, 'templates']))
      .filter((f) => f.parts[f.parts.length - 1].endsWith('.md'))
  } catch {
    return
  }

  const warnLimit = POLICY.param('DOC-004', 'md_total_warn',
    DOC_BUDGET.md_total_base + DOC_BUDGET.md_total_per_member)
  const errorLimit = POLICY.param('DOC-005', 'md_total_error', warnLimit * 2)

  const total = mdFiles.length
  result.infos.push(
    `文档预算诊断: md 文件 ${total} 个（warn 阈值 ${warnLimit} / `
    + `error 阈值 ${errorLimit}，SSOT：脚本 DOC_BUDGET）`)
  if (total > errorLimit) {
    emit(result, 'DOC-005', { total, limit: errorLimit })
  } else if (total > warnLimit) {
    emit(result, 'DOC-004', { total, limit: warnLimit })
  }
}

// ---------------------------------------------------------------------------
// policy append 执行（append = 代码执行面，须显式授权）
// ---------------------------------------------------------------------------
function runPolicyAppends(root, result, appendAllowed = true) {
  if (POLICY.append.length === 0) return
  if (!appendAllowed) {
    emit(result, 'APP-002')
    return
  }
  for (const item of POLICY.append) {
    const scriptPath = resolve(root, item.script)
    if (!existsSync(scriptPath)) {
      emit(result, 'APP-001', { script: item.script, reason: '脚本不存在' })
      continue
    }
    let proc
    try {
      proc = spawnSync(process.execPath, [scriptPath, String(root)], {
        timeout: 60000,
        encoding: 'utf8',
      })
    } catch (e) {
      emit(result, 'APP-001', { script: item.script, reason: String(e.message || e).slice(0, 200) })
      continue
    }
    if (proc.error) {
      emit(result, 'APP-001', { script: item.script, reason: String(proc.error.message || proc.error).slice(0, 200) })
      continue
    }
    if (proc.status !== 0) {
      emit(result, 'APP-001', {
        script: item.script,
        reason: ((proc.stderr || '').trim().split('\n')[0] || '').slice(0, 200),
      })
      continue
    }
    for (let line of (proc.stdout || '').split('\n')) {
      line = line.trim()
      if (!line) continue
      const parts = splitMax(line, '|', 3)
      if (parts.length !== 3 || !VALID_SEVERITIES.includes(parts[0])) {
        result.errors.push(
          `[${item.id}][error] append 脚本输出格式非法（须 SEVERITY|ID|message）: ${line.slice(0, 120)}`)
        continue
      }
      const [sev, cid, msg] = parts
      const outLine = `[${cid}][${sev}] ${msg}`
      if (sev === 'error') result.errors.push(outLine)
      else if (sev === 'warn') result.warnings.push(outLine)
      else result.infos.push(outLine)
    }
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
export function validateTarget(targetPath, opts = {}) {
  const { policyPath = null, skipPathCheck = false, trustAppend = false } = opts
  // 无条件重置：本函数会被 index.js 在同一进程内反复调用，
  // 上一次加载的 policy 不得残留到下一次校验。
  POLICY = new Policy()
  if (policyPath) loadPolicy(policyPath)

  const targetDir = resolve(targetPath)
  const result = new ValidationResult()

  if (!existsSync(targetDir)) {
    emit(result, 'LOC-002', { path: targetDir })
    return result
  }
  if (!isDirSync(targetDir)) {
    emit(result, 'LOC-003', { path: targetDir })
    return result
  }

  const pcv = PLATFORM_CONTRACT_VERSION
  result.infos.push(
    `[CONTRACT] dsh 平台契约快照 ${pcv.contract_version}（最近巡检 ${pcv.last_inspected}）：`
    + `bundle 形态 ${pcv.bundle_shape}；层序 ${pcv.layers}；manifest ${pcv.manifests}；`
    + `官方规范 ${pcv.spec_url}`)

  if (!existsSync(join(targetDir, 'package.json'))) {
    emit(result, 'DET-001')
    return result
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
  } catch (e) {
    emit(result, 'PKG-001', { reason: `非法 JSON: ${e.message}` })
    return result
  }
  if (!isDict(pkg)) {
    emit(result, 'PKG-001', { reason: '顶层必须是对象' })
    return result
  }

  const patchRel = validatePkg(targetDir, pkg, result)
  const dsh = pkg.dsh
  const isBundle = isDict(dsh) && isDict(dsh.bundle)
  if (isBundle && patchRel) validatePatchFile(targetDir, patchRel, result)
  if (isBundle) validateDevOverlay(targetDir, result)
  validateEntryTs(targetDir, pkg, result)
  validateTools(targetDir, result)
  validateConfig(targetDir, result)
  validateDeps(targetDir, pkg, result)
  validateDocsDsh(targetDir, result)
  validateDocBudget(targetDir, result)
  scanPlaceholders(targetDir, result)
  scanSecurity(targetDir, result)
  // append 脚本来自被校验包，属代码执行面：就地校验（--skip-path-check，
  // 典型为第三方包）时默认禁用，须显式 --trust-append。
  runPolicyAppends(targetDir, result, trustAppend || !skipPathCheck)

  return result
}

export function main(argv) {
  if (argv.includes('--policy-help')) {
    return { exitCode: 0, stdout: POLICY_HELP, stderr: '' }
  }

  let policyPath = null
  let skipPath = false
  let trustAppend = false
  const positional = []
  let i = 0
  while (i < argv.length) {
    if (argv[i] === '--policy') {
      if (i + 1 >= argv.length) {
        return { exitCode: 2, stdout: '❌ --policy 需要文件参数', stderr: '' }
      }
      policyPath = argv[i + 1]
      i += 2
    } else if (argv[i] === '--skip-path-check') {
      skipPath = true
      i += 1
    } else if (argv[i] === '--trust-append') {
      trustAppend = true
      i += 1
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      return { exitCode: 0, stdout: HELP_TEXT, stderr: '' }
    } else {
      positional.push(argv[i])
      i += 1
    }
  }

  if (positional.length !== 1) {
    const usage = [
      'Usage: node validate_plugin.js <path/to/plugin-dir> '
      + '[--policy <file>] [--skip-path-check] [--trust-append]',
      '',
      'Example:',
      '  node validate_plugin.js plugins/my-dsh-plugin',
      '  node validate_plugin.js /tmp/third-party-pkg --skip-path-check',
      '',
      '  node validate_plugin.js --policy-help   # policy 文件格式',
    ].join('\n')
    return { exitCode: 2, stdout: usage, stderr: '' }
  }

  const targetPath = positional[0]
  let result
  try {
    result = validateTarget(targetPath, {
      policyPath,
      skipPathCheck: skipPath,
      trustAppend,
    })
  } catch (e) {
    if (e instanceof PolicyError) {
      return { exitCode: 2, stdout: `❌ policy 拒绝加载: ${e.message}`, stderr: '' }
    }
    throw e
  }

  const stdout = `🔍 Validating target: ${targetPath}\n\n${result.summary()}`
  return { exitCode: result.isValid ? 0 : 1, stdout, stderr: '' }
}

if (isMain(import.meta.url)) runMain(main)

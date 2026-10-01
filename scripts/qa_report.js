// DSH Plugin QA Report Aggregator (M3) — aggregates machine-readable runtime
// evidence (verify_plugin.js round JSON under <target>/qa/evidence/) and
// packaging acceptance (package_plugin.js dist/acceptance.json) into
// QA-REPORT.md. Judgments belong to the LLM; this script only aggregates
// (references/qa-playbook.md, 9 dimensions).
//
// Honest scope:
//   - Pure aggregation: no verdict is ever fabricated. The 9-dimension table
//     is emitted with explicit 待判定 placeholders for the model to fill.
//   - The uncovered-items section is mandatory and never silent: known blind
//     spots from qa-playbook.md are always listed.
//   - Regression diff compares the selected round with the previous one by
//     layer verdict only (byte-level report diffing stays with the model).
//
// Exit codes: 0 = report generated, no fail verdict aggregated;
//             1 = report generated but a fail was aggregated (a 'fail' layer
//                 verdict in the selected round, or acceptance exit_code 1),
//                 or no evidence and no acceptance existed to aggregate;
//             2 = usage error (missing target / not a plugin dir / bad round).
//
// Usage:
//     node qa_report.js <plugin-dir> [--out <file>] [--round <N>]

import fs from 'node:fs'
import path from 'node:path'
import { isMain, runMain } from './_cli.js'

const USAGE = '用法: node qa_report.js <plugin-dir> [--out <file>] [--round <N>]\n'
  + '  --out <file>   报告输出路径（默认 <target>/qa/QA-REPORT.md）\n'
  + '  --round <N>   聚合指定证据轮次（默认取最新一轮）'

const VERDICT_BADGE = {
  pass: '✅ pass',
  fail: '❌ fail',
  skip: '⏭ skip',
  degraded: '⚠ degraded',
  manual: '✍ manual',
}

// Stable blind spots declared by references/qa-playbook.md — always listed so
// the report can never claim complete machine coverage.
const KNOWN_BLIND_SPOTS = [
  'TOOL-004/005 等语义级规则为词法启发式，需 L4 抽查复核（qa-playbook 已知盲区）',
  'L4 行为协议为手工执行项，脚本只留证不判定',
  '无 dsh CLI / 无密钥环境的对应层降级或跳过（以证据 JSON 的 verdict 为准）',
]

function usage2(msg) {
  return { exitCode: 2, stdout: '', stderr: `qa_report: ${msg}\n${USAGE}` }
}

function isoLocal(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Markdown table cell: escape pipes, collapse whitespace, clip long text. */
function cell(text, budget = 160) {
  const t = String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return '—'
  return t.length <= budget ? t : `${t.slice(0, budget)}…`
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function listRounds(evidenceRoot) {
  if (!fs.existsSync(evidenceRoot)) return []
  return fs.readdirSync(evidenceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^round-\d+$/.test(e.name))
    .map((e) => Number(e.name.slice('round-'.length)))
    .sort((a, b) => a - b)
}

/** Read one round: layer records (sorted by file name) + the summary record. */
function readRound(evidenceRoot, n) {
  const dir = path.join(evidenceRoot, `round-${n}`)
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    : []
  const layers = []
  let summary = null
  for (const f of files) {
    const rec = readJson(path.join(dir, f))
    if (!rec) continue
    if (f === 'summary.json') summary = rec
    else layers.push(rec)
  }
  return { n, dir, layers, summary }
}

/** layer -> verdict map (summary wins as the round's authoritative tally). */
function layerVerdictMap(round) {
  if (!round) return {}
  const map = {}
  for (const rec of round.layers) map[rec.layer] = rec.verdict
  if (round.summary && Array.isArray(round.summary.layers)) {
    for (const entry of round.summary.layers) {
      if (entry && entry.layer) map[entry.layer] = entry.verdict
    }
  }
  return map
}

function badge(verdict) {
  return VERDICT_BADGE[verdict] || `❓ ${verdict ?? 'unknown'}`
}

/** Render the summary environment block (dsh CLI tier facts). */
function environmentLines(summary) {
  const env = summary && summary.environment
  if (!env || typeof env !== 'object') return []
  const out = []
  if (typeof env.dsh_cli === 'boolean') {
    out.push(`- dsh CLI: ${env.dsh_cli ? `${env.dsh_bin || '?'}${env.dsh_version ? ` (${env.dsh_version})` : ''}` : `未检测到（${env.dsh_reason || '原因未知'}）`}`)
  }
  const rest = Object.entries(env).filter(([k]) => k !== 'dsh_cli' && k !== 'dsh_bin' && k !== 'dsh_version' && k !== 'dsh_reason' && k !== 'candidates' && k !== 'tried')
  for (const [k, v] of rest) out.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  return out
}

export function main(argv) {
  const optionValue = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }
  // Option values are not the positional target (`--out x --round 3`).
  const valueIndexes = new Set()
  for (const name of ['--out', '--round']) {
    const i = argv.indexOf(name)
    if (i >= 0) valueIndexes.add(i + 1)
  }
  const target = argv.find((a, i) => !a.startsWith('--') && !valueIndexes.has(i))
  if (!target) return usage2('缺少 <plugin-dir>')
  const outArg = optionValue('--out')
  const roundArg = optionValue('--round')

  const pluginDir = path.isAbsolute(target) ? target : path.resolve(target)
  const pkg = readJson(path.join(pluginDir, 'package.json'))
  if (!pkg || typeof pkg.name !== 'string') {
    return usage2(`目标不是 dsh 插件目录（缺少 package.json）: ${pluginDir}`)
  }
  const name = pkg.name
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'

  // ---- inputs ---------------------------------------------------------------
  const evidenceRoot = path.join(pluginDir, 'qa', 'evidence')
  const rounds = listRounds(evidenceRoot)
  let selected = null
  if (roundArg !== null) {
    const n = Number(roundArg)
    if (!Number.isInteger(n) || n < 1 || !rounds.includes(n)) {
      return usage2(`轮次 round-${roundArg} 不存在于 ${evidenceRoot}`)
    }
    selected = readRound(evidenceRoot, n)
  } else if (rounds.length > 0) {
    selected = readRound(evidenceRoot, rounds[rounds.length - 1])
  }
  const prev = selected && rounds.includes(selected.n - 1)
    ? readRound(evidenceRoot, selected.n - 1)
    : null
  const acceptance = readJson(path.join(pluginDir, 'dist', 'acceptance.json'))
  const hasAcceptance = Boolean(acceptance && typeof acceptance.verdict === 'string')

  // ---- aggregation ----------------------------------------------------------
  const currentMap = layerVerdictMap(selected)
  const prevMap = layerVerdictMap(prev)
  const tally = { pass: 0, fail: 0, skip: 0, degraded: 0, manual: 0, other: 0 }
  for (const v of Object.values(currentMap)) {
    if (v in tally) tally[v] += 1
    else tally.other += 1
  }
  const failAggregated = Object.values(currentMap).includes('fail')
    || (hasAcceptance && acceptance.exit_code === 1)
  const nothingAggregated = !selected && !hasAcceptance
  const uncoveredItems = []
  if (selected && selected.summary && Array.isArray(selected.summary.uncovered)) {
    uncoveredItems.push(...selected.summary.uncovered)
  }
  if (hasAcceptance && Array.isArray(acceptance.uncovered)) {
    uncoveredItems.push(...acceptance.uncovered)
  }
  if (!selected) uncoveredItems.push(`运行时验证未执行：qa/evidence 下无 round-* 证据（先运行 verify_plugin.js）`)
  if (!hasAcceptance) uncoveredItems.push('打包验收未执行：dist/acceptance.json 不存在（先运行 package_plugin.js）')

  // ---- report ---------------------------------------------------------------
  const report = []
  report.push(`# QA-REPORT — ${name} v${version}`)
  report.push('')
  report.push('> 由 qa_report.js 聚合生成；判定归 LLM，脚本只聚合（references/qa-playbook.md）。')
  report.push(`> 生成时间：${isoLocal(new Date())} ｜ 目标：${pluginDir}`)
  report.push(`> 证据轮次：${selected ? `round-${selected.n}（${selected.dir}）` : '无（qa/evidence 无 round-*）'} ｜ 打包验收：${hasAcceptance ? 'dist/acceptance.json' : '无'}`)
  report.push('')

  // §1 layer matrix
  report.push(`## 1. 运行时验证矩阵${selected ? `（round-${selected.n}）` : ''}`)
  report.push('')
  if (selected && selected.layers.length > 0) {
    report.push('| 层 | 判定 | 期望 | 命令 |')
    report.push('| --- | --- | --- | --- |')
    for (const rec of selected.layers) {
      report.push(`| ${cell(rec.layer, 40)} | ${badge(rec.verdict)} | ${cell(rec.expectation)} | ${cell(rec.command)} |`)
    }
    const l4 = selected.layers.find((rec) => rec.layer === 'L4')
    if (l4 && Array.isArray(l4.protocol) && l4.protocol.length > 0) {
      report.push('')
      report.push('L4 手工协议（判定归 LLM，逐项执行并如实记录）：')
      for (const item of l4.protocol) report.push(`- ${item}`)
    }
    const envLines = environmentLines(selected.summary)
    if (envLines.length > 0) {
      report.push('')
      report.push('环境：')
      report.push(...envLines)
    }
  } else if (selected) {
    report.push('证据目录存在但未读到任何层 JSON（证据可能损坏——核对 round 目录内容）。')
  } else {
    report.push('无运行时证据。运行 verify_plugin.js 产出 qa/evidence/round-*/ 后重新聚合。')
  }
  report.push('')

  // §2 regression diff
  report.push('## 2. 回归 diff')
  report.push('')
  if (!selected || !prev) {
    report.push(selected ? '仅一轮证据，无上一轮可对比。' : '无证据，无回归对比。')
  } else {
    const keys = [...new Set([...Object.keys(prevMap), ...Object.keys(currentMap)])].sort()
    const changed = keys.filter((k) => prevMap[k] !== currentMap[k])
    if (changed.length === 0) {
      report.push(`round-${prev.n} → round-${selected.n}：所有层 verdict 无变化。`)
    } else {
      report.push(`round-${prev.n} → round-${selected.n}（仅列 verdict 变化的层）：`)
      report.push('')
      report.push('| 层 | 上轮 | 本轮 |')
      report.push('| --- | --- | --- |')
      for (const k of changed) {
        report.push(`| ${cell(k, 40)} | ${badge(prevMap[k])} | ${badge(currentMap[k])} |`)
      }
    }
  }
  report.push('')

  // §3 packaging acceptance
  report.push('## 3. 打包验收（dist/acceptance.json）')
  report.push('')
  if (hasAcceptance) {
    report.push(`- 结论：**${acceptance.verdict}**（exit ${acceptance.exit_code}）`)
    if (acceptance.artifact) report.push(`- 产物：${acceptance.artifact}`)
    if (acceptance.dsh && typeof acceptance.dsh === 'object') {
      report.push(`- dsh CLI：${acceptance.dsh.available ? `${acceptance.dsh.bin || '?'}${acceptance.dsh.version ? ` (${acceptance.dsh.version})` : ''}` : `未检测到（${acceptance.dsh.reason || '原因未知'}）`}`)
    }
    const errors = Array.isArray(acceptance.errors) ? acceptance.errors : []
    const warnings = Array.isArray(acceptance.warnings) ? acceptance.warnings : []
    report.push(`- 阻断（errors）：${errors.length}`)
    for (const e of errors) report.push(`  - ❌ ${e}`)
    report.push(`- 警告（warnings）：${warnings.length}`)
    for (const w of warnings) report.push(`  - ⚠️ ${w}`)
  } else {
    report.push('未找到 dist/acceptance.json——打包验收未执行（运行 package_plugin.js 产出）。')
  }
  report.push('')

  // §4 nine dimensions
  report.push('## 4. 九维度判定表（结论列归 LLM 填写，脚本不判定）')
  report.push('')
  const dim = (v) => (v ? badge(v) : '无证据')
  const rows = [
    ['1', '调用准确性', '无自动证据（混淆矩阵需 LLM 构造问法集并执行）'],
    ['2', '开箱首轮', '无自动证据（按 README Quickstart 人工走查）'],
    ['3', '能力边界', '无自动证据（边界输入实测）'],
    ['4', '平台铁律自检', `L1=${dim(currentMap.L1)}（round-${selected ? selected.n : '-'} /L1.json）`],
    ['5', '可运行性', `L3=${dim(currentMap.L3)}，L5=${dim(currentMap['L5-add'] ?? currentMap.L5)}（round-${selected ? selected.n : '-'} /）`],
    ['6', '正确性 / 一致性', `L4=${dim(currentMap.L4)}，协议见 round-${selected ? selected.n : '-'}/L4.json`],
    ['7', '边界正确性', '无自动证据（拆分理由质询）'],
    ['8', '文档 SSOT', 'DOC-* 规则输出见 L1.json evidence'],
    ['9', '隐私 / 泄漏', 'SEC-* 规则输出见 L1.json evidence'],
  ]
  report.push('| # | 维度 | 机器证据锚点 | 结论 |')
  report.push('| --- | --- | --- | --- |')
  for (const [no, d, anchor] of rows) {
    report.push(`| ${no} | ${d} | ${cell(anchor)} | ☐ 待判定 |`)
  }
  report.push('')

  // §5 uncovered items
  report.push('## 5. 未覆盖项（禁止静默通过）')
  report.push('')
  const deduped = [...new Set(uncoveredItems)]
  if (deduped.length === 0) {
    report.push('本轮证据未声明未覆盖项。')
  } else {
    for (const u of deduped) report.push(`- ${u}`)
  }
  report.push('')
  report.push('已知盲区（qa-playbook.md，始终列出）：')
  for (const b of KNOWN_BLIND_SPOTS) report.push(`- ${b}`)
  report.push('')

  // §6 completion gate
  report.push('## 6. 完成判定')
  report.push('')
  report.push('- 九维度「结论」列全部填写后，本报告才构成 QA 完成；')
  report.push('- 未覆盖项须逐条处置或声明保留原因；')
  report.push('- 两者未满足前，禁止以本报告宣称 QA 完成。')
  report.push('')

  // ---- write ----------------------------------------------------------------
  const outPath = outArg ? path.resolve(outArg) : path.join(pluginDir, 'qa', 'QA-REPORT.md')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${report.join('\n')}\n`, 'utf8')

  const lines = []
  lines.push(`📊 QA 报告聚合：${name}@${version}`)
  lines.push(`   证据轮次: ${selected ? `round-${selected.n}` : '无'} | 打包验收: ${hasAcceptance ? acceptance.verdict : '未执行'}`)
  lines.push(`   层矩阵: pass ${tally.pass} | fail ${tally.fail} | manual ${tally.manual} | skip ${tally.skip} | degraded ${tally.degraded}${tally.other ? ` | 其他 ${tally.other}` : ''}`)
  lines.push(`   未覆盖项: ${deduped.length + KNOWN_BLIND_SPOTS.length} 条（含已知盲区 ${KNOWN_BLIND_SPOTS.length} 条）`)
  lines.push(`   报告: ${outPath}`)
  const exitCode = failAggregated || nothingAggregated ? 1 : 0
  if (exitCode === 1) {
    lines.push(failAggregated ? '❌ 聚合到 fail 判定（exit 1）——见报告 §1/§3' : '❌ 无可聚合证据（exit 1）——先运行 verify_plugin.js / package_plugin.js')
  } else {
    lines.push('✅ 聚合完成，无 fail 判定（exit 0；判定结论仍归 LLM）')
  }
  return { exitCode, stdout: lines.join('\n'), stderr: '' }
}

if (isMain(import.meta.url)) runMain(main)

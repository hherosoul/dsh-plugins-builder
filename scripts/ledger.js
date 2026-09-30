// DSH Plugin Delivery Ledger - local-first delivery ledger
// ($DSH_HOME/dsh-plugin-ledger/): LEDGER.md (human) + ledger.jsonl (machine
// event stream, mirror of each other). Subcommands: bootstrap / add / latest /
// align / advise. See references/ledger-playbook.md.
//
// Honest scope (M2):
//   - Storage is LOCAL ($DSH_HOME, falling back to ~/.dsh when unset). The
//     cloud channel is an optional host capability this script cannot detect;
//     it never claims cloud sync that did not happen.
//   - Seven mandatory fields per entry (playbook): time / plugin / version /
//     action / note / verdict / environment tier. add enforces them.
//   - advise reports days since the last platform-contract inspection
//     (from validate_plugin.js PLATFORM_CONTRACT_VERSION, single SSOT) and
//     emits the drift-report todo when over threshold.
//
// Exit codes: 0 = ok; 1 = write/verify failure (delivery claim forbidden);
// 2 = usage error.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMain, runMain } from './_cli.js'
import { dshHome } from './_run.js'
import { PLATFORM_CONTRACT_VERSION } from './validate_plugin.js'

// 契约巡检阈值（天）。SSOT 在本常量；文档一律指针引用，不写数字。
const INSPECTION_THRESHOLD_DAYS = 30

const ACTIONS = new Set(['create', 'update', 'package', 'deliver'])
const VERDICTS = new Set(['通过', '带警告通过', '不通过'])
const TIERS = new Set(['full', 'no-key', 'no-cli'])

const MD_HEADER = [
  '# dsh 插件交付台账',
  '',
  '> 本文件由 ledger.js 维护（与 ledger.jsonl 互为镜像）；历史不删，靠 archive 消化。',
  '> 字段：时间 | 插件 | 版本 | 动作 | 验收结论 | 环境覆盖档 | 变更说明',
  '',
  '| 时间 | 插件 | 版本 | 动作 | 验收结论 | 环境覆盖档 | 变更说明 |',
  '|---|---|---|---|---|---|---|',
]

function ledgerRoot() {
  return join(dshHome(), 'dsh-plugin-ledger')
}

function mdPath(root) {
  return join(root, 'LEDGER.md')
}

function jsonlPath(root) {
  return join(root, 'ledger.jsonl')
}

/** Local-timezone ISO timestamp with numeric offset (playbook: 本地时区 ISO). */
function isoLocal(now = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0')
  const off = -now.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

function readJsonl(root) {
  const p = jsonlPath(root)
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      // 历史不删：坏行原样保留在文件里，聚合时跳过（如实计数）。
    }
  }
  return out
}

function readMdRows(root) {
  const p = mdPath(root)
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 8 || cells[1] === '时间' || /^-+$/.test(cells[1])) continue
    out.push({
      time: cells[1], plugin: cells[2], version: cells[3], action: cells[4],
      verdict: cells[5], tier: cells[6], note: cells[7] || '',
    })
  }
  return out
}

function entryToMdRow(e) {
  const note = String(e.note || '').replace(/\|/g, '｜').replace(/\n/g, ' ')
  return `| ${e.time} | ${e.plugin} | ${e.version} | ${e.action} | ${e.verdict} | ${e.tier} | ${note} |`
}

function writeBoth(root, entries) {
  const sorted = [...entries].sort((a, b) => String(a.time).localeCompare(String(b.time)))
  writeFileSync(mdPath(root), [...MD_HEADER, ...sorted.map(entryToMdRow), ''].join('\n'))
  writeFileSync(jsonlPath(root), sorted.map((e) => JSON.stringify(e)).join('\n') + (sorted.length ? '\n' : ''))
  return sorted
}

function bootstrap(root) {
  mkdirSync(root, { recursive: true })
  if (!existsSync(mdPath(root))) writeFileSync(mdPath(root), [...MD_HEADER, ''].join('\n'))
  if (!existsSync(jsonlPath(root))) writeFileSync(jsonlPath(root), '')
  return {
    exitCode: 0,
    stdout: [
      `📁 台账目录: ${root}`,
      'LEDGER.md + ledger.jsonl 就绪（幂等）。',
      '云端同步：未接入（宿主未提供绑定通道）；本地台账完整可用，不谎称已同步。',
    ].join('\n'),
    stderr: '',
  }
}

function parseFlag(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}

function add(root, argv) {
  const pkgDir = parseFlag(argv, '--pkg')
  const note = parseFlag(argv, '--note')
  const verdict = parseFlag(argv, '--verdict')
  const tier = parseFlag(argv, '--tier')
  const act = parseFlag(argv, '--act') || 'update'
  const usage = '用法: node ledger.js add --pkg <插件目录> --note "<改了什么>" '
    + '--verdict 通过|带警告通过|不通过 --tier full|no-key|no-cli [--act create|update|package|deliver]'
  if (!pkgDir || !note || !verdict || !tier) return { exitCode: 2, stdout: '', stderr: usage }
  if (!VERDICTS.has(verdict)) return { exitCode: 2, stdout: '', stderr: `--verdict 须为 ${[...VERDICTS].join('|')}，got '${verdict}'\n${usage}` }
  if (!TIERS.has(tier)) return { exitCode: 2, stdout: '', stderr: `--tier 须为 ${[...TIERS].join('|')}，got '${tier}'\n${usage}` }
  if (!ACTIONS.has(act)) return { exitCode: 2, stdout: '', stderr: `--act 须为 ${[...ACTIONS].join('|')}，got '${act}'\n${usage}` }

  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) return { exitCode: 1, stdout: '', stderr: `不是插件目录（缺少 package.json）: ${pkgDir}` }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  bootstrap(root)
  const entry = {
    time: isoLocal(),
    plugin: pkg.name || '<unnamed>',
    version: pkg.version || '0.0.0',
    action: act,
    note,
    verdict,
    tier,
  }
  appendFileSync(jsonlPath(root), `${JSON.stringify(entry)}\n`)
  appendFileSync(mdPath(root), `${entryToMdRow(entry)}\n`)
  // 写后回读验证（记账铁律：写不进去不得宣称已记账）。
  const ok = readJsonl(root).some((e) => e.time === entry.time && e.plugin === entry.plugin)
  if (!ok) {
    return { exitCode: 1, stdout: '', stderr: `记账写入后回读失败（${jsonlPath(root)}）——不得宣称交付完成` }
  }
  return {
    exitCode: 0,
    stdout: `✅ 已记账: ${entry.plugin}@${entry.version} ${entry.action} ${entry.verdict}（${entry.tier}）\n📁 ${jsonlPath(root)}`,
    stderr: '',
  }
}

function latest(root) {
  const entries = readJsonl(root)
  if (entries.length === 0) {
    return { exitCode: 0, stdout: '台账为空（bootstrap 后用 add 记第一笔）。', stderr: '' }
  }
  const byPlugin = new Map()
  for (const e of entries) {
    if (e && e.plugin) byPlugin.set(e.plugin, e)
  }
  const lines = [`当前态（每插件一行，共 ${byPlugin.size} 个）:`]
  for (const [name, e] of byPlugin) {
    lines.push(`   • ${name}@${e.version || '?'}  ${e.action || '?'}  ${e.verdict || '?'}  tier=${e.tier || '?'}  @${e.time}`)
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' }
}

function align(root) {
  const fromJsonl = readJsonl(root)
  const fromMd = readMdRows(root)
  const keyOf = (e) => `${e.time}|${e.plugin}|${e.version}|${e.action}`
  const keys = new Set(fromJsonl.map(keyOf))
  const gainedFromMd = fromMd.filter((e) => !keys.has(keyOf(e)))
  const all = [...fromJsonl, ...gainedFromMd]
  const sorted = writeBoth(root, all)
  return {
    exitCode: 0,
    stdout: [
      `对齐完成（幂等）：共 ${sorted.length} 条；jsonl ${fromJsonl.length} 条，md 表 ${fromMd.length} 行，md 独有并入 ${gainedFromMd.length} 条。`,
      `📁 ${mdPath(root)}`,
    ].join('\n'),
    stderr: '',
  }
}

function advise(root) {
  const inspected = PLATFORM_CONTRACT_VERSION.last_inspected
  const days = Math.floor((Date.now() - new Date(`${inspected}T00:00:00`).getTime()) / 86_400_000)
  const lines = [
    `契约巡检：last_inspected = ${inspected}（contract_version ${PLATFORM_CONTRACT_VERSION.contract_version}），距今 ${days} 天（阈值 ${INSPECTION_THRESHOLD_DAYS} 天，SSOT：ledger.js）。`,
  ]
  if (days > INSPECTION_THRESHOLD_DAYS) {
    lines.push(`⚠️  待办：超过阈值——按 dsh-spec.md 附录页面清单（11 页）逐页核对官方文档，产出「契约漂移报告」（变了什么 / 影响哪些已交付插件 / 待办清单）。`)
  } else {
    lines.push('✅ 未超阈值，无巡检待办。')
  }
  const delivered = readJsonl(root).filter((e) => e.action === 'deliver')
  if (delivered.length > 0) {
    lines.push(`台账反查（巡检时的受影响候选，deliver 动作 ${delivered.length} 条）:`)
    const seen = new Set()
    for (const e of delivered) {
      if (seen.has(e.plugin)) continue
      seen.add(e.plugin)
      lines.push(`   • ${e.plugin}@${e.version}（最后交付 ${e.time}）`)
    }
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' }
}

export function main(argv) {
  const [cmd, ...rest] = argv
  const root = ledgerRoot()
  switch (cmd) {
    case 'bootstrap': return bootstrap(root)
    case 'add': return add(root, rest)
    case 'latest': return latest(root)
    case 'align': return align(root)
    case 'advise': return advise(root)
    default:
      return {
        exitCode: 2,
        stdout: '',
        stderr: '用法: node ledger.js bootstrap|add|latest|align|advise\n'
          + '  add --pkg <插件目录> --note "<改了什么>" --verdict 通过|带警告通过|不通过 '
          + '--tier full|no-key|no-cli [--act create|update|package|deliver]',
      }
  }
}

if (isMain(import.meta.url)) runMain(main)

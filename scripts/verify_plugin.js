// DSH Plugin Runtime Verifier - orchestrates the L2-L5 runtime verification
// matrix (references/qa-playbook.md) and writes per-layer evidence JSON to
// <target>/qa/evidence/round-<N>/.
//
// Honest scope (M2):
//   - Automated (synchronous, spawnSync-based):
//       L1 static   = in-process validate_plugin.js (single SSOT);
//       L2 build    = declared build script via pnpm/npm (JS plugins: entry
//                     presence check);
//       L3 load     = `dsh --profile <tmp> --patch <dev overlay> --dump-config`,
//                     assert row ids appear and no FAILED fiber;
//       L5 install  = temp profile (`__verify_<name>`) `dsh plugin add` ->
//                     dump-config layer check -> boot smoke (timeout-killed,
//                     warn-level) -> FORCED cleanup (failure = error, 留痕).
//   - Manual protocol: L4 behavior items (tool invocation, invalid-config
//     loud failure, HMR, cancellation) need an interactive runtime / model.
//     They are emitted as a protocol with verdict "manual" and listed in
//     未覆盖项. The script cannot see the host's model configuration, so the
//     model-key tier is not auto-detected; both protocol variants are listed.
//   - Environment tiering: no dsh CLI -> only L1-L2 run and the whole run is
//     DEGRADED (exit 3): 运行时验证未执行，交付未达可发布标准.
//
// Exit codes: 0 = all automated layers pass; 1 = some layer failed;
// 2 = usage error; 3 = environment degraded (runtime layers not executed).
//
// Usage:
//     node verify_plugin.js <path/to/plugin-dir> [--skip-smoke] [--round <N>] [--dsh <path>]
//
// CLI resolution: $DSH_BIN / --dsh win, then PATH, then the desktop app bundle
// derived from this process, then the usual install locations (_run.js).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isMain, runMain } from './_cli.js'
import { main as validateMain, parseYamlDoc } from './validate_plugin.js'
import { DSH_HINT, TIMEOUTS, describeDshFailure, dshHome, forceCleanup, resolveDsh, run, tempProfileName } from './_run.js'

const L4_PROTOCOL = [
  '工具调用（需已配置模型）：经 PTC `await tools.<name>(args)` 或 Web UI 实测，断言返回符合 output.schema 的规范值',
  '非法配置响亮失败：构造违反 Config schema 的取值，确认加载失败且报错可见（不静默回退默认值）',
  'HMR 重载：修改入口 / 配置触发重载，经日志或注册表 diff 确认无残留注册',
  '取消语义：长任务执行中触发 signal，确认 aborted 传播且以 isError 收场',
  '无密钥降级档：调用准确性降级为 description 语义评审，混淆矩阵标注「未执行」',
]

function usage(stderr) {
  return { exitCode: 2, stdout: '', stderr }
}

/** Collect dev-overlay row ids (insert/replace rows all carry `id`). */
function overlayRowIds(overlayPath) {
  let doc
  try {
    doc = parseYamlDoc(readFileSync(overlayPath, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(doc)) return null
  const ids = []
  for (const op of doc) {
    if (!op || typeof op !== 'object') continue
    for (const rows of Object.values(op)) {
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (row && typeof row === 'object' && typeof row.id === 'string') ids.push(row.id)
      }
    }
  }
  return ids
}

function excerpt(text, max = 4000) {
  const t = String(text || '').trim()
  return t.length <= max ? t : `${t.slice(0, max)}\n... [truncated ${t.length - max} chars]`
}

function nextRound(evidenceRoot, forced) {
  if (forced) return Number(forced) || 1
  let max = 0
  if (existsSync(evidenceRoot)) {
    for (const entry of readdirSync(evidenceRoot)) {
      const m = /^round-(\d+)$/.exec(entry)
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  return max + 1
}

export function main(argv) {
  const optionValue = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }
  // Option values are not the positional target (`--round 3 --dsh /x/y`).
  const valueIndexes = new Set()
  for (const name of ['--round', '--dsh']) {
    const i = argv.indexOf(name)
    if (i >= 0) valueIndexes.add(i + 1)
  }
  const target = argv.find((a, i) => !a.startsWith('--') && !valueIndexes.has(i))
  if (!target) {
    return usage('用法: node verify_plugin.js <plugin-dir> [--skip-smoke] [--round <N>] [--dsh <path>]\n'
      + '  --skip-smoke   跳过 L5 启动冒烟（仍执行 add + dump + 清理）\n'
      + '  --round <N>    指定证据轮次号（默认自动递增）\n'
      + '  --dsh <path>   指定 dsh CLI（默认 $DSH_BIN → PATH → 应用内置 CLI → 常见安装位置）')
  }
  const skipSmoke = argv.includes('--skip-smoke')
  const forcedRound = optionValue('--round')
  const dshArg = optionValue('--dsh')

  const pluginDir = isAbsolute(target) ? target : resolve(target)
  const pkgPath = join(pluginDir, 'package.json')
  if (!existsSync(pkgPath)) {
    return { exitCode: 2, stdout: '', stderr: `目标不是 dsh 插件目录（缺少 package.json）: ${pluginDir}` }
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const pluginName = pkg.name || '<unnamed>'
  const pluginVersion = pkg.version || '0.0.0'

  // ---- environment tier ----------------------------------------------------
  const dsh = resolveDsh({ explicit: dshArg })

  // ---- evidence store ------------------------------------------------------
  const evidenceRoot = join(pluginDir, 'qa', 'evidence')
  const round = nextRound(evidenceRoot, forcedRound)
  const evidenceDir = join(evidenceRoot, `round-${round}`)
  mkdirSync(evidenceDir, { recursive: true })
  const evidences = []
  const uncovered = []
  const put = (layer, ev) => {
    const record = { plugin: pluginName, round, layer, ...ev }
    evidences.push(record)
    writeFileSync(join(evidenceDir, `${layer}.json`), JSON.stringify(record, null, 2))
    return record
  }

  const lines = []
  lines.push(`🔍 Runtime verification: ${pluginDir}`)
  lines.push(`   plugin: ${pluginName}@${pluginVersion} | round ${round} | dsh CLI: ${dsh.available ? `${dsh.bin} (${dsh.version})` : `未检测到（${dsh.reason}）`}`)

  let failed = false

  // ---- L1 static -----------------------------------------------------------
  const l1 = validateMain([pluginDir])
  const l1v = put('L1', {
    command: `node scripts/validate_plugin.js ${pluginDir}`,
    exit_code: l1.exitCode,
    expectation: '静态规则 ID 校验 0 error',
    verdict: l1.exitCode === 0 ? 'pass' : 'fail',
    evidence: excerpt(l1.stdout),
  })
  lines.push(`L1 静态校验        ${mark(l1v.verdict)}`)
  if (l1v.verdict === 'fail') {
    failed = true
    lines.push('   L1 未通过，后续层不再执行（先修复静态错误）。')
    for (const layer of ['L2', 'L3', 'L4', 'L5']) {
      put(layer, { command: null, exit_code: null, expectation: null, verdict: 'skip', reason: 'L1 未通过' })
    }
  }

  // ---- L2 build ------------------------------------------------------------
  if (l1v.verdict !== 'fail') {
    const buildScript = pkg.scripts && pkg.scripts.build
    const mainEntry = pkg.main ? join(pluginDir, pkg.main) : null
    if (buildScript) {
      const pm = existsSync(join(pluginDir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
      const r = run(pm, ['run', 'build'], { cwd: pluginDir, timeout: TIMEOUTS.build })
      const pass = r.exitCode === 0 && !r.timedOut
      put('L2', {
        command: r.command, exit_code: r.exitCode, signal: r.signal, timed_out: r.timedOut,
        expectation: '构建脚本退出码 0',
        verdict: pass ? 'pass' : 'fail',
        evidence: excerpt(`${r.stdout}\n${r.stderr}`.trim()),
      })
      lines.push(`L2 构建            ${mark(pass ? 'pass' : 'fail')}  (${r.command})`)
      if (!pass) failed = true
    } else if (mainEntry && existsSync(mainEntry)) {
      put('L2', {
        command: null, exit_code: 0,
        expectation: '无构建步骤（JS 直载）：入口存在',
        verdict: 'pass',
        evidence: `main 入口存在: ${pkg.main}`,
      })
      lines.push('L2 构建            [pass]  (无构建步骤，入口直载)')
    } else {
      put('L2', {
        command: null, exit_code: null,
        expectation: '入口存在或构建脚本可用',
        verdict: 'fail',
        evidence: '既无 scripts.build，main 入口也不存在（validate PKG-008 应已报告）',
      })
      lines.push('L2 构建            [fail]  (入口缺失且无构建脚本)')
      failed = true
    }
  }

  // ---- L3 overlay load (needs dsh CLI) --------------------------------------
  const overlayPath = ['cordis.yml', 'cordis.yaml']
    .map((f) => join(pluginDir, 'dev', f))
    .find((p) => existsSync(p)) || null
  const profile = tempProfileName(pluginName)
  const profileDir = join(dshHome(), 'profiles', profile)

  if (l1v.verdict !== 'fail') {
    if (!dsh.available) {
      const why = describeDshFailure(dsh)
      put('L3', {
        command: null, exit_code: null,
        expectation: '覆盖层加载 + dump-config 出现目标行',
        verdict: 'degraded', reason: `无可用 dsh CLI（${dsh.reason}）`,
        resolution: { candidates: dsh.candidates, tried: dsh.tried }, detail: why,
      })
      uncovered.push(`L3 覆盖层加载（未执行，${dsh.reason}）: ${why}`)
      lines.push(`L3 覆盖层加载      [degraded]  ${dsh.reason}，未执行`)
    } else if (!overlayPath) {
      put('L3', {
        command: null, exit_code: null,
        expectation: 'dev/ 覆盖层加载',
        verdict: 'skip', reason: 'dev/cordis.yml 缺失（仓库只留示例覆盖层，本地覆盖层不入库属预期）',
      })
      uncovered.push('L3 覆盖层加载（dev/cordis.yml 缺失，未执行）')
      lines.push('L3 覆盖层加载      [skip]  dev/ 覆盖层缺失')
    } else {
      const rowIds = overlayRowIds(overlayPath) || []
      const r = run(dsh.bin, ['--profile', profile, '--patch', overlayPath, '--dump-config'], { timeout: TIMEOUTS.dump })
      const hasIds = rowIds.length > 0 && rowIds.every((id) => r.stdout.includes(id))
      const noFailed = !/FAILED/.test(r.stdout)
      const pass = r.exitCode === 0 && hasIds && noFailed && !r.timedOut
      put('L3', {
        command: r.command, exit_code: r.exitCode, signal: r.signal, timed_out: r.timedOut,
        expectation: `dump-config 出现行 id [${rowIds.join(', ')}] 且无 FAILED fiber`,
        verdict: pass ? 'pass' : 'fail',
        evidence: excerpt(r.stdout || r.stderr),
        checks: { row_ids_found: hasIds, no_failed_fiber: noFailed },
      })
      lines.push(`L3 覆盖层加载      ${mark(pass ? 'pass' : 'fail')}  (${r.command})`)
      if (!pass) failed = true
      const cleanup = forceCleanup(profileDir)
      if (!cleanup.ok) {
        put('L3-cleanup', { command: `rm -rf ${profileDir}`, exit_code: 1, expectation: '临时 profile 清理', verdict: 'fail', evidence: cleanup.error })
        lines.push(`   ⚠️ ${cleanup.error}`)
        failed = true
      }
    }
  }

  // ---- L4 manual protocol ---------------------------------------------------
  if (l1v.verdict !== 'fail') {
    put('L4', {
      command: null, exit_code: null,
      expectation: '行为正确性：调用返回规范值；非法配置响亮失败；HMR 无残留；取消生效',
      verdict: 'manual',
      reason: 'L4 需交互式运行时 / 模型，M2 脚本不自动化；按协议手工执行并如实记录',
      protocol: L4_PROTOCOL,
    })
    uncovered.push('L4 行为项（工具调用 / 非法配置 / HMR / 取消）——手工协议，未自动化（见 L4.json protocol）')
    lines.push('L4 行为            [manual]  手工协议（证据含步骤清单；判定归 LLM）')
  }

  // ---- L5 install-grade (needs dsh CLI) --------------------------------------
  if (l1v.verdict !== 'fail') {
    if (!dsh.available) {
      const why = describeDshFailure(dsh)
      put('L5', {
        command: null, exit_code: null,
        expectation: '净 profile 安装 → dump 层出现 → 启动冒烟 → 清理',
        verdict: 'degraded', reason: `无可用 dsh CLI（${dsh.reason}）`,
        resolution: { candidates: dsh.candidates, tried: dsh.tried }, detail: why,
      })
      uncovered.push(`L5 安装式验证（未执行，${dsh.reason}）: ${why}`)
      lines.push(`L5 安装式          [degraded]  ${dsh.reason}，未执行`)
    } else {
      const add = run(dsh.bin, ['plugin', '--profile', profile, 'add', pluginDir], { timeout: TIMEOUTS.install })
      const addOk = add.exitCode === 0 && !add.timedOut
      put('L5-add', {
        command: add.command, exit_code: add.exitCode, signal: add.signal, timed_out: add.timedOut,
        expectation: `dsh plugin add 退出码 0（临时 profile ${profile}）`,
        verdict: addOk ? 'pass' : 'fail',
        evidence: excerpt(`${add.stdout}\n${add.stderr}`.trim()),
      })
      lines.push(`L5 安装式-add      ${mark(addOk ? 'pass' : 'fail')}  (${add.command})`)
      let l5Ok = false
      if (!addOk) {
        failed = true
      } else {
        const dump = run(dsh.bin, ['--profile', profile, '--dump-config'], { timeout: TIMEOUTS.dump })
        const layerSeen = dump.stdout.includes(`# == ${pluginName}`)
        const noFailed = !/FAILED/.test(dump.stdout)
        const dumpOk = dump.exitCode === 0 && layerSeen && noFailed && !dump.timedOut
        put('L5-dump', {
          command: dump.command, exit_code: dump.exitCode, signal: dump.signal, timed_out: dump.timedOut,
          expectation: `dump-config 出现 "# == ${pluginName}" 层且无 FAILED`,
          verdict: dumpOk ? 'pass' : 'fail',
          evidence: excerpt(dump.stdout || dump.stderr),
          checks: { layer_seen: layerSeen, no_failed_fiber: noFailed },
        })
        lines.push(`L5 安装式-层确认   ${mark(dumpOk ? 'pass' : 'fail')}  (${dump.command})`)
        if (!dumpOk) failed = true
        l5Ok = addOk && dumpOk

        if (!skipSmoke) {
          const smoke = run(dsh.bin, ['--profile', profile], { timeout: TIMEOUTS.smoke })
          // Boot smoke is warn-level: we kill the process on purpose, so the
          // verdict is about the captured logs, not the exit code.
          const smokeOk = !/FAILED/.test(smoke.stdout + smoke.stderr)
          put('L5-smoke', {
            command: smoke.command, exit_code: smoke.exitCode, signal: smoke.signal, timed_out: smoke.timedOut,
            expectation: '启动日志无 FAILED fiber（超时杀进程属预期，退出码不作判据）',
            verdict: smokeOk ? 'pass' : 'fail',
            evidence: excerpt(`${smoke.stdout}\n${smoke.stderr}`.trim()),
          })
          lines.push(`L5 启动冒烟        ${mark(smokeOk ? 'pass' : 'fail')}  (warn 级：超时杀进程，看日志)`)
          if (!smokeOk) failed = true
        } else {
          put('L5-smoke', { command: null, exit_code: null, expectation: '启动冒烟', verdict: 'skip', reason: '--skip-smoke' })
          uncovered.push('L5 启动冒烟（--skip-smoke，未执行）')
        }
        lines.push(`L5 安装式          ${mark(l5Ok ? 'pass' : 'fail')}  (profile ${profile}，冒烟为 warn 级)`)
      }
      // Forced cleanup regardless of add/dump outcome (清理失败 = 报错留痕).
      const remove = run(dsh.bin, ['plugin', '--profile', profile, 'remove', pluginName], { timeout: TIMEOUTS.remove })
      const rmDir = forceCleanup(profileDir)
      const cleanupOk = rmDir.ok // CLI remove may no-op when add failed; dir cleanup is the hard gate
      put('L5-cleanup', {
        command: `${remove.command} ; rm -rf ${profileDir}`,
        exit_code: remove.exitCode,
        expectation: '临时 profile 强制清理成功',
        verdict: cleanupOk ? 'pass' : 'fail',
        evidence: excerpt(`remove exit=${remove.exitCode} ${remove.stderr}\ndir cleanup: ${rmDir.error || 'ok'}`),
      })
      if (!cleanupOk) {
        failed = true
        lines.push(`   ⚠️ ${rmDir.error}（清理失败 = 报错留痕）`)
      }
    }
  }

  // ---- summary ----------------------------------------------------------------
  const degraded = !dsh.available
  const verdict = failed ? 'fail' : (degraded ? 'degraded' : 'pass')
  const exitCode = failed ? 1 : (degraded ? 3 : 0)
  if (degraded) {
    uncovered.push(`运行时验证未执行（${dsh.reason}）：交付未达可发布标准，禁止宣称交付完成。${describeDshFailure(dsh)}`)
  }
  put('summary', {
    command: null, exit_code: exitCode,
    expectation: '环境允许的全部自动化层通过',
    verdict,
    environment: {
      dsh_cli: dsh.available,
      dsh_bin: dsh.bin,
      dsh_version: dsh.version,
      dsh_reason: dsh.reason,
      candidates: dsh.candidates,
      tried: dsh.tried,
    },
    layers: evidences.filter((e) => e.layer !== 'summary').map((e) => ({ layer: e.layer, verdict: e.verdict })),
    uncovered,
  })

  if (uncovered.length > 0) {
    lines.push(`❓ 未覆盖项（禁止静默通过）:`)
    for (const u of uncovered) lines.push(`   • ${u}`)
  }
  lines.push(`📁 证据: ${evidenceDir}`)
  if (degraded) lines.push(`💡 ${DSH_HINT}`)
  lines.push(failed
    ? `❌ 运行时验证不通过（exit 1）`
    : degraded
      ? `⚠️  环境降级：仅 L1–L2 已执行，交付未达可发布标准（exit 3）`
      : `✅ 运行时验证通过（exit 0）`)

  return { exitCode, stdout: lines.join('\n'), stderr: '' }
}

function mark(verdict) {
  return verdict === 'pass' ? '[pass]' : verdict === 'fail' ? '[fail]' : `[${verdict}]`
}

if (isMain(import.meta.url)) runMain(main)

// DSH Plugin Packager - validate -> build -> pack -> post-pack acceptance
// ([E] five-layer cleanliness + [F] install-based verification), reusing
// validate_plugin.js as the single SSOT. See references/delivery-playbook.md.
//
// Honest scope (M2):
//   - validate: in-process validate_plugin.js (fail -> 阻断清单, exit 1).
//   - build: declared scripts.build via pnpm (pnpm-lock) / npm.
//   - pack: `pnpm|npm pack --pack-destination <out>` (default <plugin>/dist);
//     tgz content listed via system `tar` (zero npm dependencies).
//   - [E] 包干净度（五层）on the tarball: manifest completeness / no junk /
//     package.json completeness / files-vs-tarball consistency / version
//     stamp consistency. warn 级问题 -> 带警告通过；error -> 不通过 (exit 1).
//   - [F] 安装式可发布性（需 dsh CLI）: 净 profile（__verify_<name>）->
//     `dsh plugin add <tgz>` -> dump-config 层确认 -> 启动冒烟（warn 级）->
//     强制清理（清理失败 = error 留痕）.
//   - 无 dsh CLI: [F] 未执行，整次运行 DEGRADED (exit 3)——「可发布」=
//     装进 profile 能跑，包打得出来不等于可发布。
//
// Acceptance verdicts: 通过 (0 error 0 warn) / 带警告通过 (0 error) /
// 不通过 (error，附阻断清单). Report ends with a mandatory 未覆盖项 section.
//
// Exit codes: 0 = 通过或带警告通过; 1 = 不通过; 2 = usage error;
// 3 = environment degraded ([F] not executed, 未达可发布标准).
//
// Usage:
//     node package_plugin.js <path/to/plugin-dir> [--out <dir>] [--skip-smoke]

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isMain, runMain } from './_cli.js'
import { main as validateMain } from './validate_plugin.js'
import { TIMEOUTS, detectDsh, dshHome, forceCleanup, run, tempProfileName } from './_run.js'

// npm always bundles these alongside `files` entries (docs auto-inclusion).
const NPM_AUTO_FILES = [/^package\.json$/, /^README(\..*)?$/i, /^LICEN[CS]E(\..*)?$/i, /^CHANGELOG(\..*)?$/i]

function excerpt(text, max = 4000) {
  const t = String(text || '').trim()
  return t.length <= max ? t : `${t.slice(0, max)}\n... [truncated ${t.length - max} chars]`
}

function mark(verdict) {
  return verdict === 'pass' ? '[pass]' : verdict === 'fail' ? '[fail]' : `[${verdict}]`
}

/** Tarball entries normalized: strip `package/` prefix and dir markers. */
function tarEntries(tgz) {
  const r = run('tar', ['-tzf', tgz], { timeout: TIMEOUTS.probe })
  if (r.exitCode !== 0) return { error: `tar -tzf 失败: ${excerpt(r.stderr, 200)}`, files: [], dirs: [] }
  const files = []
  const dirs = []
  for (const line of r.stdout.split('\n')) {
    const e = line.trim()
    if (!e) continue
    const isDir = e.endsWith('/')
    const norm = e.replace(/^package\//, '').replace(/\/$/, '')
    if (!norm) continue
    ;(isDir ? dirs : files).push(norm)
  }
  return { error: null, files, dirs }
}

/** packaged package.json via `tar -xzOf <tgz> package/package.json`. */
function packagedPkgJson(tgz) {
  const r = run('tar', ['-xzOf', tgz, 'package/package.json'], { timeout: TIMEOUTS.probe })
  if (r.exitCode !== 0) return { error: excerpt(r.stderr, 200), pkg: null }
  try {
    return { error: null, pkg: JSON.parse(r.stdout) }
  } catch (e) {
    return { error: `packaged package.json 不可解析: ${e.message}`, pkg: null }
  }
}

export function main(argv) {
  const outIdx = argv.indexOf('--out')
  const outArg = outIdx >= 0 ? argv[outIdx + 1] : null
  const outValIdx = outIdx >= 0 ? outIdx + 1 : -1
  const targetCandidates = argv.filter((a, i) => !a.startsWith('--') && i !== outValIdx)
  const skipSmoke = argv.includes('--skip-smoke')

  const pluginDir = targetCandidates.length === 1
    ? (isAbsolute(targetCandidates[0]) ? targetCandidates[0] : resolve(targetCandidates[0]))
    : null
  if (!pluginDir) {
    return {
      exitCode: 2, stdout: '',
      stderr: '用法: node package_plugin.js <plugin-dir> [--out <dir>] [--skip-smoke]\n'
        + '  --out <dir>      产物目录（默认 <plugin>/dist）\n'
        + '  --skip-smoke     跳过 [F] 启动冒烟（仍执行 add + dump + 清理）',
    }
  }
  const pkgPath = join(pluginDir, 'package.json')
  if (!existsSync(pkgPath)) {
    return { exitCode: 2, stdout: '', stderr: `目标不是 dsh 插件目录（缺少 package.json）: ${pluginDir}` }
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const pluginName = pkg.name || '<unnamed>'
  const outDir = outArg ? (isAbsolute(outArg) ? outArg : resolve(outArg)) : join(pluginDir, 'dist')
  mkdirSync(outDir, { recursive: true })

  const lines = []
  const errors = []
  const warns = []
  const uncovered = []
  const evidences = []
  const put = (id, ev) => evidences.push({ id, ...ev })

  lines.push(`📦 Packaging: ${pluginDir} (${pluginName}@${pkg.version || '0.0.0'})`)

  // ---- 1. validate (single SSOT) ---------------------------------------------
  const v = validateMain([pluginDir])
  put('validate', { command: `node scripts/validate_plugin.js ${pluginDir}`, exit_code: v.exitCode, verdict: v.exitCode === 0 ? 'pass' : 'fail', evidence: excerpt(v.stdout) })
  lines.push(`1. 校验            ${mark(v.exitCode === 0 ? 'pass' : 'fail')}`)
  if (v.exitCode !== 0) {
    errors.push('静态校验未通过（阻断；见 validate_plugin.js 输出）')
    return finish({ lines, errors, warns, uncovered, evidences, outDir, pluginName })
  }

  // ---- 2. build ---------------------------------------------------------------
  const buildScript = pkg.scripts && pkg.scripts.build
  if (buildScript) {
    const pm = existsSync(join(pluginDir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
    const r = run(pm, ['run', 'build'], { cwd: pluginDir, timeout: TIMEOUTS.build })
    const pass = r.exitCode === 0 && !r.timedOut
    put('build', { command: r.command, exit_code: r.exitCode, verdict: pass ? 'pass' : 'fail', evidence: excerpt(`${r.stdout}\n${r.stderr}`.trim()) })
    lines.push(`2. 构建            ${mark(pass ? 'pass' : 'fail')}  (${r.command})`)
    if (!pass) {
      errors.push('构建失败（阻断）')
      return finish({ lines, errors, warns, uncovered, evidences, outDir, pluginName })
    }
  } else {
    put('build', { command: null, exit_code: 0, verdict: 'pass', evidence: '无构建步骤（JS 直载）' })
    lines.push('2. 构建            [pass]  (无构建步骤)')
  }

  // ---- 3. pack ------------------------------------------------------------------
  const pm = existsSync(join(pluginDir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
  const pack = run(pm, ['pack', '--pack-destination', outDir], { cwd: pluginDir, timeout: TIMEOUTS.pack })
  const tgzNames = readdirSync(outDir).filter((f) => f.endsWith('.tgz'))
  const stdoutTgz = (pack.stdout.match(/([^\s\\/]+\.tgz)\s*$/m) || [])[1]
  const tgzName = stdoutTgz && tgzNames.includes(stdoutTgz) ? stdoutTgz : (tgzNames.length === 1 ? tgzNames[0] : null)
  const tgzPath = tgzName ? join(outDir, tgzName) : null
  const packOk = pack.exitCode === 0 && tgzPath && existsSync(tgzPath)
  put('pack', { command: pack.command, exit_code: pack.exitCode, verdict: packOk ? 'pass' : 'fail', evidence: excerpt(`${pack.stdout}\n${pack.stderr}`.trim()) })
  lines.push(`3. 打包            ${mark(packOk ? 'pass' : 'fail')}  (${pack.command})`)
  if (!packOk) {
    errors.push('打包失败或产物未生成（阻断）')
    return finish({ lines, errors, warns, uncovered, evidences, outDir, pluginName })
  }
  lines.push(`   产物: ${tgzPath}`)

  // ---- 4. [E] 包干净度（五层） ---------------------------------------------
  const tar = tarEntries(tgzPath)
  if (tar.error) {
    errors.push(tar.error)
  } else {
    const filesDeclared = Array.isArray(pkg.files) ? pkg.files : []
    const tarFiles = tar.files
    const tarAll = [...tarFiles, ...tar.dirs]

    // E1 清单完整：files 所列全部存在于 tarball（目录条目按前缀匹配）。
    const missing = filesDeclared.filter((f) => !tarAll.some((e) => e === f || e.startsWith(`${f}/`)))
    put('E1', { verdict: missing.length === 0 ? 'pass' : 'fail', detail: { files: filesDeclared, missing } })
    lines.push(`[E] 包干净度:`)
    lines.push(`   E1 清单完整      ${mark(missing.length === 0 ? 'pass' : 'fail')}${missing.length ? `  缺: ${missing.join('、')}` : ''}`)
    if (missing.length) errors.push(`E1 清单不完整: 缺 ${missing.join('、')}`)

    // E2 无杂质：.DS_Store / 备份文件 / 空目录 / *.map（map 为 warn 级「视策略」）。
    const junk = tarAll.filter((e) => /\.DS_Store$/.test(e) || /\.bak$/.test(e) || /~$/.test(e))
    const emptyDirs = tar.dirs.filter((d) => !tarAll.some((e) => e !== d && e.startsWith(`${d}/`)))
    const maps = tarFiles.filter((e) => e.endsWith('.map'))
    const e2ok = junk.length === 0 && emptyDirs.length === 0
    put('E2', { verdict: e2ok && maps.length === 0 ? 'pass' : (e2ok ? 'warn' : 'fail'), detail: { junk, empty_dirs: emptyDirs, sourcemaps: maps } })
    lines.push(`   E2 无杂质        ${mark(e2ok ? (maps.length ? 'warn' : 'pass') : 'fail')}${junk.length ? `  杂质: ${junk.join('、')}` : ''}${emptyDirs.length ? `  空目录: ${emptyDirs.join('、')}` : ''}${maps.length ? `  sourcemap: ${maps.length} 个（warn 级，视策略）` : ''}`)
    if (!e2ok) errors.push(`E2 杂质: ${[...junk, ...emptyDirs].join('、')}`)
    if (maps.length) warns.push(`E2 sourcemap 随包（视策略）: ${maps.join('、')}`)

    // E3 package.json 完备（dsh.bundle / files / type:module / version / license）。
    const want = []
    if (!pkg.dsh || !pkg.dsh.bundle) want.push('dsh.bundle')
    if (!Array.isArray(pkg.files) || pkg.files.length === 0) want.push('files')
    if (pkg.type !== 'module') want.push('type:module')
    if (!pkg.version) want.push('version')
    if (!pkg.license) want.push('license')
    put('E3', { verdict: want.length === 0 ? 'pass' : 'fail', detail: { missing: want } })
    lines.push(`   E3 清单完备      ${mark(want.length === 0 ? 'pass' : 'fail')}${want.length ? `  缺: ${want.join('、')}` : ''}`)
    if (want.length) errors.push(`E3 package.json 不完备: 缺 ${want.join('、')}`)

    // E4 清单与 files 一致：tarball 内容 ⊆ files ∪ npm 自动文档；多余 = warn。
    const extras = tarAll.filter((e) => !filesDeclared.some((f) => e === f || e.startsWith(`${f}/`))
      && !NPM_AUTO_FILES.some((re) => re.test(e)))
    put('E4', { verdict: extras.length === 0 ? 'pass' : 'warn', detail: { extras } })
    lines.push(`   E4 清单一致      ${mark(extras.length === 0 ? 'pass' : 'warn')}${extras.length ? `  多余: ${extras.join('、')}` : ''}`)
    if (extras.length) warns.push(`E4 tarball 内容超出 files 声明: ${extras.join('、')}`)

    // E5 构建产物与源码版本一致（packaged package.json vs 源 package.json）。
    const pp = packagedPkgJson(tgzPath)
    const e5ok = !pp.error && pp.pkg && pp.pkg.version === pkg.version
    put('E5', { verdict: e5ok ? 'pass' : 'fail', detail: { packaged_version: pp.pkg && pp.pkg.version, source_version: pkg.version, error: pp.error } })
    lines.push(`   E5 版本一致      ${mark(e5ok ? 'pass' : 'fail')}`)
    if (!e5ok) errors.push(`E5 版本戳不一致（${pp.error || `源 ${pkg.version} vs 包 ${pp.pkg && pp.pkg.version}` }）`)
  }

  // ---- 5. [F] 安装式可发布性（需 dsh CLI） ------------------------------------
  const dsh = detectDsh()
  const profile = tempProfileName(pluginName)
  const profileDir = join(dshHome(), 'profiles', profile)
  if (!dsh.available) {
    put('F', { verdict: 'degraded', reason: '无 dsh CLI，[F] 安装式验收未执行' })
    uncovered.push('[F] 安装式验收（无 dsh CLI，未执行）——「可发布」无法证明，未达可发布标准')
    lines.push('[F] 安装式验收    [degraded]  无 dsh CLI，未执行')
  } else {
    const add = run('dsh', ['plugin', '--profile', profile, 'add', tgzPath], { timeout: TIMEOUTS.install })
    const addOk = add.exitCode === 0 && !add.timedOut
    put('F-add', { command: add.command, exit_code: add.exitCode, verdict: addOk ? 'pass' : 'fail', evidence: excerpt(`${add.stdout}\n${add.stderr}`.trim()) })
    lines.push(`[F] 安装式验收:`)
    lines.push(`   F1 净 profile 安装 ${mark(addOk ? 'pass' : 'fail')}  (${add.command})`)
    if (!addOk) errors.push('F1 安装失败（tarball 装不进 profile = 不可交付）')
    else {
      const dump = run('dsh', ['--profile', profile, '--dump-config'], { timeout: TIMEOUTS.dump })
      const layerSeen = dump.stdout.includes(`# == ${pluginName}`)
      const noFailed = !/FAILED/.test(dump.stdout)
      const dumpOk = dump.exitCode === 0 && layerSeen && noFailed && !dump.timedOut
      put('F-dump', { command: dump.command, exit_code: dump.exitCode, verdict: dumpOk ? 'pass' : 'fail', evidence: excerpt(dump.stdout || dump.stderr), checks: { layer_seen: layerSeen } })
      lines.push(`   F2 层确认        ${mark(dumpOk ? 'pass' : 'fail')}  (期望 "# == ${pluginName}")`)
      if (!dumpOk) errors.push('F2 dump-config 未出现目标层或有 FAILED fiber')
      if (!skipSmoke) {
        const smoke = run('dsh', ['--profile', profile], { timeout: TIMEOUTS.smoke })
        const smokeOk = !/FAILED/.test(smoke.stdout + smoke.stderr)
        put('F-smoke', { command: smoke.command, exit_code: smoke.exitCode, signal: smoke.signal, timed_out: smoke.timedOut, verdict: smokeOk ? 'pass' : 'fail', evidence: excerpt(`${smoke.stdout}\n${smoke.stderr}`.trim()) })
        lines.push(`   F3 启动冒烟      ${mark(smokeOk ? 'pass' : 'fail')}  (warn 级：超时杀进程，看日志)`)
        if (!smokeOk) errors.push('F3 启动冒烟出现 FAILED fiber')
      } else {
        put('F-smoke', { verdict: 'skip', reason: '--skip-smoke' })
        uncovered.push('[F] 启动冒烟（--skip-smoke，未执行）')
      }
    }
    // 强制清理（清理失败 = 报错留痕）。
    const remove = run('dsh', ['plugin', '--profile', profile, 'remove', pluginName], { timeout: TIMEOUTS.remove })
    const rmDir = forceCleanup(profileDir)
    put('F-cleanup', { command: `${remove.command} ; rm -rf ${profileDir}`, exit_code: remove.exitCode, verdict: rmDir.ok ? 'pass' : 'fail', evidence: `dir cleanup: ${rmDir.error || 'ok'}` })
    if (!rmDir.ok) {
      errors.push(`F-cleanup ${rmDir.error}（清理失败 = 报错留痕）`)
      lines.push(`   ⚠️ ${rmDir.error}`)
    }
  }

  return finish({ lines, errors, warns, uncovered, evidences, outDir, pluginName, tgzPath, dshAvailable: dsh.available })
}

function finish({ lines, errors, warns, uncovered, evidences, outDir, pluginName, tgzPath, dshAvailable }) {
  const degraded = dshAvailable === false
  const verdict = errors.length > 0 ? '不通过'
    : degraded ? '环境降级：[F] 未执行，未达可发布标准'
      : warns.length > 0 ? '带警告通过' : '通过'
  const exitCode = errors.length > 0 ? 1 : (degraded ? 3 : 0)
  if (warns.length > 0) {
    lines.push(`⚠️  警告（${warns.length}）:`)
    for (const w of warns) lines.push(`   • ${w}`)
  }
  if (errors.length > 0) {
    lines.push(`❌ 阻断清单（${errors.length}）:`)
    for (const e of errors) lines.push(`   • ${e}`)
  }
  if (uncovered.length > 0) {
    lines.push('❓ 未覆盖项（禁止静默通过）:')
    for (const u of uncovered) lines.push(`   • ${u}`)
  }
  const reportPath = join(outDir, 'acceptance.json')
  writeFileSync(reportPath, JSON.stringify({
    plugin: pluginName, artifact: tgzPath || null, verdict, exit_code: exitCode,
    errors, warnings: warns, uncovered, checks: evidences,
  }, null, 2))
  lines.push(`📁 验收报告: ${reportPath}`)
  lines.push(`结论: ${verdict}（exit ${exitCode}）`)
  return { exitCode, stdout: lines.join('\n'), stderr: '' }
}

if (isMain(import.meta.url)) runMain(main)

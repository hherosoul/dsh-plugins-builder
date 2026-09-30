// Shared runtime helpers for the M2 scripts (verify_plugin.js /
// package_plugin.js): subprocess execution with timeout, dsh CLI resolution,
// temp-profile naming and forced cleanup. Same family as _cli.js/_analyze.js:
// no CLI form, not a tool. Zero third-party dependencies.
//
// Honest scope: process spawning is the script's job (计算 / 变换); judging
// whether captured output *means* success belongs to the LLM (qa-playbook
// 判定归属). Every run() result is recorded verbatim into evidence.
//
// Why CLI *resolution* instead of a bare `spawnSync('dsh')`: the desktop app is
// the primary dsh distribution and it ships the CLI inside the app bundle
// (`<app>/Contents/Resources/runtime/cli/bin/dsh`) without putting it on PATH.
// This plugin normally runs inside that very process, so "no dsh CLI" all too
// often only means "dsh is not on PATH" — a false degradation that silently
// skips L3/L5/[F]. We therefore try, in order: explicit override (`--dsh` /
// $DSH_BIN) → PATH → the app bundle derived from our own process → the usual
// install locations; and we report every attempt, distinguishing
// `cli-not-found` (nothing there) from `cli-broken` (found, unusable).

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Timeout budget (SSOT for all spawned steps; ms). Long budgets exist because
// `dsh plugin add` runs a real package install behind the scenes.
export const TIMEOUTS = {
  probe: 10_000,
  dump: 30_000,
  build: 300_000,
  pack: 120_000,
  install: 300_000,
  remove: 60_000,
  smoke: 20_000, // boot smoke: killed by timeout on purpose (capture load logs)
}

/** Run a command synchronously, capture everything, never throw. */
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 60_000,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: opts.env,
  })
  const timedOut = Boolean(res.error && res.error.code === 'ETIMEDOUT')
  const notFound = Boolean(res.error && res.error.code === 'ENOENT')
  return {
    command: [cmd, ...args].join(' '),
    exitCode: res.status,
    signal: res.signal || null,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    timedOut,
    notFound,
  }
}

/** $DSH_HOME (platform home), falling back to ~/.dsh when unset. */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Executable name of the dsh CLI on this platform. */
export const DSH_EXECUTABLE = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'

/** Operator hint: the supported ways to point these scripts at a CLI. */
export const DSH_HINT = '提示: 用 `--dsh <path>` 或环境变量 DSH_BIN 指定 dsh CLI；'
  + '桌面应用内置 CLI 位于 <app>/Contents/Resources/runtime/cli/bin/dsh'

const firstLine = (text) => String(text || '').trim().split('\n')[0].trim().slice(0, 120)
const short = (text, max = 200) => {
  const t = String(text || '').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/**
 * CLI paths shipped inside the desktop app bundle, derived from the process we
 * are running in (the plugin host is normally that app). Only *existing* bases
 * are returned, so a plain `node` process does not litter the candidate list
 * with invented app paths. Pure + injectable for unit checks.
 */
export function appBundleCliCandidates(execPath = process.execPath, resourcesPath = process.resourcesPath) {
  const bases = new Set()
  const add = (base) => {
    if (typeof base === 'string' && base !== '' && existsSync(base)) bases.add(base)
  }
  add(resourcesPath)                                   // Electron's own pointer
  if (typeof execPath === 'string' && execPath !== '') {
    const binDir = dirname(execPath)                   // macOS: <app>/Contents/MacOS
    if (/(^|[\\/])Contents[\\/][^\\/]+$/.test(binDir)) add(resolve(binDir, '..', 'Resources'))
    add(resolve(binDir, '..', 'resources'))            // portable layout: <root>/resources
    add(resolve(binDir, '..', 'Resources'))
  }
  return [...bases].map((base) => join(base, 'runtime', 'cli', 'bin', DSH_EXECUTABLE))
}

/** Ordered candidates: explicit override → $DSH_BIN → PATH → app bundle → usual installs. */
export function dshCandidates({ explicit, env = process.env, execPath, resourcesPath } = {}) {
  const out = []
  const add = (p) => { if (typeof p === 'string' && p.trim() !== '') out.push(p.trim()) }
  add(explicit)
  add(env.DSH_BIN)
  add(DSH_EXECUTABLE)                                 // bare name → PATH lookup
  for (const candidate of appBundleCliCandidates(execPath, resourcesPath)) add(candidate)
  const home = env.HOME || env.USERPROFILE || homedir()
  add('/usr/local/bin/dsh')                           // desktop app installer target (macOS)
  add(join(home, '.local', 'bin', 'dsh'))
  add(join(home, 'Library', 'pnpm', 'dsh'))
  add('/opt/homebrew/bin/dsh')
  return [...new Set(out)]
}

/**
 * Resolve a usable dsh CLI. Never throws. An explicit request (`--dsh <path>` /
 * `$DSH_BIN`) is **authoritative**: we never silently fall back to a different
 * binary, because "I pinned a CLI but another one ran" is exactly the kind of
 * invisible substitution this module exists to prevent. Failure modes:
 *   cli-not-found — the requested CLI (or every candidate) is absent;
 *   cli-broken    — something was found but `--version` did not succeed.
 * `tried` records every candidate with its outcome, so newly executed layers
 * name the real binary and a degraded run shows exactly where we looked.
 */
export function resolveDsh({ explicit, env = process.env, execPath, resourcesPath } = {}) {
  const trim = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  const requested = trim(explicit) || trim(env.DSH_BIN)
  const candidates = requested ? [requested] : dshCandidates({ env, execPath, resourcesPath })
  const tried = []
  for (const candidate of candidates) {
    const looksLikePath = candidate.includes('/') || candidate.includes('\\')
    if (looksLikePath && !existsSync(candidate)) {
      tried.push({ candidate, result: 'missing' })
      continue
    }
    const probe = run(candidate, ['--version'], { timeout: TIMEOUTS.probe })
    const version = firstLine(probe.stdout) || firstLine(probe.stderr)
    if (!probe.notFound && !probe.timedOut && probe.exitCode === 0) {
      tried.push({ candidate, result: 'ok', version })
      return { available: true, bin: candidate, version, requested, candidates, tried, reason: null }
    }
    tried.push({
      candidate,
      result: probe.notFound ? 'not-found' : probe.timedOut ? 'timeout' : `exit-${probe.exitCode}`,
      ...(version ? { version } : {}),
      ...(probe.stderr ? { stderr: short(probe.stderr) } : {}),
    })
  }
  const broken = tried.some((t) => t.result !== 'missing' && t.result !== 'not-found')
  return {
    available: false, bin: null, version: null, requested,
    candidates, tried, reason: broken ? 'cli-broken' : 'cli-not-found',
  }
}

/** One-line honest explanation of where we looked (evidence + stdout). */
export function describeDshFailure(resolution) {
  const list = (resolution?.tried || []).map((t) => `${t.candidate} (${t.result})`).join('; ')
  const label = resolution?.requested
    ? `指定的 dsh CLI 不可用（${resolution.reason}）`
    : resolution?.reason === 'cli-broken' ? 'dsh CLI 找到了但不可用' : '未找到 dsh CLI'
  return `${label}；已探测: ${list || '(无候选)'}`
}

/** Temp profile name for install-grade verification (playbook naming). */
export function tempProfileName(pkgName) {
  return `__verify_${String(pkgName).replace(/[^a-z0-9-]/gi, '-')}`
}

/** Best-effort recursive delete that reports failure instead of throwing. */
export function forceCleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
    return { ok: true, error: null }
  } catch (e) {
    return { ok: false, error: `清理失败: ${dir}: ${e.message}` }
  }
}

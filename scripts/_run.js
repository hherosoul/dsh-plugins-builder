// Shared runtime helpers for the M2 scripts (verify_plugin.js /
// package_plugin.js): subprocess execution with timeout, dsh CLI detection,
// temp-profile naming and forced cleanup. Same family as _cli.js/_analyze.js:
// no CLI form, not a tool. Zero third-party dependencies.
//
// Honest scope: process spawning is the script's job (计算 / 变换); judging
// whether captured output *means* success belongs to the LLM (qa-playbook
// 判定归属). Every run() result is recorded verbatim into evidence.

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/**
 * Probe the dsh CLI. `available` only means the binary was found and executed
 * — the probe result itself is returned so callers record it honestly.
 */
export function detectDsh() {
  const probe = run('dsh', ['--version'], { timeout: TIMEOUTS.probe })
  return { available: !probe.notFound, probe }
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

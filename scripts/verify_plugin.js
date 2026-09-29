// DSH Plugin Runtime Verifier - orchestrates the L2-L5 runtime verification
// matrix and emits evidence JSON (see references/qa-playbook.md).
//
// STATUS: not ready — ships at milestone M2.
// Until then, follow references/qa-playbook.md manually and record results
// honestly; never claim runtime evidence this script has not produced.
//
// Exit codes: 2 = milestone not ready (unavailable).

import { isMain, runMain } from './_cli.js'

const MILESTONE = 'M2'

export function main(_argv) {
  const stdout = JSON.stringify({
    status: 'unavailable',
    script: 'verify_plugin.js',
    milestone: MILESTONE,
    reason: '运行时验证矩阵（L2-L5）尚未实现；当前仅有 L1 静态校验'
      + '（validate_plugin.js）可用。',
    honest_substitute: '按 references/qa-playbook.md 手工执行对应层级'
      + '并如实记录证据，不得冒充已自动化。',
  }, null, 2)
  return { exitCode: 2, stdout, stderr: '' }
}

if (isMain(import.meta.url)) runMain(main)

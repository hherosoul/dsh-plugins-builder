// DSH Plugin Delivery Ledger - local-first delivery ledger
// ($DSH_HOME/dsh-plugin-ledger/): LEDGER.md (human) +
// ledger.jsonl (machine event stream). Subcommands: bootstrap / add /
// latest / align / advise. See references/ledger-playbook.md.
//
// STATUS: not ready — ships at milestone M2.
// Until then, keep a manual delivery note per the playbook; do NOT claim
// "recorded" without a written ledger entry.
//
// Exit codes: 2 = milestone not ready (unavailable).

import { isMain, runMain } from './_cli.js'

const MILESTONE = 'M2'

export function main(_argv) {
  const stdout = JSON.stringify({
    status: 'unavailable',
    script: 'ledger.js',
    milestone: MILESTONE,
    reason: '交付台账（bootstrap/add/latest/align/advise）尚未实现。',
    honest_substitute: '按 references/ledger-playbook.md 的七字段手工'
      + '记录交付条目；未记账不得宣称交付完成。',
  }, null, 2)
  return { exitCode: 2, stdout, stderr: '' }
}

if (isMain(import.meta.url)) runMain(main)

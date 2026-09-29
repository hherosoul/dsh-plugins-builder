// DSH Plugin QA Report Aggregator - aggregates machine-readable case results
// and runtime evidence into QA-REPORT.md. Judgments belong to the LLM; this
// script only aggregates (see references/qa-playbook.md, 9 dimensions).
//
// STATUS: not ready — ships at milestone M3.
//
// Exit codes: 2 = milestone not ready (unavailable).

import { isMain, runMain } from './_cli.js'

const MILESTONE = 'M3'

export function main(_argv) {
  const stdout = JSON.stringify({
    status: 'unavailable',
    script: 'qa_report.js',
    milestone: MILESTONE,
    reason: 'QA 报告聚合尚未实现；判定归 LLM，脚本只聚合。',
    honest_substitute: '按 references/qa-playbook.md 的 9 维度手工演练'
      + '并填写用例表，报告末尾强制「未覆盖项」段。',
  }, null, 2)
  return { exitCode: 2, stdout, stderr: '' }
}

if (isMain(import.meta.url)) runMain(main)

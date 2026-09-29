// DSH Plugin Packager - validate -> build -> pack -> post-pack acceptance
// ([E] five-layer cleanliness + [F] install-based verification), reusing
// validate_plugin.js. See references/delivery-playbook.md.
//
// STATUS: not ready — ships at milestone M2.
// Until then, execute the delivery playbook steps manually and record the
// outcome truthfully; "packable" is not "shippable" without [E]+[F].
//
// Exit codes: 2 = milestone not ready (unavailable).

import { isMain, runMain } from './_cli.js'

const MILESTONE = 'M2'

export function main(_argv) {
  const stdout = JSON.stringify({
    status: 'unavailable',
    script: 'package_plugin.js',
    milestone: MILESTONE,
    reason: '打包与打包后验收（[E] 干净度 + [F] 安装式）尚未实现。',
    honest_substitute: '按 references/delivery-playbook.md 手工执行'
      + '三通道分发与验收步骤并如实记录。',
  }, null, 2)
  return { exitCode: 2, stdout, stderr: '' }
}

if (isMain(import.meta.url)) runMain(main)

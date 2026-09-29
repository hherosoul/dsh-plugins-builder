// {{PKG_NAME}} — config plugin (Schemastery schema)
// Config discipline:
//   - Defaults live in the schema; invalid config must fail LOUDLY at load.
//   - Anything that may differ between deployments is configurable — no
//     hardcoded tunables in code.
//   - TS projects export a paired `interface Config` + `const Config` schema.

import Schema from '@deepseek-ai/schemastery'

export const name = '{{PKG_BASE}}'

/** @typedef {{ greeting: string, verbose?: boolean }} Config */

export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
  verbose: Schema.boolean().default(false),
})

export function apply(_ctx, config) {
  if (config.verbose) console.log(`[{{PKG_BASE}}] config:`, config)
  console.log(`[{{PKG_BASE}}] ${config.greeting}`)
}

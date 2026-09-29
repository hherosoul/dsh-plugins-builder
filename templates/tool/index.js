// {{PKG_NAME}} — tool plugin (defineTool, all five elements)
// Iron rules:
//   - execute returns ONLY the canonical value declared by output.schema;
//     content blocks come exclusively from render.
//   - Throwing or returning an invalid value = isError (fail honestly).
//   - Honor exec.signal; move long-running work to ctx.jobs.start.

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = '{{PKG_BASE}}'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: '{{ROW_ID}}',
    // description is the model's ONLY basis for call timing:
    // state when to call, when NOT to call, and the failure semantics.
    description: 'Echo the given text back unchanged. Use only for echoing text; performs no external calls and no transformation.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to echo back' },
    },
    output: {
      schema: { type: 'string' },
      // render must be a PURE function of (args, value): no I/O, no clock, no randomness.
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // Cancellation contract: check the signal at every significant step.
      if (exec.signal.aborted) throw new Error('aborted')
      return `echo: ${args.text}`
    },
  }))
}

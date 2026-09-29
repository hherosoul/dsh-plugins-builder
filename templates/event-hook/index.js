// {{PKG_NAME}} — event-hook plugin
// Four event modes: emit (broadcast) / bail (veto) / serial (chain) /
// waterfall (pipeline). Event names are namespace/action.
// WATERFALL IRON RULE: listeners MUST call next(), or the pipeline short-circuits.
// Durable session facts go through session events (session/event dispatched by
// event.type: turn/*, tool/call, tool/result); real-time extensions use Cordis events.

export const name = '{{PKG_BASE}}'
export const inject = []

export function apply(ctx) {
  // Observe tool results (real-time Cordis event).
  ctx.on('tools/result', (_event) => {
    console.log('[{{PKG_BASE}}] tool result observed')
  })

  // Waterfall example — MUST await next() and return the (possibly modified) value:
  // ctx.waterfall('agent/pre-step', async (_input, next) => {
  //   const data = await next()
  //   return data
  // })

  // Persistent session facts: listen to session/event and branch on event.type.
  // ctx.on('session/event', (event) => {
  //   if (event.type === 'tool/call') { /* record / project */ }
  // })
}

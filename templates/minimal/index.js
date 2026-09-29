// {{PKG_NAME}} — minimal dsh plugin (function form)
// Contract SSOT: dsh-plugins-builder references/dsh-spec.md

export const name = '{{PKG_BASE}}'

// Take the context as apply(ctx) once you register capabilities.
export function apply() {
  // Side effects registered via ctx (ctx.on / ctx.tools.register / timers)
  // are cleaned up automatically on unload — no manual removeListener.
  console.log('[{{PKG_BASE}}] plugin loaded')

  // Manually owned resources MUST go through ctx.effect() with a disposer:
  // ctx.effect(() => {
  //   const timer = setInterval(() => {}, 5000)
  //   return () => clearInterval(timer)
  // })
}

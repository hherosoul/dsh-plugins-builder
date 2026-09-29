// {{PKG_BASE}} seam — Consumer: injects the service published by Provider.
// Required dependency -> inject; optional dependency -> ctx.get(name)?.

import { serviceName } from '{{PKG_NAME}}-definition'

export const name = '{{PKG_BASE}}-consumer'
export const inject = [serviceName]

export function apply(ctx) {
  const svc = ctx.get(serviceName)
  if (svc) console.log('[{{PKG_BASE}}-consumer]', svc.echo({ text: 'hi' }))
}

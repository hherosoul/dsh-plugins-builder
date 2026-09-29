// {{PKG_BASE}} seam — Provider: implements the capability and publishes it
// under the service name owned by Definition.

import { Service } from '@deepseek-ai/cordis'
import { serviceName } from '{{PKG_NAME}}-definition'

export default class Provider extends Service {
  static inject = []

  constructor(ctx) {
    super(ctx, serviceName)
  }

  /** @param {import('{{PKG_NAME}}-definition').Request} req */
  echo(req) {
    return { echoed: req.text }
  }
}

// {{PKG_NAME}} — service plugin (class form)
// The class form publishes a service for other plugins:
//   - super(ctx, '<serviceName>') registers the service name (a cross-package
//     contract — renaming is a breaking change).
//   - Consumers declare inject = ['{{ROW_ID}}'] (required) or use
//     ctx.get('{{ROW_ID}})?. (optional).
// Required services that disappear trigger automatic dispose + reload.

import { Service } from '@deepseek-ai/cordis'

export default class {{CLASS_NAME}} extends Service {
  // Declare REQUIRED service dependencies here (empty = none).
  static inject = []

  constructor(ctx) {
    super(ctx, '{{ROW_ID}}')
    // Synchronous initialization only; async work belongs to lifecycle hooks.
  }

  greet(who) {
    return `hello ${who}`
  }
}

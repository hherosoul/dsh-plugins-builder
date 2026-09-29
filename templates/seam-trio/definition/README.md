# {{PKG_NAME}}-definition

Capability seam definition: owns the service name (`{{ROW_ID}}`) and the
Request/Result contract. Library package — no `dsh.bundle`, never activated
as a row; imported by provider and consumer.

## Quickstart

```js
import { serviceName } from '{{PKG_NAME}}-definition'
// serviceName === '{{ROW_ID}}'
```

Renaming the service or reshaping Request/Result is a BREAKING change —
record it in the delivery ledger before shipping.

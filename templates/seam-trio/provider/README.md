# {{PKG_NAME}}-provider

Implements the `{{ROW_ID}}` service (class form) defined by
`{{PKG_NAME}}-definition`. Library package — activated through the bundle
layer's patch row, not installed on its own.

## Quickstart

Activate via the bundle (`../bundle/`), or load straight from source with a
dev overlay:

```yaml
- insert:
  - id: {{ROW_ID}}
    name: '/abs/path/to/{{PKG_BASE}}-provider/index.js'
```

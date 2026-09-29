# {{PKG_NAME}}-consumer

Consumes the `{{ROW_ID}}` service: `inject = ['{{ROW_ID}}']` (required) or
`ctx.get('{{ROW_ID}}')?.` (optional). Plugin module — activate it as a row
in your app bundle or a dev overlay.

## Quickstart

```yaml
- insert:
  - id: {{ROW_ID}}-consumer
    name: '/abs/path/to/{{PKG_BASE}}-consumer/index.js'
```

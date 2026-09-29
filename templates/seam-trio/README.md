# {{PKG_BASE}} — seam trio (Definition / Provider / Consumer)

> Split iron rule: only split when a role needs INDEPENDENT EVOLUTION
> (different release cadence / different reuse surface). Default is single package.

Capability seam skeleton. Definition owns the service name and the
Request/Result contract; Provider implements and publishes the service;
Consumer injects and uses it. The bundle package contributes the patch layer
that activates the provider row.

## Layout

```
{{PKG_BASE}}/
├── {{PKG_BASE}}-definition/   # service name + Request/Result contract (library, no dsh.bundle)
├── {{PKG_BASE}}-provider/     # implements the service (library, no dsh.bundle)
├── {{PKG_BASE}}-consumer/     # consumes the service (library, no dsh.bundle)
└── bundle/                    # bundle package: patch layer inserting the provider row
```

## Wiring

1. Provider imports the service name from Definition and registers via class form.
2. Consumer declares `inject = ['{{ROW_ID}}']` (required) or `ctx.get('{{ROW_ID}})?.` (optional).
3. Bundle `cordis.patch.yml` inserts the provider row BY PACKAGE NAME.
4. Validate each package directory separately with `validate_plugin.py`.

## Iron rules

- Definition owns the contract: renaming the service or changing Request/Result
  shapes is a breaking change — record it in the ledger.
- No preventive splits: if this trio can live in one package, it should.

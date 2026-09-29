# {{PKG_NAME}}

<one-line positioning — fill in during Phase 1>

## Quickstart

1. Install the checkout into a profile (first use initializes the profile with `@deepseek-ai/dsh-base`):

```sh
dsh plugin --profile demo add {{PLUGIN_DIR}}
```

2. Verify the layer without booting (expect a `# == {{PKG_NAME}}` layer):

```sh
dsh --profile demo --dump-config
```

3. Boot and verify (expect `[{{PKG_BASE}}] plugin loaded` in the terminal):

```sh
dsh --profile demo
```

Remove again with `dsh plugin --profile demo remove {{PKG_NAME}}`.

## Development (no packaging)

The dev overlay loads the source entry directly by absolute path:

```sh
pnpm dsh web --patch ./dev/cordis.yml   # inside a dsh source checkout
dsh web --patch ./dev/cordis.yml        # with the dsh CLI installed
```

## Quality check

Prefer the `plugin_validate` tool provided by the dsh-plugins-builder plugin
(if installed). CLI fallback, using the dsh-plugins-builder install directory:

```sh
node <dsh-plugins-builder install dir>/scripts/validate_plugin.js {{PLUGIN_DIR}}
```

Runtime verification (L2–L5) and packaging with install-grade acceptance
(`plugin_verify` / `plugin_package` tools; M2):

```sh
node <dsh-plugins-builder install dir>/scripts/verify_plugin.js {{PLUGIN_DIR}}     # M2
node <dsh-plugins-builder install dir>/scripts/package_plugin.js {{PLUGIN_DIR}}    # M2
```

## Distribution

- npm publish (prebuilt, default) or `pnpm pack` tarball: no build authorization needed on the user side.
- git install: requires a self-contained `prepare` script, user-side `allowBuilds: {{PKG_NAME}}: true` in `pnpm-workspace.yaml`, and a locked commit — see the delivery playbook before choosing this channel.

## Environment requirements

- Node.js + pnpm (development); `dsh` CLI (installation & boot).
- No API key is needed to boot; model-backed verification of tools needs a configured model.

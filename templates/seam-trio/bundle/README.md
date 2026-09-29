# {{PKG_NAME}}-bundle

Bundle layer that activates the provider row BY PACKAGE NAME
(`{{PKG_NAME}}-provider`), so Node module resolution finds installed code.

## Quickstart

1. Install into a profile: `dsh plugin --profile demo add ./bundle`
2. Verify the layer without booting: `dsh --profile demo --dump-config`
   (expect a `# == {{PKG_NAME}}-bundle` layer).
3. Dev without installing: `dsh web --patch ./dev/cordis.yml` (loads
   provider and consumer straight from source by absolute path).

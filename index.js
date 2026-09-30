// dsh-plugins-builder — meta-engineer plugin.
// Scaffolds, validates, QA-reports and packages DeepSeek Harness plugins
// through a 5-phase gated pipeline. Methodology SSOT: references/methodology.md.
// Iron rules honored by this entry:
//   - execute returns ONLY the canonical value declared by output.schema;
//     content blocks come exclusively from render (pure functions).
//   - Throwing or returning an invalid value = isError (fail honestly).
//   - Honor exec.signal: an already-aborted call rejects before the script
//     body runs (script bodies are synchronous and run to completion).
//   - No hardcoded tunables: the workspace root comes from Config; script
//     modules are imported statically relative to this module location.
//   - UI cards follow the official card-tagged render-intent union: the six
//     script-backed tools declare terminal call/result views. presentCall /
//     presentResult / presentationMeta are pure functions of args(+result) —
//     no I/O, no clock, no randomness — so session-log replay never crashes.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { main as initPlugin } from './scripts/init_plugin.js'
import { main as validatePlugin } from './scripts/validate_plugin.js'
import { main as verifyPlugin } from './scripts/verify_plugin.js'
import { main as packagePlugin } from './scripts/package_plugin.js'
import { main as qaReport } from './scripts/qa_report.js'
import { main as ledger } from './scripts/ledger.js'

const BASE_DIR = dirname(fileURLToPath(import.meta.url))
const REFERENCES_DIR = join(BASE_DIR, 'references')

export const name = 'plugins-builder'
export const inject = ['tools']

/** @typedef {{ workspaceRoot?: string, dshBin?: string }} Config */

export const Config = Schema.object({
  workspaceRoot: Schema.string().default('')
    .description('Anchor directory for relative path arguments; empty = host process cwd.'),
  dshBin: Schema.string().default('')
    .description('dsh CLI used by plugin_verify / plugin_package; empty = $DSH_BIN, then PATH, then the app-bundled CLI, then the usual install locations.'),
})

// Canonical result shape shared by every script-backed tool (declared once).
// exitCode semantics: 0 pass (or pass-with-warnings); 1 error / acceptance
// failed; 2 usage error or milestone unavailable; 3 environment degraded —
// runtime layers not executed (no dsh CLI), delivery NOT publishable.
const scriptOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'true when exit code is 0' },
    exitCode: { type: 'number', description: 'script exit code' },
    stdout: { type: 'string', description: 'captured standard output' },
    stderr: { type: 'string', description: 'captured standard error' },
  },
  additionalProperties: false,
}

// render must be a PURE function of the canonical value: no I/O, no clock,
// no randomness.
function renderScriptResult(_args, value) {
  const lines = [value.ok ? `[pass] exit ${value.exitCode}` : `[fail] exit ${value.exitCode}`]
  if (value.stdout.trim()) lines.push(value.stdout.trim())
  if (value.stderr.trim()) lines.push(`[stderr] ${value.stderr.trim()}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

// Official render-intent union (card-tagged): script-backed tools are script
// runs, so they declare terminal views — the same intent dsh-tool-bash uses
// for foreground runs. presentationMeta projects the replayable exit facts
// from the canonical value; the core persists them on tool/result and passes
// them to presentResult, so replay reproduces the card without the value.
function terminalCallView(argv) {
  return { card: 'terminal', title: argv.join(' ') }
}

function scriptPresentationMeta(_args, value) {
  return { exitCode: value.exitCode, ok: value.ok }
}

function scriptPresentResult(_args, presented) {
  const output = (presented.content || [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  const view = { card: 'terminal', output }
  if (presented.meta && typeof presented.meta.exitCode === 'number') {
    view.exitCode = presented.meta.exitCode
  }
  return view
}

const guideOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    topics: { type: 'array', items: { type: 'string' } },
    content: { type: 'string' },
  },
  additionalProperties: false,
}

function renderGuideResult(_args, value) {
  if (!value.ok) return [{ type: 'text', text: '[fail] guide lookup failed' }]
  if (value.topics) {
    return [{ type: 'text', text: `Available methodology topics:\n${value.topics.join('\n')}` }]
  }
  return [{ type: 'text', text: value.content }]
}

// Resolve a user-supplied path: absolute paths pass through; relative paths
// anchor at config.workspaceRoot (or the host process cwd when unset).
function resolveTarget(raw, config) {
  if (!raw) return config.workspaceRoot || process.cwd()
  if (isAbsolute(raw)) return raw
  return resolve(config.workspaceRoot || process.cwd(), raw)
}

// Run a bundled script in-process: every script is zero-build ESM exporting
// main(argv) -> { exitCode, stdout, stderr } (the same entry its CLI form
// uses via scripts/_cli.js), so no interpreter is spawned and nothing is
// piped. Cancellation contract: exec.signal is honored as a pre-check — an
// aborted call throws, which surfaces as isError (honest failure). Once the
// synchronous script body starts it runs to completion; bodies are
// short-lived and their side effects are atomic per call.
function runScript(scriptMain, scriptArgs, signal) {
  if (signal.aborted) throw new Error('aborted')
  const result = scriptMain(scriptArgs)
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'plugin_init',
    description: 'Scaffold a new DeepSeek Harness plugin bundle from the built-in template library (minimal, tool, config, service, event-hook or seam-trio). Use at Phase 3 (development) start; do not use for non-dsh projects.',
    parameters: {
      name: { type: 'string', required: true, description: 'Plugin name; rendered as the dsh-<name> package' },
      kind: { type: 'string', required: true, description: 'Template kind: minimal|tool|config|service|event-hook|seam-trio' },
      path: { type: 'string', description: 'Parent directory for the new plugin (defaults to config workspaceRoot)' },
      force: { type: 'boolean', description: 'Overwrite an existing target directory' },
    },
    output: {
      schema: scriptOutputSchema,
      render: renderScriptResult,
      presentationMeta: scriptPresentationMeta,
    },
    presentCall: (args) => {
      const argv = ['node', 'scripts/init_plugin.js', args.name, '--kind', args.kind]
      if (args.path) argv.push('--path', args.path)
      if (args.force) argv.push('--force')
      return terminalCallView(argv)
    },
    presentResult: scriptPresentResult,
    async execute(args, exec) {
      const scriptArgs = [args.name, '--kind', args.kind, '--path', resolveTarget(args.path, config)]
      if (args.force) scriptArgs.push('--force')
      return runScript(initPlugin, scriptArgs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_validate',
    description: 'Run the static rule-ID compliance check (PKG/PATCH/TS/TOOL/CFG/DEP/SEC/DOC families) on a DeepSeek Harness plugin directory; exit 0 means zero errors. Use at Phase 4 (testing) and before any delivery.',
    parameters: {
      target: { type: 'string', required: true, description: 'Plugin directory to validate' },
      policy: { type: 'string', description: 'Optional policy YAML overriding methodology thresholds (B-class only)' },
      skipPathCheck: { type: 'boolean', description: 'Validate in place, e.g. third-party packages' },
      trustAppend: { type: 'boolean', description: 'Allow policy append scripts for third-party targets' },
    },
    output: {
      schema: scriptOutputSchema,
      render: renderScriptResult,
      presentationMeta: scriptPresentationMeta,
    },
    presentCall: (args) => {
      const argv = ['node', 'scripts/validate_plugin.js', args.target]
      if (args.policy) argv.push('--policy', args.policy)
      if (args.skipPathCheck) argv.push('--skip-path-check')
      if (args.trustAppend) argv.push('--trust-append')
      return terminalCallView(argv)
    },
    presentResult: scriptPresentResult,
    async execute(args, exec) {
      const scriptArgs = [resolveTarget(args.target, config)]
      if (args.policy) scriptArgs.push('--policy', resolveTarget(args.policy, config))
      if (args.skipPathCheck) scriptArgs.push('--skip-path-check')
      if (args.trustAppend) scriptArgs.push('--trust-append')
      return runScript(validatePlugin, scriptArgs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_verify',
    description: 'Orchestrate the L2-L5 runtime verification matrix for a DeepSeek Harness plugin: static check, build, dev-overlay load, install-grade check in a temp profile, writing per-layer evidence JSON under <target>/qa/evidence/. L4 behavior items are emitted as a manual protocol (verdict "manual"). The dsh CLI is located via the dshBin parameter, config.dshBin, $DSH_BIN, PATH, the desktop app bundle, then the usual install locations; only when none works does the run degrade to L1-L2 (exit 3, not publishable) and report every path it tried.',
    parameters: {
      target: { type: 'string', required: true, description: 'Plugin directory to verify at runtime' },
      skipSmoke: { type: 'boolean', description: 'Skip the L5 boot smoke (add + dump + cleanup still run)' },
      dshBin: { type: 'string', description: 'Path to the dsh CLI (defaults to config.dshBin / $DSH_BIN / auto-discovery)' },
    },
    output: {
      schema: scriptOutputSchema,
      render: renderScriptResult,
      presentationMeta: scriptPresentationMeta,
    },
    presentCall: (args) => {
      const argv = ['node', 'scripts/verify_plugin.js', args.target]
      if (args.skipSmoke) argv.push('--skip-smoke')
      if (args.dshBin) argv.push('--dsh', args.dshBin)
      return terminalCallView(argv)
    },
    presentResult: scriptPresentResult,
    async execute(args, exec) {
      const scriptArgs = [resolveTarget(args.target, config)]
      if (args.skipSmoke) scriptArgs.push('--skip-smoke')
      const dshBin = args.dshBin || config.dshBin
      if (dshBin) scriptArgs.push('--dsh', dshBin)
      return runScript(verifyPlugin, scriptArgs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_package',
    description: 'Validate, build, pack (tgz) and post-pack-accept a DeepSeek Harness plugin: [E] five-layer tarball cleanliness plus [F] install-based verification in a temp profile, with a three-tier verdict (通过 / 带警告通过 / 不通过). The dsh CLI is located via dshBin / config.dshBin / $DSH_BIN / PATH / the app bundle; only when none works does [F] skip (exit 3): "packable" is not "shippable".',
    parameters: {
      target: { type: 'string', required: true, description: 'Plugin directory to package' },
      outputDir: { type: 'string', description: 'Where to place the packaged artifact (defaults to <target>/dist)' },
      skipSmoke: { type: 'boolean', description: 'Skip the [F] boot smoke (add + dump + cleanup still run)' },
      dshBin: { type: 'string', description: 'Path to the dsh CLI (defaults to config.dshBin / $DSH_BIN / auto-discovery)' },
    },
    output: {
      schema: scriptOutputSchema,
      render: renderScriptResult,
      presentationMeta: scriptPresentationMeta,
    },
    presentCall: (args) => {
      const argv = ['node', 'scripts/package_plugin.js', args.target]
      if (args.outputDir) argv.push('--out', args.outputDir)
      if (args.skipSmoke) argv.push('--skip-smoke')
      if (args.dshBin) argv.push('--dsh', args.dshBin)
      return terminalCallView(argv)
    },
    presentResult: scriptPresentResult,
    async execute(args, exec) {
      const scriptArgs = [resolveTarget(args.target, config)]
      if (args.outputDir) scriptArgs.push('--out', resolveTarget(args.outputDir, config))
      if (args.skipSmoke) scriptArgs.push('--skip-smoke')
      const dshBin = args.dshBin || config.dshBin
      if (dshBin) scriptArgs.push('--dsh', dshBin)
      return runScript(packagePlugin, scriptArgs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_qa_report',
    description: 'Aggregate machine-readable case results and runtime evidence into QA-REPORT.md; judgments belong to the model, the script only aggregates. Milestone M3: honestly reports unavailable until then.',
    parameters: {
      evidenceDir: { type: 'string', description: 'Directory holding case results and runtime evidence JSON' },
    },
    output: {
      schema: scriptOutputSchema,
      render: renderScriptResult,
      presentationMeta: scriptPresentationMeta,
    },
    presentCall: (args) => {
      const argv = ['node', 'scripts/qa_report.js']
      if (args.evidenceDir) argv.push(args.evidenceDir)
      return terminalCallView(argv)
    },
    presentResult: scriptPresentResult,
    async execute(args, exec) {
      const scriptArgs = args.evidenceDir ? [resolveTarget(args.evidenceDir, config)] : []
      return runScript(qaReport, scriptArgs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_ledger',
    description: 'Local-first delivery ledger for plugin work ($DSH_HOME/dsh-plugin-ledger/): bootstrap (idempotent), add a mandatory seven-field entry, latest state per plugin, bidirectional align, or advise on contract-inspection days. add exit code 0 is required before any delivery claim.',
    parameters: {
      action: { type: 'string', required: true, description: 'Subcommand: bootstrap|add|latest|align|advise' },
      target: { type: 'string', description: 'Plugin directory for add (--pkg)' },
      note: { type: 'string', description: 'Change note recorded with add (e.g. QA round and pass rate)' },
      verdict: { type: 'string', description: 'Acceptance verdict for add: 通过|带警告通过|不通过' },
      tier: { type: 'string', description: 'Environment coverage tier for add: full|no-key|no-cli' },
      act: { type: 'string', description: 'Ledger action for add: create|update|package|deliver (default update)' },
    },
    output: {
      schema: scriptOutputSchema,
      render: renderScriptResult,
      presentationMeta: scriptPresentationMeta,
    },
    presentCall: (args) => {
      const argv = ['node', 'scripts/ledger.js', args.action]
      if (args.target) argv.push('--pkg', args.target)
      if (args.note) argv.push('--note', args.note)
      if (args.verdict) argv.push('--verdict', args.verdict)
      if (args.tier) argv.push('--tier', args.tier)
      if (args.act) argv.push('--act', args.act)
      return terminalCallView(argv)
    },
    presentResult: scriptPresentResult,
    async execute(args, exec) {
      const scriptArgs = [args.action]
      if (args.target) scriptArgs.push('--pkg', resolveTarget(args.target, config))
      if (args.note) scriptArgs.push('--note', args.note)
      if (args.verdict) scriptArgs.push('--verdict', args.verdict)
      if (args.tier) scriptArgs.push('--tier', args.tier)
      if (args.act) scriptArgs.push('--act', args.act)
      return runScript(ledger, scriptArgs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_guide',
    description: 'Return the dsh-plugins-builder methodology references (platform contract, design spec, QA, naming, delivery, ledger playbooks). Call with an empty topic to list available references first.',
    parameters: {
      topic: { type: 'string', description: 'Reference name without extension, e.g. dsh-spec; empty lists topics' },
    },
    output: { schema: guideOutputSchema, render: renderGuideResult },
    async execute(args) {
      const topics = readdirSync(REFERENCES_DIR)
        .filter((entry) => entry.endsWith('.md'))
        .map((entry) => entry.slice(0, -3))
        .sort()
      if (!args.topic) return { ok: true, topics }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(args.topic) || !topics.includes(args.topic)) {
        throw new Error(`unknown topic: ${args.topic} (available: ${topics.join(', ')})`)
      }
      const file = join(REFERENCES_DIR, `${args.topic}.md`)
      if (!existsSync(file)) throw new Error(`reference missing: ${args.topic}`)
      return { ok: true, content: readFileSync(file, 'utf-8') }
    },
  }))

  console.log('[plugins-builder] registered 7 tools: plugin_init, plugin_validate, plugin_verify, plugin_package, plugin_qa_report, plugin_ledger, plugin_guide')
}

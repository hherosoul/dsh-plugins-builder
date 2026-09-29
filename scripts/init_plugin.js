// DSH Plugin Initializer - scaffolds a new DeepSeek Harness plugin (bundle)
// from the built-in template library.
//
// Usage:
//     node init_plugin.js <name> --kind minimal|tool|config|service|event-hook|seam-trio
//                    [--path <dir>] [--force]
//
// Derivations (SSOT: references/naming-playbook.md):
//     bare        = kebab(<name>), 'dsh-' prefix stripped
//     dir name    = <bare>
//     package     = dsh-<bare>          (package.json "name")
//     row id      = <bare>              (patch row id)
//     plugin name = <bare>              (export const name)
//     class name  = PascalCase(<bare>)  (service template only)
//
// Templates are plain ESM JavaScript (zero build), matching the official
// hello bundle shape: package.json (dsh.bundle.patch) + cordis.patch.yml
// + index.js + dev/cordis.yml overlay.
//
// Exit codes: 0 ok; 1 render error / target exists; 2 usage error.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain, runMain } from './_cli.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = resolve(SCRIPT_DIR, '..', 'templates')

const KINDS = ['minimal', 'tool', 'config', 'service', 'event-hook', 'seam-trio']

// seam-trio: template subdir -> rendered subdir (SSOT: templates/seam-trio/README.md)
const SEAM_SUBDIRS = {
  definition: '{base}-definition',
  provider: '{base}-provider',
  consumer: '{base}-consumer',
  bundle: 'bundle',
}

const KEBAB_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/
// Residual placeholder detector: only all-caps identifiers, so JSDoc
// object-typedef braces ({{ key: type }}) never false-positive.
const RESIDUAL_RE = /\{\{[A-Z][A-Z0-9_]*\}\}/g

const HELP_TEXT = `
DSH Plugin Initializer - scaffolds a new DeepSeek Harness plugin (bundle)
from the built-in template library.

Usage:
    node init_plugin.js <name> --kind minimal|tool|config|service|event-hook|seam-trio
                   [--path <dir>] [--force]

Derivations (SSOT: references/naming-playbook.md):
    bare        = kebab(<name>), 'dsh-' prefix stripped
    dir name    = <bare>
    package     = dsh-<bare>          (package.json "name")
    row id      = <bare>              (patch row id)
    plugin name = <bare>              (export const name)
    class name  = PascalCase(<bare>)  (service template only)

Templates are plain ESM JavaScript (zero build), matching the official
hello bundle shape: package.json (dsh.bundle.patch) + cordis.patch.yml
+ index.js + dev/cordis.yml overlay.

Exit codes: 0 ok; 1 render error / target exists; 2 usage error.
`.trim()

/** Lowercase, turn _/spaces into '-', drop other invalid chars, collapse. */
export function kebabize(raw) {
  let s = raw.trim().toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
  s = s.replace(/[^a-z0-9-]/g, '')
  s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  return s
}

export function pascalCase(bare) {
  return bare.split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

export function renderText(text, mapping) {
  for (const [key, value] of Object.entries(mapping)) {
    text = text.split(`{{${key}}}`).join(value)
  }
  return text
}

/** Expand a leading '~' to the home directory (Path.expanduser equivalent). */
function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** List every file under dir as posix-relative paths, sorted like Python's
 *  sorted(rglob('*')) (segment-wise lexicographic). */
function listFilesSorted(dir) {
  const out = []
  const walk = (current, rel) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(join(current, entry.name), childRel)
      } else {
        out.push(childRel)
      }
    }
  }
  walk(dir, '')
  out.sort((a, b) => {
    const pa = a.split('/')
    const pb = b.split('/')
    const n = Math.min(pa.length, pb.length)
    for (let i = 0; i < n; i += 1) {
      if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
    }
    return pa.length - pb.length
  })
  return out
}

/** Recursively render every file under srcDir into dstDir. */
export function renderTree(srcDir, dstDir, mapping, rendered) {
  for (const rel of listFilesSorted(srcDir)) {
    const src = join(srcDir, rel)
    const dst = join(dstDir, rel)
    mkdirSync(dirname(dst), { recursive: true })
    let text = readFileSync(src, 'utf8')
    text = renderText(text, mapping)
    const leftovers = [...new Set(text.match(RESIDUAL_RE) || [])].sort()
    if (leftovers.length > 0) {
      throw new Error(`未替换的占位符 [${leftovers.map((s) => `'${s}'`).join(', ')}] 残留于 ${rel}`)
    }
    writeFileSync(dst, text, 'utf8')
    rendered.push(rel)
  }
}

function buildMapping(bare, targetDir) {
  return {
    PKG_NAME: `dsh-${bare}`,
    PKG_BASE: bare,
    ROW_ID: bare,
    CLASS_NAME: pascalCase(bare),
    ABS_ENTRY_PATH: resolve(targetDir, 'index.js'),
    PLUGIN_DIR: `./${bare}`,
  }
}

export function scaffold(kind, bare, targetDir) {
  const rendered = []
  const mapping = buildMapping(bare, targetDir)
  const tplDir = join(TEMPLATE_DIR, kind)

  if (kind === 'seam-trio') {
    mkdirSync(targetDir, { recursive: true })
    mapping.ABS_ENTRY_PATH = resolve(targetDir, 'bundle', 'index.js')
    mapping.ABS_PROVIDER_ENTRY = resolve(targetDir, `${bare}-provider`, 'index.js')
    mapping.ABS_CONSUMER_ENTRY = resolve(targetDir, `${bare}-consumer`, 'index.js')
    for (const [sub, nameTmpl] of Object.entries(SEAM_SUBDIRS)) {
      const subName = nameTmpl.replace('{base}', bare)
      renderTree(join(tplDir, sub), join(targetDir, subName), mapping, rendered)
    }
    let readme = readFileSync(join(tplDir, 'README.md'), 'utf8')
    readme = renderText(readme, mapping)
    if (readme.match(RESIDUAL_RE)) {
      throw new Error('未替换的占位符残留于 seam-trio/README.md')
    }
    writeFileSync(join(targetDir, 'README.md'), readme, 'utf8')
    rendered.push('README.md')
  } else {
    renderTree(tplDir, targetDir, mapping, rendered)
    let readme = readFileSync(join(TEMPLATE_DIR, 'README-template.md'), 'utf8')
    readme = renderText(readme, mapping)
    if (readme.match(RESIDUAL_RE)) {
      throw new Error('未替换的占位符残留于 README.md')
    }
    writeFileSync(join(targetDir, 'README.md'), readme, 'utf8')
    rendered.push('README.md')
  }

  return rendered
}

export function main(argv) {
  let kind = null
  let outPath = '.'
  let force = false
  const positional = []
  const lines = []

  let i = 0
  while (i < argv.length) {
    if (argv[i] === '--kind') {
      if (i + 1 >= argv.length) {
        return { exitCode: 2, stdout: '❌ --kind 需要参数', stderr: '' }
      }
      kind = argv[i + 1]
      i += 2
    } else if (argv[i] === '--path') {
      if (i + 1 >= argv.length) {
        return { exitCode: 2, stdout: '❌ --path 需要参数', stderr: '' }
      }
      outPath = argv[i + 1]
      i += 2
    } else if (argv[i] === '--force') {
      force = true
      i += 1
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      return { exitCode: 0, stdout: HELP_TEXT, stderr: '' }
    } else {
      positional.push(argv[i])
      i += 1
    }
  }

  if (positional.length !== 1) {
    lines.push('Usage: node init_plugin.js <name> '
      + '--kind minimal|tool|config|service|event-hook|seam-trio '
      + '[--path <dir>] [--force]')
    lines.push('')
    lines.push('Example:')
    lines.push('  node init_plugin.js echo --kind tool --path ./plugins')
    return { exitCode: 2, stdout: lines.join('\n'), stderr: '' }
  }

  if (!KINDS.includes(kind)) {
    // Mimic Python repr: None / 'value'
    const kindRepr = kind === null ? 'None' : `'${kind}'`
    return {
      exitCode: 2,
      stdout: `❌ --kind 必须是 ${KINDS.join(', ')} 之一，收到: ${kindRepr}`,
      stderr: '',
    }
  }

  let bare = kebabize(positional[0])
  if (bare.startsWith('dsh-')) bare = bare.slice('dsh-'.length)
  if (bare.length < 2 || !KEBAB_RE.test(bare)) {
    return {
      exitCode: 2,
      stdout: `❌ 非法插件名 ${JSON.stringify(positional[0])}：kebab 化后为 ${JSON.stringify(bare)}，`
        + '须满足 ^[a-z0-9][a-z0-9-]*[a-z0-9]$ 且 ≥2 字符',
      stderr: '',
    }
  }

  const targetDir = resolve(expandHome(outPath), bare)
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !force) {
    return {
      exitCode: 1,
      stdout: `❌ 目标目录已存在且非空: ${targetDir}（用 --force 覆盖渲染）`,
      stderr: '',
    }
  }

  let rendered
  try {
    rendered = scaffold(kind, bare, targetDir)
  } catch (e) {
    // Errors carrying an fs error code come from file writes; everything
    // else is a rendering failure (placeholder residue etc.).
    if (e && e.code) {
      return { exitCode: 1, stdout: `❌ 文件写入失败: ${e.message}`, stderr: '' }
    }
    return { exitCode: 1, stdout: `❌ 渲染失败: ${e.message}`, stderr: '' }
  }

  const summary = {
    status: 'ok',
    kind,
    name: bare,
    package: `dsh-${bare}`,
    path: targetDir,
    files: rendered.length,
    next: [
      `node ${join(SCRIPT_DIR, 'validate_plugin.js')} ${targetDir}`,
      `详见 ${join(targetDir, 'README.md')} 的 Quickstart（本地闭环 / 安装 / 卸载）`,
    ],
  }
  return { exitCode: 0, stdout: JSON.stringify(summary, null, 2), stderr: '' }
}

if (isMain(import.meta.url)) runMain(main)

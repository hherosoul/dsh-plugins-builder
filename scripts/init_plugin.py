#!/usr/bin/env python3
"""
DSH Plugin Initializer - scaffolds a new DeepSeek Harness plugin (bundle)
from the built-in template library.

Usage:
    init_plugin.py <name> --kind minimal|tool|config|service|event-hook|seam-trio
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
"""

import json
import re
import sys
from pathlib import Path

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / 'templates'

KINDS = ('minimal', 'tool', 'config', 'service', 'event-hook', 'seam-trio')

# seam-trio: template subdir -> rendered subdir (SSOT: templates/seam-trio/README.md)
SEAM_SUBDIRS = {
    'definition': '{base}-definition',
    'provider': '{base}-provider',
    'consumer': '{base}-consumer',
    'bundle': 'bundle',
}

KEBAB_RE = re.compile(r'^[a-z0-9][a-z0-9-]*[a-z0-9]$')
# Residual placeholder detector: only all-caps identifiers, so JSDoc
# object-typedef braces ({{ key: type }}) never false-positive.
RESIDUAL_RE = re.compile(r'\{\{[A-Z][A-Z0-9_]*\}\}')


def kebabize(raw):
    """Lowercase, turn _/spaces into '-', drop other invalid chars, collapse."""
    s = raw.strip().lower().replace('_', '-').replace(' ', '-')
    s = re.sub(r'[^a-z0-9-]', '', s)
    s = re.sub(r'-{2,}', '-', s).strip('-')
    return s


def pascal_case(bare):
    return ''.join(part.capitalize() for part in bare.split('-') if part)


def render_text(text, mapping):
    for key, value in mapping.items():
        text = text.replace('{{%s}}' % key, value)
    return text


def render_tree(src_dir, dst_dir, mapping, rendered):
    """Recursively render every file under src_dir into dst_dir."""
    for src in sorted(src_dir.rglob('*')):
        if src.is_dir():
            continue
        rel = src.relative_to(src_dir)
        dst = dst_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        text = src.read_text(encoding='utf-8')
        text = render_text(text, mapping)
        leftovers = RESIDUAL_RE.findall(text)
        if leftovers:
            raise RuntimeError(
                f'未替换的占位符 {sorted(set(leftovers))} 残留于 {rel.as_posix()}')
        dst.write_text(text, encoding='utf-8')
        rendered.append((dst_dir / rel).as_posix())


def build_mapping(bare, target_dir):
    pkg_name = f'dsh-{bare}'
    return {
        'PKG_NAME': pkg_name,
        'PKG_BASE': bare,
        'ROW_ID': bare,
        'CLASS_NAME': pascal_case(bare),
        'ABS_ENTRY_PATH': str((target_dir / 'index.js').resolve()),
        'PLUGIN_DIR': f'./{bare}',
    }


def scaffold(kind, bare, target_dir):
    rendered = []
    mapping = build_mapping(bare, target_dir)
    tpl_dir = TEMPLATE_DIR / kind

    if kind == 'seam-trio':
        target_dir.mkdir(parents=True, exist_ok=True)
        mapping['ABS_ENTRY_PATH'] = str((target_dir / 'bundle' / 'index.js').resolve())
        mapping['ABS_PROVIDER_ENTRY'] = str(
            (target_dir / f'{bare}-provider' / 'index.js').resolve())
        mapping['ABS_CONSUMER_ENTRY'] = str(
            (target_dir / f'{bare}-consumer' / 'index.js').resolve())
        for sub, name_tmpl in SEAM_SUBDIRS.items():
            sub_name = name_tmpl.format(base=bare)
            render_tree(tpl_dir / sub, target_dir / sub_name, mapping, rendered)
        readme = (tpl_dir / 'README.md').read_text(encoding='utf-8')
        readme = render_text(readme, mapping)
        if RESIDUAL_RE.search(readme):
            raise RuntimeError('未替换的占位符残留于 seam-trio/README.md')
        (target_dir / 'README.md').write_text(readme, encoding='utf-8')
        rendered.append((target_dir / 'README.md').as_posix())
    else:
        render_tree(tpl_dir, target_dir, mapping, rendered)
        readme = (TEMPLATE_DIR / 'README-template.md').read_text(encoding='utf-8')
        readme = render_text(readme, mapping)
        if RESIDUAL_RE.search(readme):
            raise RuntimeError('未替换的占位符残留于 README.md')
        (target_dir / 'README.md').write_text(readme, encoding='utf-8')
        rendered.append((target_dir / 'README.md').as_posix())

    return rendered


def main():
    args = sys.argv[1:]
    kind = None
    out_path = '.'
    force = False
    positional = []

    i = 0
    while i < len(args):
        if args[i] == '--kind':
            if i + 1 >= len(args):
                print('❌ --kind 需要参数')
                sys.exit(2)
            kind = args[i + 1]
            i += 2
        elif args[i] == '--path':
            if i + 1 >= len(args):
                print('❌ --path 需要参数')
                sys.exit(2)
            out_path = args[i + 1]
            i += 2
        elif args[i] == '--force':
            force = True
            i += 1
        elif args[i] in ('-h', '--help'):
            print(__doc__)
            sys.exit(0)
        else:
            positional.append(args[i])
            i += 1

    if len(positional) != 1:
        print('Usage: python3 init_plugin.py <name> '
              '--kind minimal|tool|config|service|event-hook|seam-trio '
              '[--path <dir>] [--force]')
        print('\nExample:')
        print('  python3 init_plugin.py echo --kind tool --path ./plugins')
        sys.exit(2)

    if kind not in KINDS:
        print(f'❌ --kind 必须是 {", ".join(KINDS)} 之一，收到: {kind!r}')
        sys.exit(2)

    bare = kebabize(positional[0])
    if bare.startswith('dsh-'):
        bare = bare[len('dsh-'):]
    if len(bare) < 2 or not KEBAB_RE.match(bare):
        print(f'❌ 非法插件名 {positional[0]!r}：kebab 化后为 {bare!r}，'
              '须满足 ^[a-z0-9][a-z0-9-]*[a-z0-9]$ 且 ≥2 字符')
        sys.exit(2)

    target_dir = (Path(out_path).expanduser() / bare).resolve()
    if target_dir.exists() and any(target_dir.iterdir()) and not force:
        print(f'❌ 目标目录已存在且非空: {target_dir}（用 --force 覆盖渲染）')
        sys.exit(1)

    try:
        rendered = scaffold(kind, bare, target_dir)
    except RuntimeError as e:
        print(f'❌ 渲染失败: {e}')
        sys.exit(1)
    except OSError as e:
        print(f'❌ 文件写入失败: {e}')
        sys.exit(1)

    scripts_dir = Path(__file__).resolve().parent
    summary = {
        'status': 'ok',
        'kind': kind,
        'name': bare,
        'package': f'dsh-{bare}',
        'path': str(target_dir),
        'files': len(rendered),
        'next': [
            f'python3 {scripts_dir / "validate_plugin.py"} {target_dir}',
            f'详见 {target_dir / "README.md"} 的 Quickstart（本地闭环 / 安装 / 卸载）',
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    sys.exit(0)


if __name__ == '__main__':
    main()

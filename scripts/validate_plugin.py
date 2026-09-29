#!/usr/bin/env python3
"""
DSH Plugin Validator - validates DeepSeek Harness plugins against the
platform contract (also dogfoods on this meta-engineer package itself).

Architecture (M1):
    - dsh plugin mode only: target is a directory with package.json
      (PKG/PATCH/TS/TOOL/CFG/DEP rule families + shared SEC/DOC).
    - Rule identity layer: every checkpoint has a stable ID (CHECKS registry).
      Output format: [ID][severity] message. IDs make waivers, precise
      references, cross-version diffs and ledger records possible.
    - Categories: A = platform contract (never overridable),
                  B = methodology threshold (overridable via --policy),
                  C = scenario dimensions (droppable with reason).
    - Heuristic rules are warn-level and say so (semantic re-check belongs
      to Phase 4); the validator never pretends certainty it does not have.
    - Exit codes: 0 pass; 1 errors found; 2 usage error.

Usage:
    validate_plugin.py <path/to/plugin-dir> [--policy <file>]
                       [--skip-path-check] [--trust-append]
    validate_plugin.py --policy-help
"""

import sys
import json
import re
import subprocess
from pathlib import Path

# ---------------------------------------------------------------------------
# 平台契约版本戳：校验器内置的 dsh 契约快照。每次官方规范巡检后更新此处，
# 巡检日期一并记录。校验输出以 info 级打印，供「契约漂移」审计。
# ---------------------------------------------------------------------------
PLATFORM_CONTRACT_VERSION = {
    'spec_url': 'https://deepseek-harness.github.io/deepseek-harness/develop/basic/',
    'contract_version': '2026-09-29',
    'last_inspected': '2026-09-29',
    'bundle_shape': 'package.json(dsh.bundle.patch) + cordis.patch.yml + index.js; type:module',
    'layers': 'bundles 顺序 -> profile patch -> $DSH_HOME patch -> --patch overlay；按行整体替换',
}

# ---------------------------------------------------------------------------
# 文档预算（SSOT）。所有文档一律指针引用本常量，禁止在文档中写具体数字。
# 总量阈值：md_total_warn = 基数 + 单包增量；error = warn × 2。
# ---------------------------------------------------------------------------
DOC_BUDGET = {
    'md_total_base': 10,
    'md_total_per_member': 4,
    'resident_warn': 5000,
    'resident_error': 10000,
}

# 占位符扫描（DOC-001）：命中即 error。scripts/ 与 templates/ 白名单豁免——
# 那里是占位符机制的实现与模板生成器所在，属「示例文件中的合法占位符」。
PLACEHOLDER_PATTERNS = ('[TODO', '[TBD', 'FIXME', 'XXX', '<占位', '待补充')
PLACEHOLDER_SCAN_EXTS = {'.md', '.json', '.py', '.txt', '.yaml', '.yml'}
SOURCE_EXTS = {'.js', '.ts'}

SKIP_DIRS = {'.git', 'node_modules', '__pycache__'}

# 需要 inject 声明的已知服务键（TS-003 启发式；语义复核归 Phase 4）
KNOWN_SERVICES = ('tools', 'llm', 'jobs', 'session', 'sessionProjections')

# ---------------------------------------------------------------------------
# 规则身份层：CHECKS 是全部检查点的唯一注册表。
# 新增检查点必须先在这里领 ID。sev = 默认严重级；cat = A/B/C。
# ---------------------------------------------------------------------------
CHECKS = {
    # --- LOC-* / DET-* · 位置与识别 ---
    'LOC-002': {'sev': 'error', 'cat': 'A', 'msg': "Directory not found: {path}"},
    'LOC-003': {'sev': 'error', 'cat': 'A', 'msg': "Not a directory: {path}"},
    'DET-001': {'sev': 'error', 'cat': 'A', 'msg': "无法识别目标：缺少 package.json（不是 dsh 插件目录）"},
    # --- PKG-* · package.json / manifest（dsh 模式） ---
    'PKG-001': {'sev': 'error', 'cat': 'A', 'msg': "package.json: {reason}"},
    'PKG-002': {'sev': 'error', 'cat': 'A', 'msg': "package.json: dsh.bundle.patch 缺失或文件不可达: {detail}"},
    'PKG-003': {'sev': 'error', 'cat': 'A', 'msg': "package.json: name 须为 kebab-case（≥2 字符），got '{name}'"},
    'PKG-004': {'sev': 'warn', 'cat': 'B', 'msg': "package.json: name '{name}' 缺 'dsh-' 前缀（官方约定 dsh-<plugin-name>）"},
    'PKG-005': {'sev': 'error', 'cat': 'A', 'msg': "package.json: 'type' 必须为 'module'，got '{value}'"},
    'PKG-006': {'sev': 'error', 'cat': 'A', 'msg': "package.json: 'files' 未覆盖 {missing}（patch 与入口产物必须随包发布）"},
    'PKG-007': {'sev': 'warn', 'cat': 'B', 'msg': "package.json: 建议字段缺失: {missing}（version/license/description/README）"},
    'PKG-008': {'sev': 'error', 'cat': 'A', 'msg': "package.json: main 入口 '{main}' 不存在且无构建脚本（scripts.build/prepare）——组合包不可安装"},
    'PKG-009': {'sev': 'warn', 'cat': 'B', 'msg': "package.json: main 入口 '{main}' 尚未构建（已声明构建脚本）——发布前先构建；开发期可用 dev/ 覆盖层直载源码"},
    # --- PATCH-* · cordis.patch.yml / dev 覆盖层 ---
    'PATCH-001': {'sev': 'error', 'cat': 'A', 'msg': "{file}: 不可解析或不是 patch 数组: {reason}"},
    'PATCH-002': {'sev': 'error', 'cat': 'A', 'msg': "{file}: 行 id 重复: {row_id}"},
    'PATCH-003': {'sev': 'error', 'cat': 'A', 'msg': "{file}: bundle 层禁止绝对源码路径（行 {row_id}: {name}）——bundle 层按包名引用；绝对路径只许出现在 dev/ 覆盖层"},
    'PATCH-004': {'sev': 'warn', 'cat': 'B', 'msg': "{file}: 行 {row_id} 声明 config——层序按行整体替换（非深合并），覆盖方必须重述该行每个键"},
    'PATCH-005': {'sev': 'warn', 'cat': 'B', 'msg': "{file}: 行 {row_id} 的 name 不是绝对路径（dev 覆盖层应绝对路径直载源码入口）"},
    'PATCH-006': {'sev': 'warn', 'cat': 'B', 'msg': "dev/ 覆盖层缺失（开发期建议 dev/cordis.yml 绝对路径直载源码，见 design-spec.md）"},
    'PATCH-007': {'sev': 'error', 'cat': 'A', 'msg': "{file}: patch 行缺少 'id' 或 'name'（第 {index} 行）"},
    # --- TS-* · 入口模块静态 ---
    'TS-001': {'sev': 'error', 'cat': 'A', 'msg': "入口 {path}: 未找到插件入口形态（导出 apply 函数 / 含 apply 的默认对象 / extends Service 类）"},
    'TS-002': {'sev': 'warn', 'cat': 'B', 'msg': "入口 {path}: 未找到 'export const name'（建议显式声明插件名；类形式经 super(ctx, ...) 命名则忽略）"},
    'TS-003': {'sev': 'warn', 'cat': 'B', 'msg': "入口 {path}: 使用 ctx.{svc} 但 inject 未见 '{svc}'（启发式；语义复核归 Phase 4）"},
    # --- TOOL-* · defineTool 约定 ---
    'TOOL-001': {'sev': 'error', 'cat': 'A', 'msg': "defineTool {path}: 五要素不齐，缺 {missing}（name/description/parameters/output/execute）"},
    'TOOL-002': {'sev': 'error', 'cat': 'A', 'msg': "defineTool {path}: output 缺 schema 或 render（规范值与渲染必须成对声明）"},
    'TOOL-003': {'sev': 'warn', 'cat': 'B', 'msg': "defineTool {path}: description 过短（{length} 字符 < 20）——模型依赖 description 判断调用时机"},
    'TOOL-004': {'sev': 'warn', 'cat': 'B', 'msg': "defineTool {path}: 显式对象节点未声明 additionalProperties（启发式；语义复核归 Phase 4）"},
    'TOOL-005': {'sev': 'warn', 'cat': 'B', 'msg': "defineTool {path}: execute 疑似返回内容块而非规范值（模式级；语义复核归 Phase 4）"},
    # --- CFG-* · 配置纪律 ---
    'CFG-001': {'sev': 'error', 'cat': 'A', 'msg': "{path}: Config 接口与 Schema 必须成对导出（现仅见 {found}）"},
    'CFG-002': {'sev': 'warn', 'cat': 'B', 'msg': "{path}: 疑似硬编码可调参数（{literal}）——部署间可能不同的参数一律配置化（语义复核归 Phase 4）"},
    'CFG-003': {'sev': 'warn', 'cat': 'B', 'msg': "{path}: 必填配置 '{field}' 无默认值——README 必须说明用户如何提供"},
    # --- SEC-* · 安全与卫生 ---
    'SEC-001': {'sev': 'error', 'cat': 'A', 'msg': "{path}: 疑似硬编码凭据（模式级命中: {pattern}）——包内严禁真实 Token / 密钥，须用配置字段或 ${{VAR}} 占位（语义级复核归 Phase 4 维度 9）"},
    'SEC-002': {'sev': 'error', 'cat': 'A', 'msg': "{path}: 个人绝对路径（{literal}）——包内禁止；dev/ 覆盖层是唯一例外（平台契约要求绝对路径）"},
    'SEC-003': {'sev': 'warn', 'cat': 'B', 'msg': "{path}: 疑似真实数据（邮箱模式: {literal}）——示例一律占位符（语义级复核归 Phase 4 维度 9）"},
    # --- DOC-* · 文档 ---
    'DOC-001': {'sev': 'error', 'cat': 'A', 'msg': "文档含占位符: {path}:{line} 命中 {pattern}"},
    'DOC-002': {'sev': 'warn', 'cat': 'B', 'msg': "README 缺 Quickstart 段（安装 → 启动 → 验证，命令可逐条复制执行）"},
    'DOC-003': {'sev': 'warn', 'cat': 'B', 'msg': "文档指针悬空: {path} 引用的 {target} 不存在"},
    'DOC-004': {'sev': 'warn', 'cat': 'B', 'msg': "文档预算: md 文件 {total} 个 > 目标值 {limit}（SSOT：脚本 DOC_BUDGET）"},
    'DOC-005': {'sev': 'error', 'cat': 'B', 'msg': "文档预算: md 文件 {total} 个 > 上限 {limit}（同一触发时机的文档应合并）"},
    # --- DEP-* · 依赖健康 ---
    'DEP-001': {'sev': 'warn', 'cat': 'B', 'msg': "{path}: import 了 {pkg} 但 package.json 未声明（宿主提供的包应放 peerDependencies）"},
    'DEP-002': {'sev': 'warn', 'cat': 'B', 'msg': "package.json 声明 repository（git 分发）但缺自包含 prepare 脚本——git 安装拉源码不构建，用户侧会加载失败"},
    'DEP-003': {'sev': 'warn', 'cat': 'B', 'msg': "prepare 脚本疑似依赖 monorepo 上下文（{pattern}）——必须自包含"},
    'DEP-004': {'sev': 'warn', 'cat': 'B', 'msg': "package.json: '@deepseek-ai/*' 位于 dependencies，建议移入 peerDependencies（宿主运行时提供，避免双份实例）"},
    # --- APP-* · policy append ---
    'APP-001': {'sev': 'error', 'cat': 'A', 'msg': "policy append 脚本执行失败: {script}（{reason}）"},
    'APP-002': {'sev': 'warn', 'cat': 'B', 'msg': "policy append 已禁用：当前为第三方 / --skip-path-check 就地校验，执行被校验包内脚本属代码执行面。确需执行请加 --trust-append"},
}

# 未覆盖项：脚本没有规则覆盖的检查面，显式声明归属，禁止静默通过。
UNCOVERED_ITEMS = [
    ('运行时行为（加载 / 调用 / HMR / 取消）', 'verify_plugin.py L3–L4（M2）'),
    ('调用准确性（混淆矩阵）', 'Phase 4 维度 1（LLM 层；无密钥环境降级为 description 语义评审）'),
    ('凭据 / 隐私语义级审计', 'Phase 4 维度 9（脚本只做模式级扫描）'),
    ('启发式规则语义复核（TS-003 / TOOL-004 / TOOL-005 / CFG-002）', 'Phase 4（LLM 层）'),
    ('安装式可发布性', 'package_plugin.py [F]（M2）'),
]

VALID_SEVERITIES = ('error', 'warn', 'info')


# ---------------------------------------------------------------------------
# Policy：白名单式配置。白名单之外即拒绝。
# ---------------------------------------------------------------------------
class PolicyError(Exception):
    pass


class Policy:
    def __init__(self):
        self.overrides = {}   # 'DOC-004.md_total_warn' -> value
        self.waived = {}      # id -> reason
        self.skip = set()     # ids
        self.dim_drop = []
        self.dim_reason = ''
        self.append = []      # [{'id','desc','script'}]
        self.plugin = ''
        self.reason = ''

    def param(self, check_id, name, default):
        return self.overrides.get(f'{check_id}.{name}', default)


POLICY = Policy()


def _policy_check_cat(check_id):
    rule = CHECKS.get(check_id)
    if rule is None:
        raise PolicyError(f"未知检查点 ID: {check_id}（合法 ID 见脚本 CHECKS 注册表）")
    return rule['cat']


def load_policy(path):
    try:
        text = Path(path).read_text(encoding='utf-8')
    except OSError as e:
        raise PolicyError(f"无法读取 policy 文件: {e}")
    data = parse_simple_yaml(text)
    if not isinstance(data, dict) or not data:
        raise PolicyError("policy 文件为空或不是键值映射")

    allowed = {'version', 'plugin', 'reason', 'overrides', 'waive', 'skip',
               'dimensions', 'append'}
    unknown = set(data) - allowed
    if unknown:
        raise PolicyError(f"policy 含未知字段（拒绝加载）: {sorted(unknown)}；允许字段: {sorted(allowed)}")

    if 'version' in data and data['version'] != 1:
        raise PolicyError(f"policy version 必须为 1，got {data['version']}")

    POLICY.plugin = str(data.get('plugin', ''))
    POLICY.reason = str(data.get('reason', ''))

    overrides = data.get('overrides') or {}
    if not isinstance(overrides, dict):
        raise PolicyError("overrides 必须是映射（<ID>.<param>: value）")
    overridable_params = {'md_total_warn', 'severity'}
    for key, value in overrides.items():
        if '.' not in str(key):
            raise PolicyError(f"overrides 键须为 <ID>.<param> 格式，got '{key}'")
        cid, pname = str(key).split('.', 1)
        cat = _policy_check_cat(cid)
        if cat == 'A':
            raise PolicyError(f"A 类（平台契约）检查点不可覆盖: {cid} —— 白名单之外即拒绝")
        if cat == 'C':
            raise PolicyError(f"C 类（场景判据）检查点无脚本参数可覆盖: {cid}（维度裁剪请用 dimensions）")
        if pname not in overridable_params:
            raise PolicyError(f"未知参数 '{pname}'（允许: {sorted(overridable_params)}）")
        if pname == 'severity' and value not in VALID_SEVERITIES:
            raise PolicyError(f"{key}: severity 只能是 {VALID_SEVERITIES}")
        POLICY.overrides[str(key)] = value

    waive = data.get('waive') or []
    if not isinstance(waive, list):
        raise PolicyError("waive 必须是列表（- id: ... / reason: ...）")
    for item in waive:
        if not isinstance(item, dict) or 'id' not in item:
            raise PolicyError(f"waive 条目须含 id: {item}")
        cid = str(item['id'])
        cat = _policy_check_cat(cid)
        reason = str(item.get('reason', '') or '').strip()
        if not reason:
            raise PolicyError(f"waive 无 reason，拒绝加载 policy: {cid}（豁免必须带原因）")
        if cat == 'A':
            raise PolicyError(f"A 类（平台契约）检查点不可豁免: {cid}")
        if cat == 'C':
            raise PolicyError(f"C 类（场景判据）请用 dimensions 裁剪并落账，不接受 waive: {cid}")
        POLICY.waived[cid] = reason

    skip = data.get('skip') or []
    if not isinstance(skip, list):
        raise PolicyError("skip 必须是 ID 列表")
    for cid in skip:
        cid = str(cid)
        cat = _policy_check_cat(cid)
        if cat == 'A':
            raise PolicyError(f"A 类（平台契约）检查点不可跳过: {cid}")
        POLICY.skip.add(cid)

    dims = data.get('dimensions')
    if dims is not None:
        if not isinstance(dims, dict) or 'drop' not in dims:
            raise PolicyError("dimensions 须为 {drop: [...], reason: \"...\"}")
        reason = str(dims.get('reason', '') or '').strip()
        if not reason:
            raise PolicyError("dimensions.reason 必填（维度裁剪必须写原因，不允许静默缺席）")
        drop = dims.get('drop') or []
        if not isinstance(drop, list):
            raise PolicyError("dimensions.drop 必须是维度编号列表")
        try:
            POLICY.dim_drop = [int(d) for d in drop]
        except (TypeError, ValueError):
            raise PolicyError(f"dimensions.drop 须为整数列表，got {drop}")
        POLICY.dim_reason = reason

    appends = data.get('append') or []
    if not isinstance(appends, list):
        raise PolicyError("append 必须是列表")
    for item in appends:
        if not isinstance(item, dict) or not item.get('id') or not item.get('script'):
            raise PolicyError(f"append 条目须含 id 与 script: {item}")
        script = str(item['script'])
        script_p = Path(script)
        if script_p.is_absolute() or '..' in script_p.parts:
            raise PolicyError(f"append 脚本路径含 '..' 或为绝对路径，拒绝: {script}")
        POLICY.append.append({'id': str(item['id']), 'desc': str(item.get('desc', '')), 'script': script})


def print_policy_help():
    print("""policy 文件格式（YAML，随 --policy 传入；SSOT 见本帮助，文档只放指针）:

version: 1
plugin: dsh-my-plugin
reason: "说明为何需要覆盖 / 豁免"

overrides:            # 只允许 B 类；出现 A 类 ID 整体拒绝
  DOC-004.md_total_warn: 30
  PKG-004.severity: info     # B 类可降级

waive:                # 单条豁免，reason 必填
  - id: PATCH-006
    reason: "该插件仅在源码仓库内开发，不需要独立 dev 覆盖层"

skip:                 # 跳过检查
  - TOOL-003

dimensions:           # C 类（Phase 4 维度）裁剪，reason 必填；须落账
  drop: [1]
  reason: "无密钥环境，调用准确性降级为 description 语义评审"

append:               # 追加自定义检查（可选）
  - id: ORG-001
    desc: "禁止提交 *.log"
    script: "scripts/my_rules.py"   # 相对被校验包根目录；禁 '..' 与绝对路径

加载规则:
  - 未知字段拒绝；waive 无 reason 拒绝；dimensions 无 reason 拒绝
  - append 脚本路径含 '..' 或绝对路径拒绝
  - A 类（平台契约）ID 出现在任何可覆盖字段 -> 整体拒绝并报出 ID
  - append 脚本由被校验包根目录下执行: <python> <script> <包根目录>，
    每行输出 "SEVERITY|ID|message"（SEVERITY ∈ error/warn/info）

⚠️ 安全警示（append 是代码执行面）:
  append 脚本**内容来自被校验包**。对第三方包做 --skip-path-check 就地
  校验时，执行这些脚本等于运行不受信代码。因此：
  - 使用了 --skip-path-check 时，append 默认**禁用**（输出 APP-002 告警）；
  - 确已审查过被校验包、愿意承担执行风险时，显式加 --trust-append 开启。""")
    sys.exit(0)


# ---------------------------------------------------------------------------
# 极简 YAML 子集解析器（零第三方依赖）。支持嵌套 dict / 块列表 / 行内列表 /
# 行内流式映射 / 引号字符串 / 数字 / 布尔 / null。顶层可以是 dict 或 list。
# ---------------------------------------------------------------------------
def _yaml_strip_comment(line):
    q = None
    for i, ch in enumerate(line):
        if q:
            if ch == q:
                q = None
        elif ch in '"\'':
            q = ch
        elif ch == '#' and (i == 0 or line[i - 1] in ' \t'):
            return line[:i].rstrip()
    return line


def _split_inline(s):
    out, buf, q, depth = [], '', None, 0
    for ch in s:
        if q:
            buf += ch
            if ch == q:
                q = None
        elif ch in '"\'':
            q = ch
            buf += ch
        elif ch in '[{':
            depth += 1
            buf += ch
        elif ch in ']}':
            depth -= 1
            buf += ch
        elif ch == ',' and depth == 0:
            out.append(buf.strip())
            buf = ''
        else:
            buf += ch
    if buf.strip():
        out.append(buf.strip())
    return out


def _yaml_scalar(s):
    s = s.strip()
    if s == '' or s == '~' or s.lower() == 'null':
        return None
    if len(s) >= 2 and s[0] == s[-1] and s[0] in '"\'':
        return s[1:-1]
    if s.startswith('[') and s.endswith(']'):
        inner = s[1:-1].strip()
        return [_yaml_scalar(x) for x in _split_inline(inner)] if inner else []
    if s.startswith('{') and s.endswith('}'):
        inner = s[1:-1].strip()
        d = {}
        if inner:
            for part in _split_inline(inner):
                k, sep, v = part.partition(':')
                if not sep:
                    continue
                d[_yaml_scalar(k)] = _yaml_scalar(v)
        return d
    low = s.lower()
    if low == 'true':
        return True
    if low == 'false':
        return False
    for conv in (int, float):
        try:
            return conv(s)
        except ValueError:
            pass
    return s


def _looks_like_kv(s):
    return bool(re.match(r'^[^\s"\[\]{}#]+:(\s|$)', s))


def _yaml_parse_block(items, i, indent):
    if i >= len(items):
        return None, i
    if items[i][1].startswith('-'):
        lst = []
        while i < len(items) and items[i][0] == indent and items[i][1].startswith('-'):
            content = items[i][1][1:].strip()
            if content == '':
                i += 1
                if i < len(items) and items[i][0] > indent:
                    v, i = _yaml_parse_block(items, i, items[i][0])
                    lst.append(v)
                else:
                    lst.append(None)
            elif _looks_like_kv(content):
                d = {}
                k, _, v = content.partition(':')
                k, v = k.strip(), v.strip()
                if v == '':
                    if i + 1 < len(items) and items[i + 1][0] > indent:
                        sub, i = _yaml_parse_block(items, i + 1, items[i + 1][0])
                        d[k] = sub
                    else:
                        d[k] = None
                        i += 1
                else:
                    d[k] = _yaml_scalar(v)
                    i += 1
                while (i < len(items) and items[i][0] > indent
                       and not items[i][1].startswith('- ')
                       and _looks_like_kv(items[i][1])):
                    k2, _, v2 = items[i][1].partition(':')
                    k2, v2 = k2.strip(), v2.strip()
                    if v2 == '':
                        if i + 1 < len(items) and items[i + 1][0] > items[i][0]:
                            sub, i = _yaml_parse_block(items, i + 1, items[i + 1][0])
                            d[k2] = sub
                        else:
                            d[k2] = None
                            i += 1
                    else:
                        d[k2] = _yaml_scalar(v2)
                        i += 1
                lst.append(d)
            else:
                lst.append(_yaml_scalar(content))
                i += 1
        return lst, i
    d = {}
    while i < len(items) and items[i][0] == indent and not items[i][1].startswith('-'):
        content = items[i][1]
        if not _looks_like_kv(content):
            i += 1
            continue
        k, _, v = content.partition(':')
        k, v = k.strip(), v.strip()
        if v == '':
            if i + 1 < len(items) and items[i + 1][0] > indent:
                sub, i = _yaml_parse_block(items, i + 1, items[i + 1][0])
                d[k] = sub
            else:
                d[k] = None
                i += 1
        else:
            d[k] = _yaml_scalar(v)
            i += 1
    return d, i


def parse_yaml_doc(text):
    """解析 YAML 子集，顶层可返回 dict 或 list。"""
    items = []
    for raw in text.split('\n'):
        line = _yaml_strip_comment(raw.rstrip())
        if not line.strip():
            continue
        stripped = line.strip()
        if stripped == '---':
            continue
        indent = len(line) - len(line.lstrip(' '))
        items.append((indent, stripped))
    if not items:
        return None
    val, _ = _yaml_parse_block(items, 0, items[0][0])
    return val


def parse_simple_yaml(text):
    val = parse_yaml_doc(text)
    return val if isinstance(val, dict) else {}


# ---------------------------------------------------------------------------
# 校验结果收集与规则发射
# ---------------------------------------------------------------------------
class ValidationResult:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.infos = []
        self.waived = []
        self.skipped = []
        self.notes = []

    @property
    def is_valid(self):
        return len(self.errors) == 0

    def summary(self):
        lines = []
        if self.errors:
            lines.append(f"❌ {len(self.errors)} error(s):")
            lines.extend(f"   • {e}" for e in self.errors)
        if self.warnings:
            lines.append(f"⚠️  {len(self.warnings)} warning(s):")
            lines.extend(f"   • {w}" for w in self.warnings)
        if self.infos:
            lines.append(f"ℹ️  {len(self.infos)} info:")
            lines.extend(f"   • {i}" for i in self.infos)
        if self.waived:
            lines.append(f"🔓 本轮豁免清单（policy，{len(self.waived)} 条）:")
            for w, reason in self.waived:
                lines.append(f"   • {w}")
                lines.append(f"     [WAIVED by policy: {reason}]")
        if self.skipped:
            lines.append(f"⏭️  已跳过检查（policy skip）: {len(self.skipped)} 条")
            lines.extend(f"   • {s}" for s in self.skipped)
        for n in self.notes:
            lines.append(f"ℹ️  {n}")
        if POLICY.dim_drop:
            lines.append(f"✂️  维度裁剪声明: 维度 {POLICY.dim_drop}（原因: {POLICY.dim_reason}）")
            lines.append("   → 须写入 Phase 4 用例表，并随包记入账本（不允许静默缺席）")
        lines.append("❓ 未覆盖项（脚本无规则覆盖，归属如下，禁止静默通过）:")
        for item, owner in UNCOVERED_ITEMS:
            lines.append(f"   • {item} → {owner}")
        if self.is_valid:
            tail = "✅ 校验通过！"
            if self.warnings:
                tail = "✅ 校验通过（带警告，见上）"
            lines.append(tail)
        return '\n'.join(lines)


def emit(result, check_id, **params):
    """统一发射口：所有检查点输出走 [ID][severity] 前缀。"""
    rule = CHECKS[check_id]
    msg = rule['msg'].format(**params)
    if check_id in POLICY.skip:
        result.skipped.append(f"[{check_id}][{rule['sev']}] {msg}")
        return
    if check_id in POLICY.waived:
        result.waived.append((f"[{check_id}][{rule['sev']}] {msg}", POLICY.waived[check_id]))
        return
    sev = rule['sev']
    ov = POLICY.overrides.get(f'{check_id}.severity')
    if ov in VALID_SEVERITIES:
        sev = ov
    line = f"[{check_id}][{sev}] {msg}"
    if sev == 'error':
        result.errors.append(line)
    elif sev == 'warn':
        result.warnings.append(line)
    else:
        result.infos.append(line)


# ---------------------------------------------------------------------------
# SEC-* 扫描模式（模式级；语义级复核归 Phase 4 维度 9）
# ---------------------------------------------------------------------------
CREDENTIAL_PATTERNS = [
    (re.compile(r'Bearer\s+[A-Za-z0-9\-_.]{20,}'), 'Bearer <长令牌>'),
    (re.compile(r'sk-[A-Za-z0-9]{20,}'), 'sk- 前缀密钥'),
    (re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}'), 'GitHub token'),
    (re.compile(r'xox[baprs]-[A-Za-z0-9\-]{10,}'), 'Slack token'),
    (re.compile(r'(?i)["\']?(api[_-]?key|secret|access[_-]?token|password)["\']?\s*[:=]\s*'
                r'["\'][A-Za-z0-9\-_.]{16,}["\']'), 'key/secret/token 字面量'),
]

# 个人绝对路径：要求 /Users/ 后跟真实形态的用户名段（占位写法
# 如 /Users/<username> 不命中）。dev/ 覆盖层在 dsh 模式按契约豁免。
PERSONAL_PATH_PATTERNS = [
    (re.compile(r'/Users/[A-Za-z0-9_.-]{2,}'), 'macOS 个人目录'),
    (re.compile(r'[A-Za-z]:\\Users\\[A-Za-z0-9_.-]{2,}'), 'Windows 个人目录'),
]

EMAIL_PATTERN = re.compile(r'[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})')
EXAMPLE_DOMAINS = {'example.com', 'example.org', 'example.net', 'localhost'}


def _iter_text_files(root, exts, exempt_parts=()):
    """遍历文本文件；跳过 SKIP_DIRS 与 exempt_parts 中的目录。"""
    for p in sorted(root.rglob('*')):
        if not p.is_file():
            continue
        try:
            rel = p.relative_to(root)
        except ValueError:
            continue
        parts = rel.parts
        if any(part in SKIP_DIRS for part in parts):
            continue
        if any(part in exempt_parts for part in parts):
            continue
        if p.suffix.lower() not in exts:
            continue
        yield p, rel.as_posix()


def scan_security(root, result):
    """SEC-001/002/003。scripts/ 与 templates/ 白名单豁免（占位符机制实现所在）；
    SEC-002 另豁免 dev/（平台契约要求覆盖层绝对路径）。"""
    exts = PLACEHOLDER_SCAN_EXTS | SOURCE_EXTS
    for path, rel in _iter_text_files(root, exts, exempt_parts=('scripts', 'templates')):
        try:
            text = path.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        for pattern, label in CREDENTIAL_PATTERNS:
            if pattern.search(text):
                emit(result, 'SEC-001', path=rel, pattern=label)
        if 'dev' not in Path(rel).parts:
            for pattern, label in PERSONAL_PATH_PATTERNS:
                m = pattern.search(text)
                if m:
                    emit(result, 'SEC-002', path=rel, literal=m.group(0))
        for m in EMAIL_PATTERN.finditer(text):
            domain = m.group(1).lower()
            if domain not in EXAMPLE_DOMAINS:
                emit(result, 'SEC-003', path=rel, literal=m.group(0))
                break


def scan_placeholders(root, result):
    """DOC-001：占位符扫描。白名单豁免 scripts/ 与 templates/。"""
    exts = PLACEHOLDER_SCAN_EXTS | SOURCE_EXTS
    for path, rel in _iter_text_files(root, exts, exempt_parts=('scripts', 'templates')):
        try:
            text = path.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        for ln, line in enumerate(text.split('\n'), 1):
            for pat in PLACEHOLDER_PATTERNS:
                if pat in line:
                    emit(result, 'DOC-001', path=rel, line=ln, pattern=pat)


# ---------------------------------------------------------------------------
# dsh 模式
# ---------------------------------------------------------------------------
def _read_source_files(plugin_dir):
    """收集源码文件（入口优先）：根 *.js/*.ts、src/、lib/ 下的 .js/.ts。"""
    out = []
    seen = set()
    for sub in ('', 'src', 'lib'):
        base = plugin_dir / sub if sub else plugin_dir
        if not base.is_dir():
            continue
        for p in sorted(base.iterdir()):
            if p.is_file() and p.suffix in SOURCE_EXTS and p.resolve() not in seen:
                seen.add(p.resolve())
                out.append(p)
    return out


def resolve_entry(plugin_dir, pkg):
    main = str(pkg.get('main') or 'index.js')
    for cand in (main, 'index.js', 'index.ts', 'src/index.ts', 'lib/index.js'):
        p = plugin_dir / cand
        if p.is_file():
            return p, cand
    return None, main


def validate_pkg(plugin_dir, pkg, result):
    name = pkg.get('name')
    version = pkg.get('version')
    if not name:
        emit(result, 'PKG-001', reason="缺少必填字段 'name'")
    if not version:
        emit(result, 'PKG-001', reason="缺少必填字段 'version'")

    if name:
        if len(str(name)) < 2 or not re.match(r'^[a-z0-9@][a-z0-9-/@.]*[a-z0-9]$', str(name)):
            emit(result, 'PKG-003', name=name)
        bare = str(name).split('/')[-1]
        if not bare.startswith('dsh-'):
            emit(result, 'PKG-004', name=name)

    if pkg.get('type') != 'module':
        emit(result, 'PKG-005', value=str(pkg.get('type', '(missing)')))

    dsh = pkg.get('dsh')
    bundle = dsh.get('bundle') if isinstance(dsh, dict) else None
    patch_rel = None
    if isinstance(bundle, dict):
        patch_rel = bundle.get('patch')
        if not patch_rel:
            emit(result, 'PKG-002', detail='dsh.bundle 存在但未声明 patch')
        else:
            patch_path = plugin_dir / str(patch_rel)
            if not patch_path.is_file():
                emit(result, 'PKG-002', detail=f'patch 文件不存在: {patch_rel}')
    if bundle is None and isinstance(dsh, dict) and not dsh.get('profile'):
        result.infos.append("未声明 dsh.bundle：按库包处理（供插件包 import，不被用户直接启用）")

    files = pkg.get('files')
    main = str(pkg.get('main') or 'index.js')
    if isinstance(files, list):
        norm = [str(f).replace('\\', '/') for f in files]

        def covered(target):
            t = str(target).replace('\\', '/')
            for f in norm:
                if f == t or t.startswith(f.rstrip('/') + '/') or f == t.split('/')[0]:
                    return True
            return False

        missing = []
        if not covered(main):
            missing.append(f"入口 {main}")
        if patch_rel and not covered(str(patch_rel).lstrip('./')):
            missing.append(f"patch {patch_rel}")
        if missing:
            emit(result, 'PKG-006', missing='、'.join(missing))

    rec_missing = []
    if not version:
        rec_missing.append('version')
    if not pkg.get('license'):
        rec_missing.append('license')
    if not pkg.get('description'):
        rec_missing.append('description')
    if not (plugin_dir / 'README.md').exists():
        rec_missing.append('README.md')
    if rec_missing:
        emit(result, 'PKG-007', missing='、'.join(rec_missing))

    main_path = plugin_dir / main
    if not main_path.is_file():
        scripts = pkg.get('scripts') or {}
        if isinstance(scripts, dict) and (scripts.get('build') or scripts.get('prepare')):
            emit(result, 'PKG-009', main=main)
        else:
            emit(result, 'PKG-008', main=main)

    return patch_rel


def _patch_rows(doc):
    """从 patch 文档提取 (op_key, row_dict, index) 序列。"""
    rows = []
    if not isinstance(doc, list):
        return rows
    idx = 0
    for op in doc:
        if not isinstance(op, dict):
            idx += 1
            continue
        for key in ('insert', 'replace', 'override', 'remove'):
            entries = op.get(key)
            if isinstance(entries, list):
                for row in entries:
                    idx += 1
                    rows.append((key, row if isinstance(row, dict) else {}, idx))
            elif entries is not None:
                idx += 1
                rows.append((key, entries if isinstance(entries, dict) else {}, idx))
    return rows


def validate_patch_file(plugin_dir, patch_rel, result):
    """PATCH-001..004/007：bundle 层 patch。"""
    display = patch_rel or 'cordis.patch.yml'
    patch_path = plugin_dir / str(patch_rel)
    try:
        text = patch_path.read_text(encoding='utf-8')
    except OSError as e:
        emit(result, 'PATCH-001', file=display, reason=f'不可读: {e}')
        return
    doc = parse_yaml_doc(text)
    if not isinstance(doc, list):
        emit(result, 'PATCH-001', file=display, reason='顶层必须是 patch 操作数组')
        return
    rows = _patch_rows(doc)
    seen_ids = set()
    for _key, row, idx in rows:
        row_id = row.get('id')
        row_name = row.get('name')
        if not row_id or not row_name:
            emit(result, 'PATCH-007', file=display, index=idx)
            continue
        row_id = str(row_id)
        if row_id in seen_ids:
            emit(result, 'PATCH-002', file=display, row_id=row_id)
        seen_ids.add(row_id)
        name_s = str(row_name)
        if name_s.startswith('/') or re.match(r'^[A-Za-z]:\\', name_s) or '://' in name_s:
            emit(result, 'PATCH-003', file=display, row_id=row_id, name=name_s)
        if 'config' in row:
            emit(result, 'PATCH-004', file=display, row_id=row_id)


def validate_dev_overlay(plugin_dir, result):
    """PATCH-005/006：dev 覆盖层（绝对路径直载源码）。"""
    dev_dir = plugin_dir / 'dev'
    overlays = sorted(dev_dir.glob('*.yml')) + sorted(dev_dir.glob('*.yaml')) if dev_dir.is_dir() else []
    if not overlays:
        emit(result, 'PATCH-006')
        return
    for ov in overlays:
        display = ov.relative_to(plugin_dir).as_posix()
        try:
            doc = parse_yaml_doc(ov.read_text(encoding='utf-8'))
        except OSError:
            continue
        if not isinstance(doc, list):
            emit(result, 'PATCH-001', file=display, reason='顶层必须是 patch 操作数组')
            continue
        for _key, row, idx in _patch_rows(doc):
            row_id = str(row.get('id', f'#{idx}'))
            row_name = row.get('name')
            if not row.get('id') or not row_name:
                emit(result, 'PATCH-007', file=display, index=idx)
                continue
            name_s = str(row_name)
            if not (name_s.startswith('/') or re.match(r'^[A-Za-z]:\\', name_s)):
                emit(result, 'PATCH-005', file=display, row_id=row_id)


def _strip_js_comments(text):
    """移除 // 行注释与 /* */ 块注释；跟踪字符串状态，URL 等串内 // 不误伤。"""
    out = []
    in_block = False
    for line in text.split('\n'):
        buf = []
        i, n = 0, len(line)
        quote = None
        while i < n:
            ch = line[i]
            if in_block:
                if ch == '*' and i + 1 < n and line[i + 1] == '/':
                    in_block = False
                    i += 2
                    continue
                i += 1
                continue
            if quote:
                buf.append(ch)
                if ch == '\\' and i + 1 < n:
                    buf.append(line[i + 1])
                    i += 2
                    continue
                if ch == quote:
                    quote = None
                i += 1
                continue
            if ch in ('\'', '"', '`'):
                quote = ch
                buf.append(ch)
                i += 1
                continue
            if ch == '/' and i + 1 < n and line[i + 1] == '/':
                break
            if ch == '/' and i + 1 < n and line[i + 1] == '*':
                in_block = True
                i += 2
                continue
            buf.append(ch)
            i += 1
        if not in_block:
            out.append(''.join(buf))
    return '\n'.join(out)


def validate_entry_ts(plugin_dir, pkg, result):
    """TS-001..003：入口模块静态检查（启发式一律 [W]）。

    仅对 bundle 包执行：官方约定无 dsh.bundle 声明的包只作普通依赖
    （纯库包，如 seam 的 definition），不要求插件入口形态。"""
    dsh = pkg.get('dsh')
    if not (isinstance(dsh, dict) and isinstance(dsh.get('bundle'), dict)):
        return
    entry_path, entry_rel = resolve_entry(plugin_dir, pkg)
    if entry_path is None:
        return  # PKG-008/009 已报告入口缺失
    try:
        raw = entry_path.read_text(encoding='utf-8')
    except (UnicodeDecodeError, OSError):
        return
    text = _strip_js_comments(raw)

    has_apply_fn = bool(re.search(r'export\s+(async\s+)?function\s+apply\b', text)
                        or re.search(r'export\s+const\s+apply\b', text))
    has_default_apply = bool(re.search(r'export\s+default\b', text) and re.search(r'\bapply\s*\(', text))
    has_service = bool(re.search(r'extends\s+Service\b', text))
    if not (has_apply_fn or has_default_apply or has_service):
        emit(result, 'TS-001', path=entry_rel)

    if not has_service:
        if not (re.search(r"export\s+const\s+name\s*=", text)
                or re.search(r"\bname\s*:\s*['\"]", text)):
            emit(result, 'TS-002', path=entry_rel)

    inject_match = re.findall(r"inject\s*=\s*\[([^\]]*)\]", text)
    declared = set()
    for chunk in inject_match:
        declared.update(re.findall(r"['\"]([^'\"]+)['\"]", chunk))
    for svc in KNOWN_SERVICES:
        if re.search(rf'ctx\.{svc}\b', text) and svc not in declared:
            emit(result, 'TS-003', path=entry_rel, svc=svc)


def _extract_marker_blocks(text, marker):
    """提取 marker( 开头的括号平衡块（跳过字符串字面量）。"""
    blocks = []
    i = 0
    n = len(text)
    while True:
        j = text.find(marker, i)
        if j < 0:
            break
        p = j + len(marker)
        if p >= n or text[p] != '(':
            i = j + len(marker)
            continue
        depth = 0
        start = p + 1
        while p < n:
            ch = text[p]
            if ch in '\'"`':
                q = ch
                p += 1
                while p < n and text[p] != q:
                    if text[p] == '\\':
                        p += 1
                    p += 1
            elif ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    break
            p += 1
        blocks.append(text[start:p])
        i = p + 1
    return blocks


def validate_tools(plugin_dir, result):
    """TOOL-001..005：defineTool 约定（括号平衡块级启发式）。"""
    for src in _read_source_files(plugin_dir):
        try:
            text = src.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        if 'defineTool' not in text:
            continue
        rel = src.relative_to(plugin_dir).as_posix()
        for block in _extract_marker_blocks(text, 'defineTool'):
            # 属性形式（key:）与方法简写（[async] key(）都接受
            missing = [k for k in ('name', 'description', 'parameters', 'output', 'execute')
                       if not re.search(rf'\b{k}\s*[:\(]', block)]
            if missing:
                emit(result, 'TOOL-001', path=rel, missing='、'.join(missing))
            if not (re.search(r'\bschema\s*:', block) and re.search(r'\brender\s*:', block)):
                emit(result, 'TOOL-002', path=rel)
            dm = re.search(r"description\s*:\s*['\"]([^'\"]+)['\"]", block)
            if dm and len(dm.group(1)) < 20:
                emit(result, 'TOOL-003', path=rel, length=len(dm.group(1)))
            if re.search(r"['\"]?type['\"]?\s*:\s*['\"]object['\"]", block) \
                    and 'additionalProperties' not in block:
                emit(result, 'TOOL-004', path=rel)
            eidx = block.find('execute')
            if eidx >= 0:
                tail = block[eidx:]
                if (re.search(r"return\s+\[\s*\{[^}]{0,80}type\s*:\s*['\"]text['\"]", tail)
                        or re.search(r"return\s+\{\s*type\s*:\s*['\"]text['\"]", tail)):
                    emit(result, 'TOOL-005', path=rel)


def validate_config(plugin_dir, result):
    """CFG-001..003：配置纪律。"""
    readme_text = ''
    readme = plugin_dir / 'README.md'
    if readme.exists():
        try:
            readme_text = readme.read_text(encoding='utf-8')
        except OSError:
            pass
    for src in _read_source_files(plugin_dir):
        try:
            text = src.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        rel = src.relative_to(plugin_dir).as_posix()

        if re.search(r"from\s+['\"]@deepseek-ai/schemastery['\"]", text) or 'Schema.object(' in text:
            has_const = bool(re.search(r'export\s+const\s+Config\b', text))
            has_iface = bool(re.search(r'export\s+(interface|type)\s+Config\b', text))
            if src.suffix == '.ts':
                if not (has_const and has_iface):
                    found = []
                    if has_const:
                        found.append('const Config')
                    if has_iface:
                        found.append('interface Config')
                    emit(result, 'CFG-001', path=rel, found='、'.join(found) or '无')
            elif not has_const:
                emit(result, 'CFG-001', path=rel, found='无')

        for line in text.split('\n'):
            stripped = line.strip()
            if stripped.startswith(('//', '*', '/*')):
                continue
            cm = re.match(
                r'(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d[\d_]*|["\'][^"\']{0,80}["\'])',
                stripped)
            if cm and re.search(r'(?i)(timeout|interval|port|limit|^max_|^min_|retr|delay|endpoint)',
                                cm.group(1)):
                emit(result, 'CFG-002', path=rel, literal=f'{cm.group(1)} = {cm.group(2)}')
            um = re.search(r"['\"](https?://[^'\"]+)['\"]", stripped)
            if um:
                emit(result, 'CFG-002', path=rel, literal=um.group(1))

        for field, chain in re.findall(r'(\w+)\s*:\s*(Schema\.[^\n]+)', text):
            if '.required()' in chain and '.default(' not in chain:
                if field not in readme_text:
                    emit(result, 'CFG-003', path=rel, field=field)


def validate_deps(plugin_dir, pkg, result):
    """DEP-001..004：依赖健康。"""
    dep_sections = {}
    for section in ('dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'):
        v = pkg.get(section)
        if isinstance(v, dict):
            dep_sections[section] = set(v.keys())
    all_declared = set().union(*dep_sections.values()) if dep_sections else set()

    for src in _read_source_files(plugin_dir):
        try:
            text = src.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        rel = src.relative_to(plugin_dir).as_posix()
        for imp in set(re.findall(r"from\s+['\"](@deepseek-ai/[^'\"/]+)['\"]", text)):
            if imp not in all_declared:
                emit(result, 'DEP-001', path=rel, pkg=imp)
            elif imp in dep_sections.get('dependencies', set()):
                emit(result, 'DEP-004')

    if pkg.get('repository'):
        scripts = pkg.get('scripts') or {}
        if not (isinstance(scripts, dict) and scripts.get('prepare')):
            emit(result, 'DEP-002')
    scripts = pkg.get('scripts') or {}
    prepare = str(scripts.get('prepare', '')) if isinstance(scripts, dict) else ''
    if prepare:
        pm = re.search(r'\.\./\.\.|--filter|\bturbo\b|\bnx\b', prepare)
        if pm:
            emit(result, 'DEP-003', pattern=pm.group(0))


def validate_docs_dsh(plugin_dir, result):
    """DOC-002/003：README Quickstart 与指针悬空。"""
    readme = plugin_dir / 'README.md'
    if not readme.exists():
        emit(result, 'DOC-002')
        return
    try:
        text = readme.read_text(encoding='utf-8')
    except OSError:
        emit(result, 'DOC-002')
        return
    if not re.search(r'(?im)^#+.*quickstart|^#+.*快速开始', text):
        emit(result, 'DOC-002')
    for target in re.findall(r'\[[^\]]*\]\(([^)#\s]+)\)', text):
        if target.startswith(('http://', 'https://', 'mailto:')) or '..' in target:
            continue
        if not (plugin_dir / target).exists():
            emit(result, 'DOC-003', path='README.md', target=target)


def validate_doc_budget(plugin_dir, result):
    """DOC-004/005：md 文档总量预算。templates/ 是渲染产物（init 的输出源），
    非读物，不计入预算。"""
    try:
        md_files = [
            p for p in plugin_dir.rglob('*.md')
            if not any(part in SKIP_DIRS for part in p.relative_to(plugin_dir).parts)
            and 'templates' not in p.relative_to(plugin_dir).parts
        ]
    except Exception:
        return

    warn_limit = POLICY.param('DOC-004', 'md_total_warn',
                              DOC_BUDGET['md_total_base'] + DOC_BUDGET['md_total_per_member'])
    error_limit = POLICY.param('DOC-005', 'md_total_error', warn_limit * 2)

    total = len(md_files)
    result.infos.append(
        f"文档预算诊断: md 文件 {total} 个（warn 阈值 {warn_limit} / "
        f"error 阈值 {error_limit}，SSOT：脚本 DOC_BUDGET）"
    )
    if total > error_limit:
        emit(result, 'DOC-005', total=total, limit=error_limit)
    elif total > warn_limit:
        emit(result, 'DOC-004', total=total, limit=warn_limit)


# ---------------------------------------------------------------------------
# policy append 执行（append = 代码执行面，须显式授权）
# ---------------------------------------------------------------------------
def run_policy_appends(root, result, append_allowed=True):
    if not POLICY.append:
        return
    if not append_allowed:
        emit(result, 'APP-002')
        return
    for item in POLICY.append:
        script_path = (root / item['script']).resolve()
        if not script_path.exists():
            emit(result, 'APP-001', script=item['script'], reason='脚本不存在')
            continue
        try:
            proc = subprocess.run(
                [sys.executable, str(script_path), str(root)],
                capture_output=True, text=True, timeout=60,
            )
            if proc.returncode != 0:
                emit(result, 'APP-001', script=item['script'],
                     reason=(proc.stderr or '').strip().split('\n')[0][:200])
                continue
            for line in (proc.stdout or '').split('\n'):
                line = line.strip()
                if not line:
                    continue
                parts = line.split('|', 2)
                if len(parts) != 3 or parts[0] not in VALID_SEVERITIES:
                    result.errors.append(
                        f"[{item['id']}][error] append 脚本输出格式非法（须 SEVERITY|ID|message）: {line[:120]}")
                    continue
                sev, cid, msg = parts
                out = f"[{cid}][{sev}] {msg}"
                if sev == 'error':
                    result.errors.append(out)
                elif sev == 'warn':
                    result.warnings.append(out)
                else:
                    result.infos.append(out)
        except Exception as e:
            emit(result, 'APP-001', script=item['script'], reason=str(e)[:200])


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
def validate_target(target_path, policy_path=None, skip_path_check=False,
                    trust_append=False):
    global POLICY
    if policy_path:
        POLICY = Policy()
        load_policy(policy_path)

    target_dir = Path(target_path).resolve()
    result = ValidationResult()

    if not target_dir.exists():
        emit(result, 'LOC-002', path=str(target_dir))
        return result
    if not target_dir.is_dir():
        emit(result, 'LOC-003', path=str(target_dir))
        return result

    pcv = PLATFORM_CONTRACT_VERSION
    result.infos.append(
        f"[CONTRACT] dsh 平台契约快照 {pcv['contract_version']}（最近巡检 {pcv['last_inspected']}）："
        f"bundle 形态 {pcv['bundle_shape']}；层序 {pcv['layers']}；官方规范 {pcv['spec_url']}")

    if not (target_dir / 'package.json').exists():
        emit(result, 'DET-001')
        return result

    try:
        pkg = json.loads((target_dir / 'package.json').read_text(encoding='utf-8'))
    except json.JSONDecodeError as e:
        emit(result, 'PKG-001', reason=f'非法 JSON: {e}')
        return result
    if not isinstance(pkg, dict):
        emit(result, 'PKG-001', reason='顶层必须是对象')
        return result

    patch_rel = validate_pkg(target_dir, pkg, result)
    dsh = pkg.get('dsh')
    is_bundle = isinstance(dsh, dict) and isinstance(dsh.get('bundle'), dict)
    if is_bundle and patch_rel:
        validate_patch_file(target_dir, patch_rel, result)
    if is_bundle:
        validate_dev_overlay(target_dir, result)
    validate_entry_ts(target_dir, pkg, result)
    validate_tools(target_dir, result)
    validate_config(target_dir, result)
    validate_deps(target_dir, pkg, result)
    validate_docs_dsh(target_dir, result)
    validate_doc_budget(target_dir, result)
    scan_placeholders(target_dir, result)
    scan_security(target_dir, result)
    # append 脚本来自被校验包，属代码执行面：就地校验（--skip-path-check，
    # 典型为第三方包）时默认禁用，须显式 --trust-append。
    run_policy_appends(target_dir, result,
                       append_allowed=(trust_append or not skip_path_check))

    return result


def main():
    args = sys.argv[1:]
    if '--policy-help' in args:
        print_policy_help()

    policy_path = None
    skip_path = False
    trust_append = False
    positional = []
    i = 0
    while i < len(args):
        if args[i] == '--policy':
            if i + 1 >= len(args):
                print("❌ --policy 需要文件参数")
                sys.exit(2)
            policy_path = args[i + 1]
            i += 2
        elif args[i] == '--skip-path-check':
            skip_path = True
            i += 1
        elif args[i] == '--trust-append':
            trust_append = True
            i += 1
        elif args[i] in ('-h', '--help'):
            print(__doc__)
            sys.exit(0)
        else:
            positional.append(args[i])
            i += 1

    if len(positional) != 1:
        print("Usage: python3 validate_plugin.py <path/to/plugin-dir> "
              "[--policy <file>] [--skip-path-check] [--trust-append]")
        print("\nExample:")
        print("  python3 validate_plugin.py plugins/my-dsh-plugin")
        print("  python3 validate_plugin.py /tmp/third-party-pkg --skip-path-check")
        print("\n  python3 validate_plugin.py --policy-help   # policy 文件格式")
        sys.exit(2)

    target_path = positional[0]
    print(f"🔍 Validating target: {target_path}\n")

    try:
        result = validate_target(target_path, policy_path=policy_path,
                                 skip_path_check=skip_path, trust_append=trust_append)
    except PolicyError as e:
        print(f"❌ policy 拒绝加载: {e}")
        sys.exit(2)

    print(result.summary())
    sys.exit(0 if result.is_valid else 1)


if __name__ == "__main__":
    main()

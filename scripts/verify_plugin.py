#!/usr/bin/env python3
"""
DSH Plugin Runtime Verifier - orchestrates the L2-L5 runtime verification
matrix and emits evidence JSON (see references/qa-playbook.md).

STATUS: not ready — ships at milestone M2.
Until then, follow references/qa-playbook.md manually and record results
honestly; never claim runtime evidence this script has not produced.

Exit codes: 2 = milestone not ready (unavailable).
"""

import json
import sys

MILESTONE = 'M2'


def main():
    print(json.dumps({
        'status': 'unavailable',
        'script': 'verify_plugin.py',
        'milestone': MILESTONE,
        'reason': '运行时验证矩阵（L2-L5）尚未实现；当前仅有 L1 静态校验'
                  '（validate_plugin.py）可用。',
        'honest_substitute': '按 references/qa-playbook.md 手工执行对应层级'
                             '并如实记录证据，不得冒充已自动化。',
    }, ensure_ascii=False, indent=2))
    sys.exit(2)


if __name__ == '__main__':
    main()

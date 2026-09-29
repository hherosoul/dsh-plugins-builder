#!/usr/bin/env python3
"""
DSH Plugin Packager - validate -> build -> pack -> post-pack acceptance
([E] five-layer cleanliness + [F] install-based verification), reusing
validate_plugin.py. See references/delivery-playbook.md.

STATUS: not ready — ships at milestone M2.
Until then, execute the delivery playbook steps manually and record the
outcome truthfully; "packable" is not "shippable" without [E]+[F].

Exit codes: 2 = milestone not ready (unavailable).
"""

import json
import sys

MILESTONE = 'M2'


def main():
    print(json.dumps({
        'status': 'unavailable',
        'script': 'package_plugin.py',
        'milestone': MILESTONE,
        'reason': '打包与打包后验收（[E] 干净度 + [F] 安装式）尚未实现。',
        'honest_substitute': '按 references/delivery-playbook.md 手工执行'
                             '三通道分发与验收步骤并如实记录。',
    }, ensure_ascii=False, indent=2))
    sys.exit(2)


if __name__ == '__main__':
    main()

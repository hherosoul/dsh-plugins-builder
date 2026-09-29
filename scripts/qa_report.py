#!/usr/bin/env python3
"""
DSH Plugin QA Report Aggregator - aggregates machine-readable case results
and runtime evidence into QA-REPORT.md. Judgments belong to the LLM; this
script only aggregates (see references/qa-playbook.md, 9 dimensions).

STATUS: not ready — ships at milestone M3.

Exit codes: 2 = milestone not ready (unavailable).
"""

import json
import sys

MILESTONE = 'M3'


def main():
    print(json.dumps({
        'status': 'unavailable',
        'script': 'qa_report.py',
        'milestone': MILESTONE,
        'reason': 'QA 报告聚合尚未实现；判定归 LLM，脚本只聚合。',
        'honest_substitute': '按 references/qa-playbook.md 的 9 维度手工演练'
                             '并填写用例表，报告末尾强制「未覆盖项」段。',
    }, ensure_ascii=False, indent=2))
    sys.exit(2)


if __name__ == '__main__':
    main()

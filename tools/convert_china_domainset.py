#!/usr/bin/env python3
from pathlib import Path

repo_root = Path(__file__).resolve().parent.parent
source = repo_root / "rules" / "China.list"
domain_set_output = repo_root / "rules" / "ChinaDomainSet.list"
keyword_output = repo_root / "rules" / "ChinaKeyword.list"


def append_unique(items: list[str], seen: set[str], value: str) -> None:
    if value and value not in seen:
        seen.add(value)
        items.append(value)


domain_set: list[str] = []
keywords: list[str] = []
unsupported: list[str] = []

domain_seen: set[str] = set()
keyword_seen: set[str] = set()

for raw_line in source.read_text(encoding="utf-8-sig").splitlines():
    line = raw_line.strip()

    if not line or line.startswith("#"):
        continue

    # 去除 Surge 规则常见的行尾注释。
    line = line.split(" //", 1)[0].strip()

    try:
        rule_type, value = (
            part.strip() for part in line.split(",", 1)
        )
    except ValueError:
        unsupported.append(line)
        continue

    if rule_type == "DOMAIN-SUFFIX":
        append_unique(
            domain_set,
            domain_seen,
            "." + value.lstrip("."),
        )

    elif rule_type == "DOMAIN":
        append_unique(
            domain_set,
            domain_seen,
            value,
        )

    elif rule_type == "DOMAIN-KEYWORD":
        append_unique(
            keywords,
            keyword_seen,
            f"DOMAIN-KEYWORD,{value}",
        )

    else:
        unsupported.append(line)

if unsupported:
    details = "\n".join(
        f"  - {line}" for line in unsupported
    )
    raise SystemExit(
        f"发现无法转换的规则，已停止写入：\n{details}"
    )

domain_set_output.write_text(
    "\n".join(domain_set) + "\n",
    encoding="utf-8",
)

keyword_output.write_text(
    "\n".join(keywords) + "\n",
    encoding="utf-8",
)

print(
    f"已生成："
    f"{domain_set_output.relative_to(repo_root)}，"
    f"{len(domain_set)} 条"
)

print(
    f"已生成："
    f"{keyword_output.relative_to(repo_root)}，"
    f"{len(keywords)} 条"
)
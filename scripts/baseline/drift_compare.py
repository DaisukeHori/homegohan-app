#!/usr/bin/env python3
"""#1243 ドリフト調査: 本番カタログと「migration が定義する認可状態」のカタログを比較する。

使い方:
    python3 scripts/baseline/drift_compare.py <本番カタログ dir> <再適用後カタログ dir> <migrations dir>

通常は scripts/baseline/drift_report.sh から呼ばれる。結果を JSON で標準出力に書く。

分類:
    prod_only       本番にだけある (migration ファイルのどれにも定義されていない)
    migration_only  migration が定義しているのに本番に無い
    different       両方にあるが定義が違う
対象: public スキーマの RLS ポリシー / 関数 (SECURITY DEFINER・search_path・EXECUTE 権限) /
      テーブルの RLS 有効状態と GRANT
"""

from __future__ import annotations

import csv
import json
import pathlib
import re
import sys

FUNC_DEF = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:\"?public\"?\.)?\"?([A-Za-z_][A-Za-z0-9_]*)\"?\s*\(",
    re.IGNORECASE,
)


def load(directory: pathlib.Path, name: str, key: tuple[str, ...]) -> dict[tuple[str, ...], dict[str, str]]:
    with open(directory / name, encoding="utf-8", newline="") as fh:
        return {tuple(row[k] for k in key): row for row in csv.DictReader(fh)}


def norm_acl(value: str) -> list[str]:
    return sorted(item.strip() for item in value.strip("{}").split(",") if item.strip())


def acl_roles(value: str, priv: str) -> list[str]:
    """aclitem 配列から、priv を持つ grantee (PUBLIC は 'PUBLIC') を返す。"""
    roles = []
    for item in norm_acl(value):
        grantee, _, rest = item.partition("=")
        privs = rest.split("/")[0]
        if priv in privs:
            roles.append(grantee or "PUBLIC")
    return sorted(roles)


def migration_function_names(migrations: pathlib.Path) -> dict[str, list[str]]:
    names: dict[str, list[str]] = {}
    for path in sorted(migrations.glob("*.sql")):
        for m in FUNC_DEF.finditer(path.read_text(encoding="utf-8")):
            names.setdefault(m.group(1).lower(), []).append(path.name)
    return names


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    prod, mig, migrations = (pathlib.Path(a) for a in argv)
    result: dict[str, dict[str, list]] = {}

    # --- RLS ポリシー (public) ---
    p = {k: v for k, v in load(prod, "catalog_policies.csv", ("schemaname", "tablename", "policyname")).items() if k[0] == "public"}
    m = {k: v for k, v in load(mig, "catalog_policies.csv", ("schemaname", "tablename", "policyname")).items() if k[0] == "public"}
    fields = ("permissive", "roles", "cmd", "qual", "with_check")
    result["policies"] = {
        "prod_only": [{"table": k[1], "policy": k[2], **{f: p[k][f] for f in fields}} for k in sorted(set(p) - set(m))],
        "migration_only": [{"table": k[1], "policy": k[2], **{f: m[k][f] for f in fields}} for k in sorted(set(m) - set(p))],
        "different": [
            {
                "table": k[1],
                "policy": k[2],
                "diff": {f: {"prod": p[k][f], "migration": m[k][f]} for f in fields if p[k][f] != m[k][f]},
            }
            for k in sorted(set(p) & set(m))
            if any(p[k][f] != m[k][f] for f in fields)
        ],
    }

    # --- 関数 (public) ---
    defined = migration_function_names(migrations)
    p = load(prod, "catalog_functions.csv", ("schema", "name", "identity_args"))
    m = load(mig, "catalog_functions.csv", ("schema", "name", "identity_args"))
    funcs: dict[str, list] = {"prod_only": [], "migration_only": [], "different": []}
    for k in sorted(set(p) | set(m)):
        name = k[1].lower()
        if k not in m:
            # ベースライン (本番) には全関数があるため、再適用後に無い = migration が DROP したまま
            funcs["prod_only"].append(
                {
                    "function": f"{k[1]}({k[2]})",
                    "security_definer": p[k]["security_definer"],
                    "execute": acl_roles(p[k]["acl"], "X"),
                    "note": "migration の再適用で DROP される (本番には残っている)",
                }
            )
            continue
        if k not in p:
            funcs["migration_only"].append(
                {
                    "function": f"{k[1]}({k[2]})",
                    "security_definer": m[k]["security_definer"],
                    "execute": acl_roles(m[k]["acl"], "X"),
                    "defined_in": defined.get(name, []),
                }
            )
            continue
        if name not in defined:
            funcs["prod_only"].append(
                {
                    "function": f"{k[1]}({k[2]})",
                    "security_definer": p[k]["security_definer"],
                    "execute": acl_roles(p[k]["acl"], "X"),
                    "note": "どの migration にも CREATE FUNCTION が無い",
                }
            )
            continue
        diff = {}
        for f in ("security_definer", "config"):
            if p[k][f] != m[k][f]:
                diff[f] = {"prod": p[k][f], "migration": m[k][f]}
        pe, me = acl_roles(p[k]["acl"], "X"), acl_roles(m[k]["acl"], "X")
        if pe != me:
            diff["execute"] = {"prod": pe, "migration": me}
        if diff:
            funcs["different"].append({"function": f"{k[1]}({k[2]})", "security_definer": p[k]["security_definer"], "diff": diff})
    result["functions"] = funcs

    # --- テーブル (public) ---
    p = {k: v for k, v in load(prod, "catalog_tables.csv", ("schema", "name")).items() if k[0] == "public"}
    m = {k: v for k, v in load(mig, "catalog_tables.csv", ("schema", "name")).items() if k[0] == "public"}
    tables: dict[str, list] = {"rls_different": [], "grant_different": [], "prod_only": [], "migration_only": []}
    for k in sorted(set(p) - set(m)):
        tables["prod_only"].append({"table": k[1], "kind": p[k]["kind"]})
    for k in sorted(set(m) - set(p)):
        tables["migration_only"].append({"table": k[1], "kind": m[k]["kind"]})
    for k in sorted(set(p) & set(m)):
        if p[k]["kind"] in ("r", "p"):
            if (p[k]["rls_enabled"], p[k]["rls_forced"]) != (m[k]["rls_enabled"], m[k]["rls_forced"]):
                tables["rls_different"].append(
                    {"table": k[1], "prod": p[k]["rls_enabled"], "migration": m[k]["rls_enabled"]}
                )
        for role in ("anon", "authenticated"):
            pr = next((i.split("=")[1].split("/")[0] for i in norm_acl(p[k]["acl"]) if i.startswith(role + "=")), "")
            mr = next((i.split("=")[1].split("/")[0] for i in norm_acl(m[k]["acl"]) if i.startswith(role + "=")), "")
            if pr != mr:
                tables["grant_different"].append({"table": k[1], "role": role, "prod": pr, "migration": mr})
    result["tables"] = tables

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""prod-schema-snapshot の artifact から supabase/baseline/ を組み立てる。

使い方:
    python3 scripts/baseline/build_baseline.py <展開した snapshot ディレクトリ> [出力先=supabase/baseline]

生成するもの:
    prod_schema.sql          本番スキーマ (supabase db dump の出力をそのまま)
    prod_storage.sql         storage バケット設定と storage.objects のポリシー (カタログから生成)
    prod_reference_data.sql  マスタテーブルのデータ (pg_dump の psql 専用行を除去)
    prod_ledger.txt          取得時点の本番 migration 台帳 (supabase migration list)
    manifest.json            取得日時・台帳の最大 version など

ベースラインは scripts/supabase-local.sh がローカル / CI の最初の migration として使う。
本番の migration 台帳とは無関係 (本番には一切適用しない)。
"""

from __future__ import annotations

import csv
import hashlib
import json
import pathlib
import re
import shutil
import sys


def parse_ledger(text: str) -> tuple[list[str], list[str], list[str]]:
    """supabase migration list の出力を (paired, local_only, remote_only) に分ける。

    CLI の出力は `| Local | Remote | Time |` 形式と、先頭・末尾の `|` が無い
    `  Local | Remote | Time` 形式の両方があり得るため、`|` で分割して判定する。
    """
    paired: list[str] = []
    local_only: list[str] = []
    remote_only: list[str] = []
    for raw in text.splitlines():
        if "|" not in raw:
            continue
        cols = [c.strip() for c in raw.strip().strip("|").split("|")]
        if len(cols) < 2:
            continue
        local, remote = cols[0], cols[1]
        if not (re.fullmatch(r"[0-9]*", local) and re.fullmatch(r"[0-9]*", remote)):
            continue
        if local and remote:
            paired.append(remote)
        elif local:
            local_only.append(local)
        elif remote:
            remote_only.append(remote)
    return paired, local_only, remote_only


def sql_literal(value: str | None) -> str:
    if value is None or value == "":
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def build_storage_sql(snapshot: pathlib.Path) -> str:
    lines = [
        "-- storage バケット設定と storage.objects のポリシー (本番カタログから生成)",
        "-- storage スキーマは supabase db dump の対象外のため、カタログ (pg_policies /",
        "-- storage.buckets) から再構成している。",
        "",
    ]
    with open(snapshot / "storage_buckets.csv", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            mimes = row["allowed_mime_types"]
            mime_sql = (
                "ARRAY[" + ", ".join(sql_literal(m) for m in mimes.split(",")) + "]::text[]"
                if mimes
                else "NULL"
            )
            size = row["file_size_limit"] or "NULL"
            public = "true" if row["public"] in ("t", "true") else "false"
            lines.append(
                "INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) "
                f"VALUES ({sql_literal(row['id'])}, {sql_literal(row['name'])}, {public}, {size}, {mime_sql}) "
                "ON CONFLICT (id) DO NOTHING;"
            )
    lines.append("")

    with open(snapshot / "catalog_policies.csv", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            if row["schemaname"] != "storage":
                continue
            table = f"storage.{quote_ident(row['tablename'])}"
            name = quote_ident(row["policyname"])
            roles = ", ".join(
                "PUBLIC" if r == "public" else quote_ident(r) for r in row["roles"].split(",") if r
            )
            stmt = f"CREATE POLICY {name} ON {table} AS {row['permissive']} FOR {row['cmd']} TO {roles}"
            if row["qual"]:
                stmt += f"\n  USING ({row['qual']})"
            if row["with_check"]:
                stmt += f"\n  WITH CHECK ({row['with_check']})"
            lines.append(f"DROP POLICY IF EXISTS {name} ON {table};")
            lines.append(stmt + ";")
            lines.append("")
    return "\n".join(lines) + "\n"


ACL_ITEM = re.compile(r'^(?P<grantee>"(?:[^"]|"")*"|[^=]*)=(?P<privs>[A-Za-z*]*)/(?P<grantor>.+)$')
API_ROLES = ("anon", "authenticated", "service_role")


def parse_acl(acl: str) -> list[tuple[str, str]]:
    """'{=X/postgres,anon=X/postgres}' を [(grantee, privs)] に分解する (grantee '' は PUBLIC)。"""
    items = []
    body = acl.strip()
    if not body:
        return items
    for item in body.strip("{}").split(","):
        m = ACL_ITEM.match(item.strip())
        if not m:
            raise ValueError(f"aclitem を解釈できません: {item!r}")
        grantee = m.group("grantee")
        if grantee.startswith('"'):
            grantee = grantee[1:-1].replace('""', '"')
        items.append((grantee, m.group("privs")))
    return items


def build_function_acl_sql(snapshot: pathlib.Path) -> str:
    """public スキーマの関数の EXECUTE 権限を本番と完全に一致させる SQL を作る。

    pg_dump の権限出力は「組み込みの既定 ACL (所有者 + PUBLIC)」からの差分しか出さないため、
    ローカルでは Supabase の ALTER DEFAULT PRIVILEGES により作成時に anon / authenticated /
    service_role へ自動付与された EXECUTE が残る (本番で REVOKE 済みの権限が復活する)。
    権限の回帰テストを本番どおりに判定できるよう、関数ごとに API ロールの権限を一度外し、
    本番の ACL にあるものだけを付け直す。
    """
    lines = [
        "-- public スキーマの関数の EXECUTE 権限を本番 (pg_proc.proacl) と一致させる",
        "-- pg_dump の権限出力だけでは Supabase の既定権限 (anon 等への自動付与) が残るため。",
        "-- 引数の型名は public 前提で書かれている (直前の prod_schema.sql が search_path を空にするため戻す)",
        "SELECT pg_catalog.set_config('search_path', 'public, extensions', false);",
        "",
    ]
    with open(snapshot / "catalog_functions.csv", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            signature = f"public.{quote_ident(row['name'])}({row['identity_args']})"
            acl = row["acl"]
            if acl:
                grants = [g for g, privs in parse_acl(acl) if "X" in privs]
            else:
                # proacl が NULL = 組み込みの既定 (所有者 + PUBLIC に EXECUTE)
                grants = [""]
            lines.append(f"REVOKE ALL ON ROUTINE {signature} FROM PUBLIC, {', '.join(API_ROLES)};")
            for grantee in grants:
                if grantee == "":
                    lines.append(f"GRANT EXECUTE ON ROUTINE {signature} TO PUBLIC;")
                elif grantee in API_ROLES:
                    lines.append(f"GRANT EXECUTE ON ROUTINE {signature} TO {quote_ident(grantee)};")
                # 所有者 (postgres 等) は暗黙に実行できるため付け直さない
    return "\n".join(lines) + "\n"


# aclitem の権限文字 → GRANT のキーワード (テーブル / ビュー)
TABLE_PRIVILEGES = {
    "r": "SELECT",
    "a": "INSERT",
    "w": "UPDATE",
    "d": "DELETE",
    "D": "TRUNCATE",
    "x": "REFERENCES",
    "t": "TRIGGER",
    "m": "MAINTAIN",
}
COLUMN_GRANT = re.compile(
    r'^GRANT (?P<privs>[A-Z ,]+)\((?P<cols>"[^"]+"(?:,\s*"[^"]+")*)\) ON TABLE "public"\."(?P<table>[^"]+)" TO "(?P<role>[^"]+)";$',
    re.M,
)


def build_table_acl_sql(snapshot: pathlib.Path) -> str:
    """public スキーマのテーブル / ビューの権限を本番 (pg_class.relacl) と完全に一致させる SQL を作る。

    関数と同じ理由で、pg_dump の権限出力だけでは Supabase の ALTER DEFAULT PRIVILEGES により
    作成時に anon / authenticated / service_role へ自動付与された権限が残る
    (例: #1232 の family_promotion_requests は本番で anon / authenticated のテーブル権限を外しているが、
    ローカルでは復活してしまい、列単位 GRANT で隠している token 列まで読めてしまう)。
    テーブルごとに API ロールの権限を一度外して本番の ACL にあるものだけを付け直し、
    最後に本番の列単位 GRANT (pg_dump の出力) を付け直す
    (テーブル単位の REVOKE は列単位の権限も一緒に外すため)。
    """
    lines = [
        "-- public スキーマのテーブル / ビューの権限を本番 (pg_class.relacl) と一致させる",
        "-- pg_dump の権限出力だけでは Supabase の既定権限 (anon 等への自動付与) が残るため。",
        "",
    ]
    with open(snapshot / "catalog_tables.csv", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            if row["schema"] != "public":
                continue
            relation = f"public.{quote_ident(row['name'])}"
            lines.append(f"REVOKE ALL ON TABLE {relation} FROM PUBLIC, {', '.join(API_ROLES)};")
            for grantee, privs in parse_acl(row["acl"] or ""):
                if grantee not in ("",) + API_ROLES:
                    continue  # 所有者 (postgres 等) と Supabase 内部ロールは触らない
                plain = [TABLE_PRIVILEGES[p] for i, p in enumerate(privs)
                         if p in TABLE_PRIVILEGES and not privs[i + 1:i + 2] == "*"]
                with_option = [TABLE_PRIVILEGES[p] for i, p in enumerate(privs)
                               if p in TABLE_PRIVILEGES and privs[i + 1:i + 2] == "*"]
                target = "PUBLIC" if grantee == "" else quote_ident(grantee)
                if plain:
                    lines.append(f"GRANT {', '.join(plain)} ON TABLE {relation} TO {target};")
                if with_option:
                    lines.append(f"GRANT {', '.join(with_option)} ON TABLE {relation} TO {target} WITH GRANT OPTION;")
    column_grants = [
        m.group(0)
        for m in COLUMN_GRANT.finditer((snapshot / "prod_schema.sql").read_text(encoding="utf-8"))
        if m.group("role") in API_ROLES
    ]
    if column_grants:
        lines.append("")
        lines.append("-- 本番の列単位 GRANT (上のテーブル単位の REVOKE で外れたものを付け直す)")
        lines.extend(column_grants)
    return "\n".join(lines) + "\n"


PSQL_META = re.compile(r"^\\(?:un)?restrict \S+$")


def clean_pg_dump(text: str) -> str:
    """pg_dump の出力から、CLI の migration 実行で通らない psql 専用行を除く。

    複数行にまたがる文字列値を壊さないよう、除去するのは pg_dump が出力する
    `\\restrict <key>` / `\\unrestrict <key>` 行と `SET transaction_timeout` 行だけ。
    """
    out = []
    for line in text.splitlines():
        if PSQL_META.match(line):
            continue
        if line.startswith("SET transaction_timeout"):
            continue
        out.append(line)
    return "\n".join(out) + "\n"


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    snapshot = pathlib.Path(argv[0])
    out = pathlib.Path(argv[1] if len(argv) > 1 else "supabase/baseline")
    out.mkdir(parents=True, exist_ok=True)

    shutil.copyfile(snapshot / "prod_schema.sql", out / "prod_schema.sql")
    (out / "prod_function_acl.sql").write_text(build_function_acl_sql(snapshot), encoding="utf-8")
    (out / "prod_table_acl.sql").write_text(build_table_acl_sql(snapshot), encoding="utf-8")
    (out / "prod_storage.sql").write_text(build_storage_sql(snapshot), encoding="utf-8")
    (out / "prod_reference_data.sql").write_text(
        clean_pg_dump((snapshot / "prod_reference_data.sql").read_text(encoding="utf-8")),
        encoding="utf-8",
    )
    ledger_text = (snapshot / "migration_list.txt").read_text(encoding="utf-8")
    (out / "prod_ledger.txt").write_text(ledger_text, encoding="utf-8")

    # 本番カタログ (verify_baseline.py でローカルとの一致確認に使う)
    catalog_dir = out / "catalog"
    catalog_dir.mkdir(exist_ok=True)
    for csv_path in sorted(snapshot.glob("*.csv")):
        shutil.copyfile(csv_path, catalog_dir / csv_path.name)

    paired, local_only, remote_only = parse_ledger(ledger_text)
    remote_versions = paired + remote_only
    if not remote_versions:
        print("migration 台帳を解析できませんでした", file=sys.stderr)
        return 1

    src_manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
    manifest = {
        "captured_at": src_manifest.get("captured_at"),
        "source": "production (read-only snapshot by .github/workflows/prod-schema-snapshot.yml)",
        "snapshot_git_sha": src_manifest.get("git_sha"),
        "supabase_cli": src_manifest.get("supabase_cli"),
        "postgres_version": src_manifest.get("postgres_version"),
        "ledger_max_version": max(remote_versions),
        "ledger_count": len(remote_versions),
        "ledger_local_only": local_only,
        "ledger_remote_only": remote_only,
        "reference_tables": src_manifest.get("reference_tables", []),
        "files": {
            name: sha256(out / name)
            for name in (
                "prod_schema.sql",
                "prod_function_acl.sql",
                "prod_table_acl.sql",
                "prod_storage.sql",
                "prod_reference_data.sql",
                "prod_ledger.txt",
            )
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: manifest[k] for k in ("captured_at", "ledger_max_version", "ledger_count")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

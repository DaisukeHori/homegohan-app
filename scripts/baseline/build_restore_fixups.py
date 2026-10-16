#!/usr/bin/env python3
"""DB バックアップ (docs/design/cross/17-backup-automation.md) の書庫に入れる補いの SQL (fixups.sql) を作る。

使い方:
    python3 scripts/baseline/build_restore_fixups.py <カタログ dir> <schema.sql> <出力ファイル>

<カタログ dir> は scripts/baseline/snapshot_catalog.sql の出力 (CSV)、<schema.sql> は supabase db dump の schema の出力。
出力 = build_baseline.py の build_function_acl_sql・build_table_acl_sql・build_storage_sql の出力をこの順につないだもの
(ローカルのベースラインが prod_function_acl.sql・prod_table_acl.sql・prod_storage.sql で補うのと同じ中身) に、
auth・storage の表のアプリのトリガーを作り直す SQL (build_app_trigger_sql。アプリのトリガーが無ければ空) を続けたもの。
<カタログ dir> にはファイルを足さない。終了コード: 0 成功 / 1 失敗 / 2 引数の誤り。
同じディレクトリの build_baseline を import するので、-I (isolated) を付けずに動かす。
"""

from __future__ import annotations

import csv
import pathlib
import re
import sys
import tempfile

from build_baseline import build_function_acl_sql, build_storage_sql, build_table_acl_sql, quote_ident

# build_table_acl_sql が列単位の GRANT を読むファイルの名前 (build_baseline.py の中の名前に合わせる)
SCHEMA_FILE_NAME = "prod_schema.sql"
# 3 つの関数が読む CSV (snapshot_catalog.sql の出力の一部)
CATALOG_INPUTS = ("catalog_functions.csv", "catalog_tables.csv", "catalog_policies.csv", "storage_buckets.csv")
# auth・storage の表に付いたトリガー (snapshot_catalog.sql の出力の 1 つ)。schema の dump は auth・storage のスキーマを除くので、
# アプリのトリガー (#1757 の auth.sessions の 3 本と auth.users の 1 本など) は dump を流しても戻らない (§3.3 の (6))
TRIGGERS_CSV = "catalog_auth_storage_triggers.csv"
TRIGGER_CSV_COLUMNS = ("schema", "table_name", "trigger_name", "definition")
# Supabase のサービス (Storage・Auth) が自分のスキーマの関数で作る内部のトリガーの関数のスキーマ。内部のトリガーはスタックが作るので補わない。
# pg_get_triggerdef は search_path で見えない関数だけをスキーマつきで書き、auth・storage は postgres の search_path に無いので、
# 内部のトリガーの関数はいつも `storage.` / `auth.` つきで出る。scripts/lib/backup-db.mjs の INTERNAL_TRIGGER_FUNCTION_SCHEMAS と同じ値
INTERNAL_TRIGGER_FUNCTION_SCHEMAS = ("auth", "storage")
# pg_get_triggerdef の定義。1 = 実行する関数の名前 (スキーマつきか無し)。scripts/lib/backup-db.mjs の TRIGGER_DEFINITION_PATTERN と同じ式
TRIGGER_DEFINITION_PATTERN = re.compile(
    r'^CREATE (?:CONSTRAINT )?TRIGGER .* EXECUTE (?:FUNCTION|PROCEDURE) ((?:"(?:[^"]|"")+"|[^".\s(]+)(?:\.(?:"(?:[^"]|"")+"|[^".\s(]+))?)\(',
    re.S,
)
QUALIFIED_NAME_PART = re.compile(r'"((?:[^"]|"")+)"|([^".]+)')
# トリガーの定義の関数の名前 (スキーマ無し) を解決する search_path。取得 (postgres の "$user", public, extensions) と同じ関数が見え、
# 直前の build_function_acl_sql の出力 (prod_function_acl.sql の冒頭) が置くのと同じ値
TRIGGER_SEARCH_PATH = "public, extensions"
# 作り直しの DO の本文を囲む dollar quote の目印 (定義・名前にこれが現れたら本文が途中で閉じるので、作らずに失敗にする)
TRIGGER_DO_TAG = "$restore_trigger$"
ARG_COUNT = 3
FAILURE_EXIT_CODE = 1
USAGE_EXIT_CODE = 2


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def trigger_function_schema(definition: str) -> str | None:
    """定義の関数のスキーマ (名前にスキーマが無ければ None)。定義の形が違えば ValueError (中身は出さない)"""
    m = TRIGGER_DEFINITION_PATTERN.match(definition)
    if not m:
        raise ValueError("trigger definition")
    parts = [a.replace('""', '"') if a else b for a, b in QUALIFIED_NAME_PART.findall(m.group(1))]
    return parts[0] if len(parts) == 2 else None


def is_app_trigger(definition: str) -> bool:
    schema = trigger_function_schema(definition)
    return schema is None or schema not in INTERNAL_TRIGGER_FUNCTION_SCHEMAS


def build_app_trigger_sql(catalog_dir: pathlib.Path) -> str:
    """auth・storage の表のアプリのトリガーを、無いときだけ取得の時点の定義で作る SQL (1 本 1 つの DO)。

    流すのは schema.sql と data.sql の後 (data を入れる間はトリガーが動かない)。§4.8 の 2 の reset (DROP SCHEMA "public" CASCADE) が
    public の関数に依るトリガーを巻き込んで消すので、ここで作り直す。同じ名前があれば作らない (定義の差は復元の検査が見つける)。
    表が無ければ CREATE TRIGGER が失敗し、ON_ERROR_STOP で復元ごと落ちる。アプリのトリガーが無ければ空の文字列
    """
    with open(catalog_dir / TRIGGERS_CSV, encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        if tuple(reader.fieldnames or ()) != TRIGGER_CSV_COLUMNS:
            raise ValueError("trigger columns")
        rows = [row for row in reader if is_app_trigger(row["definition"])]
    if not rows:
        return ""
    lines = [
        "-- auth・storage の表のアプリのトリガー (schema の dump に入らない。取得の時点の pg_get_triggerdef の定義で、無いときだけ作る)",
        f"SELECT pg_catalog.set_config('search_path', {sql_text(TRIGGER_SEARCH_PATH)}, false);",
    ]
    for row in rows:
        if any(TRIGGER_DO_TAG in row[column] for column in TRIGGER_CSV_COLUMNS):
            raise ValueError("trigger do tag")
        relation = f"{quote_ident(row['schema'])}.{quote_ident(row['table_name'])}"
        lines.append(
            f"DO {TRIGGER_DO_TAG} BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t "
            f"WHERE t.tgrelid = {sql_text(relation)}::pg_catalog.regclass AND t.tgname = {sql_text(row['trigger_name'])} "
            f"AND NOT t.tgisinternal) THEN EXECUTE {sql_text(row['definition'])}; END IF; END {TRIGGER_DO_TAG};"
        )
    return "\n".join(lines) + "\n"


def build(catalog_dir: pathlib.Path, schema_file: pathlib.Path) -> str:
    """一時ディレクトリに CSV と prod_schema.sql (= schema_file) のシンボリックリンクを置いて 3 つの関数を呼び、アプリのトリガーの SQL を続ける"""
    with tempfile.TemporaryDirectory() as tmp:
        work = pathlib.Path(tmp)
        for name in CATALOG_INPUTS:
            (work / name).symlink_to((catalog_dir / name).resolve())
        (work / SCHEMA_FILE_NAME).symlink_to(schema_file.resolve())
        acl_and_storage = build_function_acl_sql(work) + build_table_acl_sql(work) + build_storage_sql(work)
    return acl_and_storage + build_app_trigger_sql(catalog_dir)


def main(argv: list[str]) -> int:
    if len(argv) != ARG_COUNT:
        print(__doc__, file=sys.stderr)
        return USAGE_EXIT_CODE
    catalog_dir, schema_file, out = (pathlib.Path(arg) for arg in argv)
    try:
        text = build(catalog_dir, schema_file)
    except (OSError, ValueError, KeyError) as error:
        # 中身 (カタログの値) は出さず、例外の種類だけ
        print(f"build_restore_fixups: {type(error).__name__}", file=sys.stderr)
        return FAILURE_EXIT_CODE
    out.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

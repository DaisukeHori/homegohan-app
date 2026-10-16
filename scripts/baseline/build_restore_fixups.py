#!/usr/bin/env python3
"""DB バックアップ (docs/design/cross/17-backup-automation.md) の書庫に入れる補いの SQL (fixups.sql) を作る。

使い方:
    python3 scripts/baseline/build_restore_fixups.py <カタログ dir> <schema.sql> <出力ファイル>

<カタログ dir> は scripts/baseline/snapshot_catalog.sql の出力 (CSV)、<schema.sql> は supabase db dump の schema の出力。
出力 = build_baseline.py の build_function_acl_sql・build_table_acl_sql・build_storage_sql の出力をこの順につないだもの
(ローカルのベースラインが prod_function_acl.sql・prod_table_acl.sql・prod_storage.sql で補うのと同じ中身)。
<カタログ dir> にはファイルを足さない。終了コード: 0 成功 / 1 失敗 / 2 引数の誤り。
同じディレクトリの build_baseline を import するので、-I (isolated) を付けずに動かす。
"""

from __future__ import annotations

import pathlib
import sys
import tempfile

from build_baseline import build_function_acl_sql, build_storage_sql, build_table_acl_sql

# build_table_acl_sql が列単位の GRANT を読むファイルの名前 (build_baseline.py の中の名前に合わせる)
SCHEMA_FILE_NAME = "prod_schema.sql"
# 3 つの関数が読む CSV (snapshot_catalog.sql の出力の一部)
CATALOG_INPUTS = ("catalog_functions.csv", "catalog_tables.csv", "catalog_policies.csv", "storage_buckets.csv")
ARG_COUNT = 3
FAILURE_EXIT_CODE = 1
USAGE_EXIT_CODE = 2


def build(catalog_dir: pathlib.Path, schema_file: pathlib.Path) -> str:
    """一時ディレクトリに CSV と prod_schema.sql (= schema_file) のシンボリックリンクを置いて 3 つの関数を呼ぶ"""
    with tempfile.TemporaryDirectory() as tmp:
        work = pathlib.Path(tmp)
        for name in CATALOG_INPUTS:
            (work / name).symlink_to((catalog_dir / name).resolve())
        (work / SCHEMA_FILE_NAME).symlink_to(schema_file.resolve())
        return build_function_acl_sql(work) + build_table_acl_sql(work) + build_storage_sql(work)


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

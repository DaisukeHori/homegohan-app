#!/usr/bin/env python3
"""ローカルのベースライン DB が本番カタログと一致するかを確認する。

使い方:
    python3 scripts/baseline/verify_baseline.py <本番カタログ dir> <ローカルカタログ dir>

両ディレクトリには scripts/baseline/snapshot_catalog.sql の出力 CSV が入っている前提。
通常は `bash scripts/supabase-local.sh verify` から呼ばれる。

判定:
    - 不一致 (終了コード 1): public スキーマのテーブル / 関数 / ポリシーの過不足、
      RLS 有効状態・テーブル GRANT・関数の SECURITY DEFINER / 設定 / 所有者 / EXECUTE 権限の差、
      storage のポリシー・バケットの過不足
    - 警告のみ: ポリシー式の文字列差 (再解析で型キャストの書き方が変わるだけのことがある)、
      Supabase 内部スキーマ (storage の内部テーブル、realtime のパーティション等) の差
"""

from __future__ import annotations

import csv
import pathlib
import sys

APP_SCHEMAS = {"public"}


def load(directory: pathlib.Path, name: str, key: tuple[str, ...]) -> dict[tuple[str, ...], dict[str, str]]:
    with open(directory / name, encoding="utf-8", newline="") as fh:
        return {tuple(row[k] for k in key): row for row in csv.DictReader(fh)}


def norm_acl(value: str) -> tuple[str, ...]:
    return tuple(sorted(item.strip() for item in value.strip("{}").split(",") if item.strip()))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    prod_dir, local_dir = pathlib.Path(argv[0]), pathlib.Path(argv[1])
    errors: list[str] = []
    warnings: list[str] = []

    # テーブル / ビュー
    p = load(prod_dir, "catalog_tables.csv", ("schema", "name"))
    l = load(local_dir, "catalog_tables.csv", ("schema", "name"))
    for key in sorted(set(p) | set(l)):
        target = errors if key[0] in APP_SCHEMAS else warnings
        if key not in l:
            target.append(f"table missing locally: {key}")
        elif key not in p:
            target.append(f"table only local: {key}")
        else:
            for col in ("kind", "rls_enabled", "rls_forced"):
                if p[key][col] != l[key][col]:
                    target.append(f"table {key} {col}: prod={p[key][col]} local={l[key][col]}")
            if norm_acl(p[key]["acl"]) != norm_acl(l[key]["acl"]):
                target.append(f"table {key} acl: prod={p[key]['acl']} local={l[key]['acl']}")

    # 関数
    p = load(prod_dir, "catalog_functions.csv", ("schema", "name", "identity_args"))
    l = load(local_dir, "catalog_functions.csv", ("schema", "name", "identity_args"))
    for key in sorted(set(p) | set(l)):
        if key not in l:
            errors.append(f"function missing locally: {key}")
        elif key not in p:
            errors.append(f"function only local: {key}")
        else:
            for col in ("security_definer", "volatile", "config", "owner", "kind"):
                if p[key][col] != l[key][col]:
                    errors.append(f"function {key} {col}: prod={p[key][col]} local={l[key][col]}")
            if norm_acl(p[key]["acl"]) != norm_acl(l[key]["acl"]):
                errors.append(f"function {key} acl: prod={p[key]['acl']} local={l[key]['acl']}")

    # ポリシー
    p = load(prod_dir, "catalog_policies.csv", ("schemaname", "tablename", "policyname"))
    l = load(local_dir, "catalog_policies.csv", ("schemaname", "tablename", "policyname"))
    for key in sorted(set(p) | set(l)):
        target = errors if key[0] in APP_SCHEMAS | {"storage"} else warnings
        if key not in l:
            target.append(f"policy missing locally: {key}")
        elif key not in p:
            target.append(f"policy only local: {key}")
        else:
            for col in ("permissive", "roles", "cmd"):
                if p[key][col] != l[key][col]:
                    target.append(f"policy {key} {col}: prod={p[key][col]} local={l[key][col]}")
            for col in ("qual", "with_check"):
                if p[key][col] != l[key][col]:
                    warnings.append(f"policy {key} {col} text differs (再解析による表記差の可能性)")

    # storage バケット
    p = load(prod_dir, "storage_buckets.csv", ("id",))
    l = load(local_dir, "storage_buckets.csv", ("id",))
    for key in sorted(set(p) ^ set(l)):
        errors.append(f"bucket mismatch: {key}")
    for key in sorted(set(p) & set(l)):
        if p[key] != l[key]:
            errors.append(f"bucket {key} differs: prod={p[key]} local={l[key]}")

    for line in warnings:
        print(f"[warn] {line}")
    for line in errors:
        print(f"[error] {line}")
    print(f"[verify] errors={len(errors)} warnings={len(warnings)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

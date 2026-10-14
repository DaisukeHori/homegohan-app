#!/usr/bin/env python3
"""supabase/migrations を「本番スキーマのベースライン + 空のプレースホルダ」に統合する (#1116)。

背景:
  supabase/migrations は空の DB から頭から流しても再現できなかった。user_profiles や organizations などの
  基盤テーブルを作る migration が無く (ダッシュボード等で作られた)、10 本目の 20260102000002 で止まる。
  そのため CI の `supabase db diff --linked` (空のシャドウ DB に全 migration を流してから本番と比べる) が
  毎回失敗し、PR の deploy ジョブが赤くなっていた。

やること (本番には一切触れない):
  - 台帳 (supabase_migrations.schema_migrations) の最大 version 以下の migration を対象にする。
    対象の version は全て本番で適用済みで、`supabase db push` は version しか見ないため、ファイルの中身を
    書き換えても本番では何も実行されない (drift guard も version だけを比べる)。
  - 対象のうち最も古い version のファイルに、supabase/baseline/ の本番スキーマ一式
    (scripts/supabase-local.sh がベースラインとして組み立てるものと同じ順序) を入れる。
  - それ以外の対象ファイルは、統合済みであることを書いたプレースホルダにする。
  - 台帳の最大 version より新しい migration (まだ本番に無いもの) は触らない。
  結果、空の DB に全 migration を流すと「ベースライン (= 取得時点の本番) + 新しい migration」になる。

使い方:
  python3 scripts/baseline/squash_migrations.py [リポジトリのルート] [統合前のコミット]
  - 統合前のコミット: プレースホルダに「元の中身はこのコミットの履歴を参照」と書くための値 (省略時は HEAD)
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys

BASELINE_PARTS = (
    "prod_schema.sql",
    "prod_function_acl.sql",
    "prod_table_acl.sql",
    "prod_storage.sql",
    "prod_reference_data.sql",
)
# 空の DB に流したときに本番と表記まで一致させるための作り直し (統合した migration の末尾にだけ入れる)
REPLAY_FIXUPS = "replay_fixups.sql"
VERSION_RE = re.compile(r"^(\d{14})_.+\.sql$")


def main(argv: list[str]) -> int:
    root = pathlib.Path(argv[0] if argv else ".").resolve()
    base_commit = argv[1] if len(argv) > 1 else subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()
    baseline_dir = root / "supabase" / "baseline"
    mig_dir = root / "supabase" / "migrations"
    manifest = json.loads((baseline_dir / "manifest.json").read_text(encoding="utf-8"))
    ledger_max = manifest["ledger_max_version"]

    targets = sorted(
        p for p in mig_dir.glob("*.sql")
        if (m := VERSION_RE.match(p.name)) and m.group(1) <= ledger_max
    )
    if not targets:
        print("統合の対象がありません", file=sys.stderr)
        return 1
    if len(targets) != manifest["ledger_count"]:
        print(
            f"対象の migration ({len(targets)} 本) と台帳の件数 ({manifest['ledger_count']} 本) が合いません。"
            "ベースラインを取り直してから実行してください",
            file=sys.stderr,
        )
        return 1

    baseline_file = targets[0]
    header = f"""-- migration: {baseline_file.name}
-- #1116: 本番スキーマのベースライン (migration の統合)
--
-- このファイルには、本番スキーマ一式 (supabase/baseline/ の {', '.join(BASELINE_PARTS)}) を入れ、
-- 最後に {REPLAY_FIXUPS} (流し直しで表記が変わるものを本番と同じ形で作り直す) を入れている。
--   取得: {manifest['captured_at']} (prod-schema-snapshot.yml による読み取り専用のスナップショット)
--   本番の migration 台帳の最大 version: {ledger_max} ({manifest['ledger_count']} 本)
-- 台帳の最大 version 以下の migration ({len(targets)} 本) はここに統合し、ほかのファイルはプレースホルダにした。
-- 統合前の中身は git の履歴 (コミット {base_commit} 以前) を参照。
--
-- 本番への影響はない: 統合した version は全て本番で適用済み (台帳に記録済み) で、`supabase db push` は
-- version しか見ないため、このファイルが本番で実行されることはない。空の DB (ローカル・CI・
-- `supabase db diff` のシャドウ DB) に流したときだけ実行され、取得時点の本番と同じスキーマになる。
-- このファイルは scripts/baseline/squash_migrations.py が生成した。手で編集しないこと。
"""
    parts = [header]
    for part in (*BASELINE_PARTS, REPLAY_FIXUPS):
        parts.append(f"\n-- ===== supabase/baseline/{part} =====\n")
        parts.append((baseline_dir / part).read_text(encoding="utf-8"))
    # pg_dump 由来の SET (search_path='' 等) が後続の migration に残らないようにする
    parts.append("\nRESET ALL;\n")
    baseline_file.write_text("".join(parts), encoding="utf-8")

    for path in targets[1:]:
        path.write_text(
            f"""-- migration: {path.name}
-- #1116: この version の中身は {baseline_file.name} (本番スキーマのベースライン) に統合した。
-- 本番では適用済み (台帳に記録済み) のため、本番でこのファイルが実行されることはない。
-- 空の DB に流すときも、変更はベースラインに含まれているため何もしない。
-- 統合前の中身は git の履歴 (コミット {base_commit} 以前) を参照。
SELECT 1;
""",
            encoding="utf-8",
        )

    print(json.dumps({
        "baseline_file": baseline_file.name,
        "placeholders": len(targets) - 1,
        "ledger_max_version": ledger_max,
        "untouched_newer": len([p for p in mig_dir.glob("*.sql") if p not in targets]),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

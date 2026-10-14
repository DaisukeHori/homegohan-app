# supabase/baseline — ローカル / CI 専用の本番スキーマ・ベースライン

ローカルと CI では、本番スキーマのスナップショットを出発点にして、まだ本番に入っていない migration だけを上に積む。

かつて `supabase/migrations/` は空の DB から頭から流しても再現できなかった（`user_profiles` や `organizations` などの基盤テーブルを作る migration が無く、10 本目の `20260102000002` で止まる。#1116）。
#1116 で、台帳の最大 version（`20261007112200`）以下の migration を、最も古いファイル `20251126124224_create_meal_planner_tables.sql` にこのディレクトリの本番スキーマ一式として統合した（`scripts/baseline/squash_migrations.py`。ほかはプレースホルダ）。
いまは空の DB にリポジトリの migration を流しても、取得時点の本番と同じスキーマになる（ローカルで `verify_baseline.py` と比較し、エラー 0 件を確認済み）。CI の `supabase db diff --linked` もこれで動く。

- **本番には一切適用しない。** 本番の migration 台帳（`supabase_migrations.schema_migrations`）とも無関係。
- ローカル / CI の組み立ては `scripts/supabase-local.sh` が行う（作業ディレクトリ `.supabase-local/`、git 管理外）。
- スキーマ変更は従来どおり `supabase/migrations/` に `supabase migration new` で追加し、PR → main マージ → CI で本番に反映する。

## 使い方

```bash
bash scripts/supabase-local.sh start            # 起動 (ベースライン + 本番台帳より新しい migration)
bash scripts/supabase-local.sh env .env.local   # アプリ / integration テスト用の接続情報を書き出す
bash scripts/supabase-local.sh reset            # migration を追加・変更したら適用し直す (= db reset)
bash scripts/supabase-local.sh stop
```

ローカル専用の設定（project_id・認証のレート制限の緩和）と Kong の再起動対策は `scripts/supabase-local.sh` が入れるため、リポジトリの `supabase/` に対して `supabase db reset` を直接実行せず、`scripts/supabase-local.sh reset` を使う。

**ベースラインを取り直しても、統合（squash）はやり直さない。** 統合は 1 回限りで、以後の migration は通常どおり新しいファイルとして積む。取り直したベースラインは `verify` とドリフト調査に使う。

## ファイル

| ファイル | 内容 |
|---|---|
| `prod_schema.sql` | 本番スキーマ（`supabase db dump --linked` の出力。Supabase 管理スキーマを除く） |
| `prod_function_acl.sql` | public の関数の EXECUTE 権限を本番と一致させる SQL（下記「忠実度」参照） |
| `prod_table_acl.sql` | public のテーブル / ビューの権限（列単位の GRANT を含む）を本番と一致させる SQL（同上） |
| `prod_storage.sql` | storage バケット設定と `storage.objects` のポリシー（dump の対象外のためカタログから再構成） |
| `prod_reference_data.sql` | マスタテーブルのデータ（`subscription_plans` / `feature_packages` / `badges` / `sport_presets`） |
| `replay_fixups.sql` | #1116 で統合した migration の末尾にだけ入れる作り直し。dump を流し直すと表記が変わるもの（varchar の `IN (...)` の CHECK 制約・ポリシーのロールの並び等）を本番と同じ形で作り直し、`db diff` を空にする。ローカルの組み立てには使わない |
| `prod_ledger.txt` | 取得時点の本番 migration 台帳 |
| `catalog/*.csv` | 取得時点の本番カタログ（ポリシー・関数の権限・RLS 有効状態・バケット等）。`verify` と #1243 のドリフト調査に使う |
| `manifest.json` | 取得日時、台帳の最大 version（＝ベースラインに含まれる最後の migration）、各ファイルの sha256 |
| `refresh-request.txt` | これを変更した PR でスナップショット取得ワークフローが走る |

`scripts/supabase-local.sh` は `manifest.json` の `ledger_max_version` より新しい version の migration だけを適用する。
ベースライン取得後に本番へ反映された migration は、ベースラインを取り直すまではローカルで「新しい migration」として上に積まれる（結果は同じ）。

## 取り直し方

1. `refresh-request.txt` の日付と理由を更新した PR を出す（main マージ後は Actions から `Prod Schema Snapshot (read-only)` を手動実行してもよい）。
   `.github/workflows/prod-schema-snapshot.yml` が本番を **読み取り専用** で照会し、artifact `prod-schema-snapshot`（1 日保持）に保存する。
2. artifact を取得して展開し、ベースラインを生成する:
   ```bash
   gh run download <run-id> -n prod-schema-snapshot -D /tmp/snapshot
   python3 scripts/baseline/build_baseline.py /tmp/snapshot supabase/baseline
   ```
3. 本番と一致することを確認する（ベースラインだけを適用した DB のカタログを本番カタログと比較する）:
   ```bash
   bash scripts/supabase-local.sh verify   # errors=0 であること。終わったら reset で戻す
   ```
4. 差分を目視で確認してから commit する（public リポジトリのため、秘密情報が入っていないことを必ず確認する）。

## 忠実度（2026-10-06 取得分の確認結果）

`verify` で本番カタログと比較し、次が一致することを確認済み。

- RLS ポリシー 254 本（public 245 / storage 7 / cron 2）の有無・コマンド・対象ロール
- public の関数 80 本の SECURITY DEFINER・volatility・`search_path` 設定・所有者・EXECUTE 権限
- public のテーブル / ビューの有無・RLS 有効状態・GRANT
- storage バケット 3 件

既知の差（いずれも警告扱い）:

- ポリシー式の文字列が 1 件だけ表記違い（`subscription_plans_select_public`。再解析で型キャストの書き方が変わるだけで意味は同じ）
- storage の内部テーブル（`iceberg_*` / `prefixes`）と GRANT の grant option 表記（ローカルの storage サービスの版による）
- realtime の内部パーティション（`messages_YYYY_MM_DD`）

**関数の権限について:** `pg_dump` の権限出力は「組み込みの既定権限（所有者 + PUBLIC）」からの差分しか出さない。
Supabase は関数の作成時に anon / authenticated / service_role へ EXECUTE を自動付与するため、dump をそのまま流すと本番で REVOKE 済みの anon 等の権限が復活する（2026-10-06 時点で 41 関数）。
権限の回帰テストを本番どおりに判定できるよう、`prod_function_acl.sql` で関数ごとに権限を付け直している。

**テーブルの権限について:** 関数と同じ理由で、本番で anon / authenticated のテーブル権限を外したテーブルも、dump をそのまま流すと権限が復活する。
2026-10-07 取得分では `family_promotion_requests`（#1232。token 列を列単位 GRANT で隠している）がこれに当たり、`verify` が不一致を検出した。
`prod_table_acl.sql` でテーブルごとに API ロールの権限を本番の `relacl` どおりに付け直し、最後に本番の列単位 GRANT を付け直している（テーブル単位の REVOKE は列単位の権限も外すため）。

## 秘密情報の扱い

- スキーマとカタログ、上記マスタテーブルのデータのみを取得する。ユーザーデータは取得しない。
- スナップショットは `scripts/baseline/redact_secrets.py` で秘密情報らしき文字列（JWT、API キー、接続文字列のパスワード等）をマスクしてから artifact に保存する。2026-10-06 取得分の検出は 0 件。

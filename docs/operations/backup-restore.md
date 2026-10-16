# DB バックアップの取得と復元の手順書 (#1129 / #1191)

本番の Supabase (DB) の論理バックアップを、毎日、GitHub Actions が取って Cloudflare R2 に暗号化して置きます。この手順書は、その初回の設定・日々の確認・復元・訓練の記録・困ったときの手順です。

- 設計の正典は `docs/design/cross/17-backup-automation.md` です。食い違ったら設計書が正です。
- 値 (R2 の鍵・age の秘密鍵・DB の接続先) は、この手順書にも Issue にもリポジトリにも書きません。名前だけを書きます。
- 道具の使い方は `node scripts/backup-db.mjs help` でも見られます。

## 1. 全体像

```
GitHub Actions「DB Backup」(.github/workflows/db-backup.yml。毎日 02:23 JST、または手で実行)
  本番を読んでダンプ (roles / schema / data) → 戻らないものを足す (権限・storage のポリシー・台帳・cron のジョブ・カタログ)
  → tar | zstd → age (公開鍵) で暗号化 → R2 の daily/ に 3 ファイル
  → 月曜は weekly/、1 月 1 日は annual/ にも同じ 3 ファイル
  → 月曜と 1 月 1 日は、ローカルの Supabase に復元して数・カタログ・台帳・cron を確かめる
  → 結果を admin_audit_logs に backup.<層>.<結果> で残す。失敗したら Issue「【自動】DB バックアップの失敗」

Vercel Cron (14:37 JST)  /api/cron/backup-freshness  … 最新の取得が 30 時間より古ければ運用メール
運営の画面  /super-admin/backups  … 取得の状態と DR 訓練の記録 (super_admin だけ)
```

| 層 | 取る日 | R2 の置き場 | 残す期間 |
|---|---|---|---|
| daily | 毎日 | `daily/<日付>/` | 30 日 |
| weekly | 月曜 (JST) | `weekly/<日付>/` | 366 日 (30 日後に Infrequent Access) |
| annual | 1 月 1 日 (JST) | `annual/<年>/` | 2,557 日 = 7 年 (30 日後に Infrequent Access) |

- 1 回の取得は 3 ファイルです: `<base>.tar.zst.age` (暗号化した書庫)・`<base>.sha256` (書庫の SHA-256)・`<base>.manifest.json` (中身の数・台帳・cron のジョブの数などの記録)。
- 書庫を開くと 7 つが入っています: `roles.sql`・`schema.sql`・`data.sql`・`fixups.sql` (ダンプを流しても戻らない関数・表・列の権限と storage のポリシーを取得の時点に戻す)・`cron_jobs.sql` (取得の時点の本番の cron のジョブの定義)・`ledger.txt` (migration の台帳の版の一覧)・`catalog/` (取得の時点の権限・ポリシー・バケットなどの一覧)。
- 暗号化は公開鍵だけで行うので、GitHub には復号できる鍵がありません。秘密鍵を持つのはオーナーだけです。
- R2 の bucket lock で、保持の期間は上書きも削除もできません。`.sha256` も lock の下にあるので、改ざんの検出の正はそれです。
- 範囲の外: Supabase Storage のファイル (写真) は DB のダンプに入らないので、この手順では戻りません。Auth の設定 (Site URL・プロバイダ・SMTP) も DB の外にあり、戻りません (6 章で手で作り直します)。
- Supabase が Pro でない間 (PITR が無い間) の目安は、RPO 24 時間・RTO 目標 4 時間 (保証はしません)。

## 2. 初回の設定 (オーナー)

最初の取得の前に、次を上から順に行います。登録が済むまでは、毎日の取得は `not_configured` で止まり (DB の中身を取り出す前に止まります)、Issue が立ちます。

1. **R2 のバケットと Lifecycle・bucket lock**
   - Cloudflare の R2 にバケットを作ります。既定の名前は `homegohan-db-backups` です。
   - Lifecycle と bucket lock の設定は手で書き写さず、リポジトリの直下で次を流します。標準出力に `npx wrangler r2 bucket lifecycle set …` 1 行と `npx wrangler r2 bucket lock add …` 3 行が出ます。出た 4 行をその順に流します (`--out-dir` に Lifecycle の設定ファイルが書かれ、1 行目がそれを読みます)。日数・名前は道具が出すものが正です。この手順書には写しません。
     ```bash
     node scripts/backup-db.mjs r2-config --bucket homegohan-db-backups --out-dir "$(mktemp -d)"
     ```
   - wrangler は、オーナー自身の Cloudflare のログイン (`npx wrangler login`) で流します。次の API トークンには、Lifecycle・lock を変える権限を持たせません。
   - Lifecycle と lock の日数は同じ値から作られます。lock を後から短くできるかは R2 の文書で確かめられていない (短くするときは新しいバケットへ移す前提) ので、バケット名と出力を確かめてから流します。
2. **R2 の API トークンを 2 つ**。どちらも、このバケットだけに絞ります。
   - 取得用: Object Read & Write。作ると出る Access Key ID と Secret Access Key を、次の 4 で GitHub の secrets に入れます。
   - 復元用: Object Read only。Access Key ID と Secret Access Key をパスワードマネージャーに保管します (5 章・6 章で使います)。
   - 取得用の Read & Write のトークンは、手元に写しません。
3. **age の鍵対**。`age-keygen -o backup.key` で作ります。
   - 秘密鍵 (`backup.key`) は、パスワードマネージャーと、印刷した控え 1 通 (金庫) に保管します。**GitHub・Vercel・Supabase・リポジトリには置きません。**
   - 公開鍵 (`age1…`。`age-keygen` が表示する) は、次の 4 の variable に使います。
4. **GitHub の Actions に登録**。リポジトリの Settings → Secrets and variables → Actions で入れます。

   | 種類 | 名前 | 値 |
   |---|---|---|
   | secret | `BACKUP_R2_ACCESS_KEY_ID` | 取得用のトークンの Access Key ID |
   | secret | `BACKUP_R2_SECRET_ACCESS_KEY` | 取得用のトークンの Secret Access Key |
   | variable | `BACKUP_R2_ACCOUNT_ID` | Cloudflare のアカウント ID (R2 の画面に出る。公開してよい) |
   | variable | `BACKUP_R2_BUCKET` | バケット名 |
   | variable | `BACKUP_AGE_RECIPIENT` | age の公開鍵 (`age1…`) |

   - 本番に繋ぐための `SUPABASE_ACCESS_TOKEN`・`SUPABASE_DB_PASSWORD` は、ほかの workflow が使っている既存の secrets をそのまま使います。`GITHUB_TOKEN` などは GitHub が自動で入れます。
   - 任意の調整用の variable が 4 つあります。DB が育って時間切れになったときだけ入れます。無ければ既定です。形が違う値は `not_configured` で止まります (黙って既定に戻しません): `BACKUP_DUMP_TIMEOUT_MINUTES`・`BACKUP_UPLOAD_TIMEOUT_MINUTES`・`BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES`・`BACKUP_ZSTD_LEVEL`。
5. **最初の `workflow_dispatch` と、監査行の確認**。Actions の「DB Backup」を main で 1 回流し (4 章)、次を確かめます。
   - run が緑になっている。
   - `/super-admin/backups` の「日次」に最新の時刻・大きさ・R2 のキーが出ている (監査行 `backup.daily.completed` が書かれている)。
   - R2 の `daily/<日付>/` に 3 ファイルがある。
   - 登録前に立った Issue「【自動】DB バックアップの失敗」が閉じている。
   - 最初の月曜 (と 1 月 1 日) の取得は、復元の検査が加わる (3 章)。ここまで通ったら、5 章の復元も 1 回流して、秘密鍵で復号できることを確かめます (8 章の四半期の訓練を兼ねます)。

## 3. 日々の確認

- `/super-admin/backups` (super_admin だけ): 日次・週次・年次それぞれの最新の取得 (時刻・大きさ・R2 のキー・週次と年次は復元の検査の結果) と、日次が 30 時間以上取れていないときの「古い」のバッジ。DR 訓練の記録もここです。
- GitHub の Issue「【自動】DB バックアップの失敗」: 取得が失敗した日に立ち、次の取得が通ると閉じます。立っているときは 10 章を見ます。
- 運用メール (`OPS_ALERT_EMAIL`): 日次の取得が 30 時間より新しく取れていないとき、14:37 JST の確認で 1 通届きます (件名「DB バックアップが 30 時間以上取れていません」)。取得そのものが走っていない (schedule の停止・secrets の失効) ときは、Issue が立たないので、このメールとバッジが気づく手段です。
- GitHub の schedule は、リポジトリに 60 日間動きが無いと止まることがあります。止まったら鮮度の通知で気づき、Actions の画面から有効にし直します。

## 4. 手動で取る

Actions の「DB Backup」→ Run workflow (ブランチは main)。`tier` を選びます。

| `tier` | 取るもの |
|---|---|
| `auto` | 日付で決める (火曜なら daily、月曜なら daily と weekly、1 月 1 日なら daily と annual) |
| `daily` | daily だけ |
| `weekly` / `annual` | daily と、その層 |

```bash
gh workflow run db-backup.yml -f tier=auto
```

- **取得の run が実行中に流すときは、`tier` を `auto` にします。** 取得の run は同時に 1 本だけ (concurrency group `db-backup`) で、待っている run は新しい run に置き換えられて取り消されます。実行中に別の `tier` で流すと、待機中の schedule の run が取り消され、その日の層 (月曜の weekly など) が抜けます。`auto` なら、流した run が日付どおりの層を取ります。
- 手動の取得も、監査行・Issue・復元の検査 (月曜と 1 月 1 日だけ) は schedule の run と同じです。

## 5. 復元 (ローカル)

R2 から書庫を取り出し、ローカルの Supabase に復元して、数・カタログ・台帳・cron のジョブの数が取得の時点と合うことを確かめます。本番には触れません。四半期の訓練 (8 章) の手順でもあります。

**前提の道具**: Docker (ローカルのスタック)・Node (`.nvmrc` の版)・aws cli v2・age・zstd・tar・psql (16 以上。Mac は `brew install libpq` で入り、PATH に足す)・python3 (`scripts/supabase-local.sh` と `scripts/baseline/verify_baseline.py` が使う)。

**手元のシェルの環境変数** (R2 の 4 つ。値はパスワードマネージャーから。手順書・Issue・リポジトリには書かない):

| 名前 | 値 |
|---|---|
| `BACKUP_R2_ACCOUNT_ID` | GitHub の variable と同じ値 |
| `BACKUP_R2_BUCKET` | GitHub の variable と同じ値 |
| `BACKUP_R2_ACCESS_KEY_ID` | 復元用 (Object Read only) のトークンの Access Key ID |
| `BACKUP_R2_SECRET_ACCESS_KEY` | 復元用のトークンの Secret Access Key |

4 つのどれかが無いと、道具は `not_configured` で止まり (終了コード 3)、R2 にも Docker にも触れません。時間の上限を変えたいときは、同じシェルに `BACKUP_UPLOAD_TIMEOUT_MINUTES` (取り出し)・`BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES` (スタックの起動から検査まで) を置きます。

**流す** (リポジトリの直下 = main の checkout で。R2 のキーは `/super-admin/backups` の「R2 のキー」か、R2 の画面で選ぶ):

```bash
node scripts/backup-db.mjs restore --key <daily|weekly|annual>/<日付>/<base>.tar.zst.age --identity-file <age の秘密鍵のパス> --slot <枠>
```

- `--slot` は 0〜9 で、省くと 0 です。手元で `scripts/local-ci.sh` が使っている枠を避けます。
- 道具は、取り出す → SHA-256 を `.sha256` と突き合わせる → 復号 → 展開 → ローカルのスタックを起こして復元 → 数・カタログ・台帳・cron の数を確かめる、の順に進みます。平文は終わると消します。
- 成功すると「復元できました」の行に、数・`catalog_errors`・`catalog_warnings`・台帳の版の数・cron のジョブの数が出ます。見るのは次です。
  - 数が合っている (道具が書庫の manifest と突き合わせて、合わなければ止まります)。
  - `[verify] errors=0` (warnings は storage の内部の表などの既知の差。`supabase/baseline/README.md` の「忠実度」)。
  - 台帳の版の数・cron のジョブの数が manifest の数と同じ。
- 失敗すると、段 (`download`・`checksum`・`decrypt`・`extract`・`restore_env`・`restore`・`restore_check`) と reason が出て、終了コード 1 で終わります。10 章を見ます。
- 復元したスタックは止めません (続けて smoke を流すため)。

```bash
npm run test:smoke -- --base-url=http://localhost:3000
```

- 終わったら `LOCAL_CI_SLOT=<restore に渡した枠> bash scripts/supabase-local.sh stop` で止めます (枠 0 なら `LOCAL_CI_SLOT` は省けます)。止め忘れると、その枠を使う `scripts/local-ci.sh` が `slot:ports` の赤で止まります。

## 6. 復元 (新しい Supabase プロジェクト)

年次の訓練と、本番の障害のときの手順です。どの手順も、前の手順の結果を確かめてから進みます。手元のシェルには 5 章の R2 の 4 つを置いておきます。以降の作業は、手元の空のディレクトリ `$WORK` (リポジトリの外) と、リポジトリの直下 (main の checkout) を行き来します。

**(1) 書庫を取り出す。** `$WORK` で、3 ファイルをそれぞれ取り、SHA-256 を確かめ、復号して展開します (中身は 1 章の 7 つ)。

```bash
WORK="$(mktemp -d)" && cd "$WORK"
KEY_BASE='<daily|weekly|annual>/<日付>/<base>'   # 5 章と同じキーから .tar.zst.age を除いたもの
for suffix in .tar.zst.age .sha256 .manifest.json; do
  env -u AWS_SESSION_TOKEN -u AWS_PROFILE AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required aws s3 cp "s3://$BACKUP_R2_BUCKET/${KEY_BASE}${suffix}" . --endpoint-url "https://$BACKUP_R2_ACCOUNT_ID.r2.cloudflarestorage.com" --region auto
done
sha256sum -c <base>.sha256          # Mac は shasum -a 256 -c <base>.sha256
age -d -i <age の秘密鍵のパス> <base>.tar.zst.age | zstd -d | tar -x
```

- `env -u …` は、手元のシェルにある別の AWS の一時鍵・プロファイルが混ざって署名が合わなくなるのを防ぎます。2 つの `…CHECKSUM…` は、aws cli 2.23 以降が付ける CRC のヘッダーを R2 が受け付けないことがあるためです (取得の workflow と同じ打ち方)。
- `sha256sum -c` が `OK` でなければ、先へ進みません。

**(2) 新しいプロジェクトを作り、リンクする。** Supabase の画面で新しいプロジェクトを作ります。リポジトリの直下 (main の checkout) で `supabase link --project-ref <新しい ref>` を流し、`supabase/.temp/project-ref` が新しい ref であることを確かめます (以後の手順は link 先に書くので、本番に向いていないことを先に見ます)。接続先は環境変数 `NEW_DB_URL` に置きます (新しいプロジェクトの Connection string。パスワードを含む秘密です。このシェルにだけ置き、手順書・Issue・GitHub・Vercel には書きません)。

**(3) 流す。** `$WORK` で、次の 3 つをこの順に流します (Supabase の backup-restore の手順と同じです)。

```bash
cd "$WORK"
psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=0 -v VERBOSITY=sqlstate --file roles.sql
psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file schema.sql --command "SET session_replication_role = replica" --file data.sql
psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file fixups.sql
```

- 1 つ目 (roles): すでにあるロールの SQLSTATE `42710` は許します。ほかの SQLSTATE のエラーが出たら止まって調べます。
- 2 つ目 (schema と data): 1 回の取引で、どこかで失敗すれば全体が戻ります。
- 3 つ目 (fixups): 関数・表・列の権限と storage のポリシーを取得の時点に戻します。流さないと、Supabase の既定の権限で anon が REVOKE 済みの関数を呼べたり、storage のポリシーが無かったりします。

**(4) 確かめる。** 別の空のディレクトリで、復元した DB のカタログを取り、書庫の `catalog/` と比べます。

```bash
CHECKOUT="$PWD"                      # リポジトリの直下で
RESTORED_CATALOG="$(mktemp -d)"
(cd "$RESTORED_CATALOG" && psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --file "$CHECKOUT/scripts/baseline/snapshot_catalog.sql")
python3 scripts/baseline/verify_baseline.py "$WORK/catalog" "$RESTORED_CATALOG"
```

- `snapshot_catalog.sql` はカレントディレクトリに CSV を書くので、空のディレクトリで流します。
- `verify_baseline.py` の最後の行が `[verify] errors=0` であること。warnings は storage の内部の表などの既知の差です (`supabase/baseline/README.md` の「忠実度」)。errors が出たら先へ進まず、行を読んで調べます。
- あわせて、manifest (`$WORK/<base>.manifest.json`) の `dumped` の `auth_users` (利用者の数) と `audit_rows` (監査行の数) が、復元した DB の数と合っていることを見ます (公開テーブルの過不足は `verify_baseline.py` が見ます)。
  ```bash
  psql "$NEW_DB_URL" -X -q -At -c "SELECT count(*) FROM auth.users" -c "SELECT count(*) FROM public.admin_audit_logs"
  ```

**(5) 台帳を戻す。** migration の台帳が空のままだと、`deploy-supabase-migrations.yml` が全部のファイルを新しい migration として扱い、統合版の最初の migration (本番スキーマ一式) から流そうとして、復元した DB の上では落ちます。書庫の版の一覧で台帳を戻します (リポジトリの直下で)。

```bash
npx --yes supabase@2.62.10 migration repair --status applied $(cat "$WORK/ledger.txt") --linked
npx --yes supabase@2.62.10 migration list --linked
```

- CLI は DB のパスワードを聞きます (環境変数 `SUPABASE_DB_PASSWORD` に新しいプロジェクトのものを置いてもかまいません)。
- 版ごとの `supabase/migrations/` のファイルが要ります。ファイルの無い版があると止まります (取得の時点の復元の検査が先に見ています)。
- `migration list --linked` で、全部の版が Local と Remote の両方にあること。`deploy-supabase-migrations.yml` は、台帳の最大より新しいファイルだけを `db push` します。

**(6) 残りを作り直す。** 本番の障害のとき (新しいプロジェクトが本番になる) と、訓練とで分かれるものがあります。

- Vault の `app_cron_secret` と `pii_hmac_key` を作り直します (HMAC の照合は新しい鍵では合いません)。
- Auth の設定 (Site URL・リダイレクト URL・プロバイダ・SMTP) を入れます。DB の外にあり、バックアップに入りません。
- Edge Function secrets と Vercel の環境変数を、新しいプロジェクトの値に差し替えます。
- **本番の障害のときだけ**: 本番の project ref (`flmeolcfutuwwbjmzyoz`) を参照する workflow・スクリプトと、Edge Function の URL を本文に持つ DB の関数 (`supabase/migrations` の 5 ファイル) を `git grep flmeolcfutuwwbjmzyoz` で洗い、新しい ref に替える PR を出します。関数は `CREATE OR REPLACE` の migration にし、(5) で戻した台帳の次として `deploy-supabase-migrations.yml` で出します。訓練では替えません。
- **cron のジョブ**: 書庫の `cron_jobs.sql` は、取得の時点の本番の `cron.job` の定義です (manifest の `cron_jobs` の本数。2026-10-16 は 15 本)。migration に登録の SQL が無い `catalog-import-*` の 5 本と `handson-tour-sandbox-cleanup` も入っています。最後の行が、流した先の `cron.job` の名前の集合を書庫の集合と比べ、違えば例外で全体が戻ります (0 で終われば全部そろった、ということです)。
  - 本番の障害のとき:
    ```bash
    cd "$WORK"
    psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file cron_jobs.sql
    ```
  - 年次の訓練のとき (本番が生きている)。確定させません。訓練の DB の関数は本番の Edge Function の URL を持つので、ジョブを動かすと本番を呼びます。0 で終わることだけを確かめます。
    ```bash
    cd "$WORK"
    psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --command "BEGIN" --file cron_jobs.sql --command "ROLLBACK"
    ```
- 動作の確認: `/api/health?deep=1` が 200 を返すこと → smoke (`npm run test:smoke -- --base-url=<新しい環境の URL>`) が終了 0。
- Storage のファイル (写真) は戻りません。

## 7. 復元点より後の退会

復元は取得の時点の DB に戻すので、取得より後に退会した利用者は、機械では再現できません。`gdpr_deletion_requests` の記録は id の HMAC で、復元先が同じプロジェクト (Vault の `pii_hmac_key` が残る) なら照合できますが、新しいプロジェクトでは鍵がありません。影響の期間は最長 24 時間 (RPO) です。

- 復元の後に、復元点以降の退会の問い合わせがあれば、**再度の退会で応じます**。
- 退会した利用者の行は、daily 30 日・weekly 366 日・annual 7 年のあいだ暗号化したバックアップに残ります。復元以外の目的で開きません。開けるのは age の秘密鍵を持つオーナーだけです (R2 のトークンだけでは読めません)。

## 8. 訓練の予定と記録

予定は設計書 `docs/design/cross/07-dr-backup.md` §7 のとおりです。どの訓練も、終わったら画面 `/super-admin/backups` の「DR 訓練を記録」で、1 回に 1 行を記録します (super_admin)。成功以外 (`failed`・`skipped`) は、メモに理由を書きます。

**各訓練の頭に置くチェックリスト**
- [ ] 前提の道具 (5 章) がそろっている
- [ ] age の秘密鍵と、復元用の R2 のトークンの所在を確かめた (2 章)
- [ ] 終わったら、この画面に記録するところまでやる

| 訓練 | 時期 | 流すもの | 記録の kind・environment |
|---|---|---|---|
| 月次 PITR 復元テスト | 毎月の第 1 月曜 | 下の (1) | `monthly_pitr`・`staging` |
| 四半期のフル復元 | 四半期ごと | 5 章 | `quarterly_restore`・`local` |
| 年次の訓練 | 年 1 回 | 6 章 | `annual_drill`・`new_project` |

**(1) 月次 PITR 復元テスト。**
- Pro でない間 (PITR が無い間): Supabase の画面でプランが Pro でない (PITR が無い) ことを確かめ、次で記録します。kind `monthly_pitr`・result `skipped`・environment `staging`・restored_to・backup_key・rto_minutes は空・smoke `not_run`・notes に `plan_not_pro`。毎月これを残します。
- Pro + PITR の後: 設計書 07 §7.1 の 1〜3 を流します。Supabase の画面で復元点を選んで staging のプロジェクトに復元 → `curl -s "<staging の URL>/api/health?deep=1"` が 200 → `npm run test:smoke -- --base-url=<staging の URL>` が終了 0。**本番のプロジェクトには復元しません。** 記録は kind `monthly_pitr`・result (smoke まで通れば `success`、どこかで止まれば `failed` にして止まった手順を notes に)・environment `staging`・restored_to = 選んだ復元点・backup_key は空・rto_minutes = 復元を始めてから smoke が通るまでの分・smoke = `test:smoke` の結果。

**(2) 四半期のフル復元。** 5 章を流し、kind `quarterly_restore`・environment `local`・backup_key (成功なら必須。使った R2 のキー)・rto_minutes・smoke で記録します。age の秘密鍵で復号できることの確認を兼ねます。

**(3) 年次の訓練。** 6 章を流し、kind `annual_drill`・environment `new_project` で記録します。cron のジョブは確定させず、ロールバックする打ち方 (6 章の訓練のとき) で確かめます。

## 9. 鍵の入れ替え・R2 トークンの入れ替え・secrets の失効

- **age の鍵を入れ替える**: 新しい鍵対を `age-keygen` で作り (2 章の 3)、GitHub の variable `BACKUP_AGE_RECIPIENT` を新しい公開鍵に替えます。次の取得から新しい鍵で暗号化されます。**古い秘密鍵は、その鍵で暗号化した最後の対象物の保持が切れるまで捨てません** (annual は 7 年)。どの鍵で暗号化したかは、各対象物の manifest の `age_recipient` で辿れます。入れ替えの後は `workflow_dispatch` を 1 回流して、緑になることと、新しい対象物を 5 章で復号できることを確かめます。
- **R2 のトークンを入れ替える** (期限・退職・漏れの疑い): Cloudflare で新しいトークンを作り (取得用と復元用それぞれ。このバケットだけに絞る)、GitHub の secrets `BACKUP_R2_ACCESS_KEY_ID`・`BACKUP_R2_SECRET_ACCESS_KEY` と、パスワードマネージャーの復元用を替えます。`workflow_dispatch` が緑になってから、古いトークンを Cloudflare で失効させます。トークンが漏れても、bucket lock のために保持の期間の対象物は消せず・上書きできず、age の秘密鍵が無ければ読めません。
- **本番に繋ぐ secrets の失効** (`SUPABASE_ACCESS_TOKEN`・`SUPABASE_DB_PASSWORD`): 失効すると取得は `link_failed` で止まります。DB に繋げないので監査行は書けず、Issue が立ち、日次が 30 時間を超えると鮮度のメールが届きます。新しい値を GitHub の secrets に入れ、`workflow_dispatch` で取り直します。
- **age の秘密鍵を失くした**: その鍵で暗号化した対象物は開けません。新しい鍵対に替え (最初の項)、直近の対象物がもう開けないことを前提に、取り直します。2 人目の保管者を置くか、控えを増やすかは、設計書 §21 の確認事項です。

## 10. 困ったとき

取得の失敗は、Issue「【自動】DB バックアップの失敗」の本文と、`/super-admin/backups` の取得の行の stage・reason に出ます。復元 (5 章) の失敗は、手元の標準エラー出力に出ます。

| 見えたもの | 意味と対処 |
|---|---|
| `not_configured` | 取得: GitHub の secrets / variables が足りない・形が違う (Issue の `missing` に名前だけが出ます。2 章の 4)。age の公開鍵は `age1` で始まる形。`restore`: 手元のシェルの R2 の 4 つが無い (5 章) |
| `restore` の download の `timeout` | `BACKUP_UPLOAD_TIMEOUT_MINUTES` を手元のシェルで上書きして流し直す |
| `catalog_failed` | 本番のカタログ・台帳・cron のジョブの定義を読めなかった、または python3 が落ちた。`workflow_dispatch` で取り直す |
| 月曜・1 月 1 日の `copy_failed` | 層のキーへの送り直しか、その大きさの確かめが失敗した。daily は残っている。翌週の月曜まで待つか、`workflow_dispatch` の `tier` で取り直す |
| 月曜の `restore_check_failed` (カタログ・台帳の不一致) | `catalog_errors` が 0 でない = migration の本番適用と取得が重なったか、権限の補い (`fixups.sql`) が効いていない。手元で `restore` を流して `[error]` の行を見る。`supabase/migrations/` にファイルの無い版 = 台帳のずれで、`deploy-supabase-migrations.yml` が `REMOTE_ONLY` で止めるのと同じ事故。台帳とファイルのどちらが正しいかを調べてから直す。自動では直さない |
| `dump_incomplete` | ダンプが最後まで取れていない。migration の本番適用と重なったときは `workflow_dispatch` で取り直す。毎日続くときは、supabase CLI の出力の形が設計書 §4.3 の表と変わっていないかを `roundtrip-check` (PR で動く往復の検査) で確かめる |
| Issue「結果を残さずに終わった」 | run の step が時間切れ・取り消しになり、結果ファイルが無い。時間切れなら調整用の variable (`BACKUP_DUMP_TIMEOUT_MINUTES` など。2 章の 4) を上げる |
| `restore_env_failed` | ローカルのスタックが起きない・psql / python3 が無い。ベースラインを取り直す (`supabase/baseline/README.md` の「取り直し方」) |
| `image_pull_unavailable` | Docker イメージの取得の上限に当たった。検査の赤ではない。時間をおいて `workflow_dispatch` で取り直す (`roundtrip-check` は失敗したジョブだけを流し直す)。`docs/operations/ci-supabase-image-pull.md` |
| `link_failed` | `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` の失効。9 章 |
| `checksum_mismatch` / `decrypt_failed` | `.sha256` と合わない (取り出しの途中・改ざん) / 秘密鍵が違う。別の対象物 (前後の日) で試す。鍵は 9 章 |
| 日次の「古い」のバッジ・鮮度のメール | 取得が走っていない。Actions の「DB Backup」の履歴を見る。schedule が止まっているなら Actions で有効にし直す (3 章)。secrets の失効は 9 章 |
| R2 の古い対象物が消えない・多すぎる | Lifecycle が効いていない。取得のログの inventory の数 (層ごとの対象物の数) と、R2 の Lifecycle の設定を、`node scripts/backup-db.mjs r2-config` の出力と見比べる |

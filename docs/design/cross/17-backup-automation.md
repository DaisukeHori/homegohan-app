# 長期バックアップの自動化と DR 訓練の記録 設計

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-16 | 新設 (Issue #1129・#1191 の設計ゲート・A 型 4 相) |

要件の正本は Issue #1129・#1191 の本文 (どちらもコメントは閉じたときの記録の 1 件で、要件を足していない) と、既存の設計書 `cross/07-dr-backup.md`。本書はその上で決めた範囲と設計で、Issue・07 と食い違ったら本書が正 (07 のうち本書が置き換える節は §0.4 と §20)。
ファイル名 (cross/17) は設計ゲートの指定による。

前提: ローンチ前で利用者ゼロ (正しい形で作る)。本番の DB に触らない (設計ゲートでは読むだけ。実装も本番へは migration 1 本と定期の読み取りだけ)。

---

## 0. 外形固定と分冊判定 (相 1)

### 0.1 決めること

Daily / Weekly / Annual の 3 層のうちローンチに要るもの / 実行の場所と pg_dump を流せる経路 / 保存先・暗号化・ハッシュ・保持と世代の削除・秘密の置き場・費用 / 未設定のときの動き / 個人情報と退会 / 監査の記録 (`backup.*`・`dr.test.*`) と失敗の通知 / DR 訓練の手順書と結果の記録 / テスト。Supabase の Pro への移行と PITR はオーナー作業として切り出し、本書は「Pro でない間の動き」を決める。

### 0.2 要件行列

| # | 要件 | 出どころ | 本書の節 |
|---|---|---|---|
| R-1 | Daily (日次・30 日)・Weekly (週次・1 年・冷保管)・Annual (年次・長期) の 3 層の論理バックアップを自動で取る | #1129、07 §4.1 | §3, §4.1 |
| R-2 | `pg_dump` を流せる場所で動かす (Vercel の関数では動かない根拠を実測値で持つ) | #1129、§0.1 | §3.2, §4.2 |
| R-3 | 保存先・暗号化・ハッシュ・保持期間と世代の削除・秘密の置き場・費用を決める | §0.1、07 §4.3・§9・§14 | §4.3〜§4.6, §13 |
| R-4 | 秘密 (R2 の鍵・暗号化の受け手) が未設定なら、ダンプを作らずに止めて記録する | §0.1 | §4.7, §8.3 |
| R-5 | 取ったバックアップが復元できることを機械で確かめる (生成ごとの検査 + 週次の復元)。復元した DB は、数だけでなく、dump を流しても戻らないもの (関数・表・列の権限・storage のポリシー・migration の台帳・cron のジョブの定義・auth・storage の表のアプリのトリガー) も取得の時点の本番と同じにできる | 07 §12、`supabase/baseline/README.md` の「忠実度」 | §3.3, §4.3 (catalog), §4.8, §12 の 6 章 |
| R-6 | 成功・失敗を `admin_audit_logs` に `backup.<層>.<結果>` で残す (actor は無し・target_type `database_backup`)。アプリのロール (anon / authenticated) からは RLS で UPDATE / DELETE できない表だが、RLS を越える postgres・service_role は消せるので、改ざんの検出の正は bucket lock された `.sha256`。INSERT は、既存のポリシー 2 本 (`"Admins can create audit logs"`・`audit_logs_insert_admins`) が action_type を見ないので、運営のロールの人も自分の JWT で直接書ける。読む側は action_type だけで信じず、書いた経路の印 (取得の行は actor_id NULL かつ target_type `database_backup`、訓練の行は target_type `dr_test` かつ actor が今の super_admin) で絞る。前者のポリシーは actor_id も見ないので、それが残る間は印も作れる (既存の欠陥。Issue #1736 で直す。§21) | #1129、07 §4.2 | §5, §7.1, §7.3, §10, §21 |
| R-7 | 失敗を運用に知らせる。既存の運用アラート (`OPS_ALERT_EMAIL`・`claim_ops_alert`) との関係を決める | §0.1、operator/07 §8.3 | §4.9, §7.3 |
| R-8 | 定期実行そのものが止まった (走っていない) ことに気づける | R-7 の裏 (GitHub は 60 日間 push の無い公開リポジトリの schedule を自動で止める) | §7.3 |
| R-9 | DR 訓練 (月次 PITR 復元・四半期フル復元・年次訓練) の結果を `dr.test.*` で記録する仕組み (画面 + API) と手順書 | #1191、07 §7 | §6, §7.1, §7.2, §12 |
| R-10 | Pro でない間 (PITR 無し) の RPO / RTO と、月次 PITR テストの扱いを決める | §0.1、07 §3.1・§6.1 | §9.2 |
| R-11 | 退会した利用者の行がバックアップに残る期間と、プライバシーポリシーとの整合 | §0.1、cross/08 §16、cross/15 S-11 | §9.1, §21 |
| R-12 | 単体・結合 (ローカルの Supabase で dump → 復元の往復)・機械検査 (番兵) のテスト | §0.1 | §15, §18 |
| R-13 | 設計書の正典コードに `as any`・マジックナンバーを書かない。運用で変えうる値は環境変数で上書きできる | 設計ゲートの規約 | §5 (§5.1 の「運用で変えうる値と、契約で固定する値」), §7.3 |
| R-14 | 本番の秘密 (DB パスワード・R2 の鍵) をログ・応答・コミットに出さない。公開リポジトリの Actions のログに出るのは件数と大きさだけ | CLAUDE.md、prod-schema-snapshot.yml の方針 | §4.10 |

Issue 本文との食い違い (本書を正とする): #1129 の「vercel.json の cron は process-menu-queue のみ」は古く、origin/main には `app-log-alerts` (#1157) もある。07 §4.2 のコード例は Edge Function `create-backup` から dump の本体を関数の応答で受け取る形だが、Vercel の関数の本体は 4.5 MB が上限で (§4.2)、2.4 GB の DB では成り立たない。07 §9.2 の R2 Lifecycle は `GLACIER` を使うが、R2 にそのクラスは無い (Standard と Infrequent Access の 2 つ)。いずれも本書で置き換える。

### 0.3 ユーザーシナリオ (23 本。トレースは §3.4)

| # | シナリオ |
|---|---|
| S-1 | 火曜 02:23 JST。GitHub Actions が本番をダンプし、暗号化して R2 の `daily/` に置き、`backup.daily.completed` を 1 行残す。運営の画面は「最新 02:3x・新しい」を出す |
| S-2 | 月曜。S-1 に加えて同じ日の対象物 (runner の手元の 3 ファイル) を `weekly/` にも送り、ローカルの Supabase に復元して数を確かめ、`backup.weekly.completed` も残す |
| S-3 | 1 月 1 日。S-1 (と月曜なら S-2) に加えて同じ 3 ファイルを `annual/` にも送り、`backup.annual.completed` を残す |
| S-4 | R2 の鍵や暗号化の受け手 (GitHub の secrets / variables) が未設定。DB に繋いだあと設定の検査で止まり、ダンプを作らず、`backup.daily.failed` (reason `not_configured`) を残し、Issue を立て、終了コード 3 |
| S-5 | DB パスワードが間違っている (link が失敗)。監査行は書けないので Issue だけ (段・理由は結果ファイルで report の step へ渡す)。翌日 14:37 JST の鮮度の cron が「30 時間より古い」を検知して運用メールを 1 通送る |
| S-6 | ダンプは終わったが `data.sql` が途中で切れている (pg_dump の完了行 `-- PostgreSQL database dump complete` と、CLI が最後に足す `RESET ALL;` が無い・`COPY "public".` の表が `schema.sql` の表と合わない)。送らず、`failed` (stage `verify`, reason `dump_incomplete`) を残し、Issue |
| S-7 | R2 への送信が途中で切れる。aws cli の再試行でも駄目なら `failed` (stage `upload`)。翌日の成功で Issue は自動で閉じる |
| S-8 | 同じ日に手動 (workflow_dispatch) でもう 1 回流す。ファイル名に実行時刻 (UTC) が入るので別の対象物になり、bucket lock に当たらず、監査行も 2 つ |
| S-9 | push の無い 60 日が過ぎて GitHub が schedule を止めた。Actions は何も失敗しない。鮮度の cron が 30 時間を超えた時点で運用メールを送り (日 1 回の cron の回ごとに 1 通。クールダウンは 23 時間)、画面も「古い」を出す。オーナーが Actions の画面で有効に戻す |
| S-10 | 月曜の復元の検査が失敗 (ローカルの GoTrue の版が本番より古く `COPY "auth"."users"` の列が足りない)。`daily` は completed のまま、`backup.weekly.failed` (stage `restore_check`) と Issue。対象物は消さない |
| S-11 | 四半期の訓練。オーナーが手元のシェルに R2 の 4 つ (`RESTORE_REQUIRED_ENV_NAMES`。キーは復元用の読み取り専用のトークン。§4.4) を置いて `node scripts/backup-db.mjs restore --key daily/2026-10-13/... --identity-file ~/.config/homegohan/backup.key` を流し (`--slot` を省くと枠 0。手元で local-ci.sh が枠 0 を使っているときは `--slot 1` など空いている枠。§4.7 の引数の表)、ローカルに復元して `npm run test:smoke`。画面の「DR 訓練を記録」で quarterly_restore / success / rto 45 分を送ると `dr.test.quarterly.restore` が 1 行残る |
| S-12 | Free プランのまま月が替わる。月次の PITR 復元テストはできないので、画面で monthly_pitr / skipped / notes「plan_not_pro」を記録する (warn)。Pro に上がるまで毎月これを残す |
| S-13 | R2 の API トークンが漏れた。攻撃者は対象物を消そうとするが bucket lock で拒まれ、上書きも拒まれ、読めても age の秘密鍵が無いので復号できない。オーナーはトークンを作り直す |
| S-14 | 02:23 JST の取得のあと 09:00 に退会した利用者がいる。12:00 に DB が壊れ、02:23 のバックアップから復元すると、その利用者の行が戻る。手順書の「復元点より後の退会」の節に従う (§9.1) |
| S-15 | super_admin が DR 訓練の記録に NULL 文字を含む本文を送る → 400。admin ロールの人が送る → 403。kind が未知 → 400。監査行の INSERT が失敗 → 500 (記録そのものが操作なので fail-closed) |
| S-16 | age の秘密鍵を失くした。四半期の訓練で復号できず failed で記録される。以後のバックアップは新しい鍵で取り直し、古い対象物は読めないまま保持期間で消える (§4.4 の鍵の保管の規則がこれを防ぐ) |
| S-17 | 取得の step が job の途中で時間切れになる (DB が育って dump が長引いた)。run の step は結果ファイルを書けずに切られる。report の step (`if: always()`) は結果ファイルが無いことと `steps.run.outcome` (`failure` / `cancelled`) から「結果を残さずに終わった」の Issue を立てる |
| S-18 | 1 年後。daily の行は 365 行を超え、1 月 1 日の `backup.annual.completed` は新しい順の 100 行の窓の外にある。画面の annual のカードは、窓によらず action_type ごとに最新 1 行を読むので 1 月 1 日の取得を出し続ける。年次の訓練の最新も同じ |
| S-19 | 02:23 JST の取得の stats (live) のあと、data.sql のダンプ (数分〜) の間に利用者が 1 人登録した。live の数と dump の中身は 1 行ずれるが、復元の検査は dump の中身 (data.sql の `COPY "auth"."users"` の行数) と比べるので通る |
| S-20 | 火曜の取得で upload までは成功したが、最後の audit の psql (本番の pooler) が一時的な失敗で 1 を返す。監査行は 1 行も書かれない (全層を 1 回の取引で書くので、途中まで書けることは無い)。R2 の対象物は残る。report の step が「取得は成功・監査行は書けなかった」の Issue を立て、同じ日の 14:37 JST の鮮度の cron は、前日の completed から 36 時間で運用メールを送る |
| S-21 | 年次の訓練 (または本番の障害)。オーナーが新しい Supabase プロジェクトを作り、手順書 §6 で roles → schema → data → `fixups.sql` を流す。`snapshot_catalog.sql` と `verify_baseline.py` で関数・表の権限・ポリシー・バケットが取得の時点の本番と同じ (errors 0) ことを確かめ、`ledger.txt` の版で `migration repair --status applied` を流して台帳を戻す。anon は 20261008160000 で REVOKE した関数を呼べず、storage のポリシーがそろい、次の migration を `deploy-supabase-migrations.yml` で出せる。書庫の `cron_jobs.sql` で、本番の cron のジョブ 15 本 (migration に登録の SQL が無い 6 本を含む) が名前の集合までそろうことを確かめる (訓練は本番が生きているので `BEGIN` → `ROLLBACK` で確定させない。本番の障害では確定させる)。画面で annual_drill / success を記録する |
| S-22 | オーナーが手元のシェルに R2 の変数を置かずに (または調整用の `BACKUP_UPLOAD_TIMEOUT_MINUTES` に `abc` を置いて) `restore` を流す。config の段で止まり、標準エラー出力に段 `config`・reason `not_configured`・無い (形が違う) 名前を出して終了 3。R2・age・ローカルのスタックに触れない |
| S-23 | 取得が止まっている間に、admin ロールの人が自分の JWT で PostgREST に `admin_audit_logs` の行を直接 INSERT する (action_type `backup.daily.completed` と `dr.test.annual.drill`。`audit_logs_insert_admins` のポリシーで、actor_id は本人)。鮮度の cron と画面は、この行を取得の行とも訓練の行とも見ない (actor_id が NULL でない・本人は super_admin でない) ので、運用メールと赤いバッジは出たままで、訓練の記録にも並ばない。古いポリシー `"Admins can create audit logs"` で actor_id を NULL (または super_admin の id) にした行は見分けられない (既存の欠陥。Issue #1736 で閉じる。§21) |

### 0.4 分冊判定

| 目安 | 本設計 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (約 2,180 行) | 当たる |
| 消費先レーン 3 以上 | GitHub Actions (scripts) / migration / 運営の API と画面 / Vercel Cron / 手順書 の 5 面 | 当たる |
| 共有面 2 つ以上 | `admin_audit_logs` の action の一覧・`vercel.json` の crons と operator/08 の状態の注記・`OPS_ALERT_EMAIL` の読み口・env の一覧・cron 認証の番兵 | 当たる (どれも行を足す・1 行を付け替える) |

**結論: 1 冊で書く (核と配線に分けない)。** 理由: 共有面に触るのは「行を足す」と「`OPS_ALERT_EMAIL` の読み口の 1 行の付け替え」だけで、既存の表・関数・ポリシーを変えない。中心 (取得の 1 本道) を分冊すると、取得 → 記録 → 鮮度 → 画面の 1 本の流れが冊をまたいで追えなくなる。代わりに実装 WF を 4 段 (§16) に分け、段ごとに 2 枚レビューを閉じる。

**行数と分けるときの切れ目:** 本書は審査の中で 1,500 行 (叩き台の行数の上限) を超えた。増えた分は審査の指摘で足した逐語 (コマンドの argv・ダンプの実物の形・テストの事例) と、R4 の指摘で取得の 1 本道に挟んだ catalog の段 (dump で戻らない権限・ポリシー・台帳を書庫に入れる。§4.3)、同じ段に足した cron のジョブの定義 (`cron_jobs.sql`)、`restore` の設定 (R2 の変数と aws の鍵の渡し方。§4.4) と段ごとの時間の上限 (§4.12)、読む側の絞り込み (取得・訓練の行を書いた経路の印で読む。§7.1) と copy の送り直し (§4.4) で、構造は §3.2 の裁定から変わっていない。それでも分けると決まったときの切れ目を先に置く: 核 = 段 A (§4・§5.1・§5.2・§5.5・§14)、配線 = 段 B・C・D (§5.3・§5.4・§6・§7・§12)。両者をつなぐのは、6 つの action_type (§5.1 の `BACKUP_AUDIT_ACTION_TYPES`・§5.2 の `record_backup_audit` が受け付ける値・§5.3 の一覧が同じ) と、取得の行の印 (target_type `database_backup`・actor_id NULL。§5.2 の関数が書き、§5.3 の `isBackupAuditRow` が読む) だけで、§5.3 は監査行の `details` を中身を見ない record (`z.record(z.string(), z.unknown())`) として読むので、`details` の形は冊をまたがない。

**07 との関係:** 07 を改定せず、本書を新設して 07 から参照する。本書が置き換える 07 の節 = §4.1 (3 層の表)・§4.2 (Daily のコード)・§4.3 (GPG)・§9 (バケットと Lifecycle)・§11 (シーケンス)・§12 (テスト)・§13・§14 の該当行。07 に残る節 = §3 (プラン)・§5 (リージョン)・§6 (RPO / RTO。本書 §9.2 が Pro でない間の暫定を足す)・§7 (訓練の予定。記録の方法は本書 §6)・§8 (障害のシナリオ)。07 への注記は §19 の追随表で足す (本書では 07 を編集しない)。

### 0.5 用語

| 語 | 意味 |
|---|---|
| 取得 (run) | GitHub Actions の 1 回の実行。ダンプ → 検査 → 暗号化 → 送信 → 層への送り直し (copy) → 記録 までの 1 本道 |
| 層 (tier) | `daily` / `weekly` / `annual`。R2 の接頭辞と保持期間が違うだけで、中身は同じ日の同じ対象物 |
| 対象物 | 1 回の取得が R2 に置く 3 ファイル: `<base>.tar.zst.age` (暗号化した書庫)・`<base>.sha256`・`<base>.manifest.json` |
| 書庫の中身 | 暗号化する前の tar に入れる 7 つ (`ARCHIVE_ENTRIES`): `roles.sql`・`schema.sql`・`data.sql` (`db dump` の 3 回)・`fixups.sql`・`cron_jobs.sql`・`ledger.txt`・`catalog/` |
| 補いの SQL (`fixups.sql`) | dump を流しても戻らない関数・表・列の権限と storage のポリシー・バケットを、取得の時点の本番に戻す SQL。catalog の段が本番のカタログから作る (§4.3) |
| cron の定義 (`cron_jobs.sql`) | 取得の時点の本番の `cron.job` を、流せば同じジョブがそろう SQL にしたもの (ジョブごとに `cron.schedule_in_database` の 1 行と、流した先の `cron.job` の名前の集合を比べる最後の 1 行)。catalog の段が作る (§4.3) |
| 台帳 (`ledger.txt`) | 取得の時点の本番の migration 台帳 (`supabase_migrations.schema_migrations`) の version。1 行に 1 つ、昇順 |
| カタログ (`catalog/`) | 取得の時点の本番のカタログ (既存の `scripts/baseline/snapshot_catalog.sql` の出力の CSV 7 つ)。復元した DB を `verify_baseline.py` で比べる基準 |
| 受け手 (recipient) | age の公開鍵 (`age1…`)。秘密ではない。秘密鍵 (identity) は復元する人だけが持つ |
| 鮮度 | 最新の `backup.daily.completed` (取得の行 = actor_id NULL・target_type `database_backup` のものだけ。§7.3) の `created_at` からの経過時間。`BACKUP_STALE_AFTER_HOURS` を超えたら「古い」 |

### 0.6 章構成テンプレート (docs/design/CLAUDE.md) との対応

本書の見出しは A 型の設計ゲートの 4 相 (§0 外形固定・§3 構想と構造裁定・§8 表 3 点・§15〜§19 の追随) の章立てで、同じ形で通った先例 `cross/15-data-subject-requests.md` と同じ並び。テンプレートの番号に揃え直すと、本書の中の「§n」の参照と、他の文書へ渡す逐語 (§18.1)・追随表 (§19) の指し先がずれるので、番号は変えずに対応をここに置く。テンプレートの章はすべて本書のどこかにある (欠けている章は無い)。

| テンプレートの章 | 本書の節 |
|---|---|
| 1. 目的・スコープ | §1 |
| 2. 関連要件 | §2 (要件行列は §0.2) |
| 3. データモデル | §5.2 (migration。表は足さず関数 1 つ)・§10 (監査ログの action) |
| 4. API 仕様 | §6 (facade)・§7 (API・cron・画面) |
| 5. シーケンス | §14 |
| 6. エラーハンドリング | §11 (応答・終了コード)・§4.7 (取得と復元の段ごとの失敗) |
| 7. テスト方針 | §15 (テスト一覧)・§18 (既存の番兵の追随) |
| 8. 既存実装との関連 | §20 |
| 9. 未解決事項 | §21 |

---

## 1. 目的・スコープ

- 目的: Supabase の PITR (Pro 以上) に頼らず、本番 DB の論理バックアップを毎日取り、改ざん・削除・漏えいに耐える形で保管し、復元できることを機械で確かめ、取得と訓練の記録を監査ログに残す。
- 範囲 (本書で作るもの): GitHub Actions の workflow 1 本・scripts 3 本 (Node 2・Python 1)・migration 1 本 (関数 1 つ)・Vercel Cron の route 1 本とメール文面 1 通・運用メールの宛先の読み口 1 つ・運営の API 2 本と画面 1 つ・lib 1 つ・手順書 1 冊・テスト (§15)。
- 範囲外: Supabase Storage のファイル (写真) のバックアップ (§21)・Pro への移行と PITR の有効化 (オーナー作業)・Singapore レプリカ (07 §5.2)・`admin_audit_logs` の 7 年アーカイブ (operator/07 §5)・障害シナリオの手順そのもの (07 §8・operator/09 §11)。

## 2. 関連要件

- Issue #1129 (本文)・#1191 (本文)。関連 #1012・#1150・#1170・#1181 (`/api/health`・smoke test)・#1157 (運用メール)・#1562 (削除の実行記録)・#1736 (`admin_audit_logs` の INSERT のポリシーが action_type と actor を見ない既存の欠陥。本書は参照するだけ。§21)。
- `cross/07-dr-backup.md` §3・§6・§7・§8。`cross/08-legal-compliance.md` §16。`cross/15-data-subject-requests.md` S-11。`operator/07-audit-monitoring.md` §3・§4.5。`operator/08-cron-batches.md` §3.0・§3.2・§5。docs/design/CLAUDE.md §3 (RLS)・§4 (snake_case)・§6 (監査ログ)。

---

## 3. 構想 (相 2) と構造裁定 (相 3)

### 3.1 構造

```
GitHub Actions (schedule 23 17 * * * UTC = 02:23 JST / workflow_dispatch)   .github/workflows/db-backup.yml
  step run:    node scripts/backup-db.mjs run --tier <auto|…> --result-file $RUNNER_TEMP/db-backup-result.json
                                                                              scripts/backup-db.mjs → scripts/lib/backup-db.mjs
    link      supabase link (SUPABASE_ACCESS_TOKEN / SUPABASE_DB_PASSWORD。既存の secrets)
    config    R2 の鍵・バケット・age の受け手がそろっているか (無ければ止めて記録)
    stats     psql (読み取り): public の表の数・auth.users の数・DB の大きさ → manifest の source (記録だけ。突き合わせに使わない)
    dump      supabase db dump --linked × 3 (roles / schema / data。Supabase の手順どおり。data は public・auth・storage のスキーマだけ = DATA_DUMP_SCHEMAS)
    catalog   psql (読み取り): scripts/baseline/snapshot_catalog.sql → catalog/*.csv、台帳の版 → ledger.txt、cron.job の定義 → cron_jobs.sql
              python3 scripts/baseline/build_restore_fixups.py → fixups.sql (dump では戻らない権限・storage のポリシー。§4.3) → manifest の ledger
    verify    data.sql の完了行と最後の RESET ALL;・COPY の終端・`COPY "public".` の表 = schema.sql の表・auth.users の COPY → manifest の dumped (ダンプの中身の数)
    archive   tar (ARCHIVE_ENTRIES: 3 つの dump・fixups.sql・cron_jobs.sql・ledger.txt・catalog/) | zstd  →  <base>.tar.zst
    encrypt   age -r <受け手>                                   →  <base>.tar.zst.age  (平文の書庫はここで消す)
    upload    aws s3 cp × 3 → R2 daily/<日付>/                 (head-object で大きさを突き合わせる。aws の env は awsCommandEnv。§4.4)
    copy      月曜なら weekly/ へ、1/1 なら annual/ へ、手元の同じ 3 ファイルをもう一度送る (upload と同じ aws s3 cp。R2 の中のコピーは使わない。§4.4)
    inventory 各接頭辞の対象物の数 (Lifecycle が効いているかの手がかり)
    restore_check (weekly / annual の日だけ) scripts/supabase-local.sh start → public を空にして復元 → fixups.sql → 数を manifest の dumped と、
              カタログを catalog/ と (verify_baseline.py)、台帳を manifest の ledger と supabase/migrations のファイルと、cron_jobs.sql のジョブの数を manifest の cron_jobs と突き合わせ (§4.8)
    audit     runner の psql (1 回の取引): 層ごとに SELECT public.record_backup_audit('backup.<層>.<結果>', <details>)  (全層が書けるか、1 行も書かれないか。§4.12)
    cleanup   平文・一時ディレクトリを消す
    (finally) 結果ファイル (BackupRunReport: 層ごとの completed / failed・段・reason・missing の名前) を書く → 終了コード 0 / 1 / 3
  step stop:   bash scripts/supabase-local.sh stop   (if: always())
  step report: node scripts/backup-db.mjs report-issue --result-file … --run-outcome ${{ steps.run.outcome }} --run-url …   (if: always())
              失敗 (結果ファイルの failures・結果ファイルが無い) なら Issue を作る・更新、成功なら閉じる (consistency-check と同じ仕組み)

Cloudflare R2 (バケット homegohan-db-backups)
  daily/   Lifecycle: 30 日で削除           bucket lock: 30 日
  weekly/  Lifecycle: 30 日で IA、366 日で削除  bucket lock: 366 日
  annual/  Lifecycle: 30 日で IA、2,557 日で削除  bucket lock: 2,557 日 (7 年)
  API トークンは Object Read & Write (このバケットだけ)。Lifecycle・lock はオーナーが 1 回設定する

Vercel Cron (37 5 * * * UTC = 14:37 JST)  GET /api/cron/backup-freshness
  admin_audit_logs の最新の backup.daily.completed (actor_id NULL・target_type database_backup の行だけ) が 30 時間より古い (無い)
    → claim_ops_alert('backup_stale', 1380) → OPS_ALERT_EMAIL に 1 通

運営 (super_admin)  /super-admin/backups
  GET  /api/super-admin/backups            層ごとの最新の取得・種類ごとの最新の訓練 (どちらも action_type ごとに最新 1 行)・鮮度・取得と訓練の一覧 (それぞれ新しい順 100 行)
                                           (admin_audit_logs を本人のセッションで読む。取得の行は actor_id NULL・target_type database_backup、
                                            訓練の行は target_type dr_test・actor が今の super_admin に絞る。super_admin の一覧だけ service_role で読む。§7.1)
  POST /api/super-admin/backups/dr-tests   DR 訓練の結果を dr.test.<種類> で記録 (recordAdminAudit。fail-closed)
```

- 取得は「1 日 1 回・1 本道」。週次・年次は別の取得ではなく、同じ日の同じ対象物 (runner の手元の 3 ファイル) を層の接頭辞へもう一度送ったもの。3 つの schedule を持たない。
- 対象物は 1 回の取得で 3 ファイル。暗号化の受け手は公開鍵なので CI に秘密鍵が無い。改ざん・削除への耐性は R2 の bucket lock (WORM) で持ち、`.sha256` も lock の下にあるので改ざんの検出の正はそれ。監査行の SHA-256 は控え (アプリのロールからは RLS で UPDATE / DELETE できないが、DB パスワードを持つ postgres と service_role は RLS を越えるので、DB 側だけで不変は保証しない)。GPG の署名は置かない (§3.2 の裁定)。
- run と report を別の step に分ける: run の step は GitHub の client を持たず (`RunDeps` に無い)、結果をファイル (`$RUNNER_TEMP/db-backup-result.json`) に書くだけ。Issue は report の step (`if: always()`) が結果ファイルと `steps.run.outcome` から作る。run の step が時間切れ・取り消しで結果ファイルを書けなくても report の step は動く (§4.11)。
- 記録は既存の `admin_audit_logs` に `actor_id = NULL`・`target_type = 'database_backup'` で書く (pg_cron の `handson_tour_sandbox_cleanup` と同じ「利用者のいない操作」)。取得が書くのは新しい関数 `public.record_backup_audit` だけで、この関数は所有者 `postgres` (= Actions が DB パスワードで繋ぐロール) 以外は呼べない。ただし表の INSERT のポリシー 2 本 (origin/main の `supabase/baseline/prod_schema.sql` の 9496 行 `"Admins can create audit logs"` と 10111 行 `audit_logs_insert_admins`。authenticated には表の INSERT の権限もある) は action_type を見ないので、運営のロールの人は関数を通らずに `backup.*` / `dr.test.*` の行を自分の JWT で直接書ける。そこで読む側 (§7.1・§7.3) は action_type に加えて書いた経路の印で絞る: 取得の行は actor_id NULL かつ target_type `database_backup`、訓練の行は target_type `dr_test` かつ actor が今の super_admin。前者のポリシーは actor_id も見ないので、admin / super_admin / support のロールの人はその印も作れる。これは本書の外の既存の欠陥で、Issue #1736 で直す (§21)。
- 「走っていない」は取得の側では検知できないので、Vercel Cron が監査行の鮮度を見る。通知は既存の運用メールの仕組み (`OPS_ALERT_EMAIL`・`claim_ops_alert` のクールダウン) をそのまま使う。

### 3.2 代替案の比較と裁定 (1 回だけ)

| 観点 | A: 本書の構造 (GitHub Actions + R2 + age + 監査行) | B: 07 の構造 (Vercel Cron → Edge Function `create-backup` → R2 + GPG 署名) | C: pg_cron から Supabase の中で完結 | D: 手元の機械 (M2 / 270k) の cron |
|---|---|---|---|---|
| `pg_dump` を動かせるか | 動く。前例 `prod-schema-snapshot.yml` が同じ Docker イメージで本番を読んでいる | 動かない。Vercel の関数にも Edge Function (Deno) にもバイナリが無く、関数の本体は 4.5 MB、実行時間は Pro で 800 秒 (§4.2) | `COPY TO` も DB の外へ書けない。外部ストレージへは `pg_net` で小さい HTTP しか送れない | 動く |
| 時間・容量 | 1 job 6 時間・ディスク約 14 GB (§4.2)。DB 2.4 GB に対して十分 | 不可 | 不可 | 十分 |
| 秘密の置き場 | GitHub の secrets (DB パスワードはすでにある。R2 の鍵 2 つを足す)。暗号化の秘密鍵は CI に無い | Vercel の環境変数に R2 の鍵と GPG の秘密鍵 (署名用) を置く = 署名鍵が CI にある | DB の中 (Vault) | 個人の機械 |
| 失敗の見え方 | Actions の失敗 + Issue + 監査行 + 鮮度のメール | 関数のログだけ (07 は Slack だが本プロジェクトは Slack を使っていない) | `cron.job_run_details` | 誰も見ない |
| 改ざん・削除への耐性 | bucket lock (WORM) + 監査行の SHA-256 | GPG 署名 (署名鍵が CI にあるので、CI が侵害されれば署名も偽造できる) | — | — |
| 縁の発生源 | Actions の schedule が 60 日で止まる → 鮮度の cron で塞ぐ | 本体の大きさ・時間の上限が DB の成長で破綻する | 不可 | 可用性・説明責任が無い |

**裁定: A。** B は上限で成り立たず、C は構造的に不可、D は運用に耐えない。A の中で、GPG の署名を落として「bucket lock + 監査行のハッシュ」に替えるのは「縁の発生源 (CI に置く秘密鍵の管理。07 §14・cross/08 §19 の TODO) を消す」ための選択で、以後蒸し返さない。暗号化に age を選ぶのは、受け手が 1 行の文字列で GitHub の variable に置け、鍵束 (keyring) も信頼モデルの設定も要らないため (GPG の公開鍵でも同じことはできるが、`--trust-model` と鍵の取り込みが要り、手順書の行が増える)。
仕上げ (相 4) の中で構造への疑義が出たら、blocking ではなくこの裁定への差し戻し事由として扱う。

### 3.3 取得の場所を決めた実測値 (英語・日本語で検索した結果)

| 項目 | 値 | 出どころ |
|---|---|---|
| Vercel の関数の実行時間 (Fluid compute) | Hobby 300 秒 (既定 = 上限)。Pro / Enterprise 既定 300 秒・上限 800 秒・関数ごとの設定で 1,800 秒 (beta) | vercel.com/docs/functions/limitations (2026-08-24 更新)。日本語の公式ページは見つからず、英語の changelog「Vercel Functions can now run up to 30 minutes」で補った |
| Vercel の関数の本体 (要求・応答) | 4.5 MB (超えると 413 `FUNCTION_PAYLOAD_TOO_LARGE`) | 同上 |
| Vercel の関数のバンドル | 非圧縮 250 MB (Large functions beta で 5 GB)。`pg_dump` のバイナリは同梱できない前提で設計する (同梱できても本体の上限で成り立たない) | 同上 |
| GitHub Actions の job | GitHub-hosted runner は 1 job 6 時間、workflow run 35 日 | docs.github.com/en/actions/reference/limits |
| Cloudflare R2 の保管クラス | Standard $0.015 / GB-月、Infrequent Access $0.01 / GB-月 (最短 30 日・取り出し $0.01 / GB)。Class A $4.50 / 100 万、Class B $0.36 / 100 万 (IA は $9.00 / $0.90)。Egress 無料。無料枠は Standard 10 GB-月 | developers.cloudflare.com/r2/pricing |
| R2 の Lifecycle | 接頭辞ごとに削除・Infrequent Access への遷移・途中で切れたマルチパートの破棄。削除と遷移が重なれば削除が勝つ。1 バケット 1,000 ルール。設定の形は 2 つあり、`wrangler r2 bucket lifecycle set --file` が受けるのは Cloudflare の API (put object lifecycle configuration) の本文の形 = `{ rules: [{ id, enabled, conditions: { prefix }, deleteObjectsTransition / storageClassTransitions / abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: <秒> } } }] }`・クラス名 `InfrequentAccess`。S3 の形 (`Rules`・`Filter.Prefix`・`Expiration.Days`・`StorageClass: 'STANDARD_IA'`) は S3 互換 API (`PutBucketLifecycleConfiguration`) 用で、wrangler には渡せない | developers.cloudflare.com/r2/buckets/object-lifecycles (「The JSON file should be in the format of the request body of the put object lifecycle configuration API」)・wrangler の `packages/wrangler/src/r2/lifecycle.ts` (`set` は `rules` の配列を要求し、`add` は日数 × 86,400 の `maxAge` と `InfrequentAccess` を書く) |
| R2 の bucket lock | 接頭辞ごとに、日数 (`Age` の `maxAgeSeconds`)・日付・無期限 (`Indefinite`) で削除と上書きを防ぐ。Lifecycle の削除より優先。重なれば長い方 | developers.cloudflare.com/r2/buckets/bucket-locks (2025-03-06 の changelog で追加) |
| aws cli の S3 → S3 のコピー (`aws s3 cp s3://… s3://…`) と R2 | aws cli v2 の `s3 cp` は、対象物が `multipart_threshold` (既定 8 MB) 以上ならマルチパートのコピー、より小さければ 1 回の `CopyObject` にする。`--copy-props` の既定 `default` は、マルチパートのコピーで `HeadObject`・`GetObjectTagging`・`PutObjectTagging` を呼ぶことがある (公式の説明)。`none` と `metadata-directive` は、どのコピーにも `TaggingDirective = REPLACE` を付け、1 回の `CopyObject` にはそのまま渡る (マルチパートでは CreateMultipartUpload に渡す前に外す)。R2 は `GetObjectTagging`・`PutObjectTagging` を実装しておらず、`CopyObject` の `x-amz-tagging-directive` も未対応 (互換表の ❌)。REPLACE を付けた `CopyObject` が「Header 'x-amz-tagging-directive' with value 'REPLACE' not implemented」で断られた報告がある。どの値でも、`.tar.zst.age` (0.5〜1.5 GB。マルチパート) と `.sha256`・`.manifest.json` (数 KB。1 回の `CopyObject`) のどちらかが落ちる。本書は R2 の中のコピーを使わず、手元のファイルを層のキーへもう一度送る (§4.4) | docs.aws.amazon.com/cli/latest/reference/s3/cp.html の `--copy-props`・docs.aws.amazon.com/cli/latest/topic/s3-config.html の `multipart_threshold`・aws-cli の v2 の枝の `awscli/customizations/s3/subscribers.py` (`_get_none_subscribers` / `_get_metadata_directive_subscribers` → `ReplaceTaggingDirectiveSubscriber`、`SetTagsSubscriber` はマルチパートのときだけ `get_object_tagging`) と `awscli/s3transfer/copies.py` (`_submit_copy_request` が extra_args をそのまま `copy_object` へ、`CREATE_MULTIPART_ARGS_BLACKLIST` が `TaggingDirective` を外す)・developers.cloudflare.com/r2/api/s3/api/ (どれも 2026-10-16 に読んだ)。R2 の 501 は英語の報告 (AWS SDK for .NET の CopyObject)。日本語では、同じ追加の呼び出し (容量の大きいオブジェクトのマルチパートのコピーで aws cli が打つ `GetObjectTagging`) が AWS の S3 のクロスアカウントの権限で AccessDenied になる解説 (classmethod) が、同じ仕組みを裏付ける |
| `supabase db dump` の出力の形 (CLI 2.62.10) | 名前はすべて引用符つき (`--quote-all-identifier`)。schema.sql: `CREATE TABLE "` を `CREATE TABLE IF NOT EXISTS "` に書き換え、`--` で始まる行を消す (`--keep-comments` が無いとき)。data.sql: 先頭に `SET session_replication_role = replica;`、pg_dump の注釈は残し (`--keep-comments` と `--data-only` は同時に使えない)、最後に `RESET ALL;` を足す。`\restrict` / `\unrestrict` の行は `-- ` を付けて注釈にする。data の既定の対象は「除外の一覧に無いスキーマ全部」で、除外の一覧 `excludedSchemas` は `cron`・`net`・`pgmq`・`auth`・`storage`・`supabase_functions` をコメントアウトしている (コメント「Data dump includes auth, storage, etc.」。外すのは vault・extensions・realtime・supabase_migrations など)。表で外すのは `auth.schema_migrations`・`storage.migrations`・`supabase_functions.migrations` の 3 つだけ。`--schema` (`-s`) を渡すと、そのスキーマだけを取る (`--schema "<a>\|<b>"`)。詳しくは §4.3 の表 | supabase/cli の v2.62.10 の `pkg/migration/scripts/dump_schema.sh`・`dump_data.sh`・`pkg/migration/dump.go`・`cmd/db.go` (`db dump` の `--schema`)。origin/main の `supabase/baseline/prod_schema.sql` (同じ CLI の `db dump --linked` の実物) で `CREATE TABLE IF NOT EXISTS "public".` の行 127・`CREATE TABLE public.` の行 0・`--` で始まる行 0 |
| dump を流しても戻らないもの | (1) 関数の EXECUTE 権限: pg_dump の権限の出力は組み込みの既定権限からの差分だけで、Supabase の既定権限 (`prod_schema.sql` の `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon"` など) が作成時に anon・authenticated・service_role へ付けるので、本番で REVOKE した権限が戻る (2026-10-06 時点で 41 関数。20261008160000 で anon から外した SECURITY DEFINER 関数も戻る) (2) 表の権限: 同じ理由で戻る (`family_promotion_requests` の token 列を隠す列単位の GRANT) (3) storage のポリシー: `db dump` の対象外 (本番の今の数は 5) (4) migration の台帳 `supabase_migrations.schema_migrations`: schema にも data にも入らない (本番は 200 版。すべて 14 桁の数字で、どの版にも origin/main の `supabase/migrations/` にファイルがある。列は version・statements・name・created_by・idempotency_key・rollback の 6 つ) (5) cron のジョブの定義 `cron.job`: data.sql に入れない (`-s public,auth,storage`。§4.3) うえ、migration から作り直すこともできない。本番は 15 本 (どれも active・database `postgres`・username `postgres`。pg_cron 1.6.4 で `cron.schedule_in_database(job_name, schedule, command, database, username, active)` がある) で、origin/main の `supabase/migrations` が登録するのは 9 本だけ。`catalog-import-*` の 5 本 (毎月 1 日) と `handson-tour-sandbox-cleanup` (毎日) は #1116 でベースラインに統合され、登録の SQL が migration にも `supabase/baseline/` にも無い (operator/08 §3.0)。command は `public.invoke_catalog_import('…')` などの関数の呼び出しだけで秘密を含まない (5 本は複数行)。Edge Function を呼ぶ DB の関数は本番の URL (`https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/…`) を本文に持つ (`supabase/migrations` の 5 ファイル)。public の関数で anon が EXECUTE できるのは、SECURITY DEFINER が許可リストの 2 本 (`get_invite_details`・`get_promotion_details`。拡張機能の関数を除く。`tests/integration/security/anon-definer-execute.test.ts` の A)、SECURITY INVOKER が 26 本 (すべてトリガー関数。#1821 の後。本番の 2026-10-17 の読み取りでも 26。`tests/integration/security/anon-invoker-execute.test.ts` の A) (`has_function_privilege`) (6) auth・storage の表のアプリのトリガー: schema の dump は auth・storage のスキーマを除く (dump の台本の `--exclude-schema`) ので、その表に付いたトリガーも出ない。#1757 (`20261016243000_auth_history_sessions.sql`) が `auth.sessions` に 3 本 (`on_auth_session_created`・`on_auth_session_refreshed`・`on_auth_session_deleted`)、`auth.users` に 1 本 (`on_auth_user_password_changed`) を付けた (どれも public の関数を呼ぶ。ログイン・セッション・パスワードの変更の記録)。§4.8 の 2 の reset (`DROP SCHEMA "public" CASCADE`) も、public の関数に依るこれらのトリガーを巻き込んで消す。見分け方: `catalog_auth_storage_triggers.csv` (`pg_get_triggerdef`) の定義の実行する関数のスキーマが auth・storage の外ならアプリのトリガー (`INTERNAL_TRIGGER_FUNCTION_SCHEMAS`)。Storage・Auth のサービスが作る内部のトリガーは自分のスキーマの関数を呼び、`pg_get_triggerdef` は search_path (postgres は `"$user", public, extensions`) で見えない関数だけをスキーマつきで書くので、いつも `storage.` / `auth.` つきで出る (origin/main の `supabase/baseline/catalog/catalog_auth_storage_triggers.csv` の 4 行。アプリの 4 本はスキーマ無しで出る)。アプリのトリガーは `fixups.sql` の最後で、同じ名前が無いときだけ取得の時点の定義で作り直し (§5.5)、restore_check が `appTriggerChecks` で取得の時点と比べる (§4.8 の 7。`verify_baseline.py` はこの CSV を読まない)。同じ型で洗ったほかのもの: origin/main の `supabase/migrations` の全文で、auth・storage・cron などの public の外のスキーマに作るものは、(6) の 4 本の `CREATE TRIGGER` と、統合した migration の storage のバケット 3 つ (data.sql に入る) と `storage.objects` のポリシー 5 本 (= (3)) だけ (auth のスキーマの関数・ポリシー・権限は無い。2026-10-16。`tests/backup-db.test.ts` の掃除の it が auth・storage の表のトリガーを毎回見る)・realtime の publication の表は schema.sql に入る・DB とロールの設定 (`pg_db_role_setting`) は Supabase の既定の値だけ・Vault・Auth の設定・Storage のファイルは手順書 §6 で扱う | `supabase/baseline/README.md` の「忠実度」(リポジトリのローカルのベースラインは `prod_function_acl.sql`・`prod_table_acl.sql`・`prod_storage.sql` で補っている)・`prod_storage.sql` の冒頭・Supabase MCP の SELECT (2026-10-16。`cron.job` の列と行・`cron.schedule_in_database` の引数。§5.1 の `CRON_JOBS_SQL` を本番に流した出力が 15 行 + 比べる 1 行)・origin/main の `supabase/migrations` をジョブの名前ごとに `git grep` (9 本は 1 件以上、6 本は 0 件)。`scripts/baseline/build_baseline.py` の 3 つの関数 (`build_function_acl_sql`・`build_table_acl_sql`・`build_storage_sql`) に origin/main の `supabase/baseline/catalog/*.csv` と `prod_schema.sql` を渡すと、コミット済みの 3 つの SQL とバイト単位で同じものができる (2026-10-16 に確かめた) |
| Supabase の日次バックアップ | Pro 7 日・Team 14 日。Free は無し。PITR はアドオンで、有効にすると日次は取られなくなる | supabase.com/docs/guides/platform/backups |
| 本番 DB の実測 (2026-10-16・読み取り) | PostgreSQL 17.6。DB 2,417 MB (public 2,393 MB・136 表。同じ日の後の読み取りでは 137 表で、どれも通常の表 (relkind `r`。分割表・拡張の表は 0)。`dataset_menu_sets` 1,895 MB が大半)。auth.users 195 行。admin_audit_logs 261 行。表のあるスキーマは public・auth・storage・cron (`job` 15 行・`job_run_details` 541 行)・net (`_http_response` 22 行・`http_request_queue` 0 行)・realtime・supabase_migrations・vault (pgmq・supabase_functions のスキーマは無い)。予約のほかのロールは `cli_login_postgres`・`supabase_privileged_role`。`postgres` ロールは `rolbypassrls = true`・`admin_audit_logs` の所有者で、`relforcerowsecurity = false`。`service_role` も `rolbypassrls = true`、`anon` / `authenticated` は false | Supabase MCP の SELECT |

### 3.4 シナリオのトレース (構造 A で手で走らせた記録)

| # | 走らせた結果 |
|---|---|
| S-1 | 17:23 UTC に schedule。`planRun` が JST の暦日 2026-10-20 (火) を出し、tiers = [`daily`]。link → config OK → stats (136 / 195 / 2.5e9。記録だけ) → dump 3 ファイル → catalog (`snapshot_catalog.sql` の CSV 7 つ・`ledger.txt` 200 版・`cron_jobs.sql` (15 行 + 比べる 1 行)・`fixups.sql`。`checkCatalogCapture` が ok → manifest の ledger {versions_count 200, max_version} と cron_jobs 15) → verify (完了行と最後の `RESET ALL;` あり・COPY の終端あり・`COPY "public"."<t>"` の 136 表 = schema.sql の `CREATE TABLE IF NOT EXISTS "public"."<t>" (` の 136 表、`COPY "auth"."users"` あり → dumped = {public_tables 136, auth_users 195, audit_rows 261}) → archive → encrypt → upload 3 つ (env は `awsCommandEnv`: `AWS_ACCESS_KEY_ID` ← `BACKUP_R2_ACCESS_KEY_ID` など) → head-object の大きさ一致 → copy 無し → inventory (daily 20) → restore_check 無し → audit `backup.daily.completed` → cleanup → 結果ファイル {status ok, completed [daily]} → 終了 0 → stop → report: failures 0 で marker の Issue が無いので none。鮮度の cron は 14:37 JST に「12 時間」で fresh。画面の daily カードは 02:3x・鮮度 OK |
| S-2 | 月曜 (JST) → tiers = [`daily`, `weekly`]。upload まで S-1 と同じ。copy: 手元の 3 ファイルを `aws s3 cp $WORK/<base>.<拡張子> s3://…/weekly/2026-10-19/<base>.<拡張子>` で送り直し、`s3api head-object` の大きさが手元と同じ (× 3。R2 の中のコピーは使わない。§4.4)。restore_check (psql は §4.12): `psql --version` → `supabase-local.sh start` → `env` で接続先 → reset.sql (public を空に・auth / storage の COPY の表を TRUNCATE) → roles.sql (42710 は数えて許す) → schema → data (replica。cron・net は data.sql に無いので、ローカルの `cron.job` の行と重ならない) → `fixups.sql` (関数・表・列の権限と storage のポリシーを取得の時点に) → `RESTORE_COUNT_SQL` で 表 136・users 195・admin_audit_logs 261 を manifest の dumped と突き合わせ → `restored-catalog/` に `snapshot_catalog.sql` → `verify_baseline.py catalog restored-catalog` が 0 (`[verify] errors=0`) → `ledger.txt` の 200 版が manifest の ledger と同じで、どの版にも `supabase/migrations/` のファイルがある → `cron_jobs.sql` を `parseCronJobsSql` で読めて 15 本 = manifest の cron_jobs (ローカルの pg_cron には流さない) → stop。audit `backup.daily.completed` と `backup.weekly.completed` (後者の details に `copied_from` と `restore_check`)。終了 0 |
| S-3 | 1/1 → tiers に `annual` が入る (`tiersForDate` は daily を常に、月曜なら weekly、1/1 なら annual を足す)。copy (送り直し 3 ファイル) を weekly と annual の 2 層分、audit を 3 行。restore_check は copy に成功した weekly または annual があれば 1 回だけ (copy が失敗した層は stage `copy` の failed のままで、restore_check の対象から外す。§4.7) |
| S-4 | link OK → config で `BACKUP_R2_ACCESS_KEY_ID` が無い → `ConfigError(missing: ['BACKUP_R2_ACCESS_KEY_ID'])` → dump に進まない (平文が作られない) → audit `backup.daily.failed` {stage: 'config', reason: 'not_configured', missing: [名前]} (値は無い) → 結果ファイル {status not_configured, failures [{tier daily, stage config, reason not_configured, missing [名前]}]} → 終了 3 → report の step (`if: always()`): `planBackupIssue` が failures から本文 (marker・層・段・reason・missing の名前・run の URL) を作り、Issue「【自動】DB バックアップの失敗」を作る。鮮度の cron は翌日 fresh でなくなるまで鳴らない (失敗の通知は Issue と Actions の失敗通知が担う) |
| S-5 | link 失敗 → reason `link_failed` → audit は書けない (DB に繋げない。結果ファイルの `audit_written` は false) → 結果ファイル {status failed, failures [{tier daily, stage link, reason link_failed}]} → 終了 1 → report が Issue。翌日 14:37 JST の鮮度の cron: 最新 completed は前日 02:3x → 36 時間 > 30 → `claim_ops_alert('backup_stale', 1380)` → メール 1 通 (`stale_sent`)。その 15 分後の回は無い (日 1 回)。翌日の回 (24 時間後 ± 秒単位のぶれ) もまだ古ければ、前回から 23 時間 (クールダウン) を超えているので再度 1 通 |
| S-6 | dump 完了 → verify: data.sql に完了行が無い・最後の行が `RESET ALL;` でない (または `COPY "public".` が 97 表 ≠ schema.sql の 136 表) → reason `dump_incomplete` (details に expected / actual) → upload しない → audit failed → Issue → cleanup → 終了 1 |
| S-7 | upload で aws cli が再試行の末に失敗 → reason `upload_failed` (stage `upload`、どのファイルかは suffix だけ) → audit failed → 結果ファイル → report が Issue (marker が同じなので既存の Issue を更新) → 終了 1。翌日成功 → 結果ファイル {status ok} → report が marker の Issue を閉じる |
| S-8 | dispatch (tier = auto)。base = `homegohan-db-20261020T051500Z` (17:23 の回は `…T172312Z`) → キーが別 → lock に当たらない → audit 2 行目。鮮度・画面は新しい方を見る |
| S-9 | schedule 停止。監査行は増えない。14:37 JST の鮮度の cron: 最新 completed から 36 時間 → メール。画面: `isBackupStale` が true で赤いバッジと「GitHub Actions の db-backup が止まっていないか確かめる」の文 |
| S-10 | restore_check で `COPY "auth"."users"` が列不足で失敗 → `restore_check_failed` → upload・copy は済んでいるので対象物は残る → audit は `backup.daily.completed` (先に書いてある) と `backup.weekly.failed` {stage: 'restore_check', reason, copied_from} → Issue → 終了 1。手順書: `supabase link` で `.temp` の版を更新してベースラインを取り直す (オーナー) |
| S-11 | `restore` サブコマンド: config (`checkRestoreConfig`: 手元のシェルの R2 の 4 つがある。調整用は無いので既定) → aws で 3 ファイルを取得 (`s3 cp s3://<BACKUP_R2_BUCKET>/<キー> …`・`--endpoint-url https://<BACKUP_R2_ACCOUNT_ID>.r2.cloudflarestorage.com`・env は `awsCommandEnv`。子 1 つずつ `restoreStageTimeoutMs('download', …)` = 60 分) → sha256 を突き合わせ → age -d -i → zstd -d → tar (`ARCHIVE_ENTRIES` の 7 つ) → `psql --version`・`python3 --version` → `supabase-local.sh start` → public と storage のポリシーを空に → 復元 → `fixups.sql` → 数・カタログ (`verify_baseline.py`。`[error]` の行も手元の画面に出す)・台帳・cron の定義の数を確かめて表示。オーナーが `npm run test:smoke -- --base-url=http://localhost:3000` → 画面の form (kind quarterly_restore, result success, environment local, backup_key, rto_minutes 45, smoke passed, notes) → POST → `recordAdminAudit` 成功 → 201 → 一覧の先頭に出る |
| S-12 | form (monthly_pitr, skipped, environment staging, notes 'plan_not_pro') → `drTestRecordBodySchema` は result ≠ success のとき notes 必須 → 通る → severity warn → 一覧に黄色で出る |
| S-13 | DeleteObject → R2 が lock で拒否 (403)。PutObject (同じキー) → 拒否。GetObject → `.age` を得るが復号できない。`.sha256` も lock の下で書き換えられないので、復元の checksum の段が改ざんを見つける (監査行の sha256 は控え)。手順書: トークンを作り直し、`BACKUP_R2_*` を更新 |
| S-14 | 復元した DB に退会済みの人の行が戻る。`gdpr_deletion_requests` の記録は HMAC で、復元先が同じプロジェクトなら Vault の鍵が残るので照合できるが、新しいプロジェクトなら鍵が無く照合できない。手順書は「復元点より後の退会は機械では再現できない。影響期間は最長 24 時間 (RPO)。復元後に、復元点以降の退会の問い合わせがあれば再度の退会で応じる」と書く (§9.1) |
| S-15 | `rejectNullCharacterBody` が最初 → 400 INVALID_CHARACTER。`requireRole(['super_admin'])` が admin を 403。Zod が kind を 400 `OP_INVALID_INPUT` (message は最初の issue の文「訓練の種類を選んでください」、details は issues の全件。`invalidInputResponse`)。`recordAdminAudit` が `{ ok: false }` → `internalError` の 500 (記録無しで 201 を返さない) |
| S-16 | download → checksum (`.sha256` と一致) → 復号で age が失敗 → `restore` は終了 1 (stage `decrypt`, reason `decrypt_failed`。一時ディレクトリは消す)。訓練は failed で記録。新しい鍵対を作って variable を更新すれば翌日から新しい鍵で取れる。古い対象物は読めないまま Lifecycle で消える |
| S-17 | dump が長引き、run の step が `timeout-minutes: 290` (`RUN_STEP_TIMEOUT_MINUTES`) で切られる → 結果ファイルは無い (finally も走らない) → `steps.run.outcome = failure` → stop (always) → report (always): `parseRunReport` が null → `planBackupIssue` が「run の step が結果を残さずに終わった (outcome failure)。時間切れか取り消し」の本文 → Issue。監査行は書かれていない (最後の段まで行っていない) ので、翌日の鮮度の cron が拾う。job 全体 (300 分) にはまだ 10 分残っているので report の step は動ける |
| S-18 | GET: super_admin の一覧 (service_role で `user_profiles` の `id` を 1 本) → 最新 1 行を 6 本 (層 3 は `.eq('action_type', …).eq('target_type', 'database_backup').is('actor_id', null)`、訓練の種類 3 は `.eq('action_type', …).eq('target_type', 'dr_test').in('actor_id', <super_admin の id>)`。どれも `.order(created_at desc).limit(1)`) と一覧 2 本 (取得 6 種・訓練 3 種、同じ印で絞り、それぞれ limit 100) を並べて読む → annual の最新は 1 月 1 日の行 (一覧の窓の外でも) → `toBackupStatusResponse` の `isBackupAuditRow` を通る → カードに出る |
| S-19 | stats (live: auth.users 195) → dump (その間に 1 人登録) → verify: data.sql の `COPY "auth"."users"` の行数 196 → dumped.auth_users = 196 → restore_check: 復元後 196 = dumped 196 → passed。source.auth_users (195) は記録だけで比べない |
| S-20 | S-1 と同じ道で cleanup の前の audit まで来る → `buildAuditSql([{daily, completed, …}])` を `$WORK/audit.sql` に書く → `bash -c PSQL_SCRIPTS.audit` (env: PG_URL = pooler-url + `?sslmode=require`・PGPASSWORD・PSQL_FILE) が 1 → `CommandFailedError` → `classifyFailure('audit', …)` = `audit_failed` → RunResult {completed [daily], failed [{daily, audit, audit_failed}], auditWritten false, exitCode 1} → 結果ファイル {status failed} → report: `planBackupIssue` の 2 つ目 (status が ok でない) → 本文に「daily: 段 audit・reason audit_failed」と completed [daily] → Issue。R2 の `daily/` の 3 ファイルは残る。14:37 JST の鮮度の cron: 最新の completed は前日 02:3x で 36 時間 → メール |
| S-21 | 手順書 §6: 書庫を取り出して展開 (手元のシェルに復元用の読み取りのトークンと R2 の 4 つ。`aws s3 cp` は `awsCommandEnv` と同じ写し方。`ARCHIVE_ENTRIES` の 7 つ) → 新しいプロジェクトに link → roles (42710 は許す) → schema + replica + data (1 回の取引) → `fixups.sql` (1 回の取引。Supabase の既定権限で anon に付いた EXECUTE を `REVOKE ALL ON ROUTINE … FROM PUBLIC, anon, authenticated, service_role` で外し、本番の `proacl` の分だけ付け直す。表も同じで、最後に列単位の GRANT。storage のポリシー 5 つを作る) → 空のディレクトリに `snapshot_catalog.sql` → `verify_baseline.py <書庫の catalog> <そのディレクトリ>` が `errors=0` → main の checkout で `migration repair --status applied $(cat ledger.txt) --linked` (CLI が台帳の表を作り、200 版を版ごとのファイルの name・statements で入れる) → `migration list --linked` で全版が Local と Remote の両方 → Vault・Auth の設定・secrets・project ref の差し替え (本番の障害では DB の関数の Edge Function の URL も migration で新しい ref に) → `cron_jobs.sql` (訓練: `psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --command "BEGIN" --file cron_jobs.sql --command "ROLLBACK"` が 0 = 15 本が入り、最後の行の `cron.job` の名前の集合の比べが通り、確定しない。本番の障害: `--single-transaction --file cron_jobs.sql` で確定) → health → smoke → 画面で annual_drill / success。`deploy-supabase-migrations.yml` の次の回は、台帳の最大より新しいファイルだけを `db push` する |
| S-22 | `parseArgs` が通る (`--key`・`--identity-file` はある) → config: `checkRestoreConfig(env)` が `{ ok: false, missing: ['BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY'] }` (調整用が `abc` なら `BACKUP_UPLOAD_TIMEOUT_MINUTES` も) → stage `config`・reason `not_configured`・`EXIT_CODES.not_configured` (3)。標準エラー出力は段・reason・名前だけ (値を出さない)。一時ディレクトリを作る前なので、aws・age・`supabase-local.sh` を呼ばず、消すものも無い → オーナーは手順書 §5 の 4 つの名前を見て置き直す |
| S-23 | admin の JWT の INSERT → `audit_logs_insert_admins` の WITH CHECK (actor_id = auth.uid() と運営のロール) が通り、actor_id = 本人の行が 2 つできる (target_type は本人が送った値)。14:37 JST の鮮度の cron: `.eq('action_type', 'backup.daily.completed').eq('target_type', 'database_backup').is('actor_id', null)` の最新 1 行 = 最後の本物の取得 → 30 時間を超えていれば `claim_ops_alert` → stale_sent。GET: daily の最新 1 行も同じ絞り込みで本物の行 → `isBackupAuditRow` が通り、`stale` true で赤いバッジ。訓練の 4 本は `.eq('target_type', 'dr_test').in('actor_id', <今の super_admin の id>)` で、admin の id は入っていないので最新にも一覧にも出ない。route が絞り込みを書き忘れても `toBackupStatusResponse` の `isBackupAuditRow` / `isDrTestAuditRow` が落とす。`"Admins can create audit logs"` で actor_id NULL・target_type `database_backup` の行を書かれると、cron と画面はそれを本物として読む (§21。Issue #1736) |

---

## 4. 取得の設計 (GitHub Actions)

### 4.1 層・予定・保持

| 層 | 取得 | R2 の接頭辞 | Lifecycle | bucket lock | 保持の根拠 |
|---|---|---|---|---|---|
| `daily` | 毎日 02:23 JST (`23 17 * * *` UTC) | `daily/<YYYY-MM-DD>/` | 30 日で削除 | 30 日 (2,592,000 秒) | 07 §4.1 の 30 日。ローンチに必須 |
| `weekly` | 月曜 (JST) の daily と同じ 3 ファイルを送る | `weekly/<YYYY-MM-DD>/` | 30 日で Infrequent Access、366 日で削除 | 366 日 (31,622,400 秒) | 07 §4.1 の 1 年 (閏日を含めて 366)。ローンチと同時 (送り先を 1 つ足すだけなので別の工事が無い) |
| `annual` | 1 月 1 日 (JST) の daily と同じ 3 ファイルを送る | `annual/<YYYY>/` | 30 日で Infrequent Access、2,557 日で削除 | 2,557 日 (7 年。220,924,800 秒) | 07 §4.1 は「永久」だが、個人情報を含む DB を期限なしで持つことは避け、`admin_audit_logs` の保管 7 年 (operator/07 §5.1) に揃える。法務の確認は §21。ローンチと同時 (weekly と同じく送り先を 1 つ足すだけで別の工事が無い。最初の対象物はローンチ後の最初の 1 月 1 日) |

- ローンチに要るもの / 後回しのもの: 3 層とも段 A (§16) で作り、ローンチの時点で動かす (後回しにする層は無い)。daily は復元の元として必須、weekly・annual は daily と同じ 3 ファイルを層の接頭辞へもう一度送る段 (§4.4 の copy) と復元の検査だけで、別の取得・別の秘密・別の工事が無いので、分けて後から足すほうが手間が増える。後回しにするのは Supabase の Pro への移行と PITR (オーナーの作業。§9.2) だけ。
- 時刻は 02:23 JST に置く (07 は 02:00 UTC = 11:00 JST の昼間だった)。GitHub の schedule は毎時 0 分に遅れるので 0 分・30 分を避ける (daily-consistency-check.yml の経験)。pg_cron の掃除 (03:10〜03:45 JST) より前。
- 日付・曜日・1/1 の判定は JST の暦日 (`Asia/Tokyo`) で行う (`tiersForDate`)。1/1 が月曜なら 3 層とも作る。
- 世代の削除はコードでは行わない。R2 の Lifecycle に任せ、取得の `inventory` が各接頭辞の対象物の数を監査行に残す (daily が 33 日分より多ければ Lifecycle が効いていない手がかり。判定は画面を見る人)。
- `workflow_dispatch` の入力 `tier` (`auto` / `daily` / `weekly` / `annual`。既定 `auto`) で、手動のときだけ層を指定できる (`weekly` を指定すると daily + weekly)。

### 4.2 実行環境 (GitHub-hosted runner)

| 項目 | 値 | 本設計での扱い |
|---|---|---|
| job の上限 | 6 時間 | `timeout-minutes: 300` (`JOB_TIMEOUT_MINUTES`)。run の step は `timeout-minutes: 290` (`RUN_STEP_TIMEOUT_MINUTES`。report の step の分 10 分を残す)。段ごとの上限は §5.1 の `STAGE_TIMEOUT_MINUTES` (dump 120 分・upload 60 分・copy 60 分・restore_check 60 分)。段の上限の合計は 290 分を超えるが、全段が上限まで掛かることは無い前提で、超えたら step の時間切れになり S-17 の経路で Issue が立つ |
| ディスク | ubuntu-latest で約 14 GB の空き | 平文 (data.sql ≈ DB の大きさ) + 書庫 + 暗号化後 ≈ DB × 1.5。DB が 5 GB を超えたら `tar \| zstd \| age` のパイプで平文の書庫を作らない形へ (§21) |
| 入っている道具 | Docker・aws cli v2・zstd・gpg・PostgreSQL 16 (16.15。`psql` が PATH にある。サービスは止まっている)・python3。`age` は無い | `sudo apt-get update && sudo apt-get install -y age` (Ubuntu 24.04 の age 1.1.1)。版は `age --version`・`psql --version`・`python3 --version` でログに出す (step `Install age and check tools`。§4.11)。psql は catalog・audit と、ローカルのスタックへの復元 (§4.12) が使う (出どころ: actions/runner-images の Ubuntu2404-Readme の Databases)。python3 は catalog の `build_restore_fixups.py` と復元の検査の `verify_baseline.py` が使う (`supabase-local.sh` も `start` で使っている) |
| 同時実行 | `backup` job に `concurrency: { group: db-backup, cancel-in-progress: false }`。**ワークフロー直下には置かない**。`roundtrip-check` job は別の group `db-backup-roundtrip-${{ github.ref }}` (`cancel-in-progress: true`) | 手動と schedule の取得どうしは直列。ワークフロー直下に置くと PR の run (roundtrip-check) と schedule の run が同じ group に入り、GitHub の concurrency は同じ group の待機中の run を 1 つしか持たない (新しい run が入ると、待機中だった run は `cancel-in-progress: false` でも取り消される) ので、PR の push 2 回でその日の取得が job ごと取り消され、report の step も動かない (Issue が立たない)。前例: `deploy-supabase-migrations.yml` が同じ理由で group を `${{ github.ref }}` 入りに直した (同ファイルの round-3 是正の注記)。job に置いても、取得の run の待機中に取得の run (手動) がもう 1 つ入ると待機中の方は取り消される。新しい方も同じ 1 本道の取得なので daily は取れるが、手動の `tier` が `auto` 以外だと待機中だった schedule の層 (月曜の weekly など) が抜ける。手順書 §4 は「取得の実行中に手動で流すときは `tier` を `auto` にする」と書く |
| Docker イメージの取得 | `supabase db dump` (CLI が pg_dump を Supabase の postgres のイメージの中で動かす)・stats の `docker run` (同じイメージ)・`supabase-local.sh start` (restore_check と往復の検査) が、取得元の既定 `public.ecr.aws` からイメージを取る。GitHub のランナーは ECR の認証なしの上限 (`toomanyrequests`) に当たることがある (#1523。`docs/operations/ci-supabase-image-pull.md`) | dump の 3 回と stats は既存の `scripts/supabase-image-fallback.sh` を通して打ち (取得の一過性の失敗のときだけ `public.ecr.aws` → `ghcr.io` に替えてやり直す。§4.3)、`supabase-local.sh start` は中で同じライブラリ (`scripts/lib/supabase-image-pull.sh`) を使っている。どの取得元でも取れなかったときの終了コード 75 (`SIP_EXIT_PULL_UNAVAILABLE`。§5.1 の `IMAGE_PULL_UNAVAILABLE_EXIT_CODE`) を reason `image_pull_unavailable` に分ける (検査の赤・本番の不具合と区別する。§4.7)。2 つのスクリプトは変えない。`db-backup.yml` の `on.pull_request.paths` には足さない (このライブラリの変更は `tests/supabase-image-pull.test.ts` と、同じ `start` を使う security-regression.yml が PR で見ている) |
| 権限 | `permissions: { contents: read, issues: write }` | Issue の作成・更新・クローズだけ。PR・ブランチ・設定には触らない |
| 公開リポジトリ | ログは誰でも読める | 出すのは段の名前・件数・大きさ・ダイジェストの先頭 8 文字・所要秒だけ (§4.10) |

### 4.3 ダンプと検査 (Supabase の手順どおり)

```bash
# すべて supabase CLI 2.62.10 (既存の workflow と同じ版)。link は SUPABASE_ACCESS_TOKEN / SUPABASE_DB_PASSWORD (既存の secrets)
npx --yes supabase@2.62.10 link --project-ref flmeolcfutuwwbjmzyoz
# dump の 3 回は IMAGE_PULL_FALLBACK_SCRIPT を通して打つ (イメージの取得の一過性の失敗のときだけ取得元を替えてやり直す。§4.2)
bash scripts/supabase-image-fallback.sh --step "db-backup dump roles" -- \
  npx --yes supabase@2.62.10 db dump --linked -f "$WORK/roles.sql"  --role-only
bash scripts/supabase-image-fallback.sh --step "db-backup dump schema" -- \
  npx --yes supabase@2.62.10 db dump --linked -f "$WORK/schema.sql"
bash scripts/supabase-image-fallback.sh --step "db-backup dump data" -- \
  npx --yes supabase@2.62.10 db dump --linked -f "$WORK/data.sql"   --data-only --use-copy \
  -s public,auth,storage \
  -x storage.buckets_vectors -x storage.vector_indexes            # Supabase の backup-restore の手順と同じ除外 (DUMP_EXCLUDED_TABLES)
```

- data のスキーマを `-s public,auth,storage` (`DATA_DUMP_SCHEMAS`) に絞る (Supabase の手順との違いはこの 1 つ)。理由: CLI 2.62.10 の既定は cron・net などの拡張の表のデータも data.sql に入れる (§3.3)。`-s` が無いと、本番の data.sql には `COPY "cron"."job"` (15 行)・`COPY "cron"."job_run_details"` (541 行)・`COPY "net"."_http_response"` が入る。一方、復元先のローカルのスタックにも、ベースラインより新しい migration の `cron.schedule` で `cron.job` の行がある。このまま流すと、`COPY "cron"."job"` が重複キーで落ち、`--single-transaction` が全体を戻すので、往復の検査 (`roundtrip-check`) と月曜の restore_check が毎回赤になる。復元先の cron の表を空にして本番の行を入れる案は採らない: ローカルの pg_cron が本番のジョブ (本番の Edge Function を呼ぶもの) を動かしてしまうため。ジョブの定義は data.sql ではなく、catalog の段が本番の `cron.job` から `cron_jobs.sql` に書き出して書庫に入れる (migration に登録の SQL が無いジョブが 6 本ある。§3.3 の (5))。新しいプロジェクトへ復元したときは手順書 §6 でそれを流す。`cron.job_run_details`・`net` の応答は実行の記録で、復旧に要らない。

- 終了コードの読み方 (dump の 3 回と stats): 0 → 次へ / `IMAGE_PULL_UNAVAILABLE_EXIT_CODE` (75) → その段で reason `image_pull_unavailable` / ほかの非 0 → `dump_failed` (stats は `stats_failed`) / 段の時間切れ → `timeout`。やり直しの待ち (60 秒 × 周。既定 3 周で最大 3 分) は段の上限 (`STAGE_TIMEOUT_MINUTES`) の中に入る。
- `stats` (dump の前に psql。既存の `prod-schema-snapshot.yml` と同じ Docker イメージ `<取得元>/supabase/postgres:$(cat supabase/.temp/postgres-version)`、接続先は `$(cat supabase/.temp/pooler-url)?sslmode=require`、パスワードは `PGPASSWORD`。取得元は fallback が渡す `SUPABASE_INTERNAL_IMAGE_REGISTRY` (無ければ `DEFAULT_IMAGE_REGISTRY` = `public.ecr.aws`) で、`bash scripts/supabase-image-fallback.sh --step "db-backup stats" --stdout "$WORK/stats.txt" -- bash -c 'exec docker run --rm --network host -e PGPASSWORD "${SUPABASE_INTERNAL_IMAGE_REGISTRY:-public.ecr.aws}/supabase/postgres:${PG_IMAGE_TAG}" psql "$PG_URL" -At -v ON_ERROR_STOP=1 -c "$STATS_SQL"'` の形で打つ。`PG_IMAGE_TAG`・`PG_URL`・`STATS_SQL`・`PGPASSWORD` は env で渡し、コマンドラインに値を載せない。`ghcr.io/supabase/postgres` に同じ版があることは `docs/operations/ci-supabase-image-pull.md` が 2026-10-15 に確かめている): `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`・`SELECT count(*) FROM auth.users`・`SELECT pg_database_size(current_database())`。読むだけ。結果は manifest の `source` に**記録するだけ**で、verify・restore_check の突き合わせには使わない (3 回の `db dump` はそれぞれ別のスナップショットで、stats とも別の取引なので、その間の利用者の登録・退会や migration で数がずれる。S-19)。
- ダンプの出力の形 (CLI 2.62.10 の実物。verify・往復の検査・単体テストの偽物はすべてこの形に合わせる。出どころは §3.3):

| ファイル | 行の形 | verify での扱い |
|---|---|---|
| schema.sql | `CREATE TABLE IF NOT EXISTS "public"."<t>" (` (通常の表。CLI が `CREATE TABLE "` を書き換える) / `CREATE UNLOGGED TABLE "public"."<t>" (` (書き換えの対象外なので `IF NOT EXISTS` が付かない) | `SCHEMA_TABLE_LINE_PATTERN` で拾い、schema が `public` の表を数える |
| schema.sql | 本体を閉じる `);` (通常) / `)` の次の行が `PARTITION BY …;` (分割の親。pg_dump は `)` と `PARTITION BY` を別の行に書く) | 分割の親は除く (pg_dump は親に COPY を出さない)。分割の子は通常の表と同じ形 (後で `ATTACH PARTITION`) なので数える |
| schema.sql | `--` で始まる行は無い (CLI が消す) | 見ない |
| data.sql | 1 行目 `SET session_replication_role = replica;` (CLI が足す)・pg_dump の注釈 (`--` で始まる行) は残る | 注釈は数えない |
| data.sql | `-s public,auth,storage` なので、COPY のスキーマは `public`・`auth`・`storage` だけ | ほかのスキーマの COPY があれば落とす (verify の 6) |
| data.sql | `COPY "<schema>"."<t>" ("<列>", …) FROM stdin;` → 本体の行 (text 形式。1 行 = 1 行) → `\.` | `DATA_COPY_LINE_PATTERN` で拾い、`COPY_END_LINE` までを数える。空の表も `COPY … FROM stdin;` と `\.` が出る |
| data.sql | 末尾: `-- PostgreSQL database dump complete` (`DUMP_COMPLETE_TRAILER`) → `--` → (`\restrict` に対応した版の pg_dump なら `-- \unrestrict <鍵>`。CLI が注釈にする。出ない版もあるので、有っても無くても通す) → CLI が足す `RESET ALL;` (`DATA_DUMP_FINAL_LINE`) | 完了の判定 (verify の 2)。`RESET ALL;` は pg_dump が 0 で終わったときだけ書かれる (dump_data.sh は `set -euo pipefail`) |

単体テストの data.sql の偽物の骨組み (この形で書く。§15):

```text
SET session_replication_role = replica;
-- Dumped by pg_dump version 17.6
SET statement_timeout = 0;
COPY "auth"."users" ("instance_id", "id", "email") FROM stdin;
00000000-0000-0000-0000-000000000000	11111111-1111-1111-1111-111111111111	a@example.com
\.
COPY "public"."admin_audit_logs" ("id", "action_type") FROM stdin;
22222222-2222-2222-2222-222222222222	backup.daily.completed
\.
COPY "public"."family_members" ("id") FROM stdin;
\.
--
-- PostgreSQL database dump complete
--
-- \unrestrict abc123
RESET ALL;
```

- `catalog` (dump の後・verify の前。本番は読むだけ。dump を流しても戻らないもの (§3.3) を書庫に入れる。psql の打ち方は §4.12):
  1. カタログ: `$WORK/catalog/` を作り、runner の psql で既存の `scripts/baseline/snapshot_catalog.sql` (`CATALOG_SNAPSHOT_SQL`。`BEGIN TRANSACTION READ ONLY` の中で `\copy` し、最後に `ROLLBACK`。prod-schema-snapshot.yml と `supabase-local.sh verify` が使うのと同じファイルで、変えない) を流す。`cwd` が `$WORK/catalog` なので、CSV 7 つ (`CATALOG_CSV_FILES`) がそこに書かれる。
  2. 台帳と cron のジョブ: `LEDGER_VERSIONS_SQL` (`SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;`) を `count` の形で流し、標準出力を `$WORK/ledger.txt` に書く。続けて `CRON_JOBS_SQL` (§5.1。`cron.job` を読むだけ) を同じ `count` の形で流し、標準出力を `$WORK/cron_jobs.sql` (`CRON_JOBS_FILE`) に書く。中身は、ジョブの名前の順 (`COLLATE "C"`) に 1 ジョブ 1 行の `SELECT cron.schedule_in_database('<名前>', '<予定>', pg_catalog.convert_from(pg_catalog.decode('<command の UTF-8 の hex>', 'hex'), 'UTF8'), '<database>', NULL, '<t/f>');` (username は取得した人と同じ postgres なので NULL。違う username のジョブだけ `'<username>'`。§5.1 の `CRON_JOBS_SQL` の注) (command は複数行のものがあるので hex にして 1 行に収める) と、最後の 1 行の `DO $cron_check$ …` (流した先の `cron.job` の名前の集合が書庫の集合と違えば例外。手順書 §6 の (6) が使う)。名前の無いジョブと `\` を含む名前 (`%L` が `E'…'` にする) は `CRON_SCHEDULE_LINE_PATTERN` に当たらず、4 の判定で `catalog_failed` になる (本番の 15 本はどれも当たる)。
  3. 補いの SQL: `python3 scripts/baseline/build_restore_fixups.py "$WORK/catalog" "$WORK/schema.sql" "$WORK/fixups.sql"` (`RESTORE_FIXUPS_BUILDER_SCRIPT`。新設。§5.5)。既存の `build_baseline.py` の 3 つの関数をそのまま呼んでつなぐので、ローカルのベースラインが `prod_function_acl.sql`・`prod_table_acl.sql`・`prod_storage.sql` で補うのと同じ作り方になる。最後に、`catalog_auth_storage_triggers.csv` のアプリのトリガー (§3.3 の (6)) を同じ名前が無いときだけ作る DO を 1 本 1 文で足す (`build_app_trigger_sql`。アプリのトリガーが無ければ何も足さない)。
  4. 判定 (`checkCatalogCapture`。子プロセスの失敗でないので reason を直接決める): `CATALOG_CSV_FILES` の 7 つがあって 1 行 (見出し) 以上・`parseLedgerVersions(ledger.txt)` が null でない・`parseCronJobsSql(cron_jobs.sql)` が null でない (ジョブ 0 本でも最後の行があれば読める)・`fixups.sql` が空でない → manifest の `ledger` (`LedgerSummary` = 版の数と最大) と `cron_jobs` (ジョブの数)。満たさなければ `catalog_failed`。psql・python3 の非 0 は `classifyFailure('catalog', …)` (= `catalog_failed`)。
  - 失敗したら送らない (dump の失敗と同じ道。§4.7)。権限を戻す SQL の無い書庫を新しいプロジェクトへ流すと anon に関数が開くので、completed にしない。
  - 台帳を data.sql に入れない理由: (a) 本番の台帳の表は 6 列 (§3.3) で、CLI が新しいプロジェクト・ローカルのスタックに作る台帳の表と列がそろう保証が無い (b) ローカルの restore_check の先にはローカルのスタックの台帳 (ベースラインの版と新しい migration の行) があって重なる。台帳は版の一覧 (`ledger.txt`) だけを持ち、新しいプロジェクトでは CLI の `migration repair --status applied <版…>` で戻す (CLI が自分の形で表を作り、版ごとのファイルから name と statements を入れる。手順書 §6)。repair は版ごとのファイルが要るので、restore_check がファイルの有無を確かめる (§4.8 の 8)。
  - 残る窓: verify の 4 と同じく、schema.sql と catalog は別の時点なので、その間に関数・表・ポリシーを変える migration が本番に入ると、`fixups.sql` が無い関数を指して落ちるか、カタログの比べで落ちる (月曜の restore_check)。対象物は R2 にあり、Issue が立つ。`workflow_dispatch` で取り直せば通る (手順書 §10)。

- `verify` (DB に繋がない。基準は live の数ではなくダンプの中身): `schema.sql` を 1 行ずつ読む `scanSchemaSql` と、`data.sql` を 1 行ずつ読む `scanDataSql` (GB 級なので全体を読み込まない) の結果で判定する。
  1. 3 ファイルが空でない。
  2. `data.sql` の COPY の本体の外に `DUMP_COMPLETE_TRAILER` と同じ行があり (`complete_trailer_seen`)、その最後の出現より後の行のうち、空でも `--` で始まる注釈でもない行が `DATA_DUMP_FINAL_LINE` (`RESET ALL;`) の 1 行だけ (`statements_after_trailer` が `['RESET ALL;']`)。途中で切れたダンプは完了行が無く、pg_dump が失敗したダンプは `RESET ALL;` が無い。
  3. すべての `COPY … FROM stdin;` の後に `\.` の行がある (`unterminated_copy` が null)。
  4. `schema.sql` の public の表の集合 (`SchemaSqlScan.public_tables`) が空でなく、`data.sql` の `COPY "public".` の表の集合 (`DataSqlScan.public_copy_tables`) と**ちょうど**同じ (名前は引用符を外し、`""` を `"` に戻して比べる)。どちらかの形が CLI の版の変更で変わって 0 になったら、ここ (schema が空) か 5 で落ちる (0 = 0 で素通りしない)。
  5. `COPY "auth"."users"` と `COPY "public"."admin_audit_logs"` の行がある (`copy_row_counts` に `auth.users` と `public.admin_audit_logs` のキーがある)。
  6. `data.sql` に `DATA_DUMP_SCHEMAS` の外のスキーマの COPY が無く (`DataSqlScan.unexpected_copy_tables` が空。CLI が `-s` を無視するように変わったら、ここで落ちる)、`schema.sql` に public の外の表が無い (`SchemaSqlScan.non_public_tables` が空。schema.sql は CLI が auth・storage などの管理スキーマを外すので、ここに出るのは利用者が足したスキーマの表で、そのデータは `-s` の外になり取れない。足したときは `DATA_DUMP_SCHEMAS` に足す)。
  満たさなければ reason `dump_incomplete` で止める (送らない。details の expected / actual は 4 の表の数 (schema / data)、2・3・5 で落ちたときは expected = actual = schema の表の数、6 で落ちたときは expected = 0・actual = 外れた表の数)。満たせば `dumped` (`DumpCounts`: `COPY "public".` の表の数・`COPY "auth"."users"` の行数・`COPY "public"."admin_audit_logs"` の行数) を manifest に入れ、restore_check の基準にする。
  - 残る窓: schema.sql と data.sql も別のスナップショットなので、その数分の間に本番へ表を足す migration が入ると 4 で落ちる (誤検知)。migration の本番適用は main へのマージのとき (`deploy-supabase-migrations.yml` の push。ほかは手動の workflow_dispatch) だけで、02:23 JST に重なることは稀。落ちても対象物は送らず Issue が立つだけで、`workflow_dispatch` で取り直せば通る (手順書 §10)。
- 書庫: `tar -C "$WORK" -cf - roles.sql schema.sql data.sql fixups.sql cron_jobs.sql ledger.txt catalog | zstd -T0 -6 -o "$WORK/<base>.tar.zst"` (並びは `ARCHIVE_ENTRIES` の 7 つ。`ZSTD_LEVEL = 6`: 19 は数倍遅く、縮みは 1 割しか変わらない)。
- 暗号化: `age -r "$BACKUP_AGE_RECIPIENT" -o "$WORK/<base>.tar.zst.age" "$WORK/<base>.tar.zst"` → 成功したら `.tar.zst` を消す。平文 (`ARCHIVE_ENTRIES`) は restore_check が要るので cleanup まで残す (umask 077 の一時ディレクトリ)。
- ダイジェスト: `sha256sum <base>.tar.zst.age > <base>.sha256` (暗号化後のファイルに対して。復元のとき `sha256sum -c` で確かめる)。
- manifest (`<base>.manifest.json`。暗号化しない。個人情報を含まない): §5.1 の `BackupManifest`。

### 4.4 保存先・暗号化・秘密の置き場

| 物 | 置き場 | 種別 | 備考 |
|---|---|---|---|
| `BACKUP_R2_ACCOUNT_ID` | GitHub Actions variable (復元のときはオーナーの手元のシェルにも同じ値) | 公開してよい | endpoint `https://<account>.r2.cloudflarestorage.com` (`r2EndpointUrl`) |
| `BACKUP_R2_BUCKET` | GitHub Actions variable (復元のときはオーナーの手元のシェルにも同じ値) | 公開してよい | 既定の名前 `homegohan-db-backups` |
| `BACKUP_R2_ACCESS_KEY_ID` / `BACKUP_R2_SECRET_ACCESS_KEY` (取得用) | GitHub Actions secret | 秘密 | R2 の API トークン「Object Read & Write」をこのバケットだけに絞る。Lifecycle・lock を変える権限は持たせない |
| `BACKUP_R2_ACCESS_KEY_ID` / `BACKUP_R2_SECRET_ACCESS_KEY` (復元用) | オーナーのパスワードマネージャー。`restore` と手順書 §6 の (1) を流すときだけ手元のシェルの同じ名前に置く (値は手順書・Issue・リポジトリに書かない) | 秘密 | 別の R2 の API トークン「Object Read only」をこのバケットだけに絞る。取得用の Read & Write のトークンは手元に写さない (GitHub の secret は読み出せず、手元に写すと漏れたときに書ける鍵が増える)。`restore` が読む 4 つの名前は `RESTORE_REQUIRED_ENV_NAMES` |
| `BACKUP_AGE_RECIPIENT` | GitHub Actions variable | 公開してよい (公開鍵) | `age1…`。manifest にも写す (どの鍵で暗号化したかを後から辿る) |
| `BACKUP_DUMP_TIMEOUT_MINUTES` / `BACKUP_UPLOAD_TIMEOUT_MINUTES` / `BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES` / `BACKUP_ZSTD_LEVEL` | GitHub Actions variable (任意。無ければ §5.1 の既定) | 公開してよい | DB が育ったときの調整用 (§5.1 の `RUN_TUNING_ENV`)。形が違う値は `not_configured` で止める (黙って既定に戻さない) |
| age の秘密鍵 (identity) | オーナーのパスワードマネージャー + 印刷した控え 1 通 (金庫) | 秘密。**CI・Vercel・Supabase・リポジトリには置かない** | リポジトリ (公開) の外の空のディレクトリで `KEYDIR="$(mktemp -d)"` → `age-keygen -o "$KEYDIR/backup.key"` で作り、パスワードマネージャーと控えに保管したら `rm -rf "$KEYDIR"` でファイルを消す (作業ツリーに作ると `git add` で公開される)。四半期の訓練 (S-11) が、鍵で復号できることを兼ねて確かめる |
| `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` | GitHub Actions secret (既存) | 秘密 | `prod-schema-snapshot.yml`・`daily-consistency-check.yml` と同じ |
| `GITHUB_TOKEN` | 自動 | — | Issue の作成・更新・クローズ。report の step の env `GH_TOKEN` に渡す (`createGitHub` の `gh api` が読む)。ほかに読む環境変数は §13 |

- 送信・取り出しは aws cli v2 の S3 互換 API。aws を打つ回はどれも (取得の upload・copy・inventory も、`restore` の download も)、argv の最後に `--endpoint-url <r2EndpointUrl(BACKUP_R2_ACCOUNT_ID)> --region auto` (`R2_REGION`) を付け、`CommandRunner` の env に `awsCommandEnv(env)` を渡す (§5.1。env は親の環境に重ねる)。aws cli は `BACKUP_R2_*` を読まないので、`awsCommandEnv` が `AWS_ACCESS_KEY_ID` ← `BACKUP_R2_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY` ← `BACKUP_R2_SECRET_ACCESS_KEY` に写し、`AWS_REQUEST_CHECKSUM_CALCULATION=when_required`・`AWS_RESPONSE_CHECKSUM_VALIDATION=when_required` (`AWS_CHECKSUM_ENV`。aws cli 2.23 以降が既定で付ける CRC のヘッダーを R2 が受け付けないことがあるため) を足し、手元のシェルの `AWS_SESSION_TOKEN`・`AWS_PROFILE` を外す (別の AWS の一時鍵・プロファイルが混ざると署名が合わない)。鍵の値は argv・ログに出さない (`redactForLog` は名前に KEY / SECRET を含む env の値を伏せる)。バケットは `BACKUP_R2_BUCKET`、キーは `objectKey` (`restore` は `--key` と `siblingKeys`) の値で、URI は `r2ObjectUri(bucket, key)` = `s3://<bucket>/<key>`。

| 段 | aws の argv (`aws` の後。どれも最後に `--endpoint-url <endpoint> --region auto`) | 出力の扱い |
|---|---|---|
| upload (取得。`.tar.zst.age` → `.sha256` → `.manifest.json` の 3 回) | `s3 cp <一時ディレクトリのファイル> s3://<bucket>/<daily のキー>` | 0 でなければ `upload_failed` |
| upload の確かめ (取得。3 回) | `s3api head-object --bucket <bucket> --key <daily のキー>` | 標準出力の JSON の `ContentLength` が手元の大きさと違えば `upload_size_mismatch` |
| copy (取得。層ごとに 3 回) | `s3 cp <一時ディレクトリのファイル> s3://<bucket>/<層のキー>` (upload と同じ手元のファイルを層のキーへもう一度送る。R2 の中のコピー `s3 cp s3://… s3://…` は使わない。下の注) | 0 でなければその層を `copy_failed` |
| copy の確かめ (取得。層ごとに 3 回) | `s3api head-object --bucket <bucket> --key <層のキー>` | 標準出力の JSON の `ContentLength` が手元の大きさと違えばその層を `copy_failed` |
| inventory (取得。層ごとに 1 回) | `s3api list-objects-v2 --bucket <bucket> --prefix <層>/ --no-paginate --query KeyCount --output text` (1 回の応答は 1,000 件まで。保持の上限で各層は daily 90・weekly 約 160・annual 約 20 件なので 1 回で収まる) | 標準出力の整数 (`InventoryCounts`)。0 でない・整数でなければ警告 `inventory_failed` |
| download (`restore`。3 回) | `s3 cp s3://<bucket>/<キー> <一時ディレクトリ>/<キーの最後の部分>` | 0 でなければ `download_failed` |

- 送ったら `head-object` の `ContentLength` を手元の大きさと突き合わせる (`upload_size_mismatch`)。copy も同じ (違えばその層の `copy_failed`)。
- copy を R2 の中のコピーにしない理由 (§3.3 の実測): aws cli の `s3 cp s3://… s3://…` は、`--copy-props` の既定では 8 MB 以上の `.tar.zst.age` のコピーで R2 に無い `GetObjectTagging` を呼び、`--copy-props none` (と `metadata-directive`) では数 KB の `.sha256`・`.manifest.json` の `CopyObject` に R2 が対応していない `x-amz-tagging-directive: REPLACE` を付ける。どちらでも月曜・1/1 の copy が毎回 `copy_failed` になり、単体テスト (偽の `CommandRunner`) では分からない。手元の 3 ファイルは cleanup まで一時ディレクトリに残っている (§4.3 の暗号化は `.tar.zst` だけを消す) ので、upload と同じ `s3 cp <ファイル> s3://…` で層のキーへ送る。R2 に打つ操作は daily の upload と同じもの (PutObject・マルチパートの送信・HeadObject) だけになり、daily が通る日は weekly / annual も同じ操作で通る。費用と時間は §4.6 (月曜・1/1 だけ送る量が 1 組増える)。`s3api copy-object` (1 回の `CopyObject`) も採らない: R2 の文書に 1 回のコピーの大きさの上限が書かれておらず、DB が育ったときに通るかを確かめられない。copy の子の時間の上限は upload と同じ値 (§4.12)。
- 鍵の入れ替え: 新しい鍵対を作り variable を替えるだけ。古い秘密鍵は、その鍵で暗号化した最後の対象物の保持 (annual は 7 年) が切れるまで捨てない (手順書)。

### 4.5 R2 の設定 (オーナーが 1 回行う。手順書 §12)

Lifecycle と bucket lock の設定は手で書き写さず、`node scripts/backup-db.mjs r2-config --bucket <名前> --out-dir <dir>` が §5.1 の定数 (`RETENTION_DAYS`・`INFREQUENT_ACCESS_AFTER_DAYS`・`R2_ABORT_MULTIPART_AFTER_DAYS`) から作る (`buildR2LifecycleConfig`・`buildR2LockCommands`)。出すもの = `<dir>/r2-lifecycle.json` (次の JSON と同じ中身。`wrangler r2 bucket lifecycle set --file` が受ける Cloudflare の API の本文の形で、日数は秒 (`日数 × SECONDS_PER_DAY`) にする。S3 の形 (`Rules`・`Expiration.Days`・`STANDARD_IA`) は wrangler が `rules` の配列が無いとして拒むので使わない。§3.3) と、`wrangler r2 bucket lifecycle set` 1 行 + `wrangler r2 bucket lock add` 3 行 (標準出力)。手順書はこの subcommand を流す手順だけを書き、JSON を写さない (写しがずれる発生源を消す)。

```json
{ "rules": [
  { "id": "daily-expire", "enabled": true, "conditions": { "prefix": "daily/" },
    "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 2592000 } } },
  { "id": "weekly-ia", "enabled": true, "conditions": { "prefix": "weekly/" },
    "storageClassTransitions": [ { "condition": { "type": "Age", "maxAge": 2592000 }, "storageClass": "InfrequentAccess" } ],
    "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 31622400 } } },
  { "id": "annual-ia", "enabled": true, "conditions": { "prefix": "annual/" },
    "storageClassTransitions": [ { "condition": { "type": "Age", "maxAge": 2592000 }, "storageClass": "InfrequentAccess" } ],
    "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 220924800 } } },
  { "id": "abort-multipart", "enabled": true, "conditions": {},
    "abortMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 604800 } } }
] }
```

```bash
# r2-config が標準出力に出す 4 行 (バケット名が既定のとき)
npx wrangler r2 bucket lifecycle set homegohan-db-backups --file <dir>/r2-lifecycle.json
npx wrangler r2 bucket lock add homegohan-db-backups --name daily-30d    --prefix daily/  --retention-days 30
npx wrangler r2 bucket lock add homegohan-db-backups --name weekly-366d  --prefix weekly/ --retention-days 366
npx wrangler r2 bucket lock add homegohan-db-backups --name annual-2557d --prefix annual/ --retention-days 2557
```

- lock の日数と Lifecycle の日数を同じにする (lock が Lifecycle の削除より優先されるので、lock が長いと消えず、短いと攻撃者が消せる窓ができる)。どちらも `RETENTION_DAYS` の 1 か所から作るので、ずれは `tests/backup-db.test.ts` の `buildR2LifecycleConfig` / `buildR2LockCommands` / `LOCK_MAX_AGE_SECONDS` の it で機械的に見張る (§15)。
- lock の名前は `<層>-<日数>d` (`buildR2LockCommands` が作る)。
- Infrequent Access は最短 30 日の課金なので、遷移は 30 日より前にしない。
- 各層の `deleteObjectsTransition.condition.maxAge` は `LOCK_MAX_AGE_SECONDS[層]` と同じ値 (どちらも `RETENTION_DAYS[層] × SECONDS_PER_DAY`)。`abort-multipart` は `conditions` に `prefix` を持たない (バケット全体。wrangler の `lifecycle add` が接頭辞なしで作る形と同じ)。
- `lifecycle set` はバケットの既存のルールを全部置き換える (Cloudflare が既定で付けるマルチパートの 7 日の破棄も置き換わるので、`abort-multipart` を自分で持つ)。

### 4.6 費用の見積もり (2026-10-16 の実測 DB 2.4 GB から)

| 項目 | 見積もり | 式 |
|---|---|---|
| 対象物 1 つの大きさ | 0.5〜1.5 GB (text の dump は DB より大きく、zstd で 1/3〜1/5。`dataset_menu_sets` の埋め込み (vector) は縮みにくい) | 実測は最初の取得の manifest の `size_bytes` で置き換える |
| R2 の保管 | daily 30 × 1 GB = 30 GB Standard ($0.45) + weekly 52 × 1 GB (30 日後 IA) ≈ $0.55 + annual 7 × 1 GB ≈ $0.07 → **月 $1〜2** | Standard $0.015、IA $0.01 / GB-月。無料枠 10 GB を引けばさらに小さい |
| R2 の操作 | 1 日 3 送信 (`.tar.zst.age` は 8 MB ごとのマルチパートで、1 GB あたり約 130 回の Class A) + 月曜・1/1 は同じ送信をもう 1 組 (copy) + head-object・list → Class A は月 5,000 回ほど → $0.00 | Class A $4.50 / 100 万・Class B $0.36 / 100 万。無料枠は Class A 月 100 万回・Class B 月 1,000 万回 (developers.cloudflare.com/r2/pricing) |
| 取り出し | 無料 (egress) + IA の取り出し $0.01 / GB | 訓練で年 4 回 × 1 GB |
| GitHub Actions | 公開リポジトリは無料。1 回 10〜30 分 (月曜・1/1 は、復元の検査の約 15 分と copy の送り直しの数分が足される) | — |
| DB が 10 倍 (24 GB) になったら | 月 $10〜20。取得 1〜2 時間。runner のディスク (14 GB) を超えるので §21 のパイプ化が要る | — |

### 4.7 未設定・失敗のときの動き

| 条件 | 段 | reason | 平文 | 監査行 | Issue | 終了コード |
|---|---|---|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` が無い・link が通らない | link | `link_failed` | 作らない | 書けない | 立てる | 1 |
| R2 の 4 つ・`BACKUP_AGE_RECIPIENT` のどれかが無い・空・形が違う (`age1` で始まらない) | config | `not_configured` (details に無い名前) | 作らない | `failed` | 立てる | 3 |
| stats の psql が失敗 | stats | `stats_failed` | 作らない | `failed` | 立てる | 1 |
| stats・dump の Docker イメージをどの取得元からも取れない (fallback の終了 75。§4.2) | stats / dump | `image_pull_unavailable` | 作らない (stats) / 消す (dump) | `failed` | 立てる (本文の reason で「検査の赤ではない。時間をおいて `workflow_dispatch` で取り直す」と分かる。手順書 §10) | 1 |
| dump が失敗・時間切れ | dump | `dump_failed` / `timeout` | 消す | `failed` | 立てる | 1 |
| catalog の psql (カタログ・台帳・cron のジョブ) や python3 (`build_restore_fixups.py`) が失敗・時間切れ、または CSV・台帳・`cron_jobs.sql`・`fixups.sql` がそろわない・読めない (§4.3 の catalog の 4) | catalog | `catalog_failed` / `timeout` | 消す | `failed` | 立てる | 1 |
| verify が合わない | verify | `dump_incomplete` | 消す | `failed` | 立てる | 1 |
| archive / encrypt が失敗 | 同名 | `archive_failed` / `encrypt_failed` | 消す | `failed` | 立てる | 1 |
| upload が失敗・大きさが合わない | upload | `upload_failed` / `upload_size_mismatch` | 消す | `failed` | 立てる | 1 |
| copy (層のキーへの送り直し・その大きさの確かめ) が失敗 | copy | `copy_failed` (時間切れは `timeout`) | 消す | daily は `completed`、その層は `failed` (stage `copy`) | 立てる | 1 |
| inventory が失敗 | inventory | `inventory_failed` | 消す | `completed` (inventory 無し) + 警告ログ | 立てない | 0 |
| restore_check が失敗 | restore_check | `restore_check_failed` / `restore_env_failed` / `image_pull_unavailable` (`supabase-local.sh start` の終了 75) | 消す | daily は `completed`、copy に成功した weekly / annual は `failed` (stage `restore_check`) | 立てる | 1 |
| audit の psql が失敗・時間切れ (§4.12。全層を 1 回の取引で書く) | audit | `audit_failed` / `timeout` | 消す | 1 行も書かれない (途中まで書けることは無い)。結果ファイルの `failures` に plan の全層の {stage `audit`, reason} を足し、`completed` は変えない (R2 の対象物は残っている。S-20) | 立てる | 1 (config の失敗のあとなら 3) |
| 段の処理の中の予期しない例外 (子プロセスの失敗・時間切れでないもの。JSON の組み立て・fs の失敗など) | その段 | `unknown` (`classifyFailure`) | その段の失敗と同じ | その段の失敗と同じ (下の「失敗の後に進む段」) | 立てる | 1 |
| `runBackup` の外の例外 (段の外の記帳の誤り = 実装の不具合。`runCli` の catch が受ける) | — | — (結果ファイルの `failures` は空・status `failed`) | runner の一時ディレクトリに残りうるが job の終わりに runner ごと消える | 書けたかどうか分からない (`audit_written: false`) | report の step が立てる (「段の失敗として記録できずに終わった」) | 1 |
| run の step の時間切れ (`RUN_STEP_TIMEOUT_MINUTES`)・取り消し (S-17) | (どの段でも) | — (結果ファイルが無い) | runner の一時ディレクトリに残りうるが job の終わりに runner ごと消える | 書けない (audit まで行かない) | report の step が立てる | step の失敗 |
| 調整用の variable (`RUN_TUNING_ENV`) の形が違う (整数でない・範囲の外) | config | `not_configured` (details の `missing` にその名前) | 作らない | `failed` | 立てる | 3 |

失敗の後に進む段 (§8.3 の状態遷移表と同じ):

- link の失敗 → audit をしない (DB に繋げない) → cleanup → 結果ファイル (`audit_written: false`)。
- config・stats・dump・catalog・verify・archive・encrypt・upload の失敗 → 残りの段 (copy・inventory・restore_check) をしない → audit (plan の全層を同じ stage / reason の `failed` で 1 行ずつ) → cleanup → 結果ファイル。
- copy の失敗は層ごと。失敗した層だけが stage `copy` の `failed` になり、daily と copy に成功した層は先へ進む: inventory はする (失敗しても進む) / restore_check は「plan の weekly / annual のうち copy に成功した層」が 1 つ以上あるときだけ 1 回する (結果はその層の `completed` の details に入る。失敗ならその層を stage `restore_check` の `failed` に)。copy に成功した層が無ければ restore_check をしない (結果を載せる行が無い) → audit。1 つの層の監査行は 1 行だけで、先に失敗した段の stage / reason を持つ。
- inventory の失敗 (予期しない例外を含む。reason は `inventory_failed` のまま) → 警告だけで進む。restore_check の失敗 → audit へ進む。audit の失敗 → cleanup → 結果ファイル (`audit_written: false`。`failures` に plan の全層の {stage `audit`} を足す。同じ層が copy などの失敗と 2 回出ることがある)。
- 段の処理の中の予期しない例外 (reason `unknown`) は、その段の失敗と同じ道を進む (例: dump の段なら上の 2 つ目、copy の段ならその層だけ)。`runBackup` は段の失敗を RunResult に変えて返し、reject しない。段の判定が決める reason (`checkConfig`・`checkRestoreConfig` の `not_configured`・`checkCatalogCapture` の `catalog_failed`・`verifyDumpFiles` の `dump_incomplete`・head-object の `upload_size_mismatch`・`verifyChecksum` の `checksum_mismatch`・展開した中の `ARCHIVE_ENTRIES` の欠けの `extract_failed`・§4.8 の判定) は例外にせず直接その値にするので、`unknown` にはならない。
- cleanup の失敗 (一時ディレクトリを消せない) は警告のログだけで、結果 (終了コード・`failures`) を変えない (`classifyFailure` に渡さない)。
- `runBackup` が reject したとき (段の外の記帳の誤り) は、`runCli` の catch が `unexpectedFailureReport` (status `failed`・`failures` 空・exit_code 1) を結果ファイルに書いて 1 で終わる (§5.1)。

`restore` サブコマンド (オーナーが手元で流す。監査行・Issue は作らない。訓練の結果は画面で記録する。段は §5.1 の `RESTORE_STAGES`):

| 条件 | 段 | reason | 平文 | 標準エラー出力 | 終了コード |
|---|---|---|---|---|---|
| `--key` が `daily/` `weekly/` `annual/` で始まらない・`.tar.zst.age` で終わらない・`--identity-file` が無い・`--slot` が `LOCAL_SLOT_MIN`〜`LOCAL_SLOT_MAX` の整数でない (省けば `LOCAL_SLOT_DEFAULT`。下の引数の表) | (引数) | — | 作らない | 使い方 | 2 |
| R2 の 4 つ (`RESTORE_REQUIRED_ENV_NAMES`) のどれかが手元のシェルに無い・空、または調整用の `RUN_TUNING_ENV` の形が違う (`checkRestoreConfig`。`BACKUP_AGE_RECIPIENT` は見ない) | config | `not_configured` | 作らない (一時ディレクトリも作らず、aws・age・`supabase-local.sh` を呼ばない) | 段と reason・無い (形が違う) 名前 (値は出さない) | 3 |
| R2 から 3 ファイル (`.tar.zst.age`・`.sha256`・`.manifest.json`) を取れない (§4.4 の download の aws が 0 でない。鍵が違う・権限が無い・キーが無いも同じ)・時間切れ (子 1 つずつ `restoreStageTimeoutMs('download', …)`) | download | `download_failed` / `timeout` | 作らない | 段と reason | 1 |
| `.sha256` の値と取った `.age` の SHA-256 が合わない | checksum | `checksum_mismatch` | 作らない (復号しない) | 段と reason・両方のダイジェストの先頭 8 文字 | 1 |
| age が復号できない (鍵が違う・鍵を失くした。S-16)・時間切れ | decrypt | `decrypt_failed` / `timeout` | 作らない | 段と reason | 1 |
| zstd / tar が展開できない・展開した中に `ARCHIVE_ENTRIES` のどれかが無い (子プロセスの失敗でないので reason を直接決める)・時間切れ | extract | `extract_failed` / `timeout` | 消す | 段と reason (無い名前) | 1 |
| `psql` か `python3` が無い (`psql --version`・`python3 --version` が 0 でない)・ローカルのスタックが起きない・`env` から接続先が取れない (`parseLocalDbUrl` が null)・時間切れ | restore_env | `restore_env_failed` (`supabase-local.sh start` の終了 75 は `image_pull_unavailable`、時間切れは `timeout`) | 消す | 段と reason | 1 |
| 復元の psql (§4.12 の reset・restore・fixups・count・復元した DB の catalog) が 0 でない・roles.sql に 42710 のほかの SQLSTATE の失敗がある (`countRoleRestoreErrors` の `others`)・数が manifest の `dumped` と合わない・数の出力が読めない (`parseRestoreCounts` が null)・`verify_baseline.py` が 0 でない、または要約の行が読めない (権限・ポリシー・バケットが取得の時点と違う)・auth・storage の表のアプリのトリガーが取得の時点と違う、またはトリガーの CSV が読めない (`appTriggerChecks`)・台帳が manifest の `ledger` と違う、または `supabase/migrations/` にファイルの無い版がある (`ledgerChecks`)・`cron_jobs.sql` が読めない、またはジョブの数が manifest の `cron_jobs` と違う (`cronJobsChecks`) | restore / restore_check | `restore_check_failed` (時間切れは `timeout`) | 消す | 段と reason・`expected` / `actual`・`others` の SQLSTATE・`verify_baseline.py` の出力の全部 (手元なので `[error]` の行も)・ファイルの無い版 | 1 |
| 成功 | — | — | 消す | 数 (`RestoreCheckResult`。cron のジョブの数を含む) | 0 |

- `restore` は復元したローカルのスタックを止めない (オーナーがそのまま smoke を流すため)。止めるのは `LOCAL_CI_SLOT=<restore に渡した枠> bash scripts/supabase-local.sh stop` を手で (枠 0 なら `LOCAL_CI_SLOT` は省ける)。
- `roundtrip-local` も起動したローカルのスタックを自分では止めない (CI では roundtrip-check job の `Stop local Supabase` の step (`if: always()`) が止める)。手元や共有の機械で流したときは、終わったら `LOCAL_CI_SLOT=<roundtrip-local に渡した枠> bash scripts/supabase-local.sh stop` で止める。`restore` / `roundtrip-local` は local-ci.sh の枠のロックを取らないので、止め忘れたスタックはロックを持たずにその枠のポートを使い続け、その枠を取った local-ci.sh は `slot:ports` の赤で integration / e2e を回さずに終わる。

CLI の引数 (`parseArgs`。サブコマンドは 1 つ目の引数。どの誤りも「標準エラー出力に使い方 → 終了 2」で、結果ファイル・監査行・Issue を作らず、R2・DB・ローカルのスタックに触れない。知らないオプション・同じオプションの 2 回・値の無いオプション・知らないサブコマンドも同じ):

| サブコマンド | オプション | 必須 | 既定 | 受け付ける値 (外れたら終了 2) |
|---|---|---|---|---|
| `run` | `--tier` | 任意 | `auto` | `auto` / `BACKUP_TIERS` の 3 つ |
| `run` | `--result-file` | 任意 (workflow では必ず渡す) | 無し (結果ファイルを書かない) | 空でないパス |
| `restore` | `--key` | 必須 | — | `siblingKeys` が null でないキー (`daily/` `weekly/` `annual/` で始まり `.tar.zst.age` で終わる) |
| `restore` | `--identity-file` | 必須 | — | 空でないパス (ファイルがあるかは decrypt の段で分かる = `decrypt_failed`) |
| `restore` / `roundtrip-local` | `--slot` | 任意 | `LOCAL_SLOT_DEFAULT` (0) | `LOCAL_SLOT_MIN` (0)〜`LOCAL_SLOT_MAX` (9) の 10 進の整数 (`/^[0-9]+$/` で、`Number` にして範囲の中。`-1`・`1.5`・`a`・`10` は誤り)。`scripts/lib/local-ci-slot.sh` の `LCS_SLOT_MAX` と同じ上限で、`supabase-local.sh` の `LOCAL_CI_SLOT` に渡す (§5.1 の `LOCAL_SLOT_ENV`) |
| `report-issue` | `--result-file`・`--run-outcome`・`--run-url` | 3 つとも必須 | — | `--run-outcome` は `STEP_OUTCOMES` の 4 つ。ほかの 2 つは空でない文字列 (結果ファイルが無い・読めないのは誤りでなく `parseRunReport` の null) |
| `r2-config` | `--bucket`・`--out-dir` | 2 つとも必須 | — | 空でない文字列 |
| `help` (`--help`) | — | — | — | 使い方を標準出力に出して終了 0 |

- `run` は `--slot` を受け付けない (取得の restore_check は CI の枠 0 で、`Stop local Supabase` の step も枠を指定しない。渡せば知らないオプションで 2)。`run` の中の `localPgUrl` は `LOCAL_SLOT_DEFAULT` で呼ぶ。

`report-issue` サブコマンド (workflow の `Report (Issue)` の step。監査行は書かない):

| 条件 | Issue | 標準エラー出力 | 終了コード |
|---|---|---|---|
| 引数の誤り (上の表) | 触らない | 使い方 | 2 |
| 環境変数 `GITHUB_REPOSITORY` が無い・空 (Actions では自動で入る。手元で流したときだけ) | 触らない (`createGitHub` を作らない) | 名前だけ (`scripts/consistency-check.mjs` の main と同じ扱い) | 2 |
| `planBackupIssue` が問題あり/なしを決め、`planIssueAction` どおりに `listOpenIssues` → `createIssue` / `updateIssue` / `closeIssue` (または何もしない) が例外なく終わる | 作る・更新・閉じる・何もしない | — | 0 |
| GitHub の API の失敗 (`listOpenIssues`・`createIssue`・`updateIssue`・`closeIssue` のどれかが例外。`createGitHub` は `gh api` を打ち、0 でなければ投げる。`GH_TOKEN` が無い・権限が無いも同じ) | 途中まで (例: list が通って create が失敗なら Issue は無いまま) | 「GitHub の API に失敗した」と、どの操作か (`list` / `create` / `update` / `close`) と、例外の文を `redactForLog` で伏せたもの | 1 |

- `report-issue` の 1 は step の失敗 → job が赤 → GitHub Actions の失敗通知 (既定) が鳴る。結果ファイル・監査行・R2 の対象物には影響しない (どれも run の step で決まっている)。取得が失敗していた日は Issue が立たないが、Actions の失敗通知・監査行の `failed`・翌日の鮮度の cron が残る。取得が成功していた日は marker の Issue が閉じないまま残り、次に report の step が成功した日に閉じる (または更新される)。やり直しはしない (step を流し直すのはオーナーが Actions の画面で)。

- 失敗の reason は固定の名前だけ。コマンドの標準エラー出力はログに末尾 5 行を伏せ字 (§4.10) にして出し、監査行・Issue には入れない。
- 「止めて記録」= `not_configured` は dump に進まない (本番の個人情報を runner に出す前に止まる)。

### 4.8 復元できることの検査 (weekly / annual の日)

psql の打ち方 (argv・env・入力) は §4.12 の表。どれも runner (手元で流すときは手元の機械) の `psql` で、ローカルのスタックの DB に `supabase-local.sh env` の接続先で繋ぐ。

1. `psql --version` (§4.12 の `version`) と `python3 --version` (`PYTHON_COMMAND`。§4.12 の表の下) (どちらかが 0 でなければ restore_env_failed) → `bash scripts/supabase-local.sh start` (枠 0。`supabase link` の直後なので `supabase/.temp/*` の版は本番と同じ) → `bash scripts/supabase-local.sh env` の標準出力から `parseLocalDbUrl` で `SUPABASE_DB_URL` を取り、`LOCAL_PG_SSLMODE_QUERY` (`?sslmode=disable`。`supabase-local.sh verify` と同じ) を足して接続先にする。
2. 空にする: `buildResetSql(managedTablesInDump(scan))` を `$WORK/reset.sql` に書いて `reset` で流す (1 回の取引)。中身は `DROP SCHEMA IF EXISTS "public" CASCADE; CREATE SCHEMA "public"; GRANT USAGE, CREATE ON SCHEMA "public" TO "postgres"; GRANT USAGE ON SCHEMA "public" TO "anon", "authenticated", "service_role";` と、storage の全部のポリシーを外す `RESET_STORAGE_POLICIES_SQL` (DO の文。5 の `fixups.sql` が取得の時点のポリシーだけを作り直すので、ローカルにだけあるポリシーを残さない) と、data.sql の `COPY "auth"."<t>"`・`COPY "storage"."<t>"` の表の `TRUNCATE "auth"."users", … CASCADE;` (名前は引用符で囲み、`"` は `""` にして書く。表が無ければ TRUNCATE の文を書かない) の順。data.sql に cron・net の COPY は無い (§4.3 の `-s`) ので、ローカルの `cron.job` の行には触れない。
3. `roles.sql` を `roles` で流す (`ON_ERROR_STOP=0`・`VERBOSITY=sqlstate`。1 文ずつ確定するので、1 つの失敗でほかの文は止まらない)。psql は SQL の失敗では 0 で終わるので、標準エラー出力の全部 (`stderrFile`) を `countRoleRestoreErrors` で数える: `ROLES_TOLERATED_SQLSTATE` (`42710` = すでにあるロール。本番の `supabase_privileged_role` などはローカルにもある) は数えて許し (件数をログに出す)、ほかの SQLSTATE が 1 つでもあれば restore_check_failed。psql が 0 でない (繋がらないなど) も restore_check_failed。
4. `restore` で `schema.sql`・`SET session_replication_role = replica`・`data.sql` を 1 回の取引で流す (`--single-transaction --variable ON_ERROR_STOP=1 --file schema.sql --command 'SET session_replication_role = replica' --file data.sql`。Supabase の backup-restore の手順と同じ。トリガーを止めて流す。どこかで失敗すれば全体が戻る)。
5. 補い: `fixups.sql` を `reset` と同じ形 (`PSQL_FILE` = 平文の置き場の `fixups.sql`。`ON_ERROR_STOP=1`・1 回の取引) で流す。関数・表は「API のロールの権限を一度外し、取得の時点の `proacl` / `relacl` の分だけ付け直す」、最後に列単位の GRANT、storage は `DROP POLICY IF EXISTS` → `CREATE POLICY` とバケットの `INSERT … ON CONFLICT (id) DO NOTHING` (data.sql で入っているので何もしない)、最後に auth・storage の表のアプリのトリガー (§3.3 の (6)) を、同じ名前が無いときだけ取得の時点の定義で作る (data.sql の後なので、data を入れる間はトリガーが動かない。2 の reset が public の関数ごと消したものを戻す。表が無ければ失敗)。0 でなければ restore_check_failed (取引ごと戻る)。
6. 数の突き合わせ: `count` で `RESTORE_COUNT_SQL` を流し、出力 (`<表>|<利用者>|<監査行>` の 1 行) を `parseRestoreCounts` で読み、`restoreChecks(manifest.dumped, observed)` (基準はダンプの中身で、live の `source` ではない): `public` の通常の表 (relkind `r`・拡張の表を除く。分割の親は数えず子は数える = verify の数え方) の数 = `dumped.public_tables` / `auth.users` の数 = `dumped.auth_users` / `admin_audit_logs` の数 = `dumped.audit_rows` (どれも完全一致。復元したのは data.sql そのものなので、本番に書き込みがあっても一致する)。
7. 権限とポリシーの突き合わせ: `$WORK/restored-catalog/` (`RESTORED_CATALOG_DIR`) を作り、復元した DB に `snapshot_catalog.sql` を `catalog` の形で流し (§4.12。`cwd` がそのディレクトリ)、`python3 scripts/baseline/verify_baseline.py <取得の時点の catalog/> <restored-catalog/>` (`CATALOG_VERIFY_SCRIPT`。既存。変えない) を打つ。0 で、標準出力の要約の行 (`CATALOG_VERIFY_SUMMARY_LINE` = `[verify] errors=<n> warnings=<m>`) を `parseCatalogVerifySummary` で読めて errors が 0 なら合格。見るのは verify_baseline.py が errors にするもの = public の表・関数・ポリシーの過不足、表の RLS と GRANT、関数の SECURITY DEFINER・設定・所有者・EXECUTE 権限、storage のポリシーとバケット (storage の内部の表・ポリシーの式の表記の差は warnings で、落とさない。`supabase/baseline/README.md` の「既知の差」)。`fixups.sql` を流さずに Supabase の既定権限が残ると、関数の `acl` の差がここで errors になる。基準の `catalog/` は、取得 (run) では catalog の段の出力、`restore` サブコマンドでは書庫の中のもの、`roundtrip-local` では復元の前に同じローカルの DB から取ったもの。続けて、`restored-catalog/` と基準の `catalog/` の `catalog_auth_storage_triggers.csv` (`AUTH_STORAGE_TRIGGERS_CSV`) を `appTriggerChecks` で比べる (`verify_baseline.py` はこの CSV を読まない): アプリのトリガーの過不足 (`missing`・`extra`)・定義の差 (`differs`)・どちらかの CSV が読めない (`parseTriggerCatalog` が null) は restore_check_failed (トリガーの名前をログに出す)。内部のトリガーの差 (ローカルのスタックの Storage の版の差) は `internal_differences` の名前をログに出すだけで落とさない。
8. 台帳と cron のジョブの定義の突き合わせ: `ledger.txt` を `parseLedgerVersions` で読み (null は失敗)、`ledgerChecks(manifest.ledger, versions, <MIGRATIONS_DIR のファイル名の一覧>)` が ok (版の数と最大が manifest と同じ・どの版にも `<版>_*.sql` がある。新しいプロジェクトの台帳を戻す `migration repair` は版ごとのファイルが要るので、ここで先に確かめる。手順書 §6)。続けて `cronJobsChecks(manifest.cron_jobs, <cron_jobs.sql の本文>)` が ok (`parseCronJobsSql` で読め、ジョブの数が manifest と同じ)。`cron_jobs.sql` はローカルのスタックには流さない (本番のジョブを入れると、本番の Edge Function の URL を持つ関数をローカルの pg_cron が動かす。§3.3 の (5))。`roundtrip-local` では manifest の代わりに、取った台帳の `LedgerSummary` と取った `cron_jobs.sql` のジョブの数と比べ、さらに同じ DB から取った定義なので `cron_dry_run` (§4.12。`BEGIN` → `cron_jobs.sql` → `ROLLBACK`) を流して 0 であること (本物の pg_cron で、書庫の定義が流せて最後の行の名前の集合の比べが通ること。手順書 §6 の (6) の訓練と同じ打ち方) を確かめる。
9. `supabase-local.sh stop` (`always`)。
- 結果 (`RestoreCheckResult`: 数 3 つ・`catalog_errors`・`catalog_warnings`・`ledger_versions`・`cron_jobs`・所要秒) は copy に成功した層の `backup.weekly.completed` / `backup.annual.completed` の `restore_check` に入る (§5.1)。copy に成功した層が無い日は流さない。失敗は §4.7。run の restore_check の段 (監査行の stage は `restore_check`) の reason は、1 (`psql --version`・`python3 --version`・`start`・`env`) の子プロセスの失敗は `classifyFailure('restore_env', …)` (= `restore_env_failed`。`start` の終了 75 は `image_pull_unavailable`)、2〜8 の子プロセスの失敗は `classifyFailure('restore_check', …)` (= `restore_check_failed`)、時間切れはどちらも `timeout`。子プロセスの失敗でない判定 (`parseLocalDbUrl` が null → `restore_env_failed`、`countRoleRestoreErrors` の `others` が空でない・`parseRestoreCounts` が null・`restoreChecks` の不一致・`verify_baseline.py` の終了 1 (errors がある)・`parseCatalogVerifySummary` が null か errors が 0 でない・`appTriggerChecks` の不一致・`parseLedgerVersions` が null・`ledgerChecks` の不一致・`cronJobsChecks` の不一致 → `restore_check_failed`) は例外にせず、その reason を直接決める (`classifyFailure` を通すと `unknown` になるため)。restore サブコマンドの段 restore_env / restore (2〜5) / restore_check (6〜8) も同じ分け方。
- `verify_baseline.py` の出力は、取得 (run。公開リポジトリの Actions のログ) では要約の行だけをログに出す (§4.10)。`restore` サブコマンドと `roundtrip-local` は全部の行を出す (手元・ローカルのスタックの差で、本番の値ではない)。
- 同じ関数 (`resetForRestore`・`restoreDatabase`・`restoreChecks`・`verifyRestoredCatalog`・`appTriggerChecks`・`ledgerChecks`・`cronJobsChecks`) を、PR の往復テスト (§15 の `roundtrip-local`) とオーナーの `restore` サブコマンドが使う。`restore` サブコマンドはスタックを止めない (§4.7)。
- cron のジョブの定義は data.sql ではなく書庫の `cron_jobs.sql` に入る (§4.3)。新しいプロジェクトへ復元したときは手順書 §6 の (6) でそれを流す。ローカルの検査では流さず (8)、ローカルのスタックの migration が登録したジョブがそのまま残る (数えない)。

### 4.9 失敗の通知と既存の運用アラートの関係

| 事象 | 誰が知らせるか | 経路 |
|---|---|---|
| 取得が失敗した | GitHub Actions の失敗通知 (既定) + Issue (marker `<!-- db-backup -->`・題「【自動】DB バックアップの失敗」。`scripts/lib/consistency-check.mjs` の `planIssueAction` と `scripts/consistency-check.mjs` の `createGitHub` を再利用) + 監査行 `failed` | GitHub |
| 取得が走っていない (schedule 停止・secrets 失効で link できない) | Vercel Cron `backup-freshness` (§7.3) が監査行の鮮度を見て、`OPS_ALERT_EMAIL` に 1 通 | 既存の運用メールの仕組み (`claim_ops_alert`・`release_ops_alert`・`sendEmail`) |
| 画面で見る | `/super-admin/backups` の鮮度のバッジ | 画面 |

- 取得の失敗の Issue は report の step が作る (§4.11)。run の step は GitHub の client を持たない。
- `OPS_ALERT_EMAIL` が未設定なら、鮮度の cron は info ログを 1 行残して何もしない (app-log-alerts と同じ)。
- 既存の `app-log-alerts` (error の急増) は変えない。宛先の読み口だけを `src/lib/ops-alerts/recipient.ts` に切り出して 2 つの cron で共有する (§7.3)。

### 4.10 ログと秘密

- Actions のログに出すもの: 段の名前・所要秒・件数 (表・利用者・対象物。catalog の段は CSV ごとの行の数・台帳の版の数と最大・cron のジョブの数・`fixups.sql` の大きさ、restore_check は `verify_baseline.py` の要約の行の errors と warnings の数)・大きさ・SHA-256 の先頭 8 文字・R2 のキー。出さないもの: 行の中身・エラーの文の全体 (`verify_baseline.py` の `[error]` / `[warn]` の行を含む)・カタログの中身・cron のジョブの command・接続先の URL・鍵 (aws に渡す `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` の値を含む)。カタログの CSV・`cron_jobs.sql`・`fixups.sql` は暗号化した書庫の中だけに置く。
- 子プロセスの標準エラー出力は末尾 5 行だけ、`scripts/lib/cron-secret-drift.mjs` と同じ規則 (24 文字以上の英数字の連なり、名前に TOKEN / SECRET / PASSWORD / KEY を含む環境変数の値) を `***` に伏せて出す (`redactForLog`)。
- 一時ディレクトリは `fs.mkdtemp` + `umask 077`。`cleanup` は成功・失敗・シグナル (SIGINT / SIGTERM / SIGHUP) のどれでも消す。
- 結果ファイル (`BackupRunReport`) と Issue の本文に入るのは、層・段・reason・`missing` の名前 (secrets / variables の名前で値ではない)・run の URL だけ。

### 4.11 workflow の job と step、run → report の受け渡し (`.github/workflows/db-backup.yml` の `backup` job と `roundtrip-check` job)

```yaml
# 正典の形 (job の並び・concurrency・step の並び・id・if・timeout・env の参照。ほかの書き方をしない)。
# ワークフロー直下 (on / permissions と同じ階層) には concurrency を置かない (§4.2)
  backup:
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    timeout-minutes: 300                     # JOB_TIMEOUT_MINUTES
    concurrency:
      group: db-backup                       # BACKUP_CONCURRENCY_GROUP (取得どうしだけが入る)
      cancel-in-progress: false
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7
      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
      - name: Install age and check tools
        run: sudo apt-get update && sudo apt-get install -y age && age --version && psql --version && python3 --version
      - name: Run backup
        id: run
        timeout-minutes: 290                 # RUN_STEP_TIMEOUT_MINUTES (= 300 - 10。report の step の分を残す)
        run: node scripts/backup-db.mjs run --tier "$TIER_INPUT" --result-file "$RUNNER_TEMP/db-backup-result.json"
        env:
          TIER_INPUT: ${{ inputs.tier || 'auto' }}    # 入力を run: の文字列に直接埋めない (env で渡す)
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
          BACKUP_R2_ACCESS_KEY_ID: ${{ secrets.BACKUP_R2_ACCESS_KEY_ID }}
          BACKUP_R2_SECRET_ACCESS_KEY: ${{ secrets.BACKUP_R2_SECRET_ACCESS_KEY }}
          BACKUP_R2_ACCOUNT_ID: ${{ vars.BACKUP_R2_ACCOUNT_ID }}
          BACKUP_R2_BUCKET: ${{ vars.BACKUP_R2_BUCKET }}
          BACKUP_AGE_RECIPIENT: ${{ vars.BACKUP_AGE_RECIPIENT }}
          BACKUP_DUMP_TIMEOUT_MINUTES: ${{ vars.BACKUP_DUMP_TIMEOUT_MINUTES }}
          BACKUP_UPLOAD_TIMEOUT_MINUTES: ${{ vars.BACKUP_UPLOAD_TIMEOUT_MINUTES }}
          BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES: ${{ vars.BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES }}
          BACKUP_ZSTD_LEVEL: ${{ vars.BACKUP_ZSTD_LEVEL }}
      - name: Stop local Supabase
        if: always()
        run: bash scripts/supabase-local.sh stop || true
      - name: Report (Issue)
        if: always()
        run: node scripts/backup-db.mjs report-issue --result-file "$RUNNER_TEMP/db-backup-result.json" --run-outcome "$RUN_OUTCOME" --run-url "$RUN_URL"
        env:
          RUN_OUTCOME: ${{ steps.run.outcome }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          GH_TOKEN: ${{ github.token }}               # createGitHub の gh api が読む (GITHUB_REPOSITORY は Actions が自動で入れる)

  roundtrip-check:
    if: github.event_name != 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 45                      # ROUNDTRIP_JOB_TIMEOUT_MINUTES
    concurrency:
      group: db-backup-roundtrip-${{ github.ref }}   # ROUNDTRIP_CONCURRENCY_GROUP (取得の group に入れない)
      cancel-in-progress: true               # 同じ PR の新しい push が来たら古い往復の検査は要らない
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7
      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
      - name: Roundtrip (local)
        run: node scripts/backup-db.mjs roundtrip-local --slot 0
      - name: Stop local Supabase
        if: always()
        run: bash scripts/supabase-local.sh stop || true
```

| step | if | 入力 | 出力 | 失敗のとき |
|---|---|---|---|---|
| Run backup (`id: run`) | (job の if) | `--tier` (env `TIER_INPUT`)・secrets / variables | 結果ファイル `$RUNNER_TEMP/db-backup-result.json` (`BackupRunReport`。`runCli` の `finally` で一時ファイルに書いて rename。`runBackup` が reject しても `unexpectedFailureReport` を書く)・終了コード 0 / 1 / 3 | 終了 1 / 3 は step の失敗。時間切れ・取り消しは結果ファイルが無いまま終わる |
| Stop local Supabase | `always()` | — | — | `\|\| true` (止める物が無くても失敗にしない) |
| Report (Issue) | `always()` | 結果ファイル (無い・読めない・形が違うなら null)・`RUN_OUTCOME` (`success` / `failure` / `cancelled` / `skipped`)・`RUN_URL` | Issue の作成・更新・クローズ (`planBackupIssue` → `planIssueAction` → `createGitHub`)。終了 0 (GitHub の API の失敗は 1、`GITHUB_REPOSITORY` が無い・引数の誤りは 2。§4.7 の `report-issue` の表) | 1 / 2 は step の失敗 (job が赤 → Actions の失敗通知)。Issue は途中までのまま (§4.7) |
| (roundtrip-check) Roundtrip (local) | (job の if: schedule 以外) | — (secrets を使わない。枠 0 のローカルのスタック) | 終了 0 / 1 (§15 の往復) | job の赤 (PR の Checks) |
| (roundtrip-check) Stop local Supabase | `always()` | — | — | `\|\| true` |

- `planBackupIssue` の判定は次の 4 通りで、上から順に当てる (どの入力もちょうど 1 つに当たる。`failures` の件数では判定しない):
  1. 結果ファイルが無い (`parseRunReport` が null) → 問題あり。本文「run の step が結果を残さずに終わった (outcome <RUN_OUTCOME>)。時間切れか取り消し」。
  2. `status` が `ok` でない (`failed` / `not_configured`) → 問題あり。本文に `failures` の各行 (層・段・reason・`missing` の名前) と `completed` の層 (「取得は成功した層」)。`failures` が空なら「run の step が段の失敗として記録できずに終わった (予期しない例外。exit_code <n>)。Actions のログを見る」。
  3. `status = ok` で `RUN_OUTCOME` が `success` でない → 問題あり。本文「結果ファイルと step の結果が食い違う」。
  4. `status = ok` で `RUN_OUTCOME = success` → 問題なし (marker の Issue があれば閉じる)。`warnings` (inventory) だけなら問題なし。
- `parseRunReport` は形の検査に加えて、`status` が `exit_code` から決まる値 (`toRunReport` と同じ規則) と違う・`status = ok` なのに `failures` がある結果ファイルを null にする (1 に倒す)。
- inventory の失敗は `failures` に入れず `warnings` に入れる (Issue を立てない。§4.7)。
- 結果ファイルは `$RUNNER_TEMP` に置く (job の終わりに runner が消す。artifact にしない)。

### 4.12 psql の打ち方 (段ごとの argv・env・入力)

stats (本番。§4.3) のほかの psql は、すべて runner (ubuntu-latest の PostgreSQL 16。オーナーが手元で `restore` を流すときは手元の機械) の `psql` を、`CommandRunner` で `bash -c <PSQL_SCRIPTS の本文>` として打つ。接続先・パスワード・ファイルのパスは env で渡し、argv (bash -c の本文) に値を載せない (stats と同じ)。Docker の中の psql を使わないのは、手元の Mac の Docker では `--network host` で localhost のスタックに届かず、ファイルのマウントも要るため。本番に書くのは audit の 1 回だけ。

| 段 | 相手 | `PSQL_SCRIPTS` のキー (bash -c の本文) | env | 入力 | 出力の扱い |
|---|---|---|---|---|---|
| catalog のカタログ (取得) | 本番 (`supabase/.temp/pooler-url`。読むだけ) | `catalog` = `exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --file "$PSQL_FILE"` (`cwd` = `$WORK/catalog`) | `PG_URL` = pooler-url + `REMOTE_PG_SSLMODE_QUERY`・`PGPASSWORD` = `SUPABASE_DB_PASSWORD`・`PSQL_FILE` = リポジトリの `CATALOG_SNAPSHOT_SQL` の絶対パス | — (ファイルの中で `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`) | `cwd` に CSV 7 つ。0 でなければ `catalog_failed` |
| catalog の台帳 (取得) | 同上 | `count` と同じ本文 | `PG_URL`・`PGPASSWORD`・`PSQL_FILE` = `$WORK/ledger-query.sql` (`LEDGER_VERSIONS_SQL`) | — (`stdoutFile` = `$WORK/ledger.txt`) | 0 でなければ `catalog_failed`。中身は `checkCatalogCapture` が見る |
| catalog の cron のジョブ (取得) | 同上 | `count` と同じ本文 | `PG_URL`・`PGPASSWORD`・`PSQL_FILE` = `$WORK/cron-jobs-query.sql` (`CRON_JOBS_SQL`) | — (`stdoutFile` = `$WORK/cron_jobs.sql`) | 0 でなければ `catalog_failed`。中身は `checkCatalogCapture` (`parseCronJobsSql`) が見る |
| audit (取得) | 本番 (`supabase/.temp/pooler-url`) | `audit` = `exec psql "$PG_URL" -X -q -At -v ON_ERROR_STOP=1 --single-transaction --file "$PSQL_FILE"` | `PG_URL` = pooler-url + `REMOTE_PG_SSLMODE_QUERY` (`?sslmode=require`)・`PGPASSWORD` = `SUPABASE_DB_PASSWORD`・`PSQL_FILE` = `$WORK/audit.sql` | `buildAuditSql(rows)` を書いた `$WORK/audit.sql` (層ごとに 1 文。details の JSON は base64 にして SQL の中で `pg_catalog.convert_from(pg_catalog.decode('<base64>', 'base64'), 'UTF8')::jsonb` に戻す = 引用符・バックスラッシュの書き換えが要らず、argv・SQL の文字列に JSON の文字が出ない) | 0 → 全層の行が書けた (`auditWritten: true`)。0 でない・時間切れ → 1 行も書かれていない (取引ごと戻る)。plan の全層に {stage `audit`, reason `classifyFailure('audit', …)`} |
| restore_env (確認) | — | `version` = `exec psql --version` | — | — | 0 でなければ `restore_env_failed` (版をログに出す) |
| reset (復元の前) | ローカルのスタック (`parseLocalDbUrl` + `LOCAL_PG_SSLMODE_QUERY`) | `reset` = `exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file "$PSQL_FILE"` | `PG_URL`・`PSQL_FILE` = `$WORK/reset.sql` | `buildResetSql(managedTablesInDump(scan))` (§4.8 の 2) | 0 でなければ `restore_check_failed` |
| roles | 同上 | `roles` = `exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=0 -v VERBOSITY=sqlstate --file "$PSQL_FILE"` | `PG_URL`・`PSQL_FILE` = `<平文の置き場>/roles.sql` | — (`stderrFile` = `$WORK/roles.stderr` に標準エラー出力の全部) | `countRoleRestoreErrors(stderr)`: `others` が空でない・psql が 0 でない → `restore_check_failed`。`tolerated` はログに件数 |
| restore | 同上 | `restore` = `exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file "$SCHEMA_FILE" --command "SET session_replication_role = replica" --file "$DATA_FILE"` | `PG_URL`・`SCHEMA_FILE`・`DATA_FILE` (平文の置き場の schema.sql / data.sql) | — | 0 でなければ `restore_check_failed` (取引ごと戻る) |
| fixups | 同上 | `reset` と同じ本文 | `PG_URL`・`PSQL_FILE` = `<平文の置き場>/fixups.sql` | — | 0 でなければ `restore_check_failed` (取引ごと戻る) |
| count | 同上 | `count` = `exec psql "$PG_URL" -X -q -At -v ON_ERROR_STOP=1 --file "$PSQL_FILE"` | `PG_URL`・`PSQL_FILE` = `$WORK/count.sql` (`RESTORE_COUNT_SQL`) | — | 標準出力を `parseRestoreCounts` (null → `restore_check_failed`) → `restoreChecks` |
| 復元した DB のカタログ | 同上 | `catalog` (`cwd` = `$WORK/restored-catalog`) | `PG_URL`・`PSQL_FILE` = `CATALOG_SNAPSHOT_SQL` の絶対パス | — | `cwd` に CSV 7 つ。0 でなければ `restore_check_failed` |
| cron の試し (`roundtrip-local` だけ。§4.8 の 8) | 同上 | `cron_dry_run` = `exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --command "BEGIN" --file "$PSQL_FILE" --command "ROLLBACK"` | `PG_URL`・`PSQL_FILE` = `<平文の置き場>/cron_jobs.sql` | — | 0 でなければ `restore_check_failed` (取引は確定しない。失敗でも接続が切れて戻る) |

- python3 は `bash -c` を通さず `CommandRunner(PYTHON_COMMAND, args)` で打つ (引数はファイルのパスだけで、秘密を含まない): restore_env の確認 = `['--version']` / catalog の補いの SQL = `[RESTORE_FIXUPS_BUILDER_SCRIPT, <catalog dir>, <schema.sql>, <fixups.sql>]` (0 でなければ `catalog_failed`) / 復元の検査 = `[CATALOG_VERIFY_SCRIPT, <取得の時点の catalog dir>, <restored-catalog dir>]` (0 → 要約の行を読む、1 → errors がある = `restore_check_failed`、ほか → `CommandFailedError`)。スクリプトのパスはリポジトリの直下からの相対 (入口はリポジトリの直下で動かす。`supabase-local.sh` と同じ)。
- 時間の上限: `CommandRunner` に渡す `timeoutMs` は、その子プロセスを起こす段の上限 (分) × `MS_PER_MINUTE` で、段の合計ではなく子 1 つずつに掛かる (段の中の子が多ければ段は上限より長くなりうる。取得では run の step の上限 (S-17) が最後の歯止め)。取得 (と `roundtrip-local`。`roundtrip-local` は調整用の環境変数を読まず `resolveRunTuning({})` の既定の tuning) の子は `stageTimeoutMs(段, tuning)`: catalog の子 (カタログ・台帳・cron のジョブの psql と python3) はどれも catalog の 5 分、copy の子 (層のキーへの送り直しと head-object) は upload と同じ値 (`tuning.uploadTimeoutMinutes`。同じ手元のファイルを送るので)、audit は 5 分、restore_check の段の子 (`psql --version`・`python3 --version`・`supabase-local.sh start` / `env`・reset〜`cron_dry_run` と `verify_baseline.py`) はどれも restore_check の上限。`restore` サブコマンドの子は `restoreStageTimeoutMs(段, tuning)` (§5.1 の `RESTORE_STAGE_TIMEOUT_MINUTES`): download = upload の値・decrypt = encrypt・extract = archive・restore_env / restore / restore_check = restore_check の値で、`RUN_TUNING_ENV` の上書き (`BACKUP_UPLOAD_TIMEOUT_MINUTES` → download、`BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES` → restore_env・restore・restore_check) も同じ対応で効く (手元のシェルに置けば上書きできる)。config・checksum (Node の `crypto` でファイルを流して SHA-256 を取り、子を起こさない。手元の Mac に `sha256sum` が無いことがある)・cleanup は子を起こさないので上限を使わない。
- 往復の検査 (`roundtrip-local`) の種まきの SQL (利用者 1 人と表の行) も `count` と同じ形 (`--file`) で流す。往復の catalog (カタログ・台帳・cron のジョブの定義の psql 3 回と、補いの SQL の python3) は、相手が `parseLocalDbUrl` の接続先 (`PGPASSWORD` 無し) なだけで、取得と同じ打ち方。
- 手元の機械で `restore` を流すときの前提 (psql・python3・aws・age・zstd・Docker と、手元のシェルの R2 の 4 つ (`RESTORE_REQUIRED_ENV_NAMES`。§4.4 の復元用のトークン)) は手順書 §5 に書く。

---

## 5. 正典コード

### 5.1 `scripts/lib/backup-db.mjs` の契約 (JavaScript。型は次の宣言のとおり)

```ts
// scripts/lib/backup-db.mjs の公開面 (実装は JavaScript。この宣言と同じ名前・同じ引数・同じ戻り値にする)
// 入口 scripts/backup-db.mjs は `process.exitCode = await runCli(process.argv.slice(2))` の 1 行だけ (scripts/consistency-check.mjs の main と同じ形。
// 直接動かしたときだけ呼ぶ)。サブコマンドは run / restore / roundtrip-local / report-issue / r2-config / help。外部コマンドの実行 (run) は差し替えられる。
// run は runCli の finally で結果ファイルを --result-file に書く (一時ファイル → rename。runBackup が reject したら unexpectedFailureReport)。report-issue は
// parseRunReport → planBackupIssue → planIssueAction (scripts/lib/consistency-check.mjs) → createGitHub (scripts/consistency-check.mjs) で Issue を作る・更新・閉じる。
// runBackup は GitHub に触らない。

export const BACKUP_TIERS = ['daily', 'weekly', 'annual'] as const;
export type BackupTier = (typeof BACKUP_TIERS)[number];

/** 取得の予定 (UTC の cron 式) と、その JST の時刻。vercel.json ではなく .github/workflows/db-backup.yml に書く */
export const BACKUP_SCHEDULE_CRON_UTC = '23 17 * * *';
export const BACKUP_SCHEDULE_JST = '02:23';
/** weekly を作る曜日 (JST。0 = 日曜) と annual を作る月日 (JST) */
export const WEEKLY_WEEKDAY_JST = 1;
export const ANNUAL_MONTH_DAY_JST = '01-01';
/** 保持日数 (R2 の Lifecycle と bucket lock に同じ値を入れる。§4.1) */
export const RETENTION_DAYS: Readonly<Record<BackupTier, number>> = { daily: 30, weekly: 366, annual: 2557 };
/** Infrequent Access へ移す日数 (R2 の IA の最短課金 30 日より前にしない) */
export const INFREQUENT_ACCESS_AFTER_DAYS = 30;
export const SECONDS_PER_DAY = 86_400;
/** bucket lock の Age 条件の秒数 (R2 の API の maxAgeSeconds の形)。RETENTION_DAYS から作る (手で書かない) */
export const LOCK_MAX_AGE_SECONDS: Readonly<Record<BackupTier, number>> = {
  daily: RETENTION_DAYS.daily * SECONDS_PER_DAY,
  weekly: RETENTION_DAYS.weekly * SECONDS_PER_DAY,
  annual: RETENTION_DAYS.annual * SECONDS_PER_DAY,
};
/** 途中で切れたマルチパートの送信を消すまでの日数 (Lifecycle の abort-multipart。1 回の取得の再試行の窓より十分長く、残骸の課金を 1 週で止める) */
export const R2_ABORT_MULTIPART_AFTER_DAYS = 7;

export const SUPABASE_CLI_VERSION = '2.62.10';
export const SUPABASE_PROJECT_REF = 'flmeolcfutuwwbjmzyoz';
/** Supabase の backup-restore の手順と同じ除外 (データのダンプから外す表) */
export const DUMP_EXCLUDED_TABLES: readonly string[] = ['storage.buckets_vectors', 'storage.vector_indexes'];
/** データのダンプに入れるスキーマ (db dump の `-s` に `,` でつないで渡す)。CLI 2.62.10 の既定は cron・net などの拡張の表も入れ、
 *  復元先のスタックの cron.job と重なって復元が落ちる (§4.3)。cron のジョブの定義は CRON_JOBS_FILE で別に書庫に入れる */
export const DATA_DUMP_SCHEMAS = ['public', 'auth', 'storage'] as const;
export const DUMP_FILES = ['roles.sql', 'schema.sql', 'data.sql'] as const;
/** dump を流しても戻らないものを書庫に入れる (§3.3・§4.3 の catalog)。どれも tar の中の名前 */
export const RESTORE_FIXUPS_FILE = 'fixups.sql';
export const LEDGER_FILE = 'ledger.txt';
/** 本番の cron.job の定義を、流せば同じジョブがそろう SQL にしたもの (§4.3 の catalog の 2)。migration に登録の SQL が無いジョブがあるので書庫に持つ (§3.3 の (5)) */
export const CRON_JOBS_FILE = 'cron_jobs.sql';
export const CATALOG_DIR = 'catalog';
/** restore_check が復元した DB のカタログを書く置き場 (作業ディレクトリの下。書庫には入れない) */
export const RESTORED_CATALOG_DIR = 'restored-catalog';
/** tar に入れる順 (§4.3 の書庫。7 つ)。展開した後もこの名前で読む */
export const ARCHIVE_ENTRIES = [...DUMP_FILES, RESTORE_FIXUPS_FILE, CRON_JOBS_FILE, LEDGER_FILE, CATALOG_DIR] as const;
/** 既存のカタログの照会 (READ ONLY の取引で \copy し、最後に ROLLBACK)。prod-schema-snapshot.yml と supabase-local.sh verify と同じファイルで、変えない */
export const CATALOG_SNAPSHOT_SQL = 'scripts/baseline/snapshot_catalog.sql';
/** CATALOG_SNAPSHOT_SQL が cwd に書く CSV (ファイルの中の並び。tests/backup-db.test.ts がファイルの `TO '<名前>'` と突き合わせる) */
export const CATALOG_CSV_FILES = [
  'catalog_policies.csv', 'catalog_functions.csv', 'catalog_tables.csv', 'storage_buckets.csv',
  'catalog_extensions.csv', 'catalog_publication.csv', 'catalog_auth_storage_triggers.csv',
] as const;
export type CatalogCsvFile = (typeof CATALOG_CSV_FILES)[number];
/** auth・storage の表に付いたトリガーの CSV (CATALOG_CSV_FILES の 1 つ)。アプリのトリガーは dump を流しても戻らない (§3.3 の (6))。
 *  補いは build_restore_fixups.py が fixups.sql に書き、突き合わせは appTriggerChecks が行う (verify_baseline.py はこの CSV を読まない) */
export const AUTH_STORAGE_TRIGGERS_CSV = 'catalog_auth_storage_triggers.csv';
/** AUTH_STORAGE_TRIGGERS_CSV の見出し (snapshot_catalog.sql の列の並び) */
export const TRIGGER_CSV_COLUMNS = ['schema', 'table_name', 'trigger_name', 'definition'] as const;
/** Supabase のサービス (Storage・Auth) が自分のスキーマの関数で作る内部のトリガーの関数のスキーマ。内部のトリガーは補わず、差は落とさない (§3.3 の (6) の見分け方)。
 *  build_restore_fixups.py の INTERNAL_TRIGGER_FUNCTION_SCHEMAS と同じ値 */
export const INTERNAL_TRIGGER_FUNCTION_SCHEMAS = ['auth', 'storage'] as const;
/** pg_get_triggerdef の定義の行。1 = 実行する関数の名前 (スキーマつきか無し。引用符つきの名前もある)。`.*` は欲張りなので最後の EXECUTE を取る。
 *  build_restore_fixups.py の TRIGGER_DEFINITION_PATTERN と同じ式 */
export const TRIGGER_DEFINITION_PATTERN = /^CREATE (?:CONSTRAINT )?TRIGGER .* EXECUTE (?:FUNCTION|PROCEDURE) ((?:"(?:[^"]|"")+"|[^".\s(]+)(?:\.(?:"(?:[^"]|"")+"|[^".\s(]+))?)\(/s;
/** 補いの SQL を作るスクリプト (新設。build_baseline.py の 3 つの関数をつなぐ。§5.5) と、カタログを比べるスクリプト (既存。errors があれば終了 1) */
export const RESTORE_FIXUPS_BUILDER_SCRIPT = 'scripts/baseline/build_restore_fixups.py';
export const CATALOG_VERIFY_SCRIPT = 'scripts/baseline/verify_baseline.py';
export const PYTHON_COMMAND = 'python3';
/** verify_baseline.py が最後に書く要約の行。1 = errors の数、2 = warnings の数 */
export const CATALOG_VERIFY_SUMMARY_LINE = /^\[verify\] errors=(\d+) warnings=(\d+)$/;
/** 台帳の版を読む SQL (読むだけ) */
export const LEDGER_VERSIONS_SQL = 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;';
/** 台帳の版の形 (supabase migration new の YYYYMMDDHHMMSS の 14 桁。本番の 200 版はすべてこの形。§3.3) */
export const LEDGER_VERSION_PATTERN = /^[0-9]{14}$/;
/** migration のファイルの置き場 (台帳の版ごとにファイルがあるかを見る。新しいプロジェクトで台帳を戻す migration repair はファイルが要る) */
export const MIGRATIONS_DIR = 'supabase/migrations';
/** CRON_JOBS_FILE の中身を作る SQL (cron.job を読むだけ。psql -At の 1 行 = 1 文)。ジョブの名前の順に 1 ジョブ 1 行の cron.schedule_in_database
 *  (command は複数行のものがあるので UTF-8 の hex にして 1 行に収める。database・username・active も写す) と、最後に 1 行の DO
 *  (流した先の cron.job の名前の集合が書庫の集合と違えば例外。--single-transaction で流せば全体が戻る)。2026-10-16 に本番へ流して 15 行 + 1 行を確かめた。
 *  username は、取得した人 (CURRENT_USER = postgres) と同じなら NULL (流した人のジョブになる) にする: pg_cron 1.6.4 は username を渡すと
 *  superuser でない人 (Supabase の postgres) を「must be superuser to create a job for another role」で止める (同じ名前でも止める。
 *  2026-10-16 にローカルのスタックの roundtrip-local で実測)。ほかの username のジョブは名前を残し、流す側で superuser が要ることが分かるようにする */
export const CRON_JOBS_SQL = `SELECT q.line FROM (SELECT 0 AS part, j.jobname COLLATE "C" AS sort_key, pg_catalog.format('SELECT cron.schedule_in_database(%L, %L, pg_catalog.convert_from(pg_catalog.decode(%L, ''hex''), ''UTF8''), %L, %s, %L);', j.jobname, j.schedule, pg_catalog.encode(pg_catalog.convert_to(j.command, 'UTF8'), 'hex'), j.database, CASE WHEN j.username = CURRENT_USER THEN 'NULL' ELSE pg_catalog.quote_literal(j.username) END, j.active) AS line FROM cron.job j UNION ALL SELECT 1, NULL, pg_catalog.format('DO $cron_check$ BEGIN IF (SELECT COALESCE(pg_catalog.array_agg(c.jobname COLLATE "C" ORDER BY c.jobname COLLATE "C"), ARRAY[]::text[]) FROM cron.job c) IS DISTINCT FROM ARRAY[%s]::text[] THEN RAISE EXCEPTION ''cron jobs differ from the backup''; END IF; END $cron_check$;', (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.quote_literal(k.jobname), ', ' ORDER BY k.jobname COLLATE "C"), '') FROM cron.job k))) q ORDER BY q.part, q.sort_key;`;
/** CRON_JOBS_FILE のジョブの行。1 = ジョブの名前 (%L の形。'' は ' に戻す)。名前の無いジョブ (NULL) と \ を含む名前 (%L が E'…' にする) は当たらない */
export const CRON_SCHEDULE_LINE_PATTERN = /^SELECT cron\.schedule_in_database\('((?:[^'\\]|'')+)', '/;
/** CRON_JOBS_FILE の最後の行の始まり (名前の集合を比べる DO) */
export const CRON_CHECK_LINE_PREFIX = 'DO $cron_check$ ';
/** 復元の前に storage の全部のポリシーを外す (fixups.sql が取得の時点のポリシーだけを作り直すので、ローカルにだけあるものを残さない。§4.8 の 2) */
export const RESET_STORAGE_POLICIES_SQL =
  "DO $reset$ DECLARE r record; BEGIN FOR r IN SELECT p.policyname, p.tablename FROM pg_catalog.pg_policies p WHERE p.schemaname = 'storage' " +
  "LOOP EXECUTE pg_catalog.format('DROP POLICY %I ON storage.%I', r.policyname, r.tablename); END LOOP; END $reset$;";
/** Docker イメージの取得の一過性の失敗 (#1523) に強くして CLI を打つ既存の入口。dump の 3 回と stats をこれで包む (§4.2・§4.3) */
export const IMAGE_PULL_FALLBACK_SCRIPT = 'scripts/supabase-image-fallback.sh';
/** どの取得元でもイメージを取れなかったときの終了コード。scripts/lib/supabase-image-pull.sh の SIP_EXIT_PULL_UNAVAILABLE
 *  (sysexits.h の EX_TEMPFAIL) と同じ値 (tests/backup-db.test.ts がライブラリを source して突き合わせる)。supabase-local.sh start も同じ値で終わる */
export const IMAGE_PULL_UNAVAILABLE_EXIT_CODE = 75;
/** stats の docker run のイメージ名の組み立て: <取得元>/<PG_IMAGE_REPOSITORY>:<supabase/.temp/postgres-version>。
 *  取得元は fallback が渡す SUPABASE_INTERNAL_IMAGE_REGISTRY、無ければ CLI の既定 (= SIP_REGISTRIES_DEFAULT の先頭) */
export const PG_IMAGE_REPOSITORY = 'supabase/postgres';
export const DEFAULT_IMAGE_REGISTRY = 'public.ecr.aws';
/** 書庫の圧縮レベルの既定。19 は数倍遅く縮みは 1 割しか変わらない (BACKUP_ZSTD_LEVEL で上書きできる) */
export const ZSTD_LEVEL = 6;
/** zstd の通常のレベルの範囲 (20 以上は --ultra が要り、メモリを大きく使うので受けない) */
export const ZSTD_LEVEL_MIN = 1;
export const ZSTD_LEVEL_MAX = 19;
export const ARCHIVE_BASENAME_PREFIX = 'homegohan-db';
export const FILE_SUFFIXES = { archive: '.tar.zst.age', sha256: '.sha256', manifest: '.manifest.json' } as const;
export const MANIFEST_SCHEMA_VERSION = 1;
/** GitHub Actions の secrets / variables の名前 (値はここでは扱わない) */
export const REQUIRED_SECRET_NAMES = ['BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY'] as const;
export const REQUIRED_VARIABLE_NAMES = ['BACKUP_R2_ACCOUNT_ID', 'BACKUP_R2_BUCKET', 'BACKUP_AGE_RECIPIENT'] as const;
/** 運用で変えうる値の上書き (GitHub Actions variable。任意)。無ければ既定、形が違えば not_configured で止める */
export const RUN_TUNING_ENV = {
  dumpTimeoutMinutes: 'BACKUP_DUMP_TIMEOUT_MINUTES',
  uploadTimeoutMinutes: 'BACKUP_UPLOAD_TIMEOUT_MINUTES',
  restoreCheckTimeoutMinutes: 'BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES',
  zstdLevel: 'BACKUP_ZSTD_LEVEL',
} as const;
export const OPTIONAL_VARIABLE_NAMES = [
  RUN_TUNING_ENV.dumpTimeoutMinutes, RUN_TUNING_ENV.uploadTimeoutMinutes, RUN_TUNING_ENV.restoreCheckTimeoutMinutes, RUN_TUNING_ENV.zstdLevel,
] as const;
export const AGE_RECIPIENT_PATTERN = /^age1[0-9a-z]{58}$/;
/** aws cli 2.23 以降の既定の CRC ヘッダーを R2 が受け付けないことがあるので、要るときだけ付ける */
export const AWS_CHECKSUM_ENV = { AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' } as const;
export const R2_REGION = 'auto';
/** R2 の S3 互換 API の endpoint のホスト (`https://<アカウント>.<これ>`) */
export const R2_ENDPOINT_HOST_SUFFIX = 'r2.cloudflarestorage.com';
/** `https://${accountId}.${R2_ENDPOINT_HOST_SUFFIX}` (aws の --endpoint-url。§4.4) */
export declare function r2EndpointUrl(accountId: string): string;
/** `s3://${bucket}/${key}` (aws s3 cp の転送元・転送先。§4.4) */
export declare function r2ObjectUri(bucket: string, key: string): string;
/** aws を呼ぶ回 (upload・head-object・copy・inventory・restore の download) の CommandRunner の env。この形を返す:
 *  { AWS_ACCESS_KEY_ID: env.BACKUP_R2_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.BACKUP_R2_SECRET_ACCESS_KEY,
 *    AWS_SESSION_TOKEN: undefined, AWS_PROFILE: undefined, ...AWS_CHECKSUM_ENV }
 *  aws cli は BACKUP_R2_* を読まないので写す。手元のシェルの別の AWS の一時鍵・プロファイルは undefined で外す (子に渡さない)。鍵の値は argv に載せない */
export declare function awsCommandEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
/** restore サブコマンドが手元のシェルから読む名前 (§4.4。キーは復元用の読み取り専用のトークン)。BACKUP_AGE_RECIPIENT は読まない (復号は --identity-file) */
export const RESTORE_REQUIRED_ENV_NAMES = ['BACKUP_R2_ACCOUNT_ID', 'BACKUP_R2_BUCKET', 'BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY'] as const;
/** 段ごとの上限 (分)。段の中で起こす子プロセス 1 つずつの timeoutMs に掛かる (stageTimeoutMs。§4.12)。job 全体は workflow の timeout-minutes 300 (GitHub の 6 時間より短く)。
 *  copy は upload と同じ手元のファイルを層のキーへ送り直すので upload と同じ値 (上書きも BACKUP_UPLOAD_TIMEOUT_MINUTES が両方に効く。§4.4) */
export const STAGE_TIMEOUT_MINUTES = { link: 5, config: 1, stats: 5, dump: 120, catalog: 5, verify: 10, archive: 30, encrypt: 30, upload: 60, copy: 60, inventory: 5, restore_check: 60, audit: 5, cleanup: 5 } as const;
/** 分 → ミリ秒 (CommandRunner の timeoutMs) */
export const MS_PER_MINUTE = 60_000;
export const JOB_TIMEOUT_MINUTES = 300;
/** run の step の後に残す分 (stop と report の step が動く時間。§4.11) */
export const REPORT_STEP_RESERVE_MINUTES = 10;
/** run の step の timeout-minutes。job の上限から report の分を引く (run が時間切れでも report が動けるように) */
export const RUN_STEP_TIMEOUT_MINUTES = JOB_TIMEOUT_MINUTES - REPORT_STEP_RESERVE_MINUTES;
/** roundtrip-check job の timeout-minutes。ローカルのスタックの起動 (イメージの取得のやり直しを含む) が大半で、
 *  同じスタックを起こす security-regression.yml の job と同じ 45 分 (種まきした小さい DB の dump → 復元は数分) */
export const ROUNDTRIP_JOB_TIMEOUT_MINUTES = 45;
/** concurrency の group。backup job は固定 (取得どうしを直列)、roundtrip-check job は ref ごと (取得の group に入れない。§4.2) */
export const BACKUP_CONCURRENCY_GROUP = 'db-backup';
export const ROUNDTRIP_CONCURRENCY_GROUP = 'db-backup-roundtrip-${{ github.ref }}';
/** ローカルのスタックの枠 (scripts/lib/local-ci-slot.sh の枠。restore / roundtrip-local の --slot。§4.7 の引数の表)。既定は CI と同じ枠 0。
 *  上限は local-ci-slot.sh の LCS_SLOT_MAX と同じ値 (tests/backup-db.test.ts が tests/helpers/local-ci-slot-values.ts の slotMaxOf と突き合わせる) */
export const LOCAL_SLOT_DEFAULT = 0;
export const LOCAL_SLOT_MIN = 0;
export const LOCAL_SLOT_MAX = 9;
/** 枠を supabase-local.sh に渡す環境変数の名前 (start / env / stop に同じ値を渡す。run は LOCAL_SLOT_DEFAULT) */
export const LOCAL_SLOT_ENV = 'LOCAL_CI_SLOT';
/** GitHub Actions の外 (手元) で run を流したときの details / manifest の値 (runIdentityFromEnv) */
export const RUN_ID_OUTSIDE_ACTIONS = 'local';
export const RUN_ATTEMPT_OUTSIDE_ACTIONS = 0;
export const GIT_SHA_OUTSIDE_ACTIONS = 'unknown';
/** run → report の結果ファイルの名前 ($RUNNER_TEMP の下。workflow の 2 つの step が同じパスを書く) */
export const RUN_REPORT_FILE_NAME = 'db-backup-result.json';
export const RUN_REPORT_SCHEMA_VERSION = 1;
/** GitHub Actions の steps.<id>.outcome の値 */
export const STEP_OUTCOMES = ['success', 'failure', 'cancelled', 'skipped'] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];
/** pg_dump がダンプの最後に書く注釈の行 (data.sql。CLI は data の注釈を消さない)。これが無ければ途中で切れている */
export const DUMP_COMPLETE_TRAILER = '-- PostgreSQL database dump complete';
/** CLI の dump_data.sh が pg_dump の後に足す最後の行。pg_dump が失敗すると (set -euo pipefail で) 書かれない */
export const DATA_DUMP_FINAL_LINE = 'RESET ALL;';
/** COPY の本体の終わりの行 (text 形式) */
export const COPY_END_LINE = '\\.';
/** schema.sql の表の行。CLI は --quote-all-identifier で名前を引用符で囲み、`CREATE TABLE "` を `CREATE TABLE IF NOT EXISTS "` に書き換える
 *  (UNLOGGED は書き換えの対象外)。1 = schema、2 = 表 (どちらも `""` は引用符 1 つに戻して使う) */
export const SCHEMA_TABLE_LINE_PATTERN = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?"((?:[^"]|"")+)"\."((?:[^"]|"")+)" \($/;
/** 分割の親: 表の本体を閉じる `)` の行の次の行がこれで始まる (pg_dump は `)` と `PARTITION BY …;` を別の行に書く) */
export const PARTITION_BY_LINE_PREFIX = 'PARTITION BY ';
/** data.sql の COPY の行 (`COPY "<schema>"."<t>" ("a", "b") FROM stdin;`)。1 = schema、2 = 表 */
export const DATA_COPY_LINE_PATTERN = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)" (?:\(.*\) )?FROM stdin;$/;
/** 監査行の details の上限 (bytes)。SQL の record_backup_audit と同じ値 */
export const AUDIT_DETAILS_MAX_BYTES = 8192;
/** 伏せ字の規則 (scripts/lib/cron-secret-drift.mjs と同じ) */
export const MIN_OPAQUE_TOKEN_LENGTH = 24;
export const STDERR_TAIL_LINES = 5;
export const BACKUP_ISSUE_MARKER = '<!-- db-backup -->';
export const BACKUP_ISSUE_TITLE = '【自動】DB バックアップの失敗';
/** 監査行の結果 (action_type の 3 つ目) */
export const BACKUP_AUDIT_RESULTS = ['completed', 'failed'] as const;
export type BackupAuditResult = (typeof BACKUP_AUDIT_RESULTS)[number];
/** action_type (`backup.<層>.<結果>`)。migration の record_backup_audit が受け付ける 6 つ (段 A の契約テストが突き合わせる) と、
 *  src/lib/backups/core.ts の BACKUP_AUDIT_ACTION_TYPES (段 B の core のテストが同じ並びかを見る) と同じ */
export declare function backupAuditActionType(tier: BackupTier, result: BackupAuditResult): string;
/** BACKUP_TIERS × BACKUP_AUDIT_RESULTS の順 (daily.completed, daily.failed, weekly.completed, …) */
export declare const BACKUP_AUDIT_ACTION_TYPES: readonly string[];
/** psql の打ち方 (§4.12)。CommandRunner で `bash -c <本文>` として打つ。値 (接続先・パスワード・ファイルのパス) は env の
 *  PG_URL・PGPASSWORD・PSQL_FILE・SCHEMA_FILE・DATA_FILE で渡し、argv に載せない。psql は runner (手元なら手元の機械) のもの */
export const PSQL_SCRIPTS = {
  version: 'exec psql --version',
  audit: 'exec psql "$PG_URL" -X -q -At -v ON_ERROR_STOP=1 --single-transaction --file "$PSQL_FILE"',
  reset: 'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file "$PSQL_FILE"',
  roles: 'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=0 -v VERBOSITY=sqlstate --file "$PSQL_FILE"',
  restore:
    'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file "$SCHEMA_FILE" --command "SET session_replication_role = replica" --file "$DATA_FILE"',
  count: 'exec psql "$PG_URL" -X -q -At -v ON_ERROR_STOP=1 --file "$PSQL_FILE"',
  /** CATALOG_SNAPSHOT_SQL を流す。CommandRunner の cwd に CSV が書かれる (本番では catalog の段、復元した DB では restore_check) */
  catalog: 'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --file "$PSQL_FILE"',
  /** CRON_JOBS_FILE を確定させずに流す (roundtrip-local の §4.8 の 8 と、手順書 §6 の (6) の訓練が同じ打ち方) */
  cron_dry_run: 'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --command "BEGIN" --file "$PSQL_FILE" --command "ROLLBACK"',
} as const;
export type PsqlScriptName = keyof typeof PSQL_SCRIPTS;
/** 接続先の後ろに付ける sslmode。本番の pooler は必須、ローカルのスタックは無し (supabase-local.sh verify と同じ) */
export const REMOTE_PG_SSLMODE_QUERY = '?sslmode=require';
export const LOCAL_PG_SSLMODE_QUERY = '?sslmode=disable';
/** roles.sql で許すエラー (duplicate_object = ローカルにすでにあるロール)。ほかの SQLSTATE は復元の失敗 */
export const ROLES_TOLERATED_SQLSTATE = '42710';
/** VERBOSITY=sqlstate の psql が標準エラー出力に書くエラーの行 (`psql:<file>:<行>: ERROR:  42710`)。1 = SQLSTATE */
export const PSQL_SQLSTATE_ERROR_LINE = /\bERROR:\s+([0-9A-Z]{5})\s*$/;
/** 復元の後の数を 1 行 (`<表>|<利用者>|<監査行>`) で返す SQL。表は public の通常の表 (relkind r。分割の親を除き子を含む = verify の数え方) で、拡張の表を除く */
export const RESTORE_COUNT_SQL =
  "SELECT (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' " +
  "AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'e')), " +
  '(SELECT count(*) FROM auth.users), (SELECT count(*) FROM public.admin_audit_logs);';

export const STAGES = ['link', 'config', 'stats', 'dump', 'catalog', 'verify', 'archive', 'encrypt', 'upload', 'copy', 'inventory', 'restore_check', 'audit', 'cleanup'] as const;
export type Stage = (typeof STAGES)[number];
/** restore サブコマンドの段 (§4.7 の 2 つ目の表)。監査行には書かない */
export const RESTORE_STAGES = ['config', 'download', 'checksum', 'decrypt', 'extract', 'restore_env', 'restore', 'restore_check', 'cleanup'] as const;
export type RestoreStage = (typeof RESTORE_STAGES)[number];
/** restore サブコマンドの段ごとの上限 (分)。run の同じ大きさの仕事をする段の値をそのまま使う (download = upload、checksum = verify、decrypt = encrypt、
 *  extract = archive、restore_env・restore・restore_check = restore_check)。config・checksum・cleanup は子プロセスを起こさないので使わない (§4.12) */
export const RESTORE_STAGE_TIMEOUT_MINUTES: Readonly<Record<RestoreStage, number>> = {
  config: STAGE_TIMEOUT_MINUTES.config,
  download: STAGE_TIMEOUT_MINUTES.upload,
  checksum: STAGE_TIMEOUT_MINUTES.verify,
  decrypt: STAGE_TIMEOUT_MINUTES.encrypt,
  extract: STAGE_TIMEOUT_MINUTES.archive,
  restore_env: STAGE_TIMEOUT_MINUTES.restore_check,
  restore: STAGE_TIMEOUT_MINUTES.restore_check,
  restore_check: STAGE_TIMEOUT_MINUTES.restore_check,
  cleanup: STAGE_TIMEOUT_MINUTES.cleanup,
};
export const FAILURE_REASONS = [
  'link_failed', 'not_configured', 'stats_failed', 'dump_failed', 'catalog_failed', 'dump_incomplete', 'archive_failed', 'encrypt_failed',
  'upload_failed', 'upload_size_mismatch', 'copy_failed', 'inventory_failed', 'restore_check_failed', 'restore_env_failed',
  'audit_failed', 'download_failed', 'checksum_mismatch', 'decrypt_failed', 'extract_failed', 'image_pull_unavailable', 'timeout', 'unknown',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
/** 子プロセスが 0 以外で終わったときの段ごとの reason (classifyFailure が使う)。cleanup の失敗は警告だけで reason を持たない (§4.7)。
 *  config・verify は子プロセスを打たない段で、ここに当たるのは形の上だけ (checkConfig / verifyDumpFiles が not_configured / dump_incomplete を直接決める) */
export const STAGE_DEFAULT_REASON: Readonly<Record<Exclude<Stage | RestoreStage, 'cleanup'>, FailureReason>> = {
  link: 'link_failed', config: 'not_configured', stats: 'stats_failed', dump: 'dump_failed', catalog: 'catalog_failed', verify: 'dump_incomplete',
  archive: 'archive_failed', encrypt: 'encrypt_failed', upload: 'upload_failed', copy: 'copy_failed', inventory: 'inventory_failed',
  restore_check: 'restore_check_failed', audit: 'audit_failed', download: 'download_failed', checksum: 'checksum_mismatch',
  decrypt: 'decrypt_failed', extract: 'extract_failed', restore_env: 'restore_env_failed', restore: 'restore_check_failed',
};
/** 終了コード: 0 成功 / 1 失敗 (記録済み) / 2 引数の誤り / 3 未設定で止めた */
export const EXIT_CODES = { ok: 0, failed: 1, usage: 2, not_configured: 3 } as const;
/** 子プロセスを起こせなかった (ENOENT) ときに CommandRunner が返す終了コード (bash の「コマンドが無い」と同じ) */
export const COMMAND_NOT_FOUND_EXIT_CODE = 127;
/** 子プロセスが 0 以外で終わった。段の中で runBackup / restoreFromArchive / roundtripLocal が投げ、classifyFailure が段の既定の reason にする */
export declare class CommandFailedError extends Error {
  readonly cmd: string;
  readonly code: number;
  constructor(cmd: string, code: number);
}
/** CommandRunner が timeoutMs を超えた子プロセスを止めた (SIGTERM)。classifyFailure は timeout にする */
export declare class CommandTimeoutError extends Error {
  readonly cmd: string;
  readonly timeoutMs: number;
  constructor(cmd: string, timeoutMs: number);
}

/** 取得の前に live の本番から取った数。記録だけで、verify・restore_check の突き合わせには使わない (§4.3) */
export interface SourceStats { public_tables: number; auth_users: number; db_size_bytes: number }
/** ダンプの中身の数 (data.sql から数えた)。restore_check の基準 */
export interface DumpCounts { public_tables: number; auth_users: number; audit_rows: number }
/** data.sql を 1 行ずつ読んだ結果 */
export interface DataSqlScan {
  public_copy_tables: string[];        // `COPY "public"."<t>" …` の <t> (引用符を外した名前。出てきた順)
  managed_copy_tables: string[];       // `COPY "auth"."<t>"` / `COPY "storage"."<t>"` の `<schema>.<t>` (引用符を外した名前)
  copy_row_counts: Record<string, number>; // `<schema>.<t>` (引用符を外した名前。例 `auth.users`) → COPY の本体の行数 (COPY_END_LINE の手前まで)
  unterminated_copy: string | null;    // COPY_END_LINE が来る前にファイルが終わった COPY の `<schema>.<t>`
  complete_trailer_seen: boolean;      // COPY の本体の外に DUMP_COMPLETE_TRAILER と同じ行があった
  statements_after_trailer: string[];  // 最後の DUMP_COMPLETE_TRAILER より後の行のうち、空でも `--` で始まる注釈でもない行 (正常なら [DATA_DUMP_FINAL_LINE] だけ。完了行が無ければ [])
  unexpected_copy_tables: string[];    // COPY の schema が DATA_DUMP_SCHEMAS に無いものの `<schema>.<t>` (正常なら []。verify の 6)
}
/** schema.sql を 1 行ずつ読んだ結果 */
export interface SchemaSqlScan {
  public_tables: string[];      // SCHEMA_TABLE_LINE_PATTERN で schema が public の <t> (引用符を外した名前)。`)` の次の行が PARTITION_BY_LINE_PREFIX で始まる親は除く
  non_public_tables: string[];  // SCHEMA_TABLE_LINE_PATTERN で schema が public でない `<schema>.<t>` (分割の親も含む。正常なら []。verify の 6)
}
export interface BackupManifest {
  schema_version: typeof MANIFEST_SCHEMA_VERSION;
  captured_at: string;            // ISO 8601 UTC (取得の開始)
  jst_date: string;               // YYYY-MM-DD (JST)
  tiers: BackupTier[];
  basename: string;               // homegohan-db-<YYYYMMDDTHHMMSSZ>
  git_sha: string;
  supabase_cli: string;
  postgres_version: string;       // supabase/.temp/postgres-version
  age_recipient: string;
  excluded_tables: string[];
  data_schemas: string[];         // DATA_DUMP_SCHEMAS (data.sql に入れたスキーマ)
  source: SourceStats;            // 記録だけ
  dumped: DumpCounts;             // restore_check の基準
  ledger: LedgerSummary;          // 取得の時点の台帳 (版の一覧そのものは書庫の ledger.txt)。restore_check の基準
  cron_jobs: number;              // 書庫の cron_jobs.sql のジョブの数 (2026-10-16 の本番は 15)。restore_check の基準
  files: Array<{ name: string; size_bytes: number; sha256: string | null }>; // sha256 は .age だけ
}
/** 台帳の要約 (版の数と、最大の版) */
export interface LedgerSummary { versions_count: number; max_version: string }
export interface RunPlan { jst_date: string; tiers: BackupTier[]; basename: string; keys: Record<BackupTier, Record<keyof typeof FILE_SUFFIXES, string>> }
/** 復元の検査の結果 (数は復元した後のローカルの DB の値)。ローカルの cron.job は数えない (§4.8 の 8)。
 *  catalog_errors / catalog_warnings は verify_baseline.py の要約の数、ledger_versions は ledger.txt の版の数、cron_jobs は書庫の cron_jobs.sql のジョブの数
 *  (どれも、その手前で落ちた・読めなかったときは null) */
export interface RestoreCheckResult {
  result: 'passed' | 'failed'; public_tables: number; auth_users: number; audit_rows: number;
  catalog_errors: number | null; catalog_warnings: number | null; ledger_versions: number | null; cron_jobs: number | null; duration_seconds: number;
}
export interface InventoryCounts { daily_objects: number; weekly_objects: number; annual_objects: number }
export interface CompletedAuditDetails {
  tier: BackupTier; key: string; sha256: string; size_bytes: number; captured_at: string; duration_seconds: number;
  public_tables: number; auth_users: number; run_id: string; run_attempt: number; git_sha: string;   // public_tables / auth_users は manifest の dumped の値
  copied_from?: string;   // weekly / annual の行: 同じ手元のファイルを送った daily のキー (R2 の中のコピーはしない。§4.4)
  restore_check?: RestoreCheckResult; inventory?: InventoryCounts;
}
export interface FailedAuditDetails {
  tier: BackupTier; stage: Stage; reason: FailureReason; duration_seconds: number; run_id: string; run_attempt: number; git_sha: string;
  key?: string; copied_from?: string; missing?: string[]; expected?: number; actual?: number;
}
/** 失敗の 1 件。同じ層が 2 回出ることがある (例: copy の失敗のあと audit も失敗) */
export interface RunFailure { tier: BackupTier; stage: Stage; reason: FailureReason; missing?: string[] }
/** completed = 取得 (R2 の対象物と検査) が成功した層。監査行の成否によらない (audit が失敗しても残る。S-20)。
 *  auditWritten = 全層の監査行を書けた (1 回の取引なので、全部か 0 行か)。exitCode = config の失敗があれば 3、ほかに失敗があれば 1、無ければ 0 */
export interface RunResult { ok: boolean; exitCode: number; plan: RunPlan; completed: BackupTier[]; failed: RunFailure[]; warnings: Array<{ stage: 'inventory'; reason: 'inventory_failed' }>; auditWritten: boolean }
/** run → report の結果ファイルの中身 (§4.11)。値 (secrets / variables) は入れない。missing は名前だけ。completed・audit_written の意味は RunResult と同じ */
export interface BackupRunReport {
  schema_version: typeof RUN_REPORT_SCHEMA_VERSION;
  status: 'ok' | 'failed' | 'not_configured';
  exit_code: number;
  jst_date: string;
  completed: BackupTier[];
  failures: RunFailure[];
  warnings: Array<{ stage: 'inventory'; reason: 'inventory_failed' }>;
  audit_written: boolean;
}
/** RunResult から結果ファイルの中身を作る (status は exitCode から: 0 → ok、EXIT_CODES.not_configured → not_configured、ほか → failed。failures は RunResult.failed をそのまま) */
export declare function toRunReport(result: RunResult): BackupRunReport;
/** runBackup が reject したとき (段の外の記帳の誤り) に runCli が書く結果ファイル: status failed・exit_code 1・completed []・failures []・warnings []・audit_written false。
 *  jstDate は runCli が runBackup の前に planRun で作った値 */
export declare function unexpectedFailureReport(input: { jstDate: string }): BackupRunReport;
/** 結果ファイルの本文を読む。JSON でない・schema_version が違う・必須のキーが無い・列挙の外の値がある・status が exit_code から決まる値と違う・
 *  status が ok なのに failures があれば null (= 結果ファイルが無いのと同じ扱い) */
export declare function parseRunReport(text: string | null): BackupRunReport | null;
/** report の step の判定 (§4.11 の 4 通り。上から順に当て、failures の件数では判定しない)。body は BACKUP_ISSUE_MARKER で始まり、run の URL を含む */
export declare function planBackupIssue(input: { report: BackupRunReport | null; runOutcome: StepOutcome; runUrl: string }): { hasProblems: false } | { hasProblems: true; title: typeof BACKUP_ISSUE_TITLE; body: string };

/** JST の暦日から層を決める: daily は常に、月曜なら weekly、1/1 なら annual */
export declare function tiersForDate(jstDate: string): BackupTier[];
/** 取得の予定を作る。tierOverride が auto 以外なら、その層 (weekly / annual は daily と一緒) */
export declare function planRun(input: { now: Date; tierOverride: 'auto' | BackupTier }): RunPlan;
export declare function objectKey(tier: BackupTier, jstDate: string, basename: string, suffix: keyof typeof FILE_SUFFIXES): string;
/** env (値) を受け取り、必須の名前の無い・空・形が違うもの と、任意の RUN_TUNING_ENV の形が違うもの (resolveRunTuning の invalid) を返す。値は返さない・ログに出さない */
export declare function checkConfig(env: Record<string, string | undefined>): { ok: true } | { ok: false; missing: string[] };
/** restore の config の段。RESTORE_REQUIRED_ENV_NAMES の無い・空の名前と、RUN_TUNING_ENV の形が違う名前 (resolveRunTuning の invalid) を missing に返す
 *  (BACKUP_AGE_RECIPIENT は見ない)。値は返さない・ログに出さない。ok なら resolveRunTuning の tuning */
export declare function checkRestoreConfig(env: Record<string, string | undefined>): { ok: true; tuning: RunTuning } | { ok: false; missing: string[] };
export interface RunTuning { dumpTimeoutMinutes: number; uploadTimeoutMinutes: number; restoreCheckTimeoutMinutes: number; zstdLevel: number }
/** run (と roundtrip-local) の段の子プロセスの timeoutMs = STAGE_TIMEOUT_MINUTES[stage] × MS_PER_MINUTE。dump・upload・restore_check は tuning の値、
 *  copy は tuning.uploadTimeoutMinutes (roundtrip-local は既定の tuning で呼び、restore_env の子は 'restore_check' で呼ぶ。§4.12) */
export declare function stageTimeoutMs(stage: Stage, tuning: RunTuning): number;
/** restore サブコマンドの段の子プロセスの timeoutMs = RESTORE_STAGE_TIMEOUT_MINUTES[stage] × MS_PER_MINUTE。download は tuning.uploadTimeoutMinutes、
 *  restore_env・restore・restore_check は tuning.restoreCheckTimeoutMinutes (§4.12) */
export declare function restoreStageTimeoutMs(stage: RestoreStage, tuning: RunTuning): number;
/** RUN_TUNING_ENV を読む。無い・空は既定 (STAGE_TIMEOUT_MINUTES の dump / upload / restore_check、ZSTD_LEVEL)。
 *  時間は 1 以上 JOB_TIMEOUT_MINUTES 以下の整数、zstd は ZSTD_LEVEL_MIN〜ZSTD_LEVEL_MAX の整数。外れたら invalid に名前 (既定に黙って戻さない) */
export declare function resolveRunTuning(env: Record<string, string | undefined>): { ok: true; tuning: RunTuning } | { ok: false; invalid: string[] };
/** COPY の行 (DATA_COPY_LINE_PATTERN) を schema と表に分ける (引用符を外し `""` を `"` に戻す)。当たらなければ null */
export declare function parseCopyLine(line: string): { schema: string; table: string } | null;
/** schema.sql の表の行 (SCHEMA_TABLE_LINE_PATTERN) を schema と表に分ける (引用符を外し `""` を `"` に戻す)。当たらなければ null */
export declare function parseSchemaTableLine(line: string): { schema: string; table: string } | null;
/** data.sql を 1 行ずつ読む (GB 級なので行の非同期の列で受ける。全体を文字列にしない) */
export declare function scanDataSql(lines: AsyncIterable<string>): Promise<DataSqlScan>;
/** schema.sql を 1 行ずつ読む */
export declare function scanSchemaSql(lines: AsyncIterable<string>): Promise<SchemaSqlScan>;
/** §4.3 の verify の 1〜6。基準はダンプの中身 (schema.sql の表) で、live の stats を受け取らない。合えば dumped を返す */
export declare function verifyDumpFiles(input: { fileSizes: Record<(typeof DUMP_FILES)[number], number>; data: DataSqlScan; schema: SchemaSqlScan }): { ok: true; dumped: DumpCounts } | { ok: false; reason: 'dump_incomplete'; expected: number; actual: number };
/** DataSqlScan の managed_copy_tables (`COPY "auth"."x"` / `COPY "storage"."x"`) から、復元の前に空にする表を `<schema>.<t>` で集める (重複を除き、出てきた順) */
export declare function managedTablesInDump(scan: DataSqlScan): string[];
/** 復元の前に空にする SQL (§4.8 の 2)。public を落として作り直し GRANT し、RESET_STORAGE_POLICIES_SQL で storage のポリシーを全部外し、
 *  managedTables を TRUNCATE … CASCADE (名前は引用符で囲み `"` は `""`。空なら TRUNCATE の文を書かない)。この順 */
export declare function buildResetSql(managedTables: readonly string[]): string;
/** roles.sql を流した psql (VERBOSITY=sqlstate) の標準エラー出力の全部を、PSQL_SQLSTATE_ERROR_LINE の行で数える。
 *  tolerated = ROLES_TOLERATED_SQLSTATE の数、others = ほかの SQLSTATE (出てきた順・重複を残す) */
export declare function countRoleRestoreErrors(stderrText: string): { tolerated: number; others: string[] };
/** `supabase-local.sh env` の標準出力から `SUPABASE_DB_URL=` の行の値を取る (無い・空なら null) */
export declare function parseLocalDbUrl(envText: string): string | null;
/** RESTORE_COUNT_SQL の出力 (`<表>|<利用者>|<監査行>` の 1 行。前後の空白・改行は無視) を読む。3 つの 0 以上の整数でなければ null */
export declare function parseRestoreCounts(stdout: string): DumpCounts | null;
/** ledger.txt の本文を読む。空の行は無視し、残りがすべて LEDGER_VERSION_PATTERN で、真に昇順 (重複なし) で 1 つ以上なら版の配列、ほかは null */
export declare function parseLedgerVersions(text: string): string[] | null;
/** CRON_JOBS_FILE の本文を読む。空の行は無視し、最後の行が CRON_CHECK_LINE_PREFIX で始まり、ほかの行がすべて CRON_SCHEDULE_LINE_PATTERN に当たり、
 *  名前 ('' は ' に戻す) が重ならなければ、名前の配列 (ファイルの順。ジョブ 0 本なら [])。ほかは null */
export declare function parseCronJobsSql(text: string): string[] | null;
/** 復元の検査の cron の突き合わせ (§4.8 の 8)。parseCronJobsSql(cronJobsText) が null でなく、その数が expected (manifest の cron_jobs) と同じなら ok */
export declare function cronJobsChecks(expected: number, cronJobsText: string): { ok: true; cron_jobs: number } | { ok: false; reason: 'restore_check_failed'; expected: number; actual: number | null };
/** CSV (RFC 4180。psql の \copy … WITH (FORMAT csv) の出力) を行の配列にする。引用符の中の `,`・改行・`""` を扱う。
 *  引用符が閉じていない・閉じた引用符の後ろが区切り (`,`・改行・終わり) でない → null。最後の改行の後の空の行は数えない */
export declare function parseCsv(text: string): string[][] | null;
/** トリガーの定義 (TRIGGER_DEFINITION_PATTERN) から実行する関数のスキーマを取る。名前にスキーマが無ければ null、定義の形が違えば undefined */
export declare function triggerFunctionSchema(definition: string): string | null | undefined;
/** アプリのトリガーか (関数のスキーマが INTERNAL_TRIGGER_FUNCTION_SCHEMAS に無い。スキーマ無しもアプリ)。定義の形が違えば undefined */
export declare function isAppTrigger(definition: string): boolean | undefined;
export interface TriggerCatalogRow { key: string; schema: string; table: string; name: string; definition: string; app: boolean }
/** AUTH_STORAGE_TRIGGERS_CSV の本文を読む。見出しが TRIGGER_CSV_COLUMNS で、どの行も 4 列・定義が TRIGGER_DEFINITION_PATTERN に当たり、
 *  key (`<schema>.<table>.<trigger>`) が重ならなければ行の配列 (ファイルの順)。ほかは null */
export declare function parseTriggerCatalog(text: string): TriggerCatalogRow[] | null;
/** 復元の検査のトリガーの突き合わせ (§4.8 の 7 の後半)。取得の時点と復元した DB のアプリのトリガーを key で比べ、
 *  missing (取得の時点にだけある)・extra (復元した DB にだけある)・differs (定義が違う) のどれかがあれば、またはどちらかが読めなければ失敗。
 *  key は昇順。内部のトリガーの差は ok のまま internal_differences (昇順) に返す */
export declare function appTriggerChecks(capturedText: string, restoredText: string):
  | { ok: true; app_triggers: number; internal_differences: string[] }
  | { ok: false; reason: 'restore_check_failed'; unreadable: boolean; missing: string[]; extra: string[]; differs: string[] };
/** catalog の段の判定 (§4.3 の catalog の 4)。csvLineCounts は CATALOG_CSV_FILES ごとの行の数 (ファイルが無ければ null)。
 *  7 つとも 1 以上・parseLedgerVersions(ledgerText) が null でない・parseCronJobsSql(cronJobsText) が null でない・fixupsBytes が 1 以上で ok
 *  (ledger は版の数と最大、cron_jobs はジョブの数) */
export declare function checkCatalogCapture(input: { csvLineCounts: Record<CatalogCsvFile, number | null>; ledgerText: string; cronJobsText: string; fixupsBytes: number }): { ok: true; ledger: LedgerSummary; cron_jobs: number } | { ok: false; reason: 'catalog_failed' };
/** verify_baseline.py の標準出力のうち、最後の CATALOG_VERIFY_SUMMARY_LINE の行を読む (無ければ null) */
export declare function parseCatalogVerifySummary(stdout: string): { errors: number; warnings: number } | null;
/** 台帳の突き合わせ (§4.8 の 8)。版の数と最大が expected と同じ、かつ全部の版に、migrationFileNames (MIGRATIONS_DIR の中の名前) のうち
 *  `<版>_` で始まり `.sql` で終わるものがあれば ok。versions_without_files はファイルの無い版 (出てきた順) */
export declare function ledgerChecks(expected: LedgerSummary, versions: readonly string[], migrationFileNames: readonly string[]): { ok: true } | { ok: false; reason: 'restore_check_failed'; expected: LedgerSummary; actual: LedgerSummary; versions_without_files: string[] };
/** 監査行の 1 行分 */
export type AuditRow =
  | { tier: BackupTier; result: 'completed'; details: CompletedAuditDetails }
  | { tier: BackupTier; result: 'failed'; details: FailedAuditDetails };
/** 監査行を書く SQL (rows の順に 1 行 1 文: `SELECT public.record_backup_audit('<backupAuditActionType>', pg_catalog.convert_from(pg_catalog.decode('<JSON の UTF-8 の base64>', 'base64'), 'UTF8')::jsonb);`)。
 *  SQL の中に JSON の文字 (`{` `"` `\`) は出ない。action_type は BACKUP_AUDIT_ACTION_TYPES の値だけ */
export declare function buildAuditSql(rows: readonly AuditRow[]): string;
/** 基準は manifest の dumped (ダンプの中身)。observed は parseRestoreCounts の値。3 つとも完全一致で ok */
export declare function restoreChecks(expected: DumpCounts, observed: DumpCounts): { ok: true } | { ok: false; reason: 'restore_check_failed'; expected: DumpCounts; actual: DumpCounts };
export declare function buildManifest(input: Omit<BackupManifest, 'schema_version'>): BackupManifest;
/** details を作り、AUDIT_DETAILS_MAX_BYTES を超えたら inventory → restore_check の順に落とす (超えたまま送らない) */
export declare function buildCompletedDetails(input: CompletedAuditDetails): CompletedAuditDetails;
export declare function buildFailedDetails(input: FailedAuditDetails): FailedAuditDetails;
/** 段と失敗から reason を決める (上から順に当てる): CommandTimeoutError → timeout / CommandFailedError で code が IMAGE_PULL_UNAVAILABLE_EXIT_CODE かつ
 *  段が stats・dump・restore_env → image_pull_unavailable / CommandFailedError → STAGE_DEFAULT_REASON[段] /
 *  それ以外の例外 (TypeError・fs の失敗など。子プロセスの失敗でない) → unknown。cleanup には使わない。
 *  run の restore_check の段は、ローカルのスタックを起こす部分 (psql --version・python3 --version・supabase-local.sh start / env) を 'restore_env' で、
 *  復元と突き合わせ (reset〜台帳。§4.8 の 2〜8) を 'restore_check' で渡す (監査行の stage はどちらも restore_check) */
export declare function classifyFailure(stage: Exclude<Stage | RestoreStage, 'cleanup'>, error: unknown): FailureReason;
export declare function redactForLog(text: string, env: Record<string, string | undefined>): string;
/** restore の --key (アーカイブのキー) から、同じ場所の .sha256 / .manifest.json のキーを作る。形が違えば null (parseArgs が使い方の誤りにする) */
export declare function siblingKeys(archiveKey: string): Record<keyof typeof FILE_SUFFIXES, string> | null;
/** `.sha256` の本文 (sha256sum の出力 `<hex>  <name>`) と、取ったファイルのダイジェストを比べる */
export declare function verifyChecksum(input: { sha256FileText: string; actualSha256: string }): { ok: true } | { ok: false; reason: 'checksum_mismatch'; expectedPrefix: string; actualPrefix: string };
/** wrangler r2 bucket lifecycle set --file が受ける形 (Cloudflare の API の put object lifecycle configuration の本文)。S3 の形 (Rules / Expiration / STANDARD_IA) ではない (§3.3) */
export interface R2LifecycleAgeCondition { type: 'Age'; maxAge: number }   // maxAge は秒 (日数 × SECONDS_PER_DAY)
export interface R2LifecycleRule {
  id: string;
  enabled: true;
  conditions: { prefix?: string };     // prefix を持たない ({}) ルールはバケット全体
  deleteObjectsTransition?: { condition: R2LifecycleAgeCondition };
  storageClassTransitions?: Array<{ condition: R2LifecycleAgeCondition; storageClass: 'InfrequentAccess' }>;
  abortMultipartUploadsTransition?: { condition: R2LifecycleAgeCondition };
}
/** §4.5 の Lifecycle の JSON を RETENTION_DAYS / INFREQUENT_ACCESS_AFTER_DAYS / R2_ABORT_MULTIPART_AFTER_DAYS から作る (日数 × SECONDS_PER_DAY の秒) */
export declare function buildR2LifecycleConfig(): { rules: R2LifecycleRule[] };
/** §4.5 の wrangler の 4 行 (lifecycle set 1 + lock add 3) を argv の配列で作る。lock の日数は RETENTION_DAYS、名前は `<層>-<日数>d` */
export declare function buildR2LockCommands(input: { bucket: string; lifecycleFile: string }): string[][];
/** 監査行の details と manifest の run_id・run_attempt・git_sha を、GitHub Actions が自動で入れる GITHUB_RUN_ID・GITHUB_RUN_ATTEMPT・GITHUB_SHA から取る。
 *  無い・空 (手元で run を流したとき) は RUN_ID_OUTSIDE_ACTIONS・RUN_ATTEMPT_OUTSIDE_ACTIONS・GIT_SHA_OUTSIDE_ACTIONS。GITHUB_RUN_ATTEMPT が 1 以上の整数でなければ RUN_ATTEMPT_OUTSIDE_ACTIONS */
export declare function runIdentityFromEnv(env: Record<string, string | undefined>): { run_id: string; run_attempt: number; git_sha: string };
/** §4.7 の引数の表。run の --result-file は任意 (手元で流すときは省ける。workflow では必ず渡す)。report-issue の 3 つは必須で、--run-outcome は STEP_OUTCOMES の中。
 *  restore / roundtrip-local の --slot は省けば LOCAL_SLOT_DEFAULT、LOCAL_SLOT_MIN〜LOCAL_SLOT_MAX の 10 進の整数でなければ UsageError (run は --slot を受け付けない) */
export declare function parseArgs(argv: string[]): { command: 'run'; tier: 'auto' | BackupTier; resultFile: string | null } | { command: 'restore'; key: string; identityFile: string; slot: number } | { command: 'roundtrip-local'; slot: number } | { command: 'report-issue'; resultFile: string; runOutcome: StepOutcome; runUrl: string } | { command: 'r2-config'; bucket: string; outDir: string } | { command: 'help' };

/** 子プロセスを 1 つ動かす。終了コードによらず { code, stdout, stderrTail } で解決する (起こせない ENOENT は COMMAND_NOT_FOUND_EXIT_CODE)。
 *  env は親の環境 (runCli の既定の runner では process.env) に重ねて子に渡し、値が undefined のキーは渡さない (Node の spawn と同じ。awsCommandEnv が使う)。
 *  timeoutMs (stageTimeoutMs / restoreStageTimeoutMs の値) を超えたら止めて CommandTimeoutError で reject。stdinFile は標準入力、stdoutFile は標準出力の書き先 (このとき stdout は '')、
 *  stderrFile は標準エラー出力の全部の写し。stderrTail は標準エラー出力の末尾 STDERR_TAIL_LINES 行を redactForLog したもの */
export interface CommandRunner { (cmd: string, args: string[], options: { env?: Record<string, string | undefined>; timeoutMs: number; cwd?: string; stdinFile?: string; stdoutFile?: string; stderrFile?: string }): Promise<{ code: number; stdout: string; stderrTail: string }> }
export interface RunDeps { run: CommandRunner; env: Record<string, string | undefined>; now: () => Date; log: (line: string) => void; workDir?: string }
export declare function runBackup(options: { tier: 'auto' | BackupTier }, deps: RunDeps): Promise<RunResult>;
/** 手元のシェルの R2 の 4 つと調整用の値を確かめ (config。checkRestoreConfig。無ければ終了 3)、R2 から 3 ファイルを取り出し (download。§4.4 の aws の argv と
 *  awsCommandEnv)、sha256 を突き合わせ (checksum。Node の crypto で取る。合わなければ復号しない)、identity で復号し (decrypt)、展開し (extract)、
 *  ローカルの枠 slot のスタックに復元して fixups.sql を流し (restore_env → restore)、数を manifest の dumped と、カタログを書庫の catalog/ と、
 *  台帳を manifest の ledger と MIGRATIONS_DIR と、cron_jobs.sql のジョブの数を manifest の cron_jobs と突き合わせる (restore_check。§4.8 の 6〜8)。
 *  子プロセスの timeoutMs は restoreStageTimeoutMs(段, tuning)。§4.7 の 2 つ目の表 */
export declare function restoreFromArchive(options: { key: string; identityFile: string; slot: number }, deps: RunDeps): Promise<{ ok: boolean; exitCode: number; checks?: RestoreCheckResult; stage?: RestoreStage; reason?: FailureReason }>;
/** ローカルのスタックをダンプし、同じ DB から catalog (カタログ・台帳・cron のジョブの定義・補いの SQL) を取り、空にして復元し、数・カタログ・台帳・cron のジョブの数を突き合わせ、
 *  cron_jobs.sql を確定させずに流す (cron_dry_run。§4.8 の 8)。PR の往復テスト */
export declare function roundtripLocal(options: { slot: number }, deps: RunDeps): Promise<{ ok: boolean; exitCode: number; checks?: RestoreCheckResult; reason?: FailureReason }>;
/** report-issue が使う GitHub の操作 (scripts/consistency-check.mjs の createGitHub が返すものの一部) */
export interface BackupIssueGitHub {
  listOpenIssues(): Array<{ number: number; title: string; body: string }>;
  createIssue(title: string, body: string): number;
  updateIssue(issueNumber: number, body: string): void;
  closeIssue(issueNumber: number, comment: string): void;
}
export interface CliDeps {
  run?: CommandRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  log?: (line: string) => void;
  /** 既定は createGitHub({ repo: env.GITHUB_REPOSITORY }) */
  github?: BackupIssueGitHub;
  /** 既定は runBackup。テストで reject させて、runCli の catch が結果ファイルを書くことを確かめる */
  runBackup?: typeof runBackup;
}
/** scripts/backup-db.mjs の本体。parseArgs の誤り → 使い方を出して 2。run: planRun で jst_date を決め → runBackup → finally で結果ファイル
 *  (--result-file があるとき。toRunReport か、reject なら unexpectedFailureReport。`<path>.tmp-<pid>` に書いて rename) → 終了コード (reject は 1)。
 *  report-issue: env.GITHUB_REPOSITORY が無い・空なら 2 (github を作らない) → parseRunReport → planBackupIssue → planIssueAction → github
 *  (listOpenIssues / createIssue / updateIssue / closeIssue のどれかが例外なら、どの操作かと redactForLog した文を出して 1。ほかは 0。§4.7 の report-issue の表) */
export declare function runCli(argv: string[], deps?: CliDeps): Promise<number>;
```

- `restoreDatabase({ pgUrl, workDir })` (§4.12 の roles → restore → fixups)・`dumpDatabase({ linked: true } | { dbUrl })` (dump の 3 回。data の回は `-s` に `DATA_DUMP_SCHEMAS.join(',')`・`-x` に `DUMP_EXCLUDED_TABLES`)・`captureCatalog({ pgUrl, pgPassword, workDir, schemaFile })` (§4.3 の catalog の 1〜3。`pgPassword` は本番のときだけ。戻り値は `checkCatalogCapture` の入力)・`resetForRestore(pgUrl, managedTables)` (§4.12 の reset)・`countRestored(pgUrl)` (§4.12 の count → `parseRestoreCounts`)・`verifyRestoredCatalog({ pgUrl, catalogDir, workDir })` (§4.8 の 7。復元した DB の catalog → `verify_baseline.py` → `parseCatalogVerifySummary`)・`verifyRestoredTriggers({ catalogDir, workDir })` (§4.8 の 7 の後半。`verifyRestoredCatalog` の直後に `appTriggerChecks`。合わなければ restore_check_failed)・`cronDryRun({ pgUrl, cronJobsFile })` (§4.12 の `cron_dry_run`。`roundtripLocal` だけが呼ぶ)・`localPgUrl(slot)` (§4.12 の version と `python3 --version` → `supabase-local.sh start` → `env` → `parseLocalDbUrl` + `LOCAL_PG_SSLMODE_QUERY`。`supabase-local.sh` を打つときは (start・env・stop のどれも) env に `{ [LOCAL_SLOT_ENV]: String(slot) }` を足して渡す。run は `LOCAL_SLOT_DEFAULT`) は内部の関数で、3 つの入口 (`runBackup` の catalog と restore_check・`restoreFromArchive`・`roundtripLocal`) が共有する。`ledgerChecks` に渡すファイル名は `fs.readdirSync(MIGRATIONS_DIR)` (入口はリポジトリの直下で動かす)。
- 段の処理は段ごとの try / catch で包み、子プロセスの非 0 は `CommandFailedError` にして投げ、catch で `classifyFailure(段, err)` の reason の失敗にする。`runBackup`・`restoreFromArchive`・`roundtripLocal` は段の失敗で reject しない (§4.7)。
- `run` の差し替えで単体テストは本物の supabase / aws / age / docker を呼ばない (`scripts/lib/cron-secret-drift.mjs` と同じ作り)。
- `r2-config` は R2 に繋がない (ファイルを 1 つ書き、コマンドを表示するだけ)。流すのはオーナー。

運用で変えうる値と、契約で固定する値 (R-13):

| 値 | 扱い | 理由 |
|---|---|---|
| `STAGE_TIMEOUT_MINUTES` の dump / upload / copy / restore_check、`ZSTD_LEVEL` | variable で上書きできる (`RUN_TUNING_ENV`。copy は upload と同じ `BACKUP_UPLOAD_TIMEOUT_MINUTES` で上書きされる)。`restore` サブコマンドの download・restore_env・restore・restore_check も、同じ名前を手元のシェルに置けば上書きできる (`restoreStageTimeoutMs`) | DB の大きさで変わる。上書きしてもほかの面とずれない |
| `STAGE_TIMEOUT_MINUTES` のほかの段・`RESTORE_STAGE_TIMEOUT_MINUTES`・`MS_PER_MINUTE` | 固定 (`RESTORE_STAGE_TIMEOUT_MINUTES` は run の段の値から作る) | 1〜30 分で終わる短い段で、DB の大きさにほぼよらない。`restore` の段は同じ大きさの仕事をする run の段と同じ値にし、別の数を持たない |
| `RETENTION_DAYS`・`INFREQUENT_ACCESS_AFTER_DAYS`・`R2_ABORT_MULTIPART_AFTER_DAYS`・`LOCK_MAX_AGE_SECONDS` | 固定 (変えるときはコードを変え、`r2-config` を流し直す) | R2 の Lifecycle / lock と同じ値でなければならない。env で片方だけ変わると lock と削除がずれる |
| `BACKUP_SCHEDULE_CRON_UTC`・`JOB_TIMEOUT_MINUTES`・`RUN_STEP_TIMEOUT_MINUTES`・`RUN_REPORT_FILE_NAME` | 固定 (workflow の YAML と同じ PR で変える) | YAML の `schedule` / job と run の step の `timeout-minutes` / 2 つの step の `--result-file` と一致を `tests/db-backup-workflow.test.ts` が見る |
| `DUMP_COMPLETE_TRAILER`・`DATA_DUMP_FINAL_LINE`・`COPY_END_LINE`・`SCHEMA_TABLE_LINE_PATTERN`・`PARTITION_BY_LINE_PREFIX`・`DATA_COPY_LINE_PATTERN`・`RUN_REPORT_SCHEMA_VERSION`・`STEP_OUTCOMES` | 固定 | pg_dump・supabase CLI (`SUPABASE_CLI_VERSION`) の出力の形・GitHub Actions の仕様と、run / report の 2 つの step の間の契約。CLI の版を上げる PR は、往復の検査 (`roundtrip-check`) と §15 の実物の検査 (`supabase/baseline/prod_schema.sql`) で形が変わっていないことを確かめる |
| `LOCAL_SLOT_DEFAULT`・`LOCAL_SLOT_MIN`・`LOCAL_SLOT_MAX`・`LOCAL_SLOT_ENV` | 固定 (枠を選ぶのは `--slot` の引数) | `scripts/lib/local-ci-slot.sh` の枠の範囲 (`LCS_SLOT_MAX`) と `supabase-local.sh` の `LOCAL_CI_SLOT` に合わせた値 (`tests/backup-db.test.ts` が突き合わせる) |
| `RUN_ID_OUTSIDE_ACTIONS`・`RUN_ATTEMPT_OUTSIDE_ACTIONS`・`GIT_SHA_OUTSIDE_ACTIONS` | 固定 | Actions の外で流したと分かる印で、運用で変えるものではない |
| `ROUNDTRIP_JOB_TIMEOUT_MINUTES`・`BACKUP_CONCURRENCY_GROUP`・`ROUNDTRIP_CONCURRENCY_GROUP` | 固定 (workflow の YAML と同じ PR で変える) | YAML の roundtrip-check job の `timeout-minutes` と 2 つの job の `concurrency.group` との一致を `tests/db-backup-workflow.test.ts` が見る |
| `AUDIT_DETAILS_MAX_BYTES` | 固定 | SQL の `record_backup_audit` と同じ値 (migration の契約テストが見る) |
| `DATA_DUMP_SCHEMAS` | 固定 (利用者のデータのスキーマを足すときに、その migration と同じ PR で変える) | verify の 6 が、schema.sql の public の外の表と data.sql の外れたスキーマの COPY を落とすので、足し忘れは取得の Issue で分かる |
| `PSQL_SCRIPTS`・`REMOTE_PG_SSLMODE_QUERY`・`LOCAL_PG_SSLMODE_QUERY`・`ROLES_TOLERATED_SQLSTATE`・`PSQL_SQLSTATE_ERROR_LINE`・`RESTORE_COUNT_SQL`・`STAGE_DEFAULT_REASON`・`COMMAND_NOT_FOUND_EXIT_CODE`・`BACKUP_AUDIT_RESULTS` | 固定 | psql・PostgreSQL の SQLSTATE・bash の仕様と、§4.12 の打ち方・§4.7 の reason の契約。`BACKUP_AUDIT_RESULTS` は migration と core.ts の action_type と同じでなければならない (§15 の 2 つのテスト) |
| `RESTORE_FIXUPS_FILE`・`CRON_JOBS_FILE`・`CRON_JOBS_SQL`・`CRON_SCHEDULE_LINE_PATTERN`・`CRON_CHECK_LINE_PREFIX`・`LEDGER_FILE`・`CATALOG_DIR`・`RESTORED_CATALOG_DIR`・`ARCHIVE_ENTRIES`・`CATALOG_SNAPSHOT_SQL`・`CATALOG_CSV_FILES`・`RESTORE_FIXUPS_BUILDER_SCRIPT`・`CATALOG_VERIFY_SCRIPT`・`PYTHON_COMMAND`・`CATALOG_VERIFY_SUMMARY_LINE`・`LEDGER_VERSIONS_SQL`・`LEDGER_VERSION_PATTERN`・`MIGRATIONS_DIR`・`RESET_STORAGE_POLICIES_SQL`・`AUTH_STORAGE_TRIGGERS_CSV`・`TRIGGER_CSV_COLUMNS`・`INTERNAL_TRIGGER_FUNCTION_SCHEMAS`・`TRIGGER_DEFINITION_PATTERN` | 固定 | 書庫の中の名前 (書いた側と読む側の契約)・既存の `scripts/baseline` の 2 本 (変えない) の入出力・Supabase の台帳と pg_cron (1.6.4 の `cron.schedule_in_database`) の形・`pg_get_triggerdef` の書き方。`CATALOG_CSV_FILES` は `snapshot_catalog.sql` の出力と同じでなければならない (§15 の it)。トリガーの 4 つは `build_restore_fixups.py` の同じ名前の値と同じでなければならない (§15 の it) |
| `AWS_CHECKSUM_ENV`・`R2_REGION`・`R2_ENDPOINT_HOST_SUFFIX`・`RESTORE_REQUIRED_ENV_NAMES`・`SUPABASE_CLI_VERSION`・`DUMP_EXCLUDED_TABLES`・`MIN_OPAQUE_TOKEN_LENGTH`・`STDERR_TAIL_LINES`・`IMAGE_PULL_FALLBACK_SCRIPT`・`IMAGE_PULL_UNAVAILABLE_EXIT_CODE`・`PG_IMAGE_REPOSITORY`・`DEFAULT_IMAGE_REGISTRY` | 固定 (取得元の順・周回は既存のライブラリの環境変数 `SUPABASE_IMAGE_REGISTRIES`・`SUPABASE_IMAGE_PULL_ROUNDS` が受け持つ。本書では足さない) | 外部の道具の仕様・Supabase の手順・伏せ字の規則に合わせた値で、運用で調整するものではない |
| `BACKUP_STALE_AFTER_HOURS` (core.ts) | 固定 (取得の予定と同じ PR で変える) | 取得の間隔 (24 時間) + schedule の遅れの余裕から決まる。予定を変えずにしきい値だけを変える理由が無い |
| `BACKUP_STALE_ALERT_COOLDOWN_MINUTES` (core.ts) | 固定 (鮮度の cron の予定と同じ PR で変える) | 鮮度の cron の間隔 (24 時間) より短くなければ翌日の通知が落ちる (§5.3 のコメント)。間隔から作る |

### 5.2 migration (`supabase/migrations/<番号はマージ時に確定>_backup_audit_record.sql`)

```sql
-- migration: <番号はマージ時に確定>_backup_audit_record.sql
-- 戻し方: supabase/rollbacks/<番号はマージ時に確定>_backup_audit_record.down.sql
-- #1129 バックアップの取得 (GitHub Actions) が admin_audit_logs に結果を 1 行残すための関数。
-- 呼ぶのは所有者 postgres (Actions が SUPABASE_DB_PASSWORD で繋ぐロール) だけ。anon / authenticated / service_role からは外す。
-- postgres は admin_audit_logs の所有者で rolbypassrls なので、INSERT の RLS (actor_id = auth.uid()) に当たらない
-- (pg_cron の handson_tour_sandbox_cleanup と同じ「利用者のいない操作」。actor_id・ip_address は NULL のまま)。
CREATE OR REPLACE FUNCTION public.record_backup_audit(p_action_type text, p_details jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_severity text;
  -- details の上限 (bytes)。scripts/lib/backup-db.mjs の AUDIT_DETAILS_MAX_BYTES と同じ値
  c_details_max_bytes CONSTANT integer := 8192;
BEGIN
  IF p_action_type IS NULL OR p_action_type NOT IN (
    'backup.daily.completed', 'backup.daily.failed',
    'backup.weekly.completed', 'backup.weekly.failed',
    'backup.annual.completed', 'backup.annual.failed'
  ) THEN
    RAISE EXCEPTION 'record_backup_audit: invalid action_type' USING ERRCODE = '22023';
  END IF;
  IF p_details IS NULL OR pg_catalog.jsonb_typeof(p_details) <> 'object' THEN
    RAISE EXCEPTION 'record_backup_audit: details must be an object' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.pg_column_size(p_details) > c_details_max_bytes THEN
    RAISE EXCEPTION 'record_backup_audit: details too large' USING ERRCODE = '22023';
  END IF;
  v_severity := CASE WHEN p_action_type LIKE '%.failed' THEN 'warn' ELSE 'info' END;

  INSERT INTO public.admin_audit_logs (actor_id, action_type, target_type, details, severity)
  VALUES (NULL, p_action_type, 'database_backup', p_details, v_severity)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.record_backup_audit(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- GRANT は付けない。所有者 (postgres) だけが呼べる (20261015180000 の invoke_process_meal_image_jobs と同じ形)

COMMENT ON FUNCTION public.record_backup_audit(text, jsonb) IS
  '#1129: DB バックアップの取得 (GitHub Actions) の結果を admin_audit_logs に 1 行残す。action_type は backup.<daily|weekly|annual>.<completed|failed>、target_type は database_backup、actor_id は NULL (利用者のいない操作)。所有者 postgres のみ';
```

```sql
-- rollback: <番号はマージ時に確定>_backup_audit_record.sql
-- (ファイルは supabase/rollbacks/<番号はマージ時に確定>_backup_audit_record.down.sql)
-- 書いた監査行は消さない (残す記録。この down は関数だけを消す)
DROP FUNCTION IF EXISTS public.record_backup_audit(text, jsonb);
```

- 既存の表・列・ポリシー・既存の行には触れない。`CREATE OR REPLACE` なので 2 回流せる。
- 1 行目の見出し (`-- migration:` / `-- rollback:`) と 2 行目の「戻し方」の案内は、origin/main の直近の migration と同じ形 (`tests/migration-file-version-integrity.test.ts` が、見出しの名前と自分のファイル名の一致・案内した `supabase/rollbacks/` の実在・戻し口と migration の対を見る。§18)。番号を確定するときは、migration のファイル名・見出し・案内、戻し口のファイル名・見出しの 5 か所を同じ番号にそろえる。
- `admin_audit_logs` の UPDATE / DELETE を止めているのは RLS のポリシー `audit_logs_no_update` / `audit_logs_no_delete` (`USING (false)`) で、効くのは RLS の下のロール (anon / authenticated) だけ。postgres (所有者・`rolbypassrls`・`relforcerowsecurity = false`。§3.3) と service_role は RLS を越えるので消せる。本書は DB 側の不変を足さない (ローンチ前の範囲。§21)。取得の対象物そのものの改ざんの検出は bucket lock の `.sha256` が担う。
- INSERT は、この関数のほかに既存のポリシー 2 本が authenticated に許している: `"Admins can create audit logs"` (本人が admin / super_admin / support なら、actor_id も action_type も見ない) と `audit_logs_insert_admins` (actor_id = 本人と運営の 6 ロールだけを見る)。関数の REVOKE が守るのは「この関数を呼べるのは postgres だけ」で、「`backup.*` の行を書けるのは postgres だけ」ではない。本書はポリシーを変えない (既存の欠陥。Issue #1736 で直す)。読む側は action_type だけで信じず、この関数が書く形 (actor_id NULL・target_type `database_backup`) の行だけを取得の行として読む (§7.1・§7.3)。
- `target_type` は `database_backup` (varchar(30) に収まる)。`target_id` は NULL (対象は利用者ではない)。

### 5.3 `src/lib/backups/core.ts` (Zod / 型 / 定数 / 純関数。ブラウザからも読むので Node の API を import しない)

```ts
// src/lib/backups/core.ts
// #1129 / #1191 バックアップの状態と DR 訓練の記録の正典: 定数・Zod・型・純関数。
// 画面 (src/app/super-admin/backups/page.tsx) は、選択肢 (DR_TEST_* の配列)・ラベル (*_LABELS)・上限・パス・型・400 の文の読み方 (drTestErrorsFromResponse) をこのファイルから import する
// (zod を含むファイルの値を client の画面が import する前例: src/app/super-admin/llm/quotas/page.tsx の '@/lib/super-admin/llm-schemas')。
// 選択肢とラベルを page.tsx に書き写さない (正典を 2 か所にしない)。
import { z } from 'zod';

// ── 取得 (GitHub Actions が admin_audit_logs に残す行) ────────────────────────
export const BACKUP_TIERS = ['daily', 'weekly', 'annual'] as const;
export type BackupTier = (typeof BACKUP_TIERS)[number];
export const BACKUP_RESULTS = ['completed', 'failed'] as const;
export type BackupResult = (typeof BACKUP_RESULTS)[number];

/** action_type。scripts/lib/backup-db.mjs と migration の record_backup_audit が受け付ける 6 つと同じ */
export function backupAuditAction(tier: BackupTier, result: BackupResult): string {
  return `backup.${tier}.${result}`;
}
export const BACKUP_AUDIT_ACTION_TYPES: readonly string[] = BACKUP_TIERS.flatMap((tier) =>
  BACKUP_RESULTS.map((result) => backupAuditAction(tier, result)),
);
export const BACKUP_AUDIT_TARGET_TYPE = 'database_backup';

const MINUTES_PER_HOUR = 60;

/** 取得の予定 (1 日 1 回) と、「古い」とみなす経過時間。24 時間 + GitHub の schedule の遅れの余裕 6 時間 */
export const BACKUP_SCHEDULE_HOURS = 24;
export const BACKUP_STALE_SLACK_HOURS = 6;
export const BACKUP_STALE_AFTER_HOURS = BACKUP_SCHEDULE_HOURS + BACKUP_STALE_SLACK_HOURS;
/** 鮮度の cron の予定 (vercel.json)。取得 (02:23 JST) の 12 時間後で、取得の所要と遅れを吸収する。日 1 回 = 24 時間おき */
export const BACKUP_FRESHNESS_CRON_PATH = '/api/cron/backup-freshness';
export const BACKUP_FRESHNESS_SCHEDULE_UTC = '37 5 * * *';
export const BACKUP_FRESHNESS_CRON_INTERVAL_HOURS = 24;
/** 鮮度の通知の ops_alert_state のキー */
export const BACKUP_STALE_ALERT_KEY = 'backup_stale';
/** cron の起動時刻のぶれ (秒〜分) を吸収する余裕 */
export const BACKUP_STALE_ALERT_JITTER_MARGIN_HOURS = 1;
/** 送り直さない時間 (分) = 23 時間。claim_ops_alert は「前回から cooldown 以上たった」ときだけ権利を返すので、
 *  cron の間隔 (24 時間) とちょうど同じにすると、起動のぶれで翌日の回が 1 秒足りずに stale_deduped になり、通知が 48 時間空く。
 *  間隔より短く、同じ日の 2 回目 (手動の再実行など) は止まる長さにする */
export const BACKUP_STALE_ALERT_COOLDOWN_MINUTES =
  (BACKUP_FRESHNESS_CRON_INTERVAL_HOURS - BACKUP_STALE_ALERT_JITTER_MARGIN_HOURS) * MINUTES_PER_HOUR;
/** 画面と API が読む取得の行の上限 (新しい順)。日 1〜3 行なので 1〜3 か月分。層ごとの最新はこの窓によらず別に読む (§7.1) */
export const BACKUP_STATUS_LIST_LIMIT = 100;
/** 画面と API が読む訓練の行の上限 (新しい順)。年 17 行 (月次 12 + 四半期 4 + 年次 1) なので約 5 年分。種類ごとの最新は別に読む */
export const DR_TEST_LIST_LIMIT = 100;
export const SUPER_ADMIN_BACKUPS_PATH = '/super-admin/backups';
export const SUPER_ADMIN_BACKUPS_API_PATH = '/api/super-admin/backups';
export const SUPER_ADMIN_DR_TESTS_API_PATH = '/api/super-admin/backups/dr-tests';

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_HOUR = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** 最新の completed が無い、または BACKUP_STALE_AFTER_HOURS より古ければ true */
export function isBackupStale(latestCompletedAt: string | null, now: Date): boolean {
  if (latestCompletedAt === null) return true;
  const at = Date.parse(latestCompletedAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at > BACKUP_STALE_AFTER_HOURS * MS_PER_HOUR;
}

// ── DR 訓練の記録 ───────────────────────────────────────────────────────────
export const DR_TEST_KINDS = ['monthly_pitr', 'quarterly_restore', 'annual_drill'] as const;
export type DrTestKind = (typeof DR_TEST_KINDS)[number];
/** action_type (07 §7.1 の dr.test.monthly.pitr の形に揃える) */
export const DR_TEST_AUDIT_ACTIONS: Readonly<Record<DrTestKind, string>> = {
  monthly_pitr: 'dr.test.monthly.pitr',
  quarterly_restore: 'dr.test.quarterly.restore',
  annual_drill: 'dr.test.annual.drill',
};
export const DR_TEST_AUDIT_ACTION_TYPES: readonly string[] = DR_TEST_KINDS.map((kind) => DR_TEST_AUDIT_ACTIONS[kind]);
export const DR_TEST_AUDIT_TARGET_TYPE = 'dr_test';
/** 訓練を記録できるロール (POST の requireRole(['super_admin']) と同じ)。読む側は、訓練の行の actor が今このロールを持つかで絞る (§7.1) */
export const DR_TEST_RECORDER_ROLE = 'super_admin';
export const DR_TEST_RESULTS = ['success', 'failed', 'skipped'] as const;
export type DrTestResult = (typeof DR_TEST_RESULTS)[number];
export const DR_TEST_ENVIRONMENTS = ['local', 'staging', 'new_project', 'production'] as const;
export type DrTestEnvironment = (typeof DR_TEST_ENVIRONMENTS)[number];
export const DR_TEST_SMOKE_RESULTS = ['passed', 'failed', 'not_run'] as const;
export type DrTestSmokeResult = (typeof DR_TEST_SMOKE_RESULTS)[number];
/** 自由記述の上限。問い合わせの本文 (5000) より短い。要点だけを残す */
export const DR_TEST_NOTES_MAX_LENGTH = 2000;
/** R2 のキーの上限 (接頭辞 + 日付 + base + 拡張子で 80 字ほど。余裕をもって) */
export const DR_TEST_BACKUP_KEY_MAX_LENGTH = 256;
/** 復旧にかかった分の上限。約 69 日。これより長い値は打ち間違い */
export const DR_TEST_RTO_MINUTES_MAX = 100_000;
/** R2 のキーの形 (接頭辞 / 日付 / ファイル名)。それ以外の文字は受けない (監査行に任意の文字列を入れない) */
export const BACKUP_KEY_PATTERN = /^(daily|weekly|annual)\/[0-9A-Za-z._/-]{1,200}$/;

/** 400 の項目の文は schema に書いた日本語 (route は issues をそのまま src/lib/super-admin/validation-errors.ts の invalidInputResponse に渡し、画面は項目の下に出す。§7.2・§7.4) */
export const drTestRecordBodySchema = z
  .object({
    kind: z.enum(DR_TEST_KINDS, { message: '訓練の種類を選んでください' }),
    result: z.enum(DR_TEST_RESULTS, { message: '結果を選んでください' }),
    performed_on: z.iso.date({ message: '実施日を YYYY-MM-DD の形で書いてください' }),
    environment: z.enum(DR_TEST_ENVIRONMENTS, { message: '復元した先を選んでください' }),
    restored_to: z.iso.datetime({ offset: true, message: '復元した時点を日時で書いてください' }).nullable(),
    backup_key: z
      .string({ message: 'R2 のキーを文字で書いてください' })
      .max(DR_TEST_BACKUP_KEY_MAX_LENGTH, `R2 のキーは ${DR_TEST_BACKUP_KEY_MAX_LENGTH} 文字以内で書いてください`)
      .regex(BACKUP_KEY_PATTERN, 'R2 のキーは daily/・weekly/・annual/ で始まる形で書いてください')
      .nullable(),
    rto_minutes: z
      .number({ message: '復旧にかかった分を数で書いてください' })
      .int('復旧にかかった分は整数で書いてください')
      .min(0, '復旧にかかった分は 0 以上で書いてください')
      .max(DR_TEST_RTO_MINUTES_MAX, `復旧にかかった分は ${DR_TEST_RTO_MINUTES_MAX} 以下で書いてください`)
      .nullable(),
    smoke: z.enum(DR_TEST_SMOKE_RESULTS, { message: '動作確認 (smoke) の結果を選んでください' }),
    notes: z
      .string({ message: 'メモを文字で書いてください' })
      .max(DR_TEST_NOTES_MAX_LENGTH, `メモは ${DR_TEST_NOTES_MAX_LENGTH} 文字以内で書いてください`),
  })
  .strict()
  .superRefine((body, ctx) => {
    // 成功以外は理由を残す (skipped の plan_not_pro など)
    if (body.result !== 'success' && body.notes.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['notes'], message: '失敗・見送りのときは理由を書いてください' });
    }
    if (body.kind === 'quarterly_restore' && body.result === 'success' && body.backup_key === null) {
      ctx.addIssue({ code: 'custom', path: ['backup_key'], message: '復元に使った R2 のキーを書いてください' });
    }
  });
export type DrTestRecordBody = z.infer<typeof drTestRecordBodySchema>;

export function drTestSeverity(result: DrTestResult): 'info' | 'warn' {
  return result === 'success' ? 'info' : 'warn';
}

/** 画面の form の項目 (drTestRecordBodySchema の shape のキーと同じ並び。core のテストが突き合わせる) */
export const DR_TEST_FIELDS = ['kind', 'result', 'performed_on', 'environment', 'restored_to', 'backup_key', 'rto_minutes', 'smoke', 'notes'] as const;
export type DrTestField = (typeof DR_TEST_FIELDS)[number];

/** POST の 400 の本文 (validation-errors.ts の invalidInputBody / invalidJsonBodyBody の形) を画面が読むときの形。issue は path と message だけを使う */
const drTestIssueSchema = z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() });
export const drTestErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.array(drTestIssueSchema).optional() }),
});
/** 400 の本文が上の形で読めないときの文 */
export const DR_TEST_INVALID_INPUT_FALLBACK_MESSAGE = '入力を確かめてください';

export interface DrTestFieldErrors {
  /** 項目ごとの最初の文 */
  fields: Partial<Record<DrTestField, string>>;
  /** 項目に結び付かない文 (path が空・知らない項目)。項目の文も項目に結び付かない文も無ければ error.message を 1 つ */
  form: string[];
}

/** POST の 400 の本文から、画面が項目の下と form の上に出す文を作る */
export function drTestErrorsFromResponse(json: unknown): DrTestFieldErrors {
  const parsed = drTestErrorResponseSchema.safeParse(json);
  if (!parsed.success) return { fields: {}, form: [DR_TEST_INVALID_INPUT_FALLBACK_MESSAGE] };
  const fields: Partial<Record<DrTestField, string>> = {};
  const form: string[] = [];
  for (const issue of parsed.data.error.details ?? []) {
    const head = issue.path[0];
    const field = DR_TEST_FIELDS.find((name) => name === head);
    if (field === undefined) {
      form.push(issue.message);
    } else if (fields[field] === undefined) {
      fields[field] = issue.message;
    }
  }
  if (Object.keys(fields).length === 0 && form.length === 0) form.push(parsed.data.error.message);
  return { fields, form };
}

// ── 読み取り (admin_audit_logs の行) ───────────────────────────────────────
/** API が select する列 (この並びで select する。tests/integration/security/select-columns-exist が列の実在を見る)。
 *  target_type と actor_id は、行がどの経路で書かれたかを見るために読む (isBackupAuditRow / isDrTestAuditRow。§7.1) */
export const BACKUP_AUDIT_COLUMNS = ['id', 'created_at', 'action_type', 'target_type', 'actor_id', 'severity', 'details'] as const;
export const BACKUP_AUDIT_SELECT = BACKUP_AUDIT_COLUMNS.join(', ');

export const backupAuditRowSchema = z.object({
  id: z.uuid(),
  created_at: z.string(),
  action_type: z.string(),
  target_type: z.string().nullable(),
  actor_id: z.string().nullable(),
  severity: z.enum(['info', 'warn', 'critical']),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type BackupAuditRow = z.infer<typeof backupAuditRowSchema>;

/** 取得の行として信じてよいか: record_backup_audit が書く形 (action_type が BACKUP_AUDIT_ACTION_TYPES の 1 つ・target_type が
 *  BACKUP_AUDIT_TARGET_TYPE・actor_id が NULL)。admin_audit_logs の INSERT のポリシーは action_type を見ないので、action_type だけでは信じない。
 *  audit_logs_insert_admins で書いた行 (actor_id = 本人) はここで外れる。"Admins can create audit logs" で actor_id を NULL にした行は外れない (Issue #1736。§21) */
export function isBackupAuditRow(row: BackupAuditRow): boolean {
  return BACKUP_AUDIT_ACTION_TYPES.includes(row.action_type) && row.target_type === BACKUP_AUDIT_TARGET_TYPE && row.actor_id === null;
}

/** 訓練の行として信じてよいか: action_type が DR_TEST_AUDIT_ACTION_TYPES の 1 つ・target_type が DR_TEST_AUDIT_TARGET_TYPE・
 *  actor_id が今の super_admin (superAdminIds。route が user_profiles から読む) の 1 人 */
export function isDrTestAuditRow(row: BackupAuditRow, superAdminIds: ReadonlySet<string>): boolean {
  return (
    DR_TEST_AUDIT_ACTION_TYPES.includes(row.action_type) &&
    row.target_type === DR_TEST_AUDIT_TARGET_TYPE &&
    row.actor_id !== null &&
    superAdminIds.has(row.actor_id)
  );
}

export interface BackupStatusResponse {
  data: {
    /** 層ごとの最新の completed (無ければ null)。一覧の窓 (BACKUP_STATUS_LIST_LIMIT) によらない */
    latest: Record<BackupTier, BackupAuditRow | null>;
    /** 訓練の種類ごとの最新の記録 (無ければ null)。一覧の窓 (DR_TEST_LIST_LIMIT) によらない */
    latest_dr_tests: Record<DrTestKind, BackupAuditRow | null>;
    /** daily の最新の completed が BACKUP_STALE_AFTER_HOURS より古い (無い) */
    stale: boolean;
    stale_after_hours: number;
    /** 取得の行 (completed・failed) 新しい順・BACKUP_STATUS_LIST_LIMIT 行まで */
    backups: BackupAuditRow[];
    /** 訓練の行 新しい順・DR_TEST_LIST_LIMIT 行まで */
    dr_tests: BackupAuditRow[];
  };
}

/** route が読んだもの (§7.1 の super_admin の一覧と 8 本の読み取り)。latest* は action_type ごとに最新 1 行 (無ければ null) */
export interface BackupStatusSource {
  latestByTier: Record<BackupTier, BackupAuditRow | null>;
  latestDrTestByKind: Record<DrTestKind, BackupAuditRow | null>;
  backups: readonly BackupAuditRow[];
  drTests: readonly BackupAuditRow[];
  /** 今の super_admin の id (route が getSupabaseAdmin で user_profiles から読む。§7.1) */
  superAdminIds: readonly string[];
}

/** 読んだ行が期待の action_type の取得の行でなければ null (route の読み間違い・絞り込みの書き忘れを応答に出さない) */
function pickBackupRow(row: BackupAuditRow | null, actionType: string): BackupAuditRow | null {
  return row !== null && row.action_type === actionType && isBackupAuditRow(row) ? row : null;
}

/** 読んだ行が期待の action_type の訓練の行でなければ null */
function pickDrTestRow(row: BackupAuditRow | null, actionType: string, superAdminIds: ReadonlySet<string>): BackupAuditRow | null {
  return row !== null && row.action_type === actionType && isDrTestAuditRow(row, superAdminIds) ? row : null;
}

/** API の応答を作る (一覧の行はすでに新しい順・上限内)。行は isBackupAuditRow / isDrTestAuditRow で見直す */
export function toBackupStatusResponse(source: BackupStatusSource, now: Date): BackupStatusResponse {
  const superAdminIds: ReadonlySet<string> = new Set(source.superAdminIds);
  const latest: Record<BackupTier, BackupAuditRow | null> = {
    daily: pickBackupRow(source.latestByTier.daily, backupAuditAction('daily', 'completed')),
    weekly: pickBackupRow(source.latestByTier.weekly, backupAuditAction('weekly', 'completed')),
    annual: pickBackupRow(source.latestByTier.annual, backupAuditAction('annual', 'completed')),
  };
  const latestDrTests: Record<DrTestKind, BackupAuditRow | null> = {
    monthly_pitr: pickDrTestRow(source.latestDrTestByKind.monthly_pitr, DR_TEST_AUDIT_ACTIONS.monthly_pitr, superAdminIds),
    quarterly_restore: pickDrTestRow(source.latestDrTestByKind.quarterly_restore, DR_TEST_AUDIT_ACTIONS.quarterly_restore, superAdminIds),
    annual_drill: pickDrTestRow(source.latestDrTestByKind.annual_drill, DR_TEST_AUDIT_ACTIONS.annual_drill, superAdminIds),
  };
  return {
    data: {
      latest,
      latest_dr_tests: latestDrTests,
      stale: isBackupStale(latest.daily?.created_at ?? null, now),
      stale_after_hours: BACKUP_STALE_AFTER_HOURS,
      backups: source.backups.filter((row) => isBackupAuditRow(row)),
      dr_tests: source.drTests.filter((row) => isDrTestAuditRow(row, superAdminIds)),
    },
  };
}

export const DR_TEST_KIND_LABELS: Readonly<Record<DrTestKind, string>> = {
  monthly_pitr: '月次 PITR 復元テスト',
  quarterly_restore: '四半期 論理バックアップの復元',
  annual_drill: '年次 DR 訓練',
};
export const DR_TEST_RESULT_LABELS: Readonly<Record<DrTestResult, string>> = { success: '成功', failed: '失敗', skipped: '見送り' };
export const DR_TEST_ENVIRONMENT_LABELS: Readonly<Record<DrTestEnvironment, string>> = {
  local: 'ローカル',
  staging: 'staging',
  new_project: '新しいプロジェクト',
  production: '本番',
};
export const DR_TEST_SMOKE_LABELS: Readonly<Record<DrTestSmokeResult, string>> = { passed: '通った', failed: '落ちた', not_run: '流していない' };
export const BACKUP_TIER_LABELS: Readonly<Record<BackupTier, string>> = { daily: '日次', weekly: '週次', annual: '年次' };
```

### 5.4 運用メールの宛先の読み口 (`src/lib/ops-alerts/recipient.ts`。新設。`OPS_ALERT_EMAIL` を読む唯一の場所になる)

```ts
// src/lib/ops-alerts/recipient.ts
// #1157 / #1129 運用メール (OPS_ALERT_EMAIL) の宛先の読み口。app-log-alerts と backup-freshness の 2 つの cron が共有する。
// src/lib/env.ts の OPS_ALERT_EMAIL の readOnlyBy はこのファイル (tests/env-source-scan.test.ts が、ほかのファイルで値を読んでいないことを見る)。
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';

export type OpsAlertRecipient =
  /** 未設定: 何もしない (info ログを 1 行残すのは呼び出し側) */
  | { status: 'disabled' }
  /** メールアドレス 1 つの形ではない: 送らない (warn ログは呼び出し側) */
  | { status: 'invalid_config' }
  | { status: 'ok'; email: string };

/** 値そのものは返す以外に出さない (ログに書かない) */
export function resolveOpsAlertRecipient(): OpsAlertRecipient {
  const configured = process.env.OPS_ALERT_EMAIL?.trim();
  if (!configured) return { status: 'disabled' };
  const parsed = EmailEnvelopeSchema.shape.to.safeParse(configured);
  if (!parsed.success) return { status: 'invalid_config' };
  return { status: 'ok', email: parsed.data };
}
```

- `src/app/api/cron/app-log-alerts/route.ts` の `checkAppLogErrors` の冒頭 (`process.env.OPS_ALERT_EMAIL?.trim()` から `recipient.data` まで) を、この関数の呼び出しに置き換える (ログの文・応答の `status` は変えない)。

### 5.5 `scripts/baseline/build_restore_fixups.py` (新設。補いの SQL を作る)

```python
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
```

- `build_baseline.py` は変えない (3 つの関数と `quote_ident` は `if __name__ == "__main__"` の外にあり、import しても `main` は動かない)。3 つの関数の出力はどれも改行で終わるので、つなぐだけで区切りが要らない。
- `build_app_trigger_sql` (§3.3 の (6)): `catalog_auth_storage_triggers.csv` のアプリのトリガー (関数のスキーマが `INTERNAL_TRIGGER_FUNCTION_SCHEMAS` の外) ごとに 1 つの DO (同じ表に同じ名前のトリガーが無いときだけ、取得の時点の `pg_get_triggerdef` の定義を EXECUTE)。定義の関数の名前にスキーマが無いものは、直前に置く `search_path` (`public, extensions`。取得の postgres の search_path で見える関数と同じ・`prod_function_acl.sql` の冒頭と同じ値) で解決する。定義が `TRIGGER_DEFINITION_PATTERN` に当たらない・見出しが違う・DO の目印 `$restore_trigger$` を含む行は `ValueError` (終了 1。中身は出さない)。アプリのトリガーが無いカタログ (origin/main の `supabase/baseline/catalog/`) では空の文字列なので、出力は 3 つの関数をつないだものと同じ。
- 3 つの関数が、origin/main の `supabase/baseline/catalog/` の CSV と `prod_schema.sql` から、コミット済みの `prod_function_acl.sql`・`prod_table_acl.sql`・`prod_storage.sql` とバイト単位で同じものを作ることは 2026-10-16 に確かめた (§3.3)。`tests/backup-db.test.ts` が同じことを毎回見る (§15)。アプリのトリガーがあるカタログでは、その後ろにアプリのトリガーの DO が続く (同じく §15)。

---

## 6. facade 契約 (route が呼ぶ関数)

```ts
// tsc:skip — 既存の関数の使い方 (実装の指針。route の全文ではない)
// 認可:          const actor = await requireRole(['super_admin']);            // src/lib/auth/helpers (AuthError → 401 / ForbiddenError → 403)
// 本文の NUL:    const rejected = await rejectNullCharacterBody(request, { shape: 'nested' }); if (rejected) return rejected;   // handler の最初の文
// 本人の client: const supabase = await createClient();                      // @/lib/supabase/server (RLS が効く。SELECT は super_admin のポリシー)
// 本文の読み取り: const bodyResult = await readJsonBody(request); if (!bodyResult.ok) return invalidJsonBodyResponse();   // @/lib/super-admin/validation-errors (#1654)
// 検証:          const parsed = drTestRecordBodySchema.safeParse(bodyResult.body); if (!parsed.success) return invalidInputResponse(parsed.error.issues);
// 監査:          const audit = await recordAdminAudit({ supabase, actorId: actor.id, actionType: DR_TEST_AUDIT_ACTIONS[body.kind],
//                  targetType: DR_TEST_AUDIT_TARGET_TYPE, details: body, severity: drTestSeverity(body.result), request,   // body = parsed.data
//                  routeName: 'api/super-admin/backups/dr-tests POST' });
//                if (!audit.ok) return internalError('POST /api/super-admin/backups/dr-tests', new Error(audit.error), { userId: actor.id }, { shape: 'nested' });
// 500:           internalError(routeName, err, ctx, { shape: 'nested' })      // src/lib/api/errors (super-admin の入れ子の形)
// cron の認証:   const authError = await requireCronAuth(req); if (authError) return authError;   // src/lib/cron-auth
// service_role: getSupabaseAdmin()                                          // @/lib/supabase/server (cron と、運営の GET の super_admin の一覧の 1 本だけ。認証・認可のあと)
// super_admin の一覧: getSupabaseAdmin().from('user_profiles').select('id').contains('roles', [DR_TEST_RECORDER_ROLE])   // §7.1 (GET の requireRole の後)
// クールダウン:  supabase.rpc('claim_ops_alert', { p_alert_key: BACKUP_STALE_ALERT_KEY, p_cooldown_minutes: BACKUP_STALE_ALERT_COOLDOWN_MINUTES })   // 1380 分 (23 時間)
//               supabase.rpc('release_ops_alert', { p_alert_key, p_claimed_at })
// メール:        sendEmail(renderBackupStaleEmail({...}))                     // src/lib/emails/send
```

---

## 7. API・cron・画面の仕様

### 7.1 `GET /api/super-admin/backups` (super_admin)

- 認可 `requireRole(['super_admin'])`。`admin_audit_logs` は本人のセッションの client で読む (RLS の `audit_logs_select_super_admin` で super_admin が読める。`admin_audit_logs` の読み取りに service_role は使わない)。select の列は文字列リテラル `'id, created_at, action_type, target_type, actor_id, severity, details'` (= `BACKUP_AUDIT_SELECT`。§18 の select-columns-exist の行)。
- 行を信じる条件 (R-6・§10): `admin_audit_logs` の INSERT のポリシー 2 本は action_type を見ないので、運営のロールの人は自分の JWT でどの action_type の行も直接書ける (§3.1)。action_type だけで読むと、取得が止まっていても偽の `backup.daily.completed` が 1 行あれば「新しい」になり、偽の `dr.test.*` が訓練の記録に並ぶ。そこで次の印で絞る (S-23):
  - 取得の行: `target_type = BACKUP_AUDIT_TARGET_TYPE` (`database_backup`) かつ `actor_id IS NULL` (`record_backup_audit` が書く形。`audit_logs_insert_admins` で書いた行は actor_id = 本人なので外れる)。
  - 訓練の行: `target_type = DR_TEST_AUDIT_TARGET_TYPE` (`dr_test`) かつ `actor_id` が今の super_admin の 1 人 (§7.2 の POST は `requireRole(['super_admin'])` の後に本人の id で書く。ほかの運営のロールの人が本人の id で書いた行は外れる)。今の super_admin の id は、`requireRole` の後に `getSupabaseAdmin().from('user_profiles').select('id').contains('roles', [DR_TEST_RECORDER_ROLE])` で読む。`user_profiles` の SELECT のポリシーは本人の行だけ (`"Users can view own profile"`。origin/main の `supabase/baseline/prod_schema.sql` の 10060 行。ほかの migration に `user_profiles` のポリシーは無い) なので、本人の client ではほかの super_admin が見えない。service_role を使うのはこの 1 本だけで、読む列は `id` だけ。役を外れた人の記録と、actor_id が今の super_admin の id でなくなった行 (アカウントが消えて actor_id が NULL になったものなど) は画面に出ない (監査行は残る。§21)。
  - 残る穴: 古いポリシー `"Admins can create audit logs"` は actor_id も見ないので、admin / super_admin / support のロールの人は、actor_id を NULL にした `backup.*` の行も、actor_id を super_admin の id にした `dr.test.*` の行も書ける。読む側ではこれを見分けられない (既存の欠陥。Issue #1736 でポリシーを直す。§21)。
- 読み取りは、super_admin の一覧の 1 本 (`superAdminIds`) のあとに、次の 8 本を `Promise.all` で並べる (order はどれも `.order('created_at', { ascending: false }).order('id', { ascending: false })`):
  - 取得の最新 1 行 × 3 (`backupAuditAction(tier, 'completed')`): `.eq('action_type', <action>).eq('target_type', BACKUP_AUDIT_TARGET_TYPE).is('actor_id', null)` + order + `.limit(1).maybeSingle()`。
  - 訓練の最新 1 行 × 3 (`DR_TEST_AUDIT_ACTIONS[kind]`): `.eq('action_type', <action>).eq('target_type', DR_TEST_AUDIT_TARGET_TYPE).in('actor_id', superAdminIds)` + order + `.limit(1).maybeSingle()`。
  - 最新 1 行の 6 本は一覧の窓によらないので、年 1 行の `backup.annual.completed`・`dr.test.annual.drill` も消えない (S-18)。偽の行は DB 側の絞り込みで外れるので、その下の本物の最新の行が出る。
  - 取得の一覧: `.in('action_type', [...BACKUP_AUDIT_ACTION_TYPES]).eq('target_type', BACKUP_AUDIT_TARGET_TYPE).is('actor_id', null)` + order + `.limit(BACKUP_STATUS_LIST_LIMIT)`。
  - 訓練の一覧: `.in('action_type', [...DR_TEST_AUDIT_ACTION_TYPES]).eq('target_type', DR_TEST_AUDIT_TARGET_TYPE).in('actor_id', superAdminIds)` + order + `.limit(DR_TEST_LIST_LIMIT)`。
  - `superAdminIds` が空なら (本人が super_admin なので普通は起きない)、訓練の 4 本は読まず、最新は null・一覧は [] にする。
- super_admin の一覧か 8 本のどれかが `error` を返したら 500。行は `backupAuditRowSchema` で検証し (1 行でも落ちれば 500)、`toBackupStatusResponse({ latestByTier, latestDrTestByKind, backups, drTests, superAdminIds }, new Date())` を返す (200)。`toBackupStatusResponse` は同じ条件 (`isBackupAuditRow` / `isDrTestAuditRow`) で行を見直す (route の絞り込みの書き忘れを応答に出さない)。`Cache-Control: no-store`。
- 読めない (DB の失敗) → `internalError` の 500。閲覧は記録しない (利用者の情報を返さない。返す `actor_id` は、取得の行では NULL、訓練の行では記録した super_admin の id だけ)。

### 7.2 `POST /api/super-admin/backups/dr-tests` (super_admin)

- 最初の文で `rejectNullCharacterBody` (400 `INVALID_CHARACTER`)。`requireRole(['super_admin'])`。本文は `readJsonBody(request)` で読み、JSON でなければ `invalidJsonBodyResponse()` (400 `{ error: { code: 'OP_INVALID_INPUT', message: 'リクエストボディが不正です', details: [] } }`)。`drTestRecordBodySchema.safeParse` が落ちたら `invalidInputResponse(parsed.error.issues)` (400 `{ error: { code: 'OP_INVALID_INPUT', message: <最初の issue の文>, details: <issues の全件> } }`)。どちらも `src/lib/super-admin/validation-errors.ts` (#1654) の既存の形で、ほかの super-admin の route (クーポン・プラン) と同じ。issue の `message` は schema に書いた日本語 (§5.3) なので、画面はそれを項目ごとに出す (§7.4)。知らない項目 (`.strict()` の `unrecognized_keys`。path は空) だけは Zod の既定の英語の文で、#1917 から本文では `validationMessageOf` が「入力値が不正です」に置き換える (`message` と `details[].message` の両方)。画面はこれを送らない (来たら form の上に出す)。
- `recordAdminAudit` (§6) で `dr.test.<種類>` を 1 行。`target_id` は NULL、`target_type` は `dr_test`、`details` は検証済みの本文そのまま、`severity` は `drTestSeverity`。**fail-closed**: `ok` でなければ 500 で、201 を返さない。
- 201 `{ success: true }`。重複の判定はしない (同じ月に 2 回記録してもよい。一覧で見える)。

### 7.3 `GET /api/cron/backup-freshness` (Vercel Cron。`vercel.json` に `{ "path": "/api/cron/backup-freshness", "schedule": "37 5 * * *" }`)

- `runtime = 'nodejs'`・`dynamic = 'force-dynamic'`・`fetchCache = 'force-no-store'`・`maxDuration = 60` (app-log-alerts と同じ理由)。
- 認証 `requireCronAuth`。宛先 `resolveOpsAlertRecipient()`: `disabled` → info ログ・`{ status: 'disabled' }` / `invalid_config` → warn ログ・`{ status: 'invalid_config' }`。
- `getSupabaseAdmin()` で `admin_audit_logs` の取得の行 (§7.1 の印) の最新 1 行を読む: `.select('created_at').eq('action_type', backupAuditAction('daily', 'completed')).eq('target_type', BACKUP_AUDIT_TARGET_TYPE).is('actor_id', null).order('created_at', { ascending: false }).limit(1).maybeSingle()`。運営のロールの人が自分の JWT で書いた行 (actor_id = 本人) では fresh にならない (S-23。古いポリシーで actor_id を NULL にした行は見分けられない。§21)。`isBackupStale(created_at ?? null, now)` が false → `{ status: 'fresh', latest_completed_at }`。
- true → `claim_ops_alert('backup_stale', BACKUP_STALE_ALERT_COOLDOWN_MINUTES = 1380)`。NULL → `{ status: 'stale_deduped' }`。取れたら `renderBackupStaleEmail` → `sendEmail`。成功 `{ status: 'stale_sent' }`、送らなかった / 送れなかったは `release_ops_alert` して `{ status: 'stale_send_skipped' | 'stale_send_failed' }` (app-log-alerts と同じ。設定が直ったあともクールダウンで黙らないように)。ただし `result.error.code` が `NON_RELEASING_SEND_ERROR_CODES` (`suppressed` = 宛先が停止リスト / `invalid_envelope` = 文面の不備。`src/lib/ops-alerts/send-release.ts` で app-log-alerts と共有する) のときは `release_ops_alert` を呼ばず `{ status: 'stale_send_failed' }` (送り直しても同じ結果で、回ごとの繰り返しになるため。#1577 の 8。operator/10 §8.3 と同じ規則)。`release_ops_alert` 自体が error を返す・例外を投げるときは、warn ログ 1 行 (「送る権利を返せませんでした」と `pg_code` か `error_name`) だけで例外にせず、status と応答はそのまま (app-log-alerts の `releaseClaim` と同じ。権利が返らなくても、クールダウン 1380 分は cron の間隔 1440 分より短いので翌日の回は取れる。§8.3)。いずれも warn ログに `latest_completed_at` と `stale_after_hours` を残す (宛先は書かない)。
- DB の失敗は `internalError` の 500 (本文は汎用)。route は延命しない (`waitUntil` の 1 秒の延命は #1922 48fc47bf で外した)。ログの保存の完了は db-logger (`createLogger`) が待つ (#1913)。

メール文面 `src/lib/emails/ops/backup-stale.ts` (`renderBackupStaleEmail`, template `ops_backup_stale`): 件名「【ほめゴハン運用】DB バックアップが <N> 時間以上取れていません」。本文は最新の取得の日時 (日本時間。無ければ「記録なし」)・しきい値・確かめる場所 (GitHub Actions の db-backup、`/super-admin/backups` の絶対 URL = `getSiteUrl()` + `SUPER_ADMIN_BACKUPS_PATH`)・自動送信の注記・「この確認は 1 日 1 回です。古いままなら翌日の確認でもう一度お知らせします」。利用者の情報は含めない。送信元は `getEmailFrom()`。

### 7.4 画面 `/super-admin/backups` (`'use client'`。layout の `requireRole(['super_admin'])` の下)

- 上段: 層ごとのカード (`data-testid="backups-tier-daily"` など。見出しは `BACKUP_TIER_LABELS`): `data.latest[tier]` の日時 (日本時間)・大きさ・R2 のキー・`restore_check` の結果 (weekly)。null なら「記録なし」。daily のカードは `stale` なら赤いバッジ (`data-testid="backups-stale-badge"`)「古い (<stale_after_hours> 時間以上)」と「GitHub Actions の db-backup が止まっていないか確かめる」の文。
- 中段: 種類ごとの最後の訓練 (`data-testid="dr-tests-latest"`: `data.latest_dr_tests` を `DR_TEST_KIND_LABELS` の順に、日付と結果 (`DR_TEST_RESULT_LABELS`)。null なら「記録なし」) と、「DR 訓練を記録」の form (`data-testid="dr-test-form"`): kind・result・environment・smoke の select の選択肢は core.ts の `DR_TEST_KINDS`・`DR_TEST_RESULTS`・`DR_TEST_ENVIRONMENTS`・`DR_TEST_SMOKE_RESULTS` を map し、表示は `*_LABELS`。performed_on (date)・restored_to (datetime-local → ISO)・backup_key (`maxLength` は `DR_TEST_BACKUP_KEY_MAX_LENGTH`)・rto_minutes (`max` は `DR_TEST_RTO_MINUTES_MAX`)・notes (`maxLength` は `DR_TEST_NOTES_MAX_LENGTH`)。送信先は `SUPER_ADMIN_DR_TESTS_API_PATH`、読み込みは `SUPER_ADMIN_BACKUPS_API_PATH`。送信で POST → 201 なら読み直す。400 は `drTestErrorsFromResponse(await res.json())` (§5.3) の `fields` を各項目の下 (`data-testid="dr-test-field-error-<項目>"`。`<項目>` は `DR_TEST_FIELDS` の値) に、`form` を form の上 (`data-testid="dr-test-form-error"`) に出す。403 / 500 は固定の文。読み込みの GET が 200 でない (403 / 500) ときも固定の文を出し、カード・一覧は描かない。値・ラベルを page.tsx に書き写さない (core.ts から import する。§5.3 の冒頭のコメント)。
- 訓練の記録の応答を受け取れなかったとき (#2101 X2): 通信の切断・本文に API の文の無い 502 / 503 / 504 は 500 の固定の文にせず (route は毎回 `admin_audit_logs` に 1 行書き、重複の判定をしないので、押し直すと 2 行になる)、`SUPER_ADMIN_BACKUPS_API_PATH` を読み直して、送る前の `data.dr_tests` に無かった行で `details` の `DR_TEST_FIELDS` の値が送った本文と同じものがあれば済んだとして form を初めに戻す (`data-testid="dr-test-form-confirmed"`)。まだ無ければ (行が無いことは記録されていないことの確かめにならない。サーバーが書き込みの途中なら押し直しで 2 行になる)、入力を残したまま送信を止め、「済んだか分かりません。一覧で確かめてから作り直してください」と「まだ見つかりません。保存の途中のこともあるので、少し待ってから確かめ直してください」と「確かめ直す」(読み直し) を `role="alert"` の `data-testid="dr-test-form-unconfirmed"` に出す。読み直しにも失敗したときも同じく送信を止め、「確かめ直す」を出す (読み直しが 401 / 403 なら、読み込み直しても変わらないので「確かめ直す」は出さず、401 は「ログインし直してください」・403 は理由の文 (`forbiddenMessageOfResponse`) を添える。初めの読み込みの 401 も「ログインし直してください」。#2101 integrity-1030c)。送る前に読み込めていなかったのに同じ内容の行があれば、決められないので送信を止め「確かめ直す」は出さない。送信を止めたときは「もう一度送るときは、画面を開き直してください」を添える (押し直すのは、記録の一覧で確かめてから画面を開き直したときだけ。`src/lib/admin/admin-create-no-response.ts`)。
- 下段: 取得の行 (`data-testid="backups-list"`: 日時・action_type・severity・stage / reason) と訓練の行 (`data-testid="dr-tests-list"`)。details は JSON をそのまま整形して出す (個人情報は入っていない)。
- layout の `superAdminOperationsNavItems` に `{ href: '/super-admin/backups', label: 'バックアップ・DR', icon: '🗄️' }` を足す (page.tsx を先に作る。`tests/admin-console-links.test.ts`)。
- a11y (横断ルール F・`cross/05-i18n-a11y.md`): form の各入力 (select 4・date・datetime-local・text 2・number) に `<label htmlFor>` と対になる `id` を付ける (placeholder だけで名前にしない)。読み込み・送信の失敗の文と 400 の項目の文 (`dr-test-field-error-<項目>`・`dr-test-form-error`) は `role="alert"` の要素に出し、文のある項目の入力には `aria-invalid="true"` と、その文の要素の `id` を指す `aria-describedby` を付ける (既存の `src/app/super-admin/coupons/[id]/page.tsx` の適用履歴の失敗の文と同じ)。鮮度のバッジは色だけでなく文 (「古い (<stale_after_hours> 時間以上)」) で状態を伝える。送信は `<button type="submit">`。層のカード・一覧は見出し (`h2`) で区切る。リポジトリにはまだ `@axe-core/playwright` が入っておらず (package.json に無い・使う spec も無い)、本書は依存を足さない。axe の検査を入れる時は、この画面を対象に入れる (§19・§21)。

---

## 8. 表 3 点

### 8.1 ①全パターン表 (層 × 日 × 段の結果 → 置くもの・記録・通知)

| 層の組 | 発生する日 (JST) | 成功 | 失敗 (段) | 監査行 | Issue | 鮮度の cron |
|---|---|---|---|---|---|---|
| daily | 毎日 | daily/ に 3 ファイル | §4.7 | completed 1 / failed 1 | 失敗で立てる・成功で閉じる | completed が 30 時間以内なら fresh |
| daily + weekly | 月曜 | 上 + weekly/ に同じ 3 ファイルを送り直す (copy) + 復元の検査 | copy・restore_check は weekly だけ failed | 2 行 | 同上 | daily の行だけを見る |
| daily + annual | 1/1 | 上 + annual/ に送り直し 3 + 復元の検査 | copy・restore_check は annual だけ failed | 2 行 | 同上 | 同上 |
| daily + weekly + annual | 1/1 が月曜 | 送り直し 6 + 復元の検査 1 回 | copy は失敗した層だけ failed (下の 3 行)。restore_check の失敗は copy に成功した weekly / annual の全部が failed (stage `restore_check`。daily は completed) | 3 行 | 同上 | 同上 |
| 手動 (dispatch) | 任意 | 指定した層 (auto なら日付で決める)。base が別なので同じ日に 2 つ目 | 同上 | 同上 | 同上 | 同上 |
| `restore` (オーナーが手元で) | 訓練・障害のとき | 手元のシェルの R2 の 4 つ (復元用の読み取りのトークン) で取り出し、ローカルのスタックに復元して `fixups.sql` を流し、数・カタログ (`verify_baseline.py`)・台帳・cron の定義の数を確かめて表示 (S-11) | config (R2 の変数が無い = 終了 3。S-22) / download / checksum / decrypt (S-16) / extract / restore_env / restore (fixups を含む) / restore_check (数・カタログ・台帳・cron の定義の数。§4.7 の 2 つ目の表)。download・decrypt・extract・restore_env 以降は時間切れ (`timeout`) もある | 書かない (訓練の結果は画面で `dr.test.*`) | 立てない | 関係しない |
| 新しいプロジェクトへの復元 (手順書 §6。年次の訓練・本番の障害。S-21) | 年 1 回・障害のとき | roles → schema + data → `fixups.sql` → カタログの比べ (errors 0) → `migration repair` で台帳 → Vault・Auth の設定・secrets・project ref (障害では DB の関数の Edge Function の URL も) → `cron_jobs.sql` (15 本と名前の集合の比べ。訓練は `BEGIN` → `ROLLBACK`、障害は確定) | 手順書の各手順で止める (どの手順も前の手順の結果を確かめてから進む) | 書かない (訓練の結果は画面で `dr.test.annual.drill`) | 立てない | 関係しない |
| `roundtrip-local` (CI の `roundtrip-check`) | PR (§15) | ローカルのスタックで dump → catalog → 空に → 復元 → `fixups.sql` → 数・カタログ・台帳・cron の定義の数が合い、`cron_dry_run` が 0 | dump / catalog / verify / restore_env / restore_check | 書かない | 立てない | 関係しない |
| catalog の失敗 (本番のカタログ・台帳・`cron.job` を読めない・python3 が落ちる・CSV・台帳・`cron_jobs.sql`・`fixups.sql` がそろわない・読めない) | 任意 | — | catalog (全層 failed。送らない) | reason `catalog_failed` | 立てる | 続けば鳴る |
| `r2-config` (オーナーが 1 回) | 初回の設定・保持の変更のとき | `r2-lifecycle.json` と wrangler の 4 行 | 引数の誤りだけ (終了 2) | 書かない | 立てない | 関係しない |
| run の step の時間切れ・取り消し (S-17) | 任意 | — | 結果ファイルが無い | 書かれない (audit まで行っていない) | report の step が立てる (「結果を残さずに終わった」) | 翌日 stale になれば鳴る |
| 取得の run の待機中に取得の run (手動) がもう 1 つ入る | 任意 | 新しい方の run が取る | 待機中だった方は canceled (job が始まらない) | 新しい方の分だけ | 新しい方の report の step が判断する | 新しい方の completed で fresh |
| PR の run (roundtrip-check) が取得の run と重なる | PR のある日 | 両方とも動く (group が別) | — | 取得の分だけ | 取得の分だけ | 関係しない |
| 結果ファイルが `ok` なのに step が `success` でない | 任意 | — | 食い違い | 書いたとおり | report の step が立てる (「食い違う」) | 同上 |
| copy が一部の層だけ失敗 (1/1 が月曜で weekly の copy だけ失敗) | 1/1 が月曜 | daily/ と annual/ に 3 ファイルずつ + 復元の検査 1 回 (annual のため) | copy (weekly だけ) | daily completed・weekly failed (stage `copy`)・annual completed (restore_check 入り) の 3 行 | 立てる | daily の行だけを見る |
| copy が一部の層だけ失敗 (1/1 が月曜で annual の copy だけ失敗) | 1/1 が月曜 | daily/ と weekly/ に 3 ファイルずつ + 復元の検査 1 回 (copy に成功した weekly のため。§4.7 の「失敗の後に進む段」) | copy (annual だけ) | daily completed・weekly completed (restore_check 入り)・annual failed (stage `copy`, reason `copy_failed`。restore_check は無い) の 3 行 | 立てる | daily の行だけを見る |
| copy が両方の層で失敗 (1/1 が月曜で weekly と annual の copy が失敗) | 1/1 が月曜 | daily/ に 3 ファイル。weekly/ と annual/ には無い。復元の検査はしない (copy に成功した weekly / annual が無い。§8.3 の「restore_check をしない」) | copy (weekly・annual) | daily completed・weekly failed・annual failed (どちらも stage `copy`, reason `copy_failed`) の 3 行 | 立てる | daily の行だけを見る |
| copy が annual だけの日に失敗 (1/1 が月曜でない日に annual の copy が失敗) | 1/1 (月曜でない) | daily/ に 3 ファイル。annual/ には無い。復元の検査はしない (copy に成功した weekly / annual が無い。§8.3 の「restore_check をしない」) | copy (annual) | daily completed・annual failed (stage `copy`, reason `copy_failed`。restore_check は無い) の 2 行 | 立てる | daily の行だけを見る |
| report の step の GitHub の API の失敗 (`listOpenIssues` / `createIssue` / `updateIssue` / `closeIssue` が例外) | 任意 | 取得・監査行・結果ファイルは run の step のとおり (report は変えない) | report-issue (終了 1。§4.7 の report-issue の表) | run の step のとおり | 途中までのまま (問題ありの日は立たない・成功の日は閉じない。次に report が通った日に直る) | 取得が失敗していれば翌日に鳴る。job の赤で Actions の失敗通知 |
| Docker イメージをどの取得元からも取れない (§4.2) | 任意 (日中の上限。02:23 JST は少ない) | — | stats / dump (全層 failed)・restore_check (copy に成功した weekly / annual だけ failed) | reason `image_pull_unavailable` | 立てる (検査の赤ではないと分かる reason) | stats / dump で落ちた日は completed が無いので、続けば鳴る |
| audit の psql が失敗 (S-20) | 任意 | 対象物は R2 に残る (completed に層がある) | audit (全層) | 1 行も書かれない (1 回の取引) | 立てる (本文に「取得は成功・監査行は書けなかった」と completed) | 次の回の時刻で 30 時間を超えれば鳴る |
| 段の処理の中の予期しない例外 (reason `unknown`) | 任意 | — | その段 (§4.7) | その段の失敗と同じ | 立てる | 同上 |
| `runBackup` の外の例外 (実装の不具合) | 任意 | — | 結果ファイルの failures は空・status `failed` | 書けたか分からない | 立てる (「段の失敗として記録できずに終わった」) | 同上 |
| 運営のロールの人が `admin_audit_logs` に直接 INSERT する (S-23。自分の JWT で PostgREST へ) | 任意 | — | — | 行はできるが、`audit_logs_insert_admins` では actor_id = 本人なので、取得の行 (actor_id NULL) としても訓練の行 (actor が今の super_admin。本人が super_admin でなければ) としても読まれない (§7.1)。古いポリシー `"Admins can create audit logs"` で actor_id を NULL / super_admin の id にした行は見分けられない (Issue #1736) | 立てない | 取得が止まっていれば鳴る (actor のある偽の行では fresh にならない) |
| 消費経路 | — | R2 (保管)・admin_audit_logs (記録)・結果ファイル (run → report の step)・`/super-admin/backups` (表示。層・訓練の種類ごとの最新 1 行 + 一覧 2 本)・`backup-freshness` (監視)・`restore` サブコマンド (ローカルへの復元)・手順書 §6 (新しいプロジェクトへの復元。書庫の `fixups.sql`・`catalog/`・`ledger.txt`・`cron_jobs.sql` を読む) | — | — | — | — |

### 8.2 ②状態比較表 (現行 vs 設計後)

| 面 | 現行 (origin/main) | 設計後 |
|---|---|---|
| 論理バックアップ | 無い (Free プランで Supabase の日次も無い) | 毎日 02:23 JST に GitHub Actions が取る。daily 30 日・weekly 366 日・annual 7 年 |
| 取得の場所 | 07 は Vercel Cron + Edge Function (未実装・成立しない) | GitHub Actions (`.github/workflows/db-backup.yml`) |
| 保存先 | 07 は R2 + GLACIER (R2 に無い) | R2 の Standard → 30 日で Infrequent Access。bucket lock |
| 暗号化・整合性 | 07 は GPG 署名 + sha256 | age (公開鍵。秘密鍵は CI に無い) + sha256 + bucket lock + 監査行のハッシュ |
| 世代の削除 | — | R2 の Lifecycle (`r2-config` が wrangler の受ける Cloudflare の API の形で作る)。コードは消さない |
| 同時実行の group | (db-backup.yml は無い。前例の daily-consistency-check.yml はワークフロー直下) | `backup` job だけに `db-backup`、`roundtrip-check` job は `db-backup-roundtrip-<ref>`。ワークフロー直下には置かない |
| 記録 | 無い (`backup.*` 0 件) | `record_backup_audit` が `admin_audit_logs` に層ごと 1 行 |
| 失敗の通知 | — | Actions の失敗通知 + Issue (report の step が結果ファイルと `steps.run.outcome` から作る) + 監査行 |
| 走っていないことの検知 | — | Vercel Cron `backup-freshness` → `OPS_ALERT_EMAIL` (日 1 回の cron の回ごとに 1 通。クールダウン 23 時間) + 画面のバッジ |
| 復元の検査の基準 | — | ダンプの中身 (manifest の `dumped`)・取得の時点のカタログ (書庫の `catalog/`。`verify_baseline.py` で比べる)・台帳 (manifest の `ledger` と `supabase/migrations/` のファイル)。live の stats は記録だけ |
| 書庫の中身 | — | 3 つの dump・`fixups.sql`・`cron_jobs.sql`・`ledger.txt`・`catalog/` (`ARCHIVE_ENTRIES` の 7 つ) |
| dump で戻らないもの (関数・表・列の権限・storage のポリシー・台帳・auth・storage の表のアプリのトリガー) | ローカルのベースラインだけが `prod_function_acl.sql`・`prod_table_acl.sql`・`prod_storage.sql` で補う (`supabase/baseline/README.md`)。台帳の写しは無い。auth の表のトリガーはローカルでは migration (#1757) が作る | 取得ごとに、同じ作り方 (`build_baseline.py` の 3 つの関数) にアプリのトリガーの作り直しを足した `fixups.sql` と `ledger.txt` を書庫に入れる。ローカルへの復元は `fixups.sql` まで流して確かめ (アプリのトリガーは `appTriggerChecks` で取得の時点と比べる)、新しいプロジェクトは手順書 §6 で `fixups.sql` と `migration repair` |
| データのダンプに入れるスキーマ | — (CLI の既定は cron・net なども入れる) | public・auth・storage だけ (`DATA_DUMP_SCHEMAS`。cron のジョブの定義は `cron_jobs.sql`) |
| cron のジョブの定義 | 本番の `cron.job` は 15 本。migration が登録するのは 9 本で、`catalog-import-*` の 5 本と `handson-tour-sandbox-cleanup` の写しはリポジトリのどこにも無い (operator/08 §3.0) | 取得ごとに本番の `cron.job` から `cron_jobs.sql` を作って書庫に入れる (manifest の `cron_jobs`)。新しいプロジェクトでは手順書 §6 の (6) で流し、最後の行が名前の集合を書庫と比べる。ローカルの検査では流さず数だけ見る (`roundtrip-local` は `cron_dry_run` まで) |
| aws cli に渡す R2 の鍵 | — | `awsCommandEnv` が `BACKUP_R2_*` を `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` に写す (取得は GitHub の secret、`restore` は手元のシェルの復元用の読み取り専用のトークン。§4.4) |
| 監査行の書き方 | — | runner の psql で全層を 1 回の取引 (全部か 0 行か)。details は base64 で SQL に入れる (§4.12) |
| DR 訓練の記録の 400 | — (route が無い) | `OP_INVALID_INPUT` (`src/lib/super-admin/validation-errors.ts` の形。項目の文は schema の日本語で、画面が項目の下に出す) |
| 画面の「層ごとの最新」「訓練の種類ごとの最新」 | — | action_type ごとに最新 1 行を読む (一覧の 100 行の窓によらない。書いた経路の印でも絞る = 次の行) |
| 取得・訓練の行を信じる条件 | — (`backup.*` / `dr.test.*` の行は無い。表の INSERT のポリシー 2 本は action_type を見ない) | action_type だけでは信じない。取得の行は actor_id NULL かつ target_type `database_backup`、訓練の行は target_type `dr_test` かつ actor が今の super_admin (§7.1・§7.3。鮮度の cron・画面の GET・`toBackupStatusResponse` が同じ条件)。INSERT のポリシーそのものは変えない (古いポリシーが残る間の穴は Issue #1736) |
| weekly / annual の対象物の作り方 | 07 は weekly を月曜 03:00 UTC の別の Vercel Cron で取る (未実装) | daily と同じ手元の 3 ファイルを層のキーへもう一度送る (`aws s3 cp <ファイル> s3://…` と head-object。R2 の中のコピーは使わない。§3.3・§4.4) |
| `admin_audit_logs` の UPDATE / DELETE の禁止 | RLS (`USING (false)`)。anon / authenticated に効き、postgres・service_role は越える | 変えない (取得の行も同じ扱い。対象物の改ざんの検出は bucket lock の `.sha256`) |
| `OPS_ALERT_EMAIL` の読み口 | `app-log-alerts/route.ts` だけ | `src/lib/ops-alerts/recipient.ts` (2 つの cron が共有) |
| DR 訓練の記録 | 無い (`dr.test.*` 0 件。手順も文書だけ) | `POST /api/super-admin/backups/dr-tests` + 画面。`dr.test.monthly.pitr` / `dr.test.quarterly.restore` / `dr.test.annual.drill` |
| 手順書 | `docs/operations/` に無い | `docs/operations/backup-restore.md` |
| Vercel Cron | 2 本 | + 1 本 (`backup-freshness`。段 C の PR の時点の実数 + 1。並行の cross/16 の `login-alerts`・mobile/06 の `push-outbox` が先に入っていれば 4 本・5 本。`operator/08` の §3.0・§3.2・§5 の 5 か所を同じ PR で直す。§18.1 の並行の規則) |
| `admin_audit_logs` の action の族 | admin / super_admin / finance / support / system | + backup / dr.test (operator/07 §4.5 に追記) |

### 8.3 ③状態遷移表 (取得の 1 回。状態 × 操作 → 遷移先・ガード・副作用)

| 状態 | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| queued (`backup` job の concurrency の待機) | 同じ group (`db-backup`) に取得の run がもう 1 つ入る | canceled (job が始まらない。report の step も動かない) | 待機中の run は group に 1 つだけ (GitHub の仕様)。PR の run (roundtrip-check) は別の group なのでここに入らない | 監査行・Issue は無い。新しい方の run が同じ 1 本道で取るので daily は欠けない。手動の `tier` が `auto` 以外なら月曜の weekly などが抜けうる (§4.2) |
| queued | 先に走っている取得の run が終わる | started | — | — |
| started | link | linked / failed(link) | secrets がある・`supabase link` が 0 | `.temp` の版が更新される |
| linked | config | configured / failed(config) | 5 つの名前がそろい、受け手が `age1…`、`RUN_TUNING_ENV` は無いか形が合う (`resolveRunTuning`) | failed なら監査行 + Issue、終了 3 |
| configured | stats | counted / failed(stats) | psql が 0 | manifest の source |
| counted | dump | dumped / failed(dump) | 3 回の `db dump` が 0、上限 120 分 | 平文 3 ファイル |
| dumped | catalog | cataloged / failed(catalog) | カタログの psql (`snapshot_catalog.sql`)・台帳の psql・cron のジョブの psql (`CRON_JOBS_SQL`)・python3 (`build_restore_fixups.py`) が 0 (子 1 つずつ catalog の 5 分の中)、`checkCatalogCapture` が ok (§4.3 の catalog の 4) | `catalog/` に CSV 7 つ・`ledger.txt`・`cron_jobs.sql`・`fixups.sql`。manifest の `ledger` と `cron_jobs` |
| cataloged | verify | verified / failed(verify) | 完了行 (`DUMP_COMPLETE_TRAILER`) の後が `RESET ALL;` だけ・COPY の終端・schema.sql の public の表 (空でない) = `COPY "public".` の表・`COPY "auth"."users"`・`COPY "public"."admin_audit_logs"`・`DATA_DUMP_SCHEMAS` の外の COPY が無い・schema.sql に public の外の表が無い (§4.3 の 1〜6。実物の形。live の stats は見ない) | manifest の `dumped` |
| verified | archive → encrypt | encrypted / failed(archive, encrypt) | zstd・age が 0 | `.tar.zst` を消す |
| encrypted | upload | uploaded / failed(upload) | 3 つの PUT と head-object の大きさ一致 (aws の argv と env は §4.4 の表と `awsCommandEnv`) | daily/ に 3 ファイル |
| uploaded | copy | copied (全層が成功) / copied_partial (1 層以上が failed(copy)) | weekly / annual があるときだけ。層ごとに、手元の 3 ファイルを層のキーへ送る `aws s3 cp <ファイル> s3://…` が 0 で、head-object の `ContentLength` が手元と同じ (§4.4。R2 の中のコピーは使わない。子 1 つずつ `stageTimeoutMs('copy', tuning)` = upload の上限の中。時間切れは reason `timeout`) | 成功した層は weekly/ annual/ に 3 ファイルずつ。失敗した層は `RunFailure` {stage `copy`, reason `copy_failed`} を持つ (daily と、ほかの層には影響しない) |
| uploaded | copy をしない (daily だけの日) | copied | `plan.tiers` に `weekly` も `annual` も無い | 何もしない (copy の段は失敗にも成功にも数えない) |
| copied | inventory | inventoried (失敗でも進む) | — | counts |
| copied_partial | inventory | inventoried (失敗でも進む) | — | counts。failed(copy) の層は以後の restore_check の対象から外し、監査行は stage `copy` の `failed` のまま (§4.7 の「失敗の後に進む段」) |
| inventoried | restore_check | checked / failed(restore_check) | plan の weekly / annual のうち copy に成功した層が 1 つ以上あるときだけ (1 回)。§4.8 の 2〜8: reset・roles・restore・fixups の psql が 0・`restoreChecks(manifest.dumped, …)` が ok・復元した DB のカタログを `verify_baseline.py` が errors 0・`ledgerChecks(manifest.ledger, …)` と `cronJobsChecks(manifest.cron_jobs, …)` が ok (`cron_jobs.sql` はローカルに流さない)。reason は §4.8 の分け方 (`psql --version`・`python3 --version`・`start`・`env` の失敗は `restore_env_failed`、`start` の終了 75 は `image_pull_unavailable`、reset〜台帳の失敗は `restore_check_failed`) | ローカルのスタックの起動と停止。結果は copy に成功した層の `completed` の details に入る。失敗ならその層を stage `restore_check` の `failed` に |
| inventoried | restore_check をしない (daily だけの日・copy に成功した層が無い日) | checked | `plan.tiers` に `weekly` も `annual` も無い、または weekly / annual がすべて failed(copy) (結果を載せる行が無い) | ローカルのスタックを起こさない。`restore_check` の結果は無く、どの監査行の details にも入らない (§4.8) |
| checked | audit | audited / failed(audit) | link が通っている | `buildAuditSql` の層ごとに 1 文を 1 回の取引で書く (§4.12)。daily は `completed`、copy に失敗した層は stage `copy` の `failed`、ほかの層は `completed` (restore_check をした日は copy に成功した weekly / annual の details に結果。終了 0、copy の失敗があれば 1) |
| failed(restore_check) (copy に成功した weekly / annual の全部が stage `restore_check` の failed。daily は completed のまま) | audit | audited / failed(audit) | link が通っている | `buildAuditSql` の層ごとに 1 文を 1 回の取引で書く (§4.12)。daily は `completed`、copy に成功した weekly / annual は stage `restore_check` の `failed` (reason は §4.8 の分け方 = `restore_env_failed` / `image_pull_unavailable` / `restore_check_failed` / `timeout` / `unknown`)、copy に失敗した層は stage `copy` の `failed` のまま (1 つの層の監査行は 1 行で、先に失敗した段。§4.7)。R2 の対象物は消さない (S-10)。終了 1 |
| failed(config / stats / dump / catalog / verify / archive / encrypt / upload) | audit | audited / failed(audit) | link が通っている | plan の全層を同じ stage / reason の `failed` で 1 行ずつ。copy・inventory・restore_check は通らない。config は終了 3、ほかは 1 |
| failed(link) | audit をしない | not_audited | DB に繋がっていない (`record_backup_audit` を呼べない) | 監査行は無い (結果ファイルの `audit_written: false`)。翌日の鮮度の cron が気づく (S-5) |
| (audit の段) | psql が 0 でない・時間切れ・予期しない例外 | failed(audit) | — | 監査行は 1 行も無い (取引ごと戻る)。plan の全層に `RunFailure` {stage `audit`, reason `classifyFailure('audit', …)` = `audit_failed` / `timeout` / `unknown`} を足す。`completed` は変えない (S-20)。`audit_written: false`。終了は config の失敗があれば 3、ほかは 1 |
| (link〜restore_check のどの段) | 段の処理の中の予期しない例外 (子プロセスの失敗・時間切れでない) | failed(その段) | — | reason `unknown`。その段の失敗と同じ遷移 (inventory だけは例外も警告 `inventory_failed` で inventoried へ) |
| どの状態 | cleanup (always) | — | — | 一時ディレクトリを消す |
| audited / failed(audit) / not_audited (`runCli` の finally) | 結果ファイルを書く | reported_to_file | — | `$RUNNER_TEMP/db-backup-result.json` に `toRunReport(result)` (一時ファイル → rename)。終了コード 0 / 1 / 3 で run の step が終わる |
| (どの状態でも) `runBackup` が reject (段の外の記帳の誤り) | `runCli` の catch → finally | reported_to_file | — | 結果ファイルに `unexpectedFailureReport({ jstDate })` (status `failed`・`failures` 空・exit_code 1)。終了 1 |
| (run の step が時間切れ・取り消しで終わった) | — | no_report_file | — | 結果ファイルは無い (finally も走らない) |
| run の step の終わり (成否・時間切れ・取り消しを問わない) | step `Stop local Supabase` (`if: always()`) | — | — | `supabase-local.sh stop \|\| true` |
| reported_to_file / no_report_file | step `Report (Issue)` (`if: always()`) で `GITHUB_REPOSITORY` が無い・引数の誤り | report_usage_error | — | Issue に触らない。終了 2 (step の失敗 → job が赤 → Actions の失敗通知)。Actions の中では `GITHUB_REPOSITORY` は自動で入るので、手元で流したときだけ |
| reported_to_file / no_report_file | step `Report (Issue)` で、`planIssueAction` が選んだ GitHub の操作 (`listOpenIssues` → `createIssue` / `updateIssue` / `closeIssue`) のどれかが例外 | report_failed | — | どの操作かと `redactForLog` した例外の文を標準エラー出力に出して終了 1 (step の失敗 → job が赤 → Actions の失敗通知)。Issue は失敗した操作の手前のまま (作られない・更新されない・閉じない)。やり直さない。監査行・結果ファイル・R2 は変えない。次の取得の report の step が同じ marker で作る・更新・閉じる |
| reported_to_file / no_report_file | step `Report (Issue)` (`if: always()`) で、GitHub の操作がどれも例外なく終わる | done | 入力 = 結果ファイル (`parseRunReport`。無い・壊れている・status と exit_code が食い違う・ok なのに failures があれば null) + `RUN_OUTCOME` (`steps.run.outcome`) + `RUN_URL` | `planBackupIssue` (§4.11 の 4 通り: null → 問題あり / status が ok でない → 問題あり (failures が空でも) / ok で outcome が success でない → 問題あり / ok で success → 問題なし) → 問題ありなら marker の Issue を作る・更新 (本文に failures の層・段・reason・`missing` の名前と completed の層)、問題なしなら閉じる。終了 0 |
| restore: started (`parseArgs` が通った。`--key` が `siblingKeys` で 3 つのキーにならなければその手前で終了 2) | config | configured / failed(config) | `checkRestoreConfig(env)` が ok (`RESTORE_REQUIRED_ENV_NAMES` の 4 つが空でない・`RUN_TUNING_ENV` は無いか形が合う。`BACKUP_AGE_RECIPIENT` は見ない) | failed なら stage `config`・reason `not_configured`・終了 3 (標準エラー出力に名前だけ)。一時ディレクトリを作らず、aws・age・`supabase-local.sh` を呼ばない (S-22) |
| restore: configured | download | downloaded / failed(download) | aws (`s3 cp s3://<BACKUP_R2_BUCKET>/<キー> …`・`--endpoint-url r2EndpointUrl(BACKUP_R2_ACCOUNT_ID)`・`--region auto`・env は `awsCommandEnv`) で 3 ファイルが 0、子 1 つずつ `restoreStageTimeoutMs('download', tuning)` の中 | 一時ディレクトリに `.age`・`.sha256`・`.manifest.json`。0 でなければ `download_failed`、時間切れは `timeout` |
| restore: downloaded | checksum | checked_sum / failed(checksum) | `verifyChecksum` が ok (`.age` の SHA-256 は Node の crypto で取る。子を起こさない) | 合わなければ復号しない (`checksum_mismatch`) |
| restore: checked_sum | decrypt | decrypted / failed(decrypt) | `age -d -i <identity>` が 0 (`restoreStageTimeoutMs('decrypt', tuning)` の中) | `.tar.zst` (平文の書庫)。時間切れは `timeout` |
| restore: decrypted | extract | extracted / failed(extract) | zstd -d と tar が 0 (子 1 つずつ `restoreStageTimeoutMs('extract', tuning)` の中)・展開した中に `ARCHIVE_ENTRIES` の 7 つがある | 平文 (3 つの dump・`fixups.sql`・`cron_jobs.sql`・`ledger.txt`・`catalog/`)。時間切れは `timeout` |
| restore: extracted | restore_env | env_ready / failed(restore_env) | `psql --version` と `python3 --version` が 0・`supabase-local.sh start` と `env` が 0 (子 1 つずつ `restoreStageTimeoutMs('restore_env', tuning)` の中)・`parseLocalDbUrl` が null でない | ローカルのスタックが起きる。時間切れは `timeout` |
| restore: env_ready | restore → restore_check | restored / failed(restore) / failed(restore_check) | restore (§4.8 の 2〜5): reset (storage のポリシーも外す)・roles (`countRoleRestoreErrors` の others が空)・restore・fixups の psql が 0 (§4.12)。data.sql に cron・net の COPY は無いので、ローカルの `cron.job` の行と重ならない (§4.3 の `-s`) / restore_check (§4.8 の 6〜8): count の出力が `parseRestoreCounts` で読め `restoreChecks(manifest.dumped, …)` が ok・復元した DB の catalog の psql が 0 で `verify_baseline.py <書庫の catalog/> <restored-catalog/>` が 0 かつ要約の errors が 0・`ledgerChecks(manifest.ledger, <ledger.txt の版>, <MIGRATIONS_DIR>)` が ok・`cronJobsChecks(manifest.cron_jobs, <cron_jobs.sql>)` が ok (ローカルには流さない)。子 1 つずつ `restoreStageTimeoutMs('restore' / 'restore_check', tuning)` の中 | ローカルの DB が本番の取得時点 (数・関数と表の権限・ポリシー・バケット) になる。台帳はローカルのスタックのまま (版の一覧とファイルの有無だけを確かめる。新しいプロジェクトでは手順書 §6 の repair)。failed は reason `restore_check_failed` (時間切れは `timeout`) |
| restore: どの状態 | cleanup (always) | — | — | 一時ディレクトリを消す (スタックは止めない) |
| DR 訓練: (記録なし) | POST | 記録あり | super_admin・Zod・`recordAdminAudit` が ok | `dr.test.*` 1 行。失敗は 500 で記録なしのまま |
| DR 訓練: (記録なし) | POST (拒否) | 記録なし | NULL 文字 → 400 `INVALID_CHARACTER` / super_admin でない → 401・403 (`requireRole`) / JSON でない・Zod 不合格 → 400 `OP_INVALID_INPUT` (`invalidJsonBodyResponse` / `invalidInputResponse`) / `recordAdminAudit` が ok でない → 500 (§7.2) | 監査行を書かない |
| 鮮度: (どれでも) | cron (宛先が無い / 形が違う) | disabled / invalid_config | `resolveOpsAlertRecipient()` が `disabled` / `invalid_config` (DB に触れる前) | info / warn ログだけ。DB を読まない・claim しない (§7.3) |
| 鮮度: (どれでも) | cron (DB の読み取りが error) | error (500) | `admin_audit_logs` の最新 1 行の select が error | `internalError` の 500 (本文は汎用)。claim しない・メールを送らない。翌日の回でもう一度読む (§7.3) |
| 鮮度: fresh | cron | fresh | 取得の行 (`action_type = backup.daily.completed` かつ `target_type = database_backup` かつ `actor_id IS NULL`。§7.3) の最新が 30 時間以内。運営のロールの人が自分の JWT で書いた行 (actor_id = 本人) は数えない (S-23) | — |
| 鮮度: stale | cron (claim が NULL) | stale_deduped | 前回の送信から 1380 分 (`BACKUP_STALE_ALERT_COOLDOWN_MINUTES`) より前。cron の間隔 1440 分より短いので翌日の回は取れる | 送らない |
| 鮮度: stale | cron (claim が取れ、`sendEmail` が ok) | stale_sent | claim が取れた | メール 1 通 (権利は返さない = 23 時間は次を送らない) |
| 鮮度: stale | cron (claim が取れ、`sendEmail` が `{ ok: false, skipped: true }`) | stale_send_skipped | 送信の設定が未完了 | `release_ops_alert` で権利を返す (200) |
| 鮮度: stale | cron (claim が取れ、`sendEmail` が `{ ok: false }` で skipped でなく、`error.code` が `NON_RELEASING_SEND_ERROR_CODES` に無い (`outbox_failed` など)) | stale_send_failed | 送信先・Resend が断った・送信待ちに登録できなかった | `release_ops_alert` で権利を返す (200) |
| 鮮度: stale | cron (claim が取れ、`sendEmail` が例外) | error (500) | — | `release_ops_alert` で権利を返し、`internalError` の 500 (app-log-alerts と同じ。§15) |
| 鮮度: stale (上の 3 行の `release_ops_alert` の途中) | `release_ops_alert` が error を返す・例外を投げる | 上の 3 行の遷移先のまま (stale_send_skipped / stale_send_failed の 200、`sendEmail` の例外の行は 500) | — | warn ログ 1 行 (「送る権利を返せませんでした」と `pg_code` か `error_name`。宛先は書かない) だけで、例外にせず応答を変えない (app-log-alerts の `releaseClaim` と同じ。送れなかったという本題を release の失敗で上書きしない)。権利は返らないので次の claim はクールダウン (1380 分) の後になるが、cron の間隔 1440 分より短いので翌日の回は取れる (通知は遅れない) |
| 鮮度: stale | cron (claim が取れ、`sendEmail` が `{ ok: false }` で `error.code` が `NON_RELEASING_SEND_ERROR_CODES` (`suppressed` / `invalid_envelope`)) | stale_send_failed | 宛先が停止リストに載っている・文面の不備 | `release_ops_alert` を呼ばない (権利を持ったまま。送り直しても同じ結果で、回ごとの繰り返しになるため。クールダウン 1380 分の抑止が効く。#1577 の 8・operator/10 §8.3) (200) |
| 鮮度: stale | cron (`claim_ops_alert` が error) | error (500) | — | `internalError` の 500。送らない |
| 画面: GET | 読み込み | 表示 | super_admin・super_admin の一覧 (service_role の 1 本) と 8 本の読み取りがどれも error でない・行が `backupAuditRowSchema` を通る | 層・訓練の種類ごとの最新 (窓によらない) と一覧 2 本。どれも取得の行は actor_id NULL かつ target_type `database_backup`、訓練の行は target_type `dr_test` かつ actor が今の super_admin だけ (DB 側で絞り、`toBackupStatusResponse` が見直す。§7.1) |
| 画面: GET | 読み込み (失敗) | 読み込みの失敗 | super_admin でない → 401・403 (`requireRole`。このとき `getSupabaseAdmin` を呼ばない) / super_admin の一覧か 8 本の読み取りのどれかが error、または 1 行でも `backupAuditRowSchema` を通らない → 500 `internalError` (§7.1) | 画面は固定の文だけ (§7.4。カード・一覧を描かない)。閲覧は記録しない |

- 表に無い遷移を作らない (例: verify を飛ばして upload・cleanup を飛ばす・監査行の UPDATE)。

---

## 9. 個人情報・退会・Pro でない間

### 9.1 退会した利用者の行とバックアップ

| 事項 | 本書の決め |
|---|---|
| 残る期間 | 退会した日の取得から、daily 30 日・weekly 366 日・annual 7 年。暗号化して R2 にだけ置き、復元以外の目的で開かない |
| 誰が開けるか | age の秘密鍵を持つオーナーだけ。R2 のトークンだけでは読めない |
| 復元で戻ること | 復元点より後の退会は機械では再現できない (S-14)。`gdpr_deletion_requests` の記録は id の HMAC で、復元先が同じプロジェクト (Vault の `pii_hmac_key` が残る) なら照合できるが、新しいプロジェクトでは鍵が無い。影響の期間は最長 24 時間 (RPO)。手順書に「復元後に、復元点以降の退会の問い合わせがあれば再度の退会で応じる」と書く |
| プライバシーポリシー | 現行の文面 (src/app/privacy/page.tsx) にバックアップの保持は書かれていない。追記の案 (§19): 「当社は、障害からの復旧のために個人情報を含むデータベースのバックアップを暗号化して保管します。退会後も、バックアップには最長 1 年 (年 1 回の長期保管分は 7 年) 残ることがありますが、復旧以外の目的で利用しません」。文言と年数は法務の確認 (§21) |
| 隠したコンテンツ・古いログ | 運営が隠して 90 日で消すもの (purge-hidden-content) と 30 日で消す app_logs も、消えた後に上の期間だけバックアップに残る。同じ文で扱う |

### 9.2 Pro でない間 (PITR 無し) の RPO / RTO と訓練

| 項目 | Pro でない間 (本書) | Pro + PITR の後 (07 §6.1) |
|---|---|---|
| RPO | 24 時間 (daily の間隔)。プランを問わず同じ | プラン別 (1 分〜24 時間) |
| RTO | 目標 4 時間 (新しいプロジェクトに手で復元。手順書 §12)。保証しない | プラン別 |
| 月次 PITR 復元テスト | できない。毎月 `monthly_pitr` を `skipped` + notes `plan_not_pro` で記録する (S-12) | Supabase の画面で staging へ復元 → smoke → `success` で記録 |
| 四半期の論理復元 | 本書の `restore` でローカルへ (S-11) | 同じ |
| 年次の訓練 | 新しいプロジェクトへの復元を含む (手順書) | 同じ |
| 07 §3.1 の「本番リリース前に Pro へ」 | 変えない。本書は Pro の前後で動きを変えない (Pro になっても論理バックアップは続ける。Supabase の日次 7 日 / PITR は別の層) | — |

---

## 10. 監査ログ (admin_audit_logs)

| action_type | 誰が | 書き方 | severity | target_type | details |
|---|---|---|---|---|---|
| `backup.daily.completed` / `backup.weekly.completed` / `backup.annual.completed` | GitHub Actions (postgres) | `record_backup_audit` | info | `database_backup` | `CompletedAuditDetails` (§5.1) |
| `backup.daily.failed` / `backup.weekly.failed` / `backup.annual.failed` | 同上 | 同上 | warn | 同上 | `FailedAuditDetails` |
| `dr.test.monthly.pitr` / `dr.test.quarterly.restore` / `dr.test.annual.drill` | super_admin | `recordAdminAudit` (本人の client。`actor_id = auth.uid()`) | success → info、failed / skipped → warn | `dr_test` | `DrTestRecordBody` |

- `actor_id` は取得の行で NULL (利用者のいない操作。operator/07 §4.1.1 の pg_cron の行と同じ)。`ip_address` も NULL。
- 読む側の条件 (§7.1・§7.3): 取得の行は `target_type = database_backup` かつ `actor_id IS NULL`、訓練の行は `target_type = dr_test` かつ actor が今の super_admin。表の INSERT のポリシー 2 本 (`"Admins can create audit logs"`・`audit_logs_insert_admins`) は action_type を見ないので、action_type だけでは「誰がどの経路で書いたか」を決められない。前者は actor_id も見ないので、それが残る間は運営のロール (admin / super_admin / support) の人が上の印を持つ行も書ける (既存の欠陥。Issue #1736。§21)。
- details に利用者の情報・エラーの文・鍵・接続先は入れない。
- 命名の規則: `admin.<対象>.<操作>` は運営の操作の族。`backup.<層>.<結果>` と `dr.test.<周期>.<種類>` は新しい族として operator/07 §4.5 (システム自動操作) の隣に表を足す (§19)。

---

## 11. エラー表

| 場所 | 条件 | 応答・終了 |
|---|---|---|
| `scripts/backup-db.mjs` | 引数の誤り (§4.7 の引数の表。`--slot` の範囲の外を含む) | 標準エラー出力に使い方、終了 2 |
| 同 | §4.7 の各失敗 | 終了 1 (`not_configured` は 3。`run` の config と、`restore` の config = 手元のシェルに R2 の 4 つが無い) |
| 同 (`report-issue`) | `GITHUB_REPOSITORY` が無い・空 | 標準エラー出力に名前、終了 2 (Issue に触らない) |
| 同 (`report-issue`) | GitHub の API の失敗 (`listOpenIssues` / `createIssue` / `updateIssue` / `closeIssue` が例外) | 標準エラー出力に操作の名前と伏せた文、終了 1 (Issue は途中までのまま。§4.7・§8.3 の report_failed) |
| `POST /api/super-admin/backups/dr-tests` | 本文に NUL | 400 `{ error: { code: 'INVALID_CHARACTER', message: <文> } }` (`rejectNullCharacterBody(request, { shape: 'nested' })`。ほかの項目と同じ入れ子の形。#1917 の続き) |
| 同 | 未ログイン | 401 `{ error: { code: 'UNAUTHORIZED', message } }` |
| 同 | super_admin でない・凍結中 | 403 `{ error: { code: 'FORBIDDEN', message } }` |
| 同 | JSON でない | 400 `{ error: { code: 'OP_INVALID_INPUT', message: 'リクエストボディが不正です', details: [] } }` (`invalidJsonBodyResponse`) |
| 同 | Zod に落ちる | 400 `{ error: { code: 'OP_INVALID_INPUT', message: <最初の issue の文>, details: <issues の全件 (path・message など)> } }` (`invalidInputResponse`。`src/lib/super-admin/validation-errors.ts`。#1654 と同じ形。文は §5.3 の schema の日本語) |
| 同 | 監査行を書けない | 500 `{ error: { code: 'INTERNAL_ERROR', message } }` (`internalError`。記録しない) |
| `GET /api/super-admin/backups` | 401 / 403 / DB の失敗 | 上と同じ形 / 500 |
| `GET /api/cron/backup-freshness` | 認証 | 401 `{ error: 'unauthorized' }` / 503 `{ error: 'cron_disabled' }` (`requireCronAuth`) |
| 同 | DB の失敗 | 500 (`internalError`。flat の形) |
| 同 | 正常 | 200 `{ status: 'disabled' \| 'invalid_config' \| 'fresh' \| 'stale_deduped' \| 'stale_sent' \| 'stale_send_skipped' \| 'stale_send_failed', latest_completed_at?: string \| null, stale_after_hours?: number }` |

新しいエラーコードは足さない (既存の `INVALID_CHARACTER` / `OP_INVALID_INPUT` / `UNAUTHORIZED` / `FORBIDDEN` / `INTERNAL_ERROR` を使う)。

---

## 12. 手順書 (`docs/operations/backup-restore.md`。実装の段 D で作る。章立てを固定する)

1. 全体像 (本書 §3.1 の図)。2. 初回の設定 (オーナー): R2 のバケット・Lifecycle と bucket lock (`node scripts/backup-db.mjs r2-config --bucket <名前> --out-dir <dir>` が出す 4 行を流す。JSON・日数は手順書に写さない。§4.5)・API トークン 2 つ (取得用 = Object Read & Write・バケット限定 → GitHub の secrets、復元用 = Object Read only・バケット限定 → パスワードマネージャー。§4.4)・`age-keygen` と鍵の保管 (§4.4)・GitHub の secrets 2 つと variables 3 つ・最初の `workflow_dispatch` と監査行の確認。3. 日々の確認: `/super-admin/backups`・Issue・運用メール。4. 手動で取る (`workflow_dispatch`。取得の run の実行中に流すときは `tier` を `auto` にする。待機中の schedule の run が取り消され、その日の層が抜けないように。§4.2)。5. 復元 (ローカル): 前提の道具 = Docker (ローカルのスタック)・Node (`.nvmrc`)・aws cli v2・age・zstd・tar・psql (16 以上。Mac は `brew install libpq` で入り、PATH に足す。§4.12)・python3 (`supabase-local.sh` と `verify_baseline.py` が使う)。手元のシェルの環境変数 = R2 の 4 つ (`RESTORE_REQUIRED_ENV_NAMES`: `BACKUP_R2_ACCOUNT_ID`・`BACKUP_R2_BUCKET` は GitHub の variable と同じ値、`BACKUP_R2_ACCESS_KEY_ID`・`BACKUP_R2_SECRET_ACCESS_KEY` は復元用の読み取りのトークン。値は手順書に書かない。無ければ `restore` は config で止まり終了 3。§4.7)。時間の上限は `BACKUP_UPLOAD_TIMEOUT_MINUTES` (download)・`BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES` (スタックの起動〜検査) を同じシェルに置けば上書きできる (§4.12)。リポジトリの直下 (main の checkout) で `node scripts/backup-db.mjs restore --key <R2 のキー> --identity-file <path> [--slot <枠>]` (枠は省くと 0。手元で local-ci.sh が使っている枠を避ける。止めるときは `LOCAL_CI_SLOT=<枠> bash scripts/supabase-local.sh stop`。§4.7 の引数の表) → 数・カタログ (`[verify] errors=0`)・台帳・cron の定義の数が合うことを見る → `npm run test:smoke -- --base-url=http://localhost:3000`。6. 復元 (新しい Supabase プロジェクト。年次の訓練と本番の障害。S-21。どの手順も前の手順の結果を確かめてから進む): (1) 書庫を取り出す: 手元のシェルに 5 章の R2 の 4 つを置き、手元の空のディレクトリで 3 ファイル (`<base>.tar.zst.age`・`<base>.sha256`・`<base>.manifest.json`) をそれぞれ `env -u AWS_SESSION_TOKEN -u AWS_PROFILE AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required aws s3 cp "s3://$BACKUP_R2_BUCKET/<キー>" . --endpoint-url "https://$BACKUP_R2_ACCOUNT_ID.r2.cloudflarestorage.com" --region auto` (§4.4 の `awsCommandEnv` と同じ写し方) → `sha256sum -c <base>.sha256` (Mac は `shasum -a 256 -c <base>.sha256`) → `age -d -i <鍵> <base>.tar.zst.age \| zstd -d \| tar -x` (中身は `ARCHIVE_ENTRIES` の 7 つ)。(2) 新しいプロジェクトを作り、main の checkout で `supabase link --project-ref <新しい ref>`。`supabase/.temp/project-ref` が新しい ref であることを確かめる (以後の手順は link 先に書くので、本番に向いていないことを先に見る)。接続先は環境変数 `NEW_DB_URL` に置き、手順書に値を書かない。(3) 流す (§4.8 と同じ打ち方): `psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=0 -v VERBOSITY=sqlstate --file roles.sql` (42710 は許す) → `psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file schema.sql --command "SET session_replication_role = replica" --file data.sql` (Supabase の手順) → `psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file fixups.sql` (関数・表・列の権限と storage のポリシーを取得の時点に戻す。流さないと、Supabase の既定権限で anon が REVOKE 済みの関数を呼べ、storage のポリシーが無い。§3.3)。(4) 確かめる: 別の空のディレクトリで `psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --file <checkout>/scripts/baseline/snapshot_catalog.sql` → `python3 scripts/baseline/verify_baseline.py <書庫の catalog> <そのディレクトリ>` が `[verify] errors=0` (warnings は storage の内部の表など。`supabase/baseline/README.md` の「既知の差」)。(5) 台帳: main の checkout で `npx --yes supabase@<SUPABASE_CLI_VERSION> migration repair --status applied $(cat <書庫>/ledger.txt) --linked` (CLI が台帳の表を作り、版ごとのファイルの name と statements で入れる。ファイルの無い版があると止まる。取得の時点の restore_check が先に見ている。§4.8 の 8) → `migration list --linked` で全版が Local と Remote の両方にある (`deploy-supabase-migrations.yml` は台帳の最大より新しいファイルだけを `db push` する)。(6) Vault の `app_cron_secret` と `pii_hmac_key` を作り直す (HMAC の照合は新しい鍵では合わない) → Auth の設定 (Site URL・リダイレクト URL・プロバイダ・SMTP。DB の外にあり、バックアップに入らない) → Edge Function secrets と Vercel の環境変数の差し替え → 本番の project ref (`flmeolcfutuwwbjmzyoz`) を参照する workflow・スクリプトと、Edge Function の URL を本文に持つ DB の関数 (`supabase/migrations` の 5 ファイル。§3.3 の (5)) を `git grep` で洗い、新しい ref に替える PR (関数は `CREATE OR REPLACE` の migration にし、(5) で戻した台帳の次として `deploy-supabase-migrations.yml` で出す。本番の障害のときだけ。訓練では替えない) → cron のジョブ: 書庫の `cron_jobs.sql` (取得の時点の本番の `cron.job`。manifest の `cron_jobs` の本数 (2026-10-16 は 15)。migration に登録の SQL が無い `catalog-import-*` の 5 本と `handson-tour-sandbox-cleanup` も入っている) を流す。本番の障害: `psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file cron_jobs.sql` (最後の行が `cron.job` の名前の集合を書庫の集合と比べ、違えば例外で全体が戻る = 0 で終われば全部そろった)。年次の訓練 (本番が生きている): `psql "$NEW_DB_URL" -X -q -v ON_ERROR_STOP=1 --command "BEGIN" --file cron_jobs.sql --command "ROLLBACK"` (`PSQL_SCRIPTS.cron_dry_run` と同じ。確定させない: 訓練の DB の関数は本番の Edge Function の URL を持つので、ジョブを動かすと本番を呼ぶ) が 0 で終わることを確かめる → `/api/health?deep=1` → smoke。Storage のファイル (写真) は戻らない (§21)。(7) 後片付け (訓練・障害の両方): `rm -rf "$WORK" "$RESTORED_CATALOG" "$KEYDIR"` で平文 (data.sql の利用者の個人情報を含む)・取り直したカタログ・秘密鍵のファイルを消し、`NEW_DB_URL` を外す (5 章の道具が平文を消すのと同じく、手元に残さない)。7. 復元点より後の退会 (§9.1)。8. 訓練の予定と記録 (予定は 07 §7。どの訓練も、終わったら画面 `/super-admin/backups` の「DR 訓練を記録」で 1 回に 1 行。項目は §5.3 の `drTestRecordBodySchema`): (1) 月次 PITR 復元テスト (07 §7 の第 1 月曜)。Pro でない間 (§9.2・S-12): Supabase の画面でプランが Pro でない (PITR が無い) ことを確かめ、kind `monthly_pitr`・result `skipped`・environment `staging`・restored_to・backup_key・rto_minutes は空・smoke `not_run`・notes `plan_not_pro` で記録する。Pro + PITR の後: 07 §7.1 の 1〜3 (Supabase の画面で復元点を選んで staging のプロジェクトに復元 → `curl -s "<staging の URL>/api/health?deep=1"` が 200 → `npm run test:smoke -- --base-url=<staging の URL>` が終了 0) を流す。本番のプロジェクトには復元しない。07 §7.1 の 4 (記録) は本書の画面で行う: kind `monthly_pitr`・result (smoke まで通れば `success`、どこかで止まれば `failed` で止まった手順を notes に)・environment `staging`・restored_to = 選んだ復元点・backup_key は空・rto_minutes = 復元を始めてから smoke が通るまでの分・smoke = test:smoke の結果。(2) 四半期のフル復元: 5 章を流し、kind `quarterly_restore`・environment `local`・backup_key (成功なら必須)・rto_minutes・smoke で記録する (S-11)。(3) 年次の訓練: 6 章を流し、kind `annual_drill`・environment `new_project` で記録する (S-21)。チェックリスト (前提の道具・age の秘密鍵と復元用のトークンの所在 (§4.4)・記録まで) を各訓練の頭に置く。9. 鍵の入れ替え・R2 トークンの入れ替え・secrets の失効。10. 困ったとき: `not_configured` (取得: GitHub の secrets / variables。`restore`: 手元のシェルの R2 の 4 つ。5 章)・`restore` の download の `timeout` (`BACKUP_UPLOAD_TIMEOUT_MINUTES` を手元のシェルで上書き)・`catalog_failed` (本番のカタログ・台帳・cron のジョブの定義を読めなかった・python3 が落ちた。`workflow_dispatch` で取り直す)・weekly / annual の `copy_failed` (層のキーへの送り直しか、その大きさの確かめが失敗した。daily は残っている。翌週の月曜まで待つか、`workflow_dispatch` の `tier` で取り直す)・weekly / annual を取った run (schedule なら月曜・1/1。手動で tier を選べばどの曜日でも) の restore_check の `restore_check_failed` のうちカタログ・台帳の不一致 (`catalog_errors` が 0 でない = migration の本番適用と取得が重なったか、権限の補いが効いていない → 手元で `restore` を流して `[error]` の行を見る。`supabase/migrations/` にファイルの無い版 = 台帳のずれ。`deploy-supabase-migrations.yml` が REMOTE_ONLY として止めるのと同じ事故で、台帳とファイルのどちらが正しいかを調べてから直す。自動では直さない)・`dump_incomplete` (migration の本番適用と重なったときは `workflow_dispatch` で取り直す。毎日続くときは supabase CLI の出力の形が §4.3 の表と変わっていないかを `roundtrip-check` で確かめる。§4.3)・Issue の「結果を残さずに終わった」(時間切れ。`BACKUP_DUMP_TIMEOUT_MINUTES` などの調整)・`restore_env_failed` (ベースラインの取り直し)・`image_pull_unavailable` (Docker イメージの取得の上限。検査の赤ではない。時間をおいて `workflow_dispatch` で取り直す。`docs/operations/ci-supabase-image-pull.md`)・schedule の停止 (60 日)・Lifecycle が効いていない (inventory の数)。

---

## 13. 秘密・費用・保持の一覧 (§4 の要約。実装者の確認用)

| 項目 | 値 |
|---|---|
| secrets (新規) | `BACKUP_R2_ACCESS_KEY_ID`・`BACKUP_R2_SECRET_ACCESS_KEY` |
| variables (新規) | `BACKUP_R2_ACCOUNT_ID`・`BACKUP_R2_BUCKET`・`BACKUP_AGE_RECIPIENT` |
| variables (新規・任意) | `BACKUP_DUMP_TIMEOUT_MINUTES`・`BACKUP_UPLOAD_TIMEOUT_MINUTES`・`BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES`・`BACKUP_ZSTD_LEVEL` (無ければ既定) |
| secrets (既存) | `SUPABASE_ACCESS_TOKEN`・`SUPABASE_DB_PASSWORD`・`GITHUB_TOKEN` |
| GitHub Actions が自動で入れる環境変数 (設定しない) | `GITHUB_REPOSITORY` (report-issue の `createGitHub` の repo。無ければ終了 2)・`GITHUB_RUN_ID`・`GITHUB_RUN_ATTEMPT`・`GITHUB_SHA` (`runIdentityFromEnv` → 監査行の details と manifest の run_id・run_attempt・git_sha。無ければ `RUN_ID_OUTSIDE_ACTIONS` など)・`RUNNER_TEMP` (YAML の `--result-file` の置き場。シェルが展開し、スクリプトは読まない) |
| step の env で渡すもの (YAML) | `GH_TOKEN` = `github.token` (report の step。`createGitHub` が打つ `gh api` が読む)・`TIER_INPUT`・`RUN_OUTCOME`・`RUN_URL` (どれも YAML の `run:` の中でシェルが展開して argv にする。スクリプトは読まない) |
| 既存のライブラリが読むもの (本書では設定しない・既定のまま) | `SUPABASE_IMAGE_REGISTRIES`・`SUPABASE_IMAGE_PULL_ROUNDS`・`SUPABASE_IMAGE_PULL_WAIT_UNIT` (`scripts/lib/supabase-image-pull.sh` の取得元の順・周回・待ち)・`SUPABASE_INTERNAL_IMAGE_REGISTRY` (fallback が子に渡す取得元。stats のイメージ名が読む。§5.1 の `PG_IMAGE_REPOSITORY`) |
| スクリプトが子に渡すもの | `LOCAL_CI_SLOT` (`LOCAL_SLOT_ENV`。`supabase-local.sh` の枠。`--slot` の値、run は 0)・`AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY` (aws の回だけ。`awsCommandEnv` が `BACKUP_R2_ACCESS_KEY_ID`・`BACKUP_R2_SECRET_ACCESS_KEY` の値を写す。`AWS_CHECKSUM_ENV` の 2 つも足し、`AWS_SESSION_TOKEN`・`AWS_PROFILE` は外す) |
| オーナーの手元だけ (手順書 §5・§6。値は手順書・Issue・リポジトリに書かない) | `NEW_DB_URL` (新しい Supabase プロジェクトの接続先。パスワードを含む秘密。GitHub・Vercel には置かない)・`restore` と手順書 §6 の (1) が読む R2 の 4 つ (`RESTORE_REQUIRED_ENV_NAMES`。`BACKUP_R2_ACCOUNT_ID`・`BACKUP_R2_BUCKET` は variable と同じ値、`BACKUP_R2_ACCESS_KEY_ID`・`BACKUP_R2_SECRET_ACCESS_KEY` は復元用の読み取り専用のトークン。§4.4)・任意の `BACKUP_UPLOAD_TIMEOUT_MINUTES`・`BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES` (`restore` の上限の上書き) |
| Next.js の環境変数 | 新しいものは無い (`OPS_ALERT_EMAIL` の読み口が変わるだけ) |
| 費用 | 月 $1〜2 (2.4 GB)。§4.6 |
| 保持 | daily 30 / weekly 366 / annual 2,557 日 |

---

## 14. シーケンス

```mermaid
sequenceDiagram
    participant GH as GitHub Actions (02:23 JST)
    participant S as scripts/backup-db.mjs run
    participant DB as Supabase (本番・読む + 監査行 1 行)
    participant R2 as Cloudflare R2
    participant L as ローカル Supabase (runner)
    participant V as Vercel Cron (14:37 JST)
    participant M as OPS_ALERT_EMAIL

    GH->>S: run --tier auto
    S->>DB: supabase link / psql (表の数・利用者の数)
    S->>S: config (secrets / variables がそろうか)
    S->>DB: db dump × 3 (roles / schema / data。data は public・auth・storage)
    S->>DB: psql (読むだけ) snapshot_catalog.sql → catalog/*.csv・台帳の版 → ledger.txt・cron.job の定義 → cron_jobs.sql
    S->>S: python3 build_restore_fixups.py → fixups.sql
    S->>S: verify → tar (3 つの dump・fixups.sql・cron_jobs.sql・ledger.txt・catalog/) | zstd → age → sha256 → manifest
    S->>R2: PUT daily/<日付>/<base>.{tar.zst.age,sha256,manifest.json} (aws。env は awsCommandEnv)
    S->>R2: head-object (大きさ)
    alt 月曜 / 1月1日
        S->>R2: PUT weekly/ / annual/ (手元の同じ 3 ファイルを送り直す。R2 の中のコピーは使わない) + head-object (大きさ)
        S->>L: supabase-local.sh start → public と storage のポリシーを空に → 復元 → fixups.sql → 数・カタログ (verify_baseline.py)・台帳・cron の定義の数を突き合わせ → stop
    end
    S->>R2: list (inventory)
    S->>DB: psql 1 回の取引で SELECT record_backup_audit('backup.<層>.<結果>', details) (層ごとに 1 文。全部か 0 行か)
    S->>GH: 結果ファイル $RUNNER_TEMP/db-backup-result.json (finally)
    GH->>GH: step Report (if always) report-issue (結果ファイル + steps.run.outcome → 失敗なら Issue、成功なら閉じる)
    V->>DB: 最新の backup.daily.completed (target_type database_backup・actor_id NULL の行だけ)
    alt 30 時間より古い・無い
        V->>DB: claim_ops_alert('backup_stale', 1380)
        V->>M: ops_backup_stale (1 通)
    end
```

---

## 15. テスト一覧

| ファイル | 段 | it 名 (要点) |
|---|---|---|
| `tests/backup-db.test.ts` (scripts/lib/backup-db.mjs。`run` は偽物。bash と python3 を起こす it があるので、import の直後・テストを登録する前に `vi.setConfig(resolveHeavyUnitTimeouts(process.env));` (`./helpers/heavy-unit-test-timeout` から import。§18 の heavy-unit-test-timeout の行)) | A | tiersForDate: 火曜 → [daily] / 月曜 → [daily, weekly] / 2027-01-01 (金) → [daily, annual] / 2029-01-01 (月) → 3 つ / JST の境界 (16:00 UTC の日曜 = 月曜 01:00 JST) で weekly になる / planRun: tierOverride weekly → [daily, weekly]、auto は日付どおり、basename が `homegohan-db-<YYYYMMDDTHHMMSSZ>` / objectKey: `daily/2026-10-20/<base>.tar.zst.age`・annual は `annual/2026/` / checkConfig: 5 つそろえば ok、無い・空・`age1` 以外は missing に名前だけ (値を含まない) / (偽物の data.sql / schema.sql はすべて §4.3 の「ダンプの出力の形」の表と骨組みのとおりに書く。引用符の無い `COPY public.x` や `CREATE TABLE public.a (` を正の例に使わない) parseCopyLine: `COPY "auth"."users" ("id", "email") FROM stdin;` → {auth, users} / 列の無い `COPY "public"."t" FROM stdin;` も拾う / `COPY "public"."a""b" ("x") FROM stdin;` → 表 `a"b` / 引用符の無い `COPY public.x (a) FROM stdin;` → null / parseSchemaTableLine: `CREATE TABLE IF NOT EXISTS "public"."family_members" (` → {public, family_members} / `CREATE UNLOGGED TABLE "public"."b" (` → {public, b} / 引用符の無い `CREATE TABLE public.a (` → null / scanDataSql: `COPY "auth"."users" (…) FROM stdin;` から `\.` までの行数を copy_row_counts[`auth.users`] に数える・`\.` の前でファイルが終わると unterminated_copy にその表・`COPY "public"."x"` を public_copy_tables (`x`)、`COPY "storage"."objects"` を managed_copy_tables (`storage.objects`) に分ける・§4.3 の骨組みで complete_trailer_seen true と statements_after_trailer `['RESET ALL;']` (`-- \unrestrict …` と `--` は数えない)・骨組みから `-- \unrestrict` の行を除いても同じ結果・完了行の無いファイルで complete_trailer_seen false と statements_after_trailer []・COPY の本体の中の行が DUMP_COMPLETE_TRAILER と同じ文字列でも complete_trailer_seen にしない・先頭の `SET session_replication_role = replica;` と注釈を表に数えない・`COPY "cron"."job" ("jobid") FROM stdin;` を unexpected_copy_tables (`cron.job`) に入れ、public・auth・storage の COPY は入れない / scanSchemaSql: `CREATE TABLE IF NOT EXISTS "public"."a" (`・`CREATE UNLOGGED TABLE "public"."b" (` を拾い、`)` の次の行が `PARTITION BY RANGE ("d");` の親は除く (`);` で閉じた表と、`ATTACH PARTITION` される子は数える)・`CREATE TABLE IF NOT EXISTS "auth"."x" (` は public_tables に拾わず non_public_tables (`auth.x`) に入れる / **実物の形の検査**: `supabase/baseline/prod_schema.sql` (同じ CLI 2.62.10 の `db dump --linked` の実物。prod-schema-snapshot.yml が更新する) を scanSchemaSql に掛けると public_tables が空でなく、その数がファイルの `CREATE TABLE IF NOT EXISTS "public".` と `CREATE UNLOGGED TABLE "public".` で始まる行の数 (startsWith で別に数えた値) と同じ・同じファイルに `CREATE TABLE public.` で始まる行と `--` で始まる行が無い (CLI の出力の形が §4.3 の表のままであること) / verifyDumpFiles: schema の表の集合と `COPY "public".` の集合が同じで ok と dumped {public_tables, auth_users (`COPY "auth"."users"` の行数), audit_rows} / 1 表少ないと dump_incomplete {expected, actual} / 数は同じで名前が違う (片方に無い表) と落ちる / complete_trailer_seen が false で落ちる / statements_after_trailer が [] (RESET ALL; が無い) で落ちる / 完了行の後に `RESET ALL;` 以外の文 (例 `SET x = 1;`) があると落ちる / unterminated_copy があると落ちる / auth.users・admin_audit_logs の COPY が無いと落ちる / schema の表も COPY の表も 0 (形が変わって何も拾えない) で落ちる / 空のファイルで落ちる / unexpected_copy_tables が 1 つ (`cron.job`) で落ち expected 0・actual 1 / non_public_tables が 1 つで落ちる / 引数に live の stats を取らない (stats が dumped と違っても結果に影響しない) / managedTablesInDump: `auth.users`・`storage.objects` を拾い public は拾わない・重複を除く / restoreChecks: dumped と 3 つ (表・利用者・監査行) が一致で ok、どれか 1 つずれれば failed で expected / actual が DumpCounts の形 / buildResetSql: `DROP SCHEMA IF EXISTS "public" CASCADE;` → `CREATE SCHEMA "public";` → 2 つの GRANT → RESET_STORAGE_POLICIES_SQL → TRUNCATE の順・`['auth.users', 'storage.objects']` で `TRUNCATE "auth"."users", "storage"."objects" CASCADE;`・`a"b` は `"a""b"`・[] なら TRUNCATE の文が無い / countRoleRestoreErrors: `psql:/w/roles.sql:3: ERROR:  42710` 2 行と `ERROR:  42501` 1 行 → tolerated 2・others ['42501']・ERROR の行が無ければ 0 と []・NOTICE の行を数えない / parseLocalDbUrl: `supabase-local.sh env` の出力の `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` を取る・行が無い・空なら null / parseRestoreCounts: `136\|195\|261` と改行 → {136, 195, 261}・列が 2 つ・数でない・負は null / buildAuditSql: rows 2 つで 2 文・各文の action_type が backupAuditActionType の値・`decode('…', 'base64')` の中を base64 で戻すと JSON.stringify(details) と同じ・SQL の文字列に `{` と `"` が無い / backupAuditActionType と BACKUP_AUDIT_ACTION_TYPES: 6 値で `backup.daily.completed` から BACKUP_TIERS × BACKUP_AUDIT_RESULTS の順 / STAGE_DEFAULT_REASON: cleanup を除く STAGES と RESTORE_STAGES の全部にキーがあり、値が FAILURE_REASONS の中 / buildCompletedDetails: 8192 bytes を超えたら inventory → restore_check の順に落とす・超えないなら全部残す / buildFailedDetails: reason が FAILURE_REASONS の中 / classifyFailure: CommandTimeoutError → timeout・CommandFailedError → STAGE_DEFAULT_REASON[段] (link → link_failed・audit → audit_failed・restore → restore_check_failed)・TypeError → unknown / redactForLog: 24 文字以上の英数字と TOKEN/SECRET/KEY/PASSWORD の値を *** に、短い語は残す / parseArgs: run の既定 tier auto・`--result-file` は任意 (無ければ null)、restore は key と identity-file 必須、report-issue は `--result-file`・`--run-outcome`・`--run-url` 必須で `--run-outcome` が STEP_OUTCOMES の外なら UsageError、知らないオプションは UsageError / toRunReport: exitCode 0 → ok・3 → not_configured・1 → failed、failures に RunFailure (missing の名前) を写し値を写さない、warnings・audit_written を写す / parseRunReport: toRunReport の JSON を往復で同じに読む・unexpectedFailureReport の JSON も読む・null・JSON でない・schema_version 2・status が未知・failures の reason が FAILURE_REASONS の外・status ok で exit_code 1・status failed で exit_code 0・status ok で failures が 1 件 → null / planBackupIssue: ok + success → hasProblems false / failures 1 件 → 本文が BACKUP_ISSUE_MARKER で始まり層・段・reason・missing の名前・run の URL を含む / report null + outcome failure → 「結果を残さずに終わった」と outcome を含む / report null + cancelled も問題あり / ok なのに outcome failure → 「食い違う」/ warnings だけ (inventory_failed) は問題なし / status failed で failures が空 (unexpectedFailureReport) + outcome failure → 問題あり・本文に「段の失敗として記録できずに終わった」/ status not_configured → 問題あり / failures が audit の行だけで completed が [daily] → 問題あり・本文に completed の daily がある / 本文に env の値 (偽の鍵の文字列) が出ない / report-issue の入口 (偽の github): 問題ありで既存の marker の Issue が無ければ createIssue、あれば updateIssue、問題なしで既存があれば closeIssue (planIssueAction どおり) / runCli (run): deps.runBackup が reject → 結果ファイルが unexpectedFailureReport (status failed・failures []・exit_code 1・jst_date は planRun の値) で、runCli は 1 を返す・成功のときは toRunReport の中身・どちらも `<path>.tmp-<pid>` を書いてから rename (途中の失敗で path に半端なファイルが残らない)・`--result-file` が無ければ書かない・parseArgs の誤りは 2 で結果ファイルを書かない / runBackup (偽の run): 成功の段の順 (STAGES の順) と呼ぶコマンドの名前 (stats と dump の 3 回は `bash` + IMAGE_PULL_FALLBACK_SCRIPT + `--step` + `--` の後に docker / supabase、catalog は `bash -c` の psql 3 回 (カタログ・台帳・cron のジョブ) と python3、ほかは zstd / age / aws) 、audit と restore_check の psql は `bash` + `-c` + PSQL_SCRIPTS の本文 (§4.12) と、パスワード・鍵・接続先・details の JSON をコマンドラインに載せない (env で渡す) / audit: plan の全層を 1 回の psql (PSQL_SCRIPTS.audit) で書き、env に PG_URL (pooler-url + REMOTE_PG_SSLMODE_QUERY)・PGPASSWORD・PSQL_FILE があり、PSQL_FILE の中身が buildAuditSql の値 / audit の psql が 1 → failures に plan の全層の {stage audit, reason audit_failed}・completed は [daily] のまま・auditWritten false・終了 1 / audit が CommandTimeoutError → reason timeout / config の失敗のあと audit も失敗 → 終了 3 で failures に config と audit の 2 種 / dump の段で偽の run が TypeError を投げる → 全層 failed (stage dump, reason unknown)・aws を呼ばない・audit は呼ぶ・runBackup は reject しない / cleanup が失敗しても終了コードと failures は変わらない / config で止まると dump を呼ばない・audit は failed で呼ぶ・終了 3 / verify で落ちると aws を呼ばない / copy の失敗で daily は completed・weekly は failed の 2 行 / 月曜の copy の 3 回の argv が `s3 cp <work>/<base><suffix> s3://<偽の bucket>/weekly/<日付>/<base><suffix>` (+ endpoint) で、転送元が一時ディレクトリのファイル (`s3://` で始まらない)・argv に `--copy-props` が無い・続けて `s3api head-object --bucket <偽の bucket> --key weekly/<日付>/<base><suffix>` を 3 回打つ / copy の head-object の `ContentLength` が手元と違う → weekly だけ failed (stage copy, reason copy_failed)・daily は completed / copy の aws が CommandTimeoutError → weekly failed (stage copy, reason timeout) / 月曜で weekly の copy が失敗 → supabase-local.sh start を呼ばない (restore_check をしない) / 1/1 が月曜で weekly の copy だけ失敗 → restore_check を 1 回呼び、daily completed・weekly failed (stage copy)・annual completed (details に restore_check) の 3 行 / dump の偽の run が IMAGE_PULL_UNAVAILABLE_EXIT_CODE で終わる → 全層 failed (stage dump, reason image_pull_unavailable)・aws を呼ばない・終了 1 / stats が 75 → stage stats・reason image_pull_unavailable・dump を呼ばない / restore_check の supabase-local.sh start が 75 → daily completed・weekly failed (stage restore_check, reason image_pull_unavailable) / stats の `bash -c` の本文に `${SUPABASE_INTERNAL_IMAGE_REGISTRY:-<DEFAULT_IMAGE_REGISTRY>}/<PG_IMAGE_REPOSITORY>:${PG_IMAGE_TAG}` があり、argv に接続先・パスワードの値が無い (env で渡す) / **IMAGE_PULL_UNAVAILABLE_EXIT_CODE**: `bash -c '. scripts/lib/supabase-image-pull.sh; echo $SIP_EXIT_PULL_UNAVAILABLE'` の出力と同じ (tests/supabase-image-pull.test.ts の同じ it の作り)・`fs.existsSync(IMAGE_PULL_FALLBACK_SCRIPT)` / classifyFailure: stats・dump・restore_env の 75 → image_pull_unavailable、restore_check を含むほかの段の 75 は段の既定 / run の restore_check の段: `psql --version` が COMMAND_NOT_FOUND_EXIT_CODE → weekly failed (stage restore_check, reason restore_env_failed) で supabase-local.sh start を呼ばない・reset の psql が 1 → reason restore_check_failed / inventory の失敗は completed のまま終了 0 / link の失敗は audit を呼ばず終了 1 / cleanup は失敗でも呼ばれる / 監査行の details に stderr の文・接続先を含まない / aws を呼ぶすべての回 (upload・head-object・copy・inventory) の env が `awsCommandEnv(偽の env)` と同じ (AWS_ACCESS_KEY_ID が偽の BACKUP_R2_ACCESS_KEY_ID の値・AWS_SECRET_ACCESS_KEY が偽の BACKUP_R2_SECRET_ACCESS_KEY の値・AWS_CHECKSUM_ENV の 2 つ) で、argv の最後が `--endpoint-url https://<偽の account>.r2.cloudflarestorage.com --region auto`、転送の argv に `s3://<偽の BACKUP_R2_BUCKET>/daily/…` があり、argv のどこにも鍵の値が無い / inventory の argv が `s3api list-objects-v2 --bucket <bucket> --prefix <層>/ --no-paginate --query KeyCount --output text` (+ endpoint) で、標準出力の整数が InventoryCounts に入る / **awsCommandEnv**: `{ BACKUP_R2_ACCESS_KEY_ID: 'AK', BACKUP_R2_SECRET_ACCESS_KEY: 'SK', AWS_SESSION_TOKEN: 'T', AWS_PROFILE: 'p' }` → AWS_ACCESS_KEY_ID 'AK'・AWS_SECRET_ACCESS_KEY 'SK'・AWS_CHECKSUM_ENV の 2 つ・AWS_SESSION_TOKEN と AWS_PROFILE はキーがあって値が undefined / r2EndpointUrl('acc') が `https://acc.r2.cloudflarestorage.com`・r2ObjectUri('b', 'daily/x') が `s3://b/daily/x` / zstd の引数が `-<ZSTD_LEVEL>` (上書きがあればその値) / supabase の引数に `supabase@<SUPABASE_CLI_VERSION>` があり、data の回だけに `-s` `DATA_DUMP_SCHEMAS.join(',')` (= `public,auth,storage`) と DUMP_EXCLUDED_TABLES の `-x` がある / 各段の子プロセスの timeoutMs が `stageTimeoutMs(段, tuning)` (= STAGE_TIMEOUT_MINUTES[段] × MS_PER_MINUTE。dump / upload / restore_check は上書きの値、copy は upload の上書きの値。catalog の 4 つの子はどれも catalog の値、restore_check の段の子はどれも restore_check の値)。**stageTimeoutMs / restoreStageTimeoutMs / RESTORE_STAGE_TIMEOUT_MINUTES**: RESTORE_STAGE_TIMEOUT_MINUTES のキーの集合が RESTORE_STAGES と同じで、download が STAGE_TIMEOUT_MINUTES.upload・checksum が verify・decrypt が encrypt・extract が archive・restore_env / restore / restore_check が restore_check の値 / restoreStageTimeoutMs('download', {uploadTimeoutMinutes: 90, …}) が 90 × MS_PER_MINUTE・('restore', {restoreCheckTimeoutMinutes: 120, …}) が 120 × MS_PER_MINUTE・('decrypt', 既定) が STAGE_TIMEOUT_MINUTES.encrypt × MS_PER_MINUTE / stageTimeoutMs('dump', {dumpTimeoutMinutes: 240, …}) が 240 × MS_PER_MINUTE・('copy', {uploadTimeoutMinutes: 90, …}) が 90 × MS_PER_MINUTE・('audit', 既定) が STAGE_TIMEOUT_MINUTES.audit × MS_PER_MINUTE / STAGE_TIMEOUT_MINUTES.copy が STAGE_TIMEOUT_MINUTES.upload と同じ。**buildManifest**: schema_version が MANIFEST_SCHEMA_VERSION・`files` の sha256 は `.tar.zst.age` の行だけが文字列でほかは null・age_recipient と excluded_tables・data_schemas・source・dumped・ledger・cron_jobs を写す・引数に無いキーを足さない。**catalog の段 (偽の run)**: 段の順が dump → catalog → verify・カタログの psql が `bash -c PSQL_SCRIPTS.catalog` で cwd が `<work>/catalog`、env の PSQL_FILE が CATALOG_SNAPSHOT_SQL の絶対パス、PG_URL が pooler-url + REMOTE_PG_SSLMODE_QUERY、PGPASSWORD がある・台帳の psql が `PSQL_SCRIPTS.count` の本文で stdoutFile が `<work>/ledger.txt`、PSQL_FILE の中身が LEDGER_VERSIONS_SQL・cron のジョブの psql が `PSQL_SCRIPTS.count` の本文で stdoutFile が `<work>/cron_jobs.sql`、PSQL_FILE の中身が CRON_JOBS_SQL・python3 の argv が [RESTORE_FIXUPS_BUILDER_SCRIPT, `<work>/catalog`, `<work>/schema.sql`, `<work>/fixups.sql`] / cron のジョブの psql が 1 → catalog_failed / カタログの psql が 1 → 全層 failed (stage catalog, reason catalog_failed)・aws を呼ばない・audit は呼ぶ・終了 1 / python3 が COMMAND_NOT_FOUND_EXIT_CODE → catalog_failed / 偽の catalog が CSV を 1 つ書かない → catalog_failed (子プロセスは 0) / tar の引数の名前が ARCHIVE_ENTRIES の順 / manifest の ledger が偽の ledger.txt の版の数と最大・manifest の cron_jobs が偽の cron_jobs.sql のジョブの数。**checkCatalogCapture**: 7 つの CSV が 1 行以上・台帳 2 版・cron_jobs.sql が 2 ジョブ + 比べる 1 行・fixups 1 byte 以上で ok と ledger {2, 最大}・cron_jobs 2 / cron_jobs.sql が比べる 1 行だけ (ジョブ 0 本) でも ok で cron_jobs 0 / cronJobsText が parseCronJobsSql で null (空・比べる行が無い) → catalog_failed / CSV の 1 つが null・0 行 → catalog_failed / 台帳が空・14 桁でない行・同じ版が 2 回 → catalog_failed / fixupsBytes 0 → catalog_failed。**parseCronJobsSql**: `SELECT cron.schedule_in_database('a', '5 * * * *', …);` と `…('b''c', …);` と `DO $cron_check$ BEGIN … END $cron_check$;` の 3 行 → ['a', "b'c"] (空の行は無視) / 比べる行だけ → [] / 比べる行が無い・最後でない・`(E'a\\b', …)` の行・`(NULL, …)` の行・知らない行がある・同じ名前が 2 回 → null。**cronJobsChecks**: 2 ジョブのファイルと expected 2 → ok で cron_jobs 2 / expected 3 → failed で expected 3・actual 2 / 読めないファイル → failed で actual null。**CRON_JOBS_SQL**: `SELECT` で始まり `FROM cron.job` と `cron.schedule_in_database` と CRON_CHECK_LINE_PREFIX の `DO $cron_check$` を含み、`INSERT`・`UPDATE`・`DELETE`・`cron.unschedule` を含まない (読むだけ)。**parseLedgerVersions**: `20251126124224\n20261016230000\n` → 2 つ (末尾の空の行は無視) / 空・`2025`・逆順・重複 → null。**ledgerChecks**: 数と最大が同じで全部の版に `<版>_x.sql` がある → ok / 数が違う・最大が違う → failed で expected / actual / ファイル名が `<版>_x.sql.bak` だけ・ファイルが無い → failed で versions_without_files にその版。**parseCatalogVerifySummary**: `[warn] …` の行の後の `[verify] errors=0 warnings=3` → {0, 3} / 要約の行が無い → null / 2 つあれば最後。**CATALOG_CSV_FILES**: `scripts/baseline/snapshot_catalog.sql` を読み、`TO '<名前>'` の名前の並びと同じ (ファイルを変えたらここが赤くなる)。**補いの SQL の golden**: `python3 scripts/baseline/build_restore_fixups.py supabase/baseline/catalog supabase/baseline/prod_schema.sql <tmp>/fixups.sql` (spawnSync) が 0 で、出力が `supabase/baseline/prod_function_acl.sql`・`prod_table_acl.sql`・`prod_storage.sql` をこの順につないだものとバイト単位で同じ (ローカルのベースラインと同じ作り方であることの機械検査。ベースラインを取り直すと 3 つのファイルとカタログが一緒に変わるので、ずれない)・実行の後も `supabase/baseline/catalog/` のファイルの集合が変わらない (prod_schema.sql を足さない)・引数が 2 つ → 2・カタログのディレクトリが無い → 1 で標準エラー出力に CSV の中身が出ない。**run の restore_check の段 (偽の run)**: 子プロセスの順が `psql --version` → `python3 --version` → supabase-local.sh start → env → reset → roles → restore → fixups (reset の本文で PSQL_FILE が `fixups.sql`) → count → catalog (cwd が `<work>/restored-catalog`) → python3 [CATALOG_VERIFY_SCRIPT, `<work>/catalog`, `<work>/restored-catalog`] / reset.sql に RESET_STORAGE_POLICIES_SQL がある / fixups の psql が 1 → weekly failed (stage restore_check, reason restore_check_failed) / verify_baseline が 1 (stdout `[verify] errors=2 warnings=0`) → restore_check_failed で RestoreCheckResult の catalog_errors 2 / verify_baseline が 0 でも要約の行が無い → restore_check_failed / 偽の ledger.txt に `19990101000000` (ファイルが無い版) → restore_check_failed / 偽の cron_jobs.sql のジョブの数が manifest の cron_jobs と違う → restore_check_failed・cron_jobs.sql を psql に渡す呼び出しが無い (ローカルに流さない) / python3 の `--version` が COMMAND_NOT_FOUND_EXIT_CODE → restore_env_failed で supabase-local.sh start を呼ばない / ログに verify_baseline.py の `[error]`・`[warn]` の行が無く、`[verify]` の要約の数だけ / 合格のとき completed の details の restore_check に catalog_errors 0・catalog_warnings・ledger_versions・cron_jobs がある。**runBackup の dumped**: completed の details の public_tables / auth_users が verify の dumped の値 (stats の値ではない)・restore_check が manifest の dumped と比べる (偽の stats を 1 ずらしても passed)。**結果ファイルの定数**: RUN_STEP_TIMEOUT_MINUTES が JOB_TIMEOUT_MINUTES − REPORT_STEP_RESERVE_MINUTES で正。**checkRestoreConfig**: RESTORE_REQUIRED_ENV_NAMES の 4 つがそろえば ok で tuning が既定 / 無い・空の名前だけが missing (値を含まない) / `BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES=0` → missing にその名前 / BACKUP_AGE_RECIPIENT を見ない。**resolveRunTuning / checkConfig**: 上書き無し → 既定 (dump 120・upload 60・restore_check 60・zstd 6) / `BACKUP_DUMP_TIMEOUT_MINUTES=240` → 240 / 0・301 (JOB_TIMEOUT_MINUTES 超)・`1.5`・`abc` → invalid に名前 / `BACKUP_ZSTD_LEVEL=20` → invalid / checkConfig は invalid の名前を missing に入れる (値は入れない)。**R2 の設定の機械検査**: `LOCK_MAX_AGE_SECONDS[t] === RETENTION_DAYS[t] * SECONDS_PER_DAY` (3 層) / buildR2LifecycleConfig が §4.5 の JSON と同じ (`rules` の 4 ルール。どれも `enabled: true`・condition の type は `Age`。daily は deleteObjectsTransition だけ、weekly / annual は storageClassTransitions の maxAge が INFREQUENT_ACCESS_AFTER_DAYS × SECONDS_PER_DAY で storageClass が `InfrequentAccess`、deleteObjectsTransition の maxAge が LOCK_MAX_AGE_SECONDS[t]、abort-multipart は conditions が {} で abortMultipartUploadsTransition の maxAge が R2_ABORT_MULTIPART_AFTER_DAYS × SECONDS_PER_DAY) / 各層の deleteObjectsTransition.condition.maxAge と、buildR2LockCommands の `--retention-days` × SECONDS_PER_DAY が同じ値 / storageClassTransitions の maxAge が deleteObjectsTransition の maxAge より小さい / JSON.stringify(buildR2LifecycleConfig()) に S3 の形のキー (`Rules`・`Expiration`・`Transitions`・`STANDARD_IA`・`Days`) が無い / lock の名前が `<層>-<日数>d` で一意。**restoreFromArchive** (偽の run): 成功の段の順が RESTORE_STAGES の順 (config から) で、終了 0・checks (cron_jobs を含む) を返し、スタックの stop を呼ばない / config: RESTORE_REQUIRED_ENV_NAMES のどれか 1 つ (4 通り) が無い・空 → stage config・reason not_configured・終了 3 で aws・age・supabase-local.sh を呼ばず、標準エラー出力に名前があり偽の値が無い / BACKUP_AGE_RECIPIENT が無くても config は通る / `BACKUP_UPLOAD_TIMEOUT_MINUTES=abc` → config で not_configured・終了 3 / download の aws の 3 回の env が `awsCommandEnv(偽の env)` と同じで、argv が `s3 cp s3://<偽の bucket>/<キー> <一時ディレクトリ>/<名前> --endpoint-url https://<偽の account>.r2.cloudflarestorage.com --region auto`、argv に鍵の値が無い / 各子プロセスの timeoutMs が restoreStageTimeoutMs(段, tuning) (`BACKUP_UPLOAD_TIMEOUT_MINUTES=90` で download の 3 回が 90 × MS_PER_MINUTE、`BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES=120` で start と reset が 120 × MS_PER_MINUTE、age が STAGE_TIMEOUT_MINUTES.encrypt × MS_PER_MINUTE) / aws (download) が CommandTimeoutError → stage download・reason timeout・終了 1 で age を呼ばない / age が CommandTimeoutError → stage decrypt・reason timeout / `.sha256` が合わない → stage checksum・reason checksum_mismatch・終了 1 で age を呼ばない / age が非 0 → stage decrypt・reason decrypt_failed・終了 1 で supabase-local.sh を呼ばない / aws が非 0 → download_failed / zstd・tar が非 0 → extract_failed / 偽の tar が `fixups.sql` (または `cron_jobs.sql`) を出さない (ARCHIVE_ENTRIES の 1 つが無い) → extract_failed で supabase-local.sh を呼ばない / 書庫の cron_jobs.sql のジョブの数が manifest の cron_jobs と違う → stage restore_check・reason restore_check_failed / restoreChecks が合わない → restore_check_failed / supabase-local.sh start が 75 → stage restore_env・reason image_pull_unavailable / `psql --version` が COMMAND_NOT_FOUND_EXIT_CODE → stage restore_env・reason restore_env_failed で supabase-local.sh を呼ばない / 子プロセスの順が `psql --version` → `python3 --version` → start → env → reset → roles → restore → fixups → count → catalog (restored-catalog) → python3 verify_baseline.py [書庫の `catalog`, `restored-catalog`] (§4.8・§4.12) で、roles の呼び出しに stderrFile がある / verify_baseline が 1 → stage restore_check・reason restore_check_failed で、標準出力に `[error]` の行を出す (手元なので) / 書庫の ledger.txt に manifest の ledger と違う数 → restore_check_failed / fixups の psql が 1 → stage restore・reason restore_check_failed で count を呼ばない / roles の stderr が 42710 だけ → 通る・42501 がある → stage restore・reason restore_check_failed で restore の psql を呼ばない / count の出力が読めない → restore_check_failed / 失敗でも一時ディレクトリを消す / identity のパスを標準出力・ログに出さない。**siblingKeys / verifyChecksum**: `daily/2026-10-13/<base>.tar.zst.age` → 3 つのキー / `.sha256` で終わる・接頭辞が違う → null / sha256sum の出力 (2 つの空白・`*` 付き) を読み、大文字小文字を区別せず比べる / 合わないと先頭 8 文字の両方を返す。**parseArgs**: `r2-config` は `--bucket` と `--out-dir` 必須 / restore の `--key` が siblingKeys で null なら UsageError / restore・roundtrip-local の `--slot` を省くと LOCAL_SLOT_DEFAULT・`--slot 0` と `--slot 9` は通る・`-1`・`10`・`1.5`・`a`・値の無い `--slot` は UsageError (runCli は 2)・run に `--slot` を渡すと UsageError / LOCAL_SLOT_MAX が `slotMaxOf(process.cwd())` (`./helpers/local-ci-slot-values` の既存の関数) と同じ・LOCAL_SLOT_ENV が `LOCAL_CI_SLOT` で `scripts/supabase-local.sh` の本文に `LOCAL_CI_SLOT:-0` がある / restoreFromArchive (偽の run) に slot 3 を渡すと、supabase-local.sh の start と env の呼び出しの env に `LOCAL_CI_SLOT: '3'` がある・runBackup の restore_check の呼び出しは `'0'`。**runIdentityFromEnv**: 3 つがそろえばその値 (run_attempt は数) / 無い・空 → `local`・0・`unknown` / GITHUB_RUN_ATTEMPT が `0`・`x` → 0 / runBackup の監査行の details の run_id・run_attempt・git_sha がこの関数の値。**runCli (report-issue)**: env に GITHUB_REPOSITORY が無い → 2 で偽の github を呼ばない / 偽の github の createIssue・updateIssue・closeIssue・listOpenIssues がそれぞれ投げる 4 通り → 1 で、標準エラー出力に操作の名前があり、例外の文の 24 文字以上の英数字の連なりが `***` に伏せてある・投げた操作より後の操作を呼ばない。**auth・storage の表のアプリのトリガー (§3.3 の (6))**: parseCsv が引用符の中の `,`・改行・`""` を扱い、閉じない引用符・引用符の後ろの文字は null / triggerFunctionSchema・isAppTrigger: `storage.`・`auth.` の関数は内部、スキーマ無し・`public.`・ほかのスキーマ (引用符つきを含む) はアプリ、WHEN の中の文字列の `EXECUTE FUNCTION` に惑わされない、形が違えば undefined / parseTriggerCatalog: origin/main のベースラインの 4 行はどれも内部・見出し・列の数・定義の形・key の重なりが違えば null / appTriggerChecks: 同じなら ok (アプリ 4 本)・1 本無い → missing・取得の時点に無いものが復元した DB にある → extra・定義が違う → differs・読めない → unreadable (どれも restore_check_failed)・内部のトリガーだけの差は ok で internal_differences / build_restore_fixups.py (python3 を起こす): #1757 の 4 本があるカタログで、出力が 3 つの SQL をつないだ golden で始まり、その後ろに search_path の 1 行と 4 つの DO (内部の 4 本は作らない)・アプリのトリガーが無いカタログでは golden と同じ・引用符を含む定義は `''`・定義の形の誤り / DO の目印 / 見出しの誤りは 1 で中身を出さない / Python と JS の `INTERNAL_TRIGGER_FUNCTION_SCHEMAS`・`TRIGGER_CSV_COLUMNS`・CSV の名前・`TRIGGER_DEFINITION_PATTERN` が同じ / 掃除: `supabase/migrations` が auth・storage の表に作る `CREATE TRIGGER` はどれも isAppTrigger が true で、#1757 の 4 本が見つかる / runBackup の restore_check: 復元した DB のトリガーの CSV で 1 本足りない・CSV が無い → weekly が restore_check_failed で、足りない名前をログに出す・内部のトリガーだけの差は passed で名前をログに出す・成功はアプリのトリガーの本数をログに出す / restoreFromArchive: 1 本足りない → restore_check の段の restore_check_failed |
| `tests/db-backup-workflow.test.ts` (YAML の契約。`import yaml from 'js-yaml'`) | A | schedule が `23 17 * * *` (BACKUP_SCHEDULE_CRON_UTC と同じ) と workflow_dispatch の tier の choices が auto + BACKUP_TIERS / permissions が contents: read・issues: write だけ / ワークフロー直下 (トップレベル) に `concurrency` が無い / `jobs.backup.concurrency` が {group: BACKUP_CONCURRENCY_GROUP, cancel-in-progress: false} / `jobs.roundtrip-check.concurrency` が {group: ROUNDTRIP_CONCURRENCY_GROUP (`${{ github.ref }}` を含み BACKUP_CONCURRENCY_GROUP と違う), cancel-in-progress: true} / roundtrip-check job の timeout-minutes が ROUNDTRIP_JOB_TIMEOUT_MINUTES で、step の名前の並びが §4.11 のとおり (Checkout repository → Setup Node.js → Roundtrip (local) → Stop local Supabase)、Roundtrip の run の文に `roundtrip-local` があり、Stop が `if: always()` / backup job の timeout-minutes が JOB_TIMEOUT_MINUTES / 本番へ書くコマンド (`db push`・`migration repair`・`db reset`・`apply_migration`) を含まない / `supabase@` の版がすべて SUPABASE_CLI_VERSION / secrets の名前が REQUIRED_SECRET_NAMES + SUPABASE_ACCESS_TOKEN・SUPABASE_DB_PASSWORD・GITHUB_TOKEN だけ、variables が REQUIRED_VARIABLE_NAMES + OPTIONAL_VARIABLE_NAMES だけ / ワークフロー直下 (jobs の外) で secrets を参照しない / `age` を apt で入れ、同じ step で `age --version`・`psql --version`・`python3 --version` を打つ / Stop local Supabase が `if: always()` / ジョブ単位の `continue-on-error` が無い / backup job の step の名前の並びが §4.11 のとおり (Checkout repository → Setup Node.js → Install age and check tools → Run backup → Stop local Supabase → Report (Issue)) / Run backup の `id` が `run`、`timeout-minutes` が RUN_STEP_TIMEOUT_MINUTES、run の文に `--result-file "$RUNNER_TEMP/<RUN_REPORT_FILE_NAME>"` があり `${{ inputs.` を含まない (入力は env の TIER_INPUT) / Report (Issue) の `if` が `always()`、run の文が `report-issue` で同じ `--result-file` のパス・`--run-outcome "$RUN_OUTCOME"`・`--run-url "$RUN_URL"`、env の RUN_OUTCOME が `${{ steps.run.outcome }}`、GH_TOKEN が `${{ github.token }}` / Report の step が Run backup より後 / `on` は schedule・workflow_dispatch・pull_request (paths: scripts/backup-db.mjs・scripts/lib/backup-db.mjs・scripts/supabase-local.sh・この workflow) の 3 つ / `backup` job の `if` が `github.event_name != 'pull_request'`・`github.ref == 'refs/heads/main'`・`github.actor != 'dependabot[bot]'` の 3 つを含む (PR では動かない。3 つ目は tests/security-workflow.test.ts の BOT_GUARD と同じ文字列) / `roundtrip-check` job は secrets を参照しない (ローカルのスタックだけ) で、`if` が schedule を外す (`github.event_name != 'schedule'`) |
| `tests/backup-audit-record-migration-contract.test.ts` (SQL の文面) | A | rollback が同じ version / 名前で対 / migration の 1 行目が `-- migration: <自分のファイル名>`・2 行目が `-- 戻し方: supabase/rollbacks/<版>_backup_audit_record.down.sql`、戻し口の 1 行目が `-- rollback: <migration のファイル名>` (§5.2) / 関数は SECURITY INVOKER・`SET search_path = ''`・参照が完全修飾 / action_type の 6 値が `scripts/lib/backup-db.mjs` の BACKUP_AUDIT_ACTION_TYPES と同じ集合 (段 A の中で閉じる。core.ts との一致は段 B の core のテストが見る) / 上限 8192 が AUDIT_DETAILS_MAX_BYTES と同じ / REVOKE が完全形 (PUBLIC, anon, authenticated, service_role) で GRANT が無い / INSERT の列が actor_id, action_type, target_type, details, severity で actor_id が NULL / 既存の表・関数に触れる文が無い (CREATE OR REPLACE が 1 つ、ALTER / UPDATE / DELETE が無い) / down は DROP FUNCTION IF EXISTS だけ |
| `src/__tests__/lib/backups/core.test.ts` | B | isBackupStale: null → true / 29 時間 → false / 31 時間 → true / 形が崩れた文字列 → true / drTestRecordBodySchema: success は notes 空でよい・failed と skipped は notes 必須・quarterly_restore の success は backup_key 必須・backup_key は `daily/…` の形だけ・rto 100001 は落ちる・performed_on の 2026-02-30 は落ちる・未知の key (strict) は落ちる / toBackupStatusResponse: latest が latestByTier の取得の行 (actor_id null・target_type `database_backup`) をそのまま写す (一覧 backups が空でも annual の最新が出る = 窓によらない)・latest_dr_tests も同じ (actor_id が superAdminIds にあり target_type `dr_test`)・latest に action_type の違う行 (failed など) が渡されたら null・latestByTier.daily が actor_id のある行・target_type が `database_backup` でない行なら latest.daily が null で stale が true・latestDrTestByKind に actor_id が superAdminIds に無い行・actor_id が null の行・target_type が `dr_test` でない行が渡されたら null・backups / dr_tests は action_type の族の外の行と、上の印の合わない行を落とす・superAdminIds が [] なら dr_tests が [] で latest_dr_tests がすべて null・stale が latest.daily から決まる / isBackupAuditRow: 族の action_type・`database_backup`・actor_id null → true、actor_id がある・target_type が null か別の値・action_type が `dr.test.…` → false / isDrTestAuditRow: 族の action_type・`dr_test`・actor_id が集合の中 → true、集合の外・null・target_type が別・action_type が `backup.…` → false / DR_TEST_RECORDER_ROLE が `super_admin` / BACKUP_AUDIT_TARGET_TYPE が migration (`supabase/migrations/` の `*_backup_audit_record.sql`) の INSERT の target_type の値 `'database_backup'` と同じ (読む側の印と書く側がずれない。ファイルはテストの中で readdir して名前の末尾で探す) / backupAuditAction と BACKUP_AUDIT_ACTION_TYPES が 6 値 / DR_TEST_AUDIT_ACTIONS が `dr.test.` で始まり 3 値 / BACKUP_AUDIT_SELECT が 7 列 (`id, created_at, action_type, target_type, actor_id, severity, details`) / drTestSeverity / BACKUP_TIER_LABELS・DR_TEST_KIND_LABELS・DR_TEST_RESULT_LABELS・DR_TEST_ENVIRONMENT_LABELS・DR_TEST_SMOKE_LABELS のキーの集合がそれぞれ BACKUP_TIERS・DR_TEST_KINDS・DR_TEST_RESULTS・DR_TEST_ENVIRONMENTS・DR_TEST_SMOKE_RESULTS と同じで、値が空でない一意の文字列 / BACKUP_STALE_ALERT_COOLDOWN_MINUTES が BACKUP_FRESHNESS_CRON_INTERVAL_HOURS × 60 より小さく、1380 (= (24 − 1) × 60) / BACKUP_FRESHNESS_SCHEDULE_UTC が日 1 回の式 (分・時が数字で、日・月・曜日が `*`) で BACKUP_FRESHNESS_CRON_INTERVAL_HOURS が 24 / BACKUP_TIERS が scripts/lib/backup-db.mjs の BACKUP_TIERS と同じ並び・BACKUP_AUDIT_ACTION_TYPES が scripts/lib/backup-db.mjs の BACKUP_AUDIT_ACTION_TYPES と同じ並び (2 か所の正典のずれを見る。mjs は一番外側の import で読む) / DR_TEST_FIELDS が `Object.keys(drTestRecordBodySchema.shape)` と同じ並び / drTestRecordBodySchema の issue の文がどれも日本語 (kind 未知・performed_on 2026-02-30・backup_key `x/1`・rto 1.5 と 100001・notes 2001 字・failed で notes 空で、各 issue の message が schema に書いた文) / drTestErrorsFromResponse: `invalidInputBody(issues)` (validation-errors.ts) の形 → fields に項目ごとの最初の文・path が [] の issue は form に・details が空なら form に error.message・`invalidJsonBodyBody()` → form に「リクエストボディが不正です」・形の違う JSON (null・文字列) → form に DR_TEST_INVALID_INPUT_FALLBACK_MESSAGE / BACKUP_STALE_AFTER_HOURS が BACKUP_SCHEDULE_HOURS + BACKUP_STALE_SLACK_HOURS (vercel.json は読まない。vercel.json の行は段 C で足すので、その突き合わせは段 C の backup-freshness.test.ts の O) |
| `src/__tests__/lib/ops-alerts/recipient.test.ts` | C | 未設定・空白 → disabled / 名前つき・カンマ区切り → invalid_config / アドレス 1 つ → ok で値を返す (各 it の後に vi.unstubAllEnvs) |
| `src/__tests__/api/cron/backup-freshness.test.ts` (app-log-alerts.test.ts と同じモックの形。route はファイルの一番外側で 1 回だけ `const routeModule = await import('@/app/api/cron/backup-freshness/route');` と読み (行頭に書く)、テスト・フックの中では import しない (GET だけを公開する検査も `routeModule` を使う)。§18 の heavy-unit-test-timeout の行) | C | Authorization 無し 401・CRON_SECRET 未設定 503 (DB に触れない) / OPS_ALERT_EMAIL 未設定 → disabled で from を呼ばない / 形が違う → invalid_config / 最新が 12 時間前 → fresh・claim を呼ばない / admin_audit_logs の読み取りの連なりに `.eq('action_type', 'backup.daily.completed')`・`.eq('target_type', 'database_backup')`・`.is('actor_id', null)` がある (S-23。actor のある偽の行で fresh にしない) / 行が無い → claim → sendEmail → stale_sent / claim の引数が `{ p_alert_key: 'backup_stale', p_cooldown_minutes: BACKUP_STALE_ALERT_COOLDOWN_MINUTES }` で、その値が 1440 より小さい (翌日の回の境界: 前回から 23 時間 59 分 59 秒でも権利が取れる側にある) / claim が NULL → stale_deduped・送らない / sendEmail が { ok: false, skipped } → release を呼び stale_send_skipped / sendEmail が { ok: false } で error.code が suppressed・invalid_envelope → release を呼ばず stale_send_failed (S-8。#1577 の 8)・outbox_failed・not_configured・validation_error → release を呼ぶ (S-9) / sendEmail が例外 → release して 500 / sendEmail が { ok: false } で release が error を返す → warn ログで stale_send_failed の 200 のまま・release が例外を投げる → 同じく 200 のまま (例外を外へ出さない。§8.3) / DB の失敗 → 500 で本文は汎用 / メールの本文に宛先・利用者の情報が無い / (延命の確認は #1922 48fc47bf で外した。route が延命しないことは `src/__tests__/api/cron/cron-log-keepalive-1909.test.ts` が見張る) / O: vercel.json の crons に、path が BACKUP_FRESHNESS_CRON_PATH で schedule が BACKUP_FRESHNESS_SCHEDULE_UTC (`37 5 * * *`) の行がちょうど 1 本あり、既存の 2 本 (`/api/cron/process-menu-queue`・`/api/cron/app-log-alerts`) が残っている |
| `src/__tests__/lib/emails/ops/backup-stale.test.ts` | C | template が ops_backup_stale / 件名に時間 / 最新が null で「記録なし」/ 日本時間の表記 / 本文に `getSiteUrl()` + `/super-admin/backups` / ドメインの直書きが無い |
| `tests/super-admin-backups-route.test.ts` (本物の requireRole・recordAdminAudit。Supabase はモック。2 つの route はファイルの一番外側で読み、テスト・フックの中では import しない) | B | GET: 未ログイン 401・admin 403 (どちらも getSupabaseAdmin を呼ばない)・super_admin 200 / requireRole の後に getSupabaseAdmin の client で `from('user_profiles').select('id').contains('roles', ['super_admin'])` を 1 本 (getSupabaseAdmin の client では admin_audit_logs を読まない) / admin_audit_logs は本人の client で 8 本: 取得の最新が `.eq('action_type', <completed 3 値>)` + `.eq('target_type', 'database_backup')` + `.is('actor_id', null)` + `.limit(1)` の 3 本、訓練の最新が `.eq('action_type', <DR_TEST_AUDIT_ACTION_TYPES 3 値>)` + `.eq('target_type', 'dr_test')` + `.in('actor_id', <super_admin の id>)` + `.limit(1)` の 3 本、一覧が `.in('action_type', …)` の 2 本 (取得 6 値 + `.eq('target_type', 'database_backup')` + `.is('actor_id', null)` + `.limit(BACKUP_STATUS_LIST_LIMIT)`、訓練 3 値 + `.eq('target_type', 'dr_test')` + `.in('actor_id', <super_admin の id>)` + `.limit(DR_TEST_LIST_LIMIT)`) / select の列が BACKUP_AUDIT_SELECT と同じ文字列 / 一覧の窓に annual の行が無くても、`backup.annual.completed` の最新 1 行が `data.latest.annual` に出る / dr の一覧に annual_drill が無くても `data.latest_dr_tests.annual_drill` に出る / モックが actor_id のある daily の最新の行を返しても `data.latest.daily` が null で `stale` が true (core の見直し) / super_admin の一覧が [] → 訓練の 4 本を呼ばず、latest_dr_tests がすべて null・dr_tests が [] / super_admin の一覧の読み取りが error → 500 / 8 本のどれかが error → 500 / 行の検証に落ちる (severity が未知) → 500 / Cache-Control no-store。POST: NUL → 400 で createClient を呼ばない / 未ログイン 401 / admin 403 / JSON でない → 400 で本文が `invalidJsonBodyBody()` と同じ (`OP_INVALID_INPUT`・details []) / kind が未知 → 400 `OP_INVALID_INPUT`・message「訓練の種類を選んでください」・details[0].path が ['kind'] / failed で notes 空 → 400・message「失敗・見送りのときは理由を書いてください」・details[0].path が ['notes'] / 400 のどれも recordAdminAudit を呼ばない / 201 で recordAdminAudit が `dr.test.quarterly.restore`・target_type dr_test・severity info・details が本文と同じ・request を渡している / skipped は warn / insert の失敗で 500 と本文は汎用・201 を返さない / ip_address が x-forwarded-for の先頭 |
| `tests/super-admin-backups-page.test.tsx` | B | 鮮度 true で赤いバッジと文 (バッジの textContent に「古い」と時間がある。色だけにしない) / a11y (§7.4): form の select・input のすべてに id があり、同じ id を `htmlFor` に持つ label がちょうど 1 つある / 読み込みの 500 と送信の 400・403・500 の文が `[role="alert"]` の中に出て、成功の後は `[role="alert"]` が無い / 送信のボタンが `button[type="submit"]` / 層のカードに最新の日時 (日本時間)・latest が null で「記録なし」/ `dr-tests-latest` に種類ごとの最後の訓練 / form の kind・result・environment・smoke の option が core.ts の配列と同じ並びで、表示が `*_LABELS` の値 / form の送信で POST の本文が drTestRecordBodySchema を通る形 / 400 (本文 = `invalidInputBody(drTestRecordBodySchema.safeParse(<failed で notes 空>).error.issues)`) で `[data-testid="dr-test-field-error-notes"]` が `role="alert"` で「失敗・見送りのときは理由を書いてください」を出し、notes の入力が `aria-invalid="true"` でその要素の id を `aria-describedby` に持つ / 400 (本文 = `invalidJsonBodyBody()`) で `[data-testid="dr-test-form-error"]` に「リクエストボディが不正です」/ 201 で読み直し、項目の文が消える / 一覧に details の JSON / page.tsx の文面に `'monthly_pitr'`・`'月次 PITR 復元テスト'` などの値・ラベルの直書きが無い (core.ts から import している) |
| `src/__tests__/api/cron/app-log-alerts.test.ts` (既存。読み口の置き換えの回帰) | C | 変えない。OPS_ALERT_EMAIL を stubEnv する既存の it (未設定 → disabled・形の誤り → invalid_config・設定あり → 送る) が、`resolveOpsAlertRecipient` に替えたあとも同じ結果になることが回帰の確認 |
| 往復 (CI の job `roundtrip-check`。`node scripts/backup-db.mjs roundtrip-local`) | A | ローカルのスタックを起動 → SQL で利用者 1 人と表の行を種まき → `dumpDatabase({ dbUrl })` → scanSchemaSql / scanDataSql → verifyDumpFiles が ok (本物の `supabase db dump` の data.sql に DUMP_COMPLETE_TRAILER と最後の `RESET ALL;` があり、引用符つきの `COPY "public".` の表の集合が schema.sql の `CREATE TABLE IF NOT EXISTS "public".` の表と合うこと、`-s public,auth,storage` で cron・net の COPY が無いこと (ローカルのスタックの `cron.job` には migration が登録した行がある) を、ここで実物で確かめる。§4.3 の表と食い違えばここが赤くなる) → captureCatalog (同じローカルの DB から CSV 7 つ・ledger.txt・cron_jobs.sql・fixups.sql。checkCatalogCapture が ok で、cron_jobs がローカルの `cron.job` の行の数 (migration が登録したジョブ) と同じ) → resetForRestore (storage のポリシーも外す) → restoreDatabase (roles の 42710 は許す → restore → fixups) → countRestored → `restoreChecks(dumped, …)` が passed (表の数・auth.users 1・admin_audit_logs の行) → verifyRestoredCatalog が `[verify] errors=0` (復元の前と後の権限・ポリシー・バケットが同じ = 本物の dump と本物の `build_restore_fixups.py` の出力で、fixups.sql が流れて元に戻ることをここで確かめる) → ledgerChecks が ok (ローカルの台帳の版に全部ファイルがある) → cronJobsChecks が ok → cronDryRun (`cron_dry_run`: BEGIN → cron_jobs.sql → ROLLBACK) が 0 (本物の pg_cron 1.6 で、書庫の定義の `cron.schedule_in_database` の行と最後の名前の集合の比べが通ること。同じ DB の定義なので集合は同じ。確定しないので `cron.job` は変わらない) → 終了 0。psql は runner のもの (§4.12)。`tests/integration/` には置かない: public を落として戻す破壊的な検査で、共有のスタックで走る結合テストと同居できないため (CI の job として独立させる) |
| `tests/integration/security/backup-audit-record.test.ts` (ローカルの Supabase。関数の呼び出しは postgres-meta の `/pg/query` = postgres で実行。接続先と鍵は `process.env.NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_ANON_KEY`・`SUPABASE_SERVICE_ROLE_KEY` を読み、無ければ throw (`tests/integration/rls/ai-daily-limit-rpc.test.ts` と同じ形)。ポート付きの `localhost` / `127.0.0.1` の URL・ポートの数字を書かない (§18 の `tests/local-ci-slot-consumers.test.ts` の行)) | A | `record_backup_audit('backup.daily.completed', {...})` が行を作り actor_id NULL・severity info・target_type database_backup / `.failed` は warn / 未知の action_type・配列の details・8193 bytes は 22023 / service_role の client の `rpc('record_backup_audit')` は 42501 / anon も 42501 / authenticated の super_admin (`tests/integration/helpers/users.ts` の `createTestUserWithRoles({ roles: ['super_admin'] })` の jwt で作った client) で、関数が作った行を `.update({ severity: 'critical' }).eq('id', …)`・`.delete().eq('id', …)` → エラー無しで 0 行 (RLS の `USING (false)`)、service_role の client で読み直して行が変わっていない / postgres (`/pg/query`) では消せる (この表の不変は RLS でアプリのロールにだけ効く。§5.2。後片付けを兼ねる) |
| `tests/integration/security/backup-app-triggers.test.ts` (ローカルの Supabase。SQL は postgres-meta の `/pg/query`。接続先と鍵は `process.env.NEXT_PUBLIC_SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY` を読み、無ければ throw。ポートの数字を書かない。python3 で `build_restore_fixups.py` の `build_app_trigger_sql` を呼ぶ) | A | `snapshot_catalog.sql` と同じ照会 (search_path を `"$user", public, extensions` にして) の auth・storage の表のトリガーで、isAppTrigger が「関数のスキーマ (`pg_proc` の名前空間) が auth・storage の外か」と同じに見分け、#1757 の 4 本がアプリ / auth の 4 本がある DB では `build_app_trigger_sql` の SQL を流しても何もしない (定義はそのまま) / public の試しの表のトリガー (WHEN に `,` を含む) を消して流すと同じ定義で戻り、もう一度流しても 1 本のまま (postgres は auth の表のトリガーを DROP できないため、作り直しは public の表で確かめる) |
| `tests/backup-restore-runbook.test.ts` (段 D。`docs/operations/backup-restore.md` の文面) | D | §12 の 10 章の見出しがある / `node scripts/backup-db.mjs r2-config` と `node scripts/backup-db.mjs restore` の行がある / 6 章 (新しいプロジェクト) に `fixups.sql`・`snapshot_catalog.sql`・`verify_baseline.py`・`migration repair --status applied`・`ledger.txt`・`project-ref`・`cron_jobs.sql` の確かめがあり、6 章の本文の中の位置で、`--file fixups.sql` が `--file data.sql` より後、`migration repair` が `verify_baseline.py` より後、`--file cron_jobs.sql` が `migration repair` より後に出てくる / 6 章に `cron_jobs.sql` を流す行が 2 つ (`--single-transaction --file cron_jobs.sql` と、`PSQL_SCRIPTS.cron_dry_run` から先頭の `exec ` を除き、`"$PG_URL"` を `"$NEW_DB_URL"` に、`"$PSQL_FILE"` を `cron_jobs.sql` に替えた行) あり、6 章に `tests/helpers/migration-cron-jobs.ts` の語が無い (migration から流し直す手順に戻さない) / 6 章の (1) の aws の行が `env -u AWS_SESSION_TOKEN -u AWS_PROFILE`・`AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID"`・`AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY"`・AWS_CHECKSUM_ENV の 2 つ (`名前=値`)・`--endpoint-url "https://$BACKUP_R2_ACCOUNT_ID.r2.cloudflarestorage.com"`・`--region auto` を含む / 5 章に RESTORE_REQUIRED_ENV_NAMES の 4 つの名前がある / 接続先の値 (`postgres://`・`postgresql://` で始まる文字列) を書いていない / Lifecycle の JSON (`"deleteObjectsTransition"`・`"storageClassTransitions"`・`"maxAge"`) と `--retention-days <数字>` を写していない (r2-config の出力を正とする。§4.5) / secrets と variables の名前が REQUIRED_SECRET_NAMES・REQUIRED_VARIABLE_NAMES・OPTIONAL_VARIABLE_NAMES と同じ集合 |
| 既存の番兵の更新 | §18 の段の列 | §18 の各行 |

- 段の列の規則: テストの it の 1 つ 1 つが読む新設のファイル・行は、その段か前の段で作るものだけにする (段内レビューの時点で緑にできる)。後の段で足すもの (例: 段 C の `vercel.json` の行) を見る it は、その段のテストに置く (`vercel.json` の行の突き合わせは、段 B の core のテストではなく段 C の `backup-freshness.test.ts` の O)。段ごとの「触るファイル」は §16。
- `js-yaml` は package.json の直接の依存ではないが、`node_modules/js-yaml` (package-lock の最上位) に入っていて、既存の 7 ファイル (`tests/security-workflow.test.ts`・`tests/consistency-check.test.ts`・`tests/edge-function-dep-pinning.test.ts`・`tests/edge-function-deploy-use-api.test.ts`・`tests/edge-functions-prune.test.ts`・`tests/supabase-image-pull.test.ts`・`tests/helpers/maestro-flow-testids.ts`) が同じ `import yaml from 'js-yaml'` をしている。本設計は依存を足さず、この前例に従う (package.json は触らない)。
- 横断ルール F の a11y (`@axe-core/playwright`・CI 必須) は、origin/main の package.json に依存が無く、使う spec も CI のジョブも無い (2026-10-16 に確かめた。設計書の記述だけがある)。本設計は依存と CI のジョブを足さず (範囲の外)、新しい画面 `/super-admin/backups` の a11y は `tests/super-admin-backups-page.test.tsx` の構造の検査 (label と id の対・`role="alert"`・文で伝えるバッジ・submit のボタン。§7.4) で受け持つ。axe を入れるときにこの画面を対象に入れることは §19・§21 に置く。

---

## 16. 段分け (実装 WF は 1 本・同じ worktree。段ごとに 2 枚レビューを閉じる)

| 段 | 中身 | 触るファイル |
|---|---|---|
| A: 取得と記録 | `scripts/backup-db.mjs`・`scripts/lib/backup-db.mjs`・`scripts/baseline/build_restore_fixups.py` (§5.5。既存の `scripts/baseline` の 3 本は変えない)・`.github/workflows/db-backup.yml` (backup job + roundtrip-check job)・migration + down・database.types.ts (両方) の作り直し・`tests/backup-db.test.ts`・`tests/db-backup-workflow.test.ts`・`tests/backup-audit-record-migration-contract.test.ts`・`tests/integration/security/backup-audit-record.test.ts`・`tests/integration/security/backup-app-triggers.test.ts`・§18 の段 A の番兵 (変えるのは `tests/local-ci-workflow-sync.test.ts` の EXCLUDED_WORKFLOWS の 1 行だけ) | scripts/backup-db.mjs、scripts/lib/backup-db.mjs、scripts/baseline/build_restore_fixups.py、.github/workflows/db-backup.yml、supabase/migrations/<新>、supabase/rollbacks/<新>、src/types/database.types.ts、packages/shared/src/database.types.ts、tests/backup-db.test.ts、tests/db-backup-workflow.test.ts、tests/backup-audit-record-migration-contract.test.ts、tests/integration/security/backup-audit-record.test.ts、tests/integration/security/backup-app-triggers.test.ts、tests/local-ci-workflow-sync.test.ts (package.json は触らない。§15 の js-yaml の注) |
| B: 運営の API と画面 | `src/lib/backups/core.ts`・`src/app/api/super-admin/backups/route.ts`・`.../dr-tests/route.ts`・`src/app/super-admin/backups/page.tsx`・layout の nav・§18 の段 B の番兵・route / page / core のテスト | src/lib/backups/core.ts、src/app/api/super-admin/backups/route.ts、src/app/api/super-admin/backups/dr-tests/route.ts、src/app/super-admin/backups/page.tsx、src/app/super-admin/layout.tsx、src/__tests__/lib/backups/core.test.ts、tests/super-admin-backups-route.test.ts、tests/super-admin-backups-page.test.tsx、src/__tests__/api/null-character-routes.test.ts (ENTRIES の 1 行)、tests/admin-mutation-audit-coverage-1571.test.ts (EXPECTED の 1 行) |
| C: 鮮度の cron | `src/lib/ops-alerts/recipient.ts`・`app-log-alerts/route.ts` の読み口の置き換え・`src/app/api/cron/backup-freshness/route.ts`・`src/lib/emails/ops/backup-stale.ts`・`vercel.json`・`src/lib/env.ts` の readOnlyBy・`.env.example` の注記・`operator/08-cron-batches.md` の §3.0・§3.2 (注記と表の 2 行)・§5 の注記の 4 か所と、§3.0 の「過去の migration で登録されたジョブ」の文の後ろの 1 文 (§19。cron のジョブの定義が書庫に入ること) (専権 PATCH。§18 の 2 行目の逐語の文。`tests/log-cleanup-dau-snapshot-contract.test.ts` の「#1125 設計書の『いま』の記述」の 2 つの it が赤になるため同じ PR。並行の案件が先に cron を足していれば §18.1 の並行の規則)・`ENV_SETUP.md` と `operator/10` の Vercel Cron の列挙 (§19 の段 C の行)・§18 の段 C の番兵・テスト | src/lib/ops-alerts/recipient.ts、src/app/api/cron/app-log-alerts/route.ts、src/app/api/cron/backup-freshness/route.ts、src/lib/emails/ops/backup-stale.ts、vercel.json、src/lib/env.ts、.env.example、docs/design/operator/08-cron-batches.md、src/__tests__/lib/ops-alerts/recipient.test.ts、src/__tests__/api/cron/backup-freshness.test.ts、src/__tests__/lib/emails/ops/backup-stale.test.ts、tests/email-send-throttle-contract.test.ts (EXEMPT_EMAIL_SENDERS の 1 行。この map はこのテストファイルの中にある)、src/__tests__/lib/env.test.ts (readOnlyBy の 1 行)、tests/ai-usage-contract.test.ts (CRON_ENTRYPOINTS のコメントと 1 行。§18)、ENV_SETUP.md (`CRON_SECRET` の行の列挙と `OPS_ALERT_EMAIL` の節の 1 文。§19)、docs/design/operator/10-logs-and-mail-retry.md (§2 の Vercel Cron の 1 文。§19) |
| D: 文書 | `docs/operations/backup-restore.md` (§12)・`tests/backup-restore-runbook.test.ts`・`ENV_SETUP.md` の secrets の節・§19 の追随のうち「実装のマージと同日」のもの | docs/operations/backup-restore.md、tests/backup-restore-runbook.test.ts、ENV_SETUP.md、docs/operations/ci-supabase-image-pull.md (§19 の 2 行)、supabase/baseline/README.md (§19 の 1 行。ほかの baseline のファイルは触らない)、§19 の「実装のマージと同日」の行の docs/design/** |
| 横断 | ローカル CI 4 段が緑・2 回連続で全件緑・`roundtrip-check` が緑 | — |

オーナーの作業 (段ではない。A のマージの前後どちらでもよいが、最初の取得の前に要る): R2 のバケット・Lifecycle・lock・トークン、age の鍵対、GitHub の secrets / variables、migration の本番適用 (追加だけ: 関数 1 つ)。

---

## 17. 新設一覧

| 種別 | 名前 |
|---|---|
| workflow | `.github/workflows/db-backup.yml` (jobs: `backup`, `roundtrip-check`) |
| scripts | `scripts/backup-db.mjs` (入口。直接動かしたときだけ `process.exitCode = await runCli(process.argv.slice(2))`。サブコマンドは `run` / `restore` / `roundtrip-local` / `report-issue` / `r2-config` / `--help`)、`scripts/lib/backup-db.mjs` (§5.1 の export 全部。`RESTORE_FIXUPS_FILE`・`CRON_JOBS_FILE`・`CRON_JOBS_SQL`・`CRON_SCHEDULE_LINE_PATTERN`・`CRON_CHECK_LINE_PREFIX`・`parseCronJobsSql`・`cronJobsChecks`・`R2_ENDPOINT_HOST_SUFFIX`・`r2EndpointUrl`・`r2ObjectUri`・`awsCommandEnv`・`RESTORE_REQUIRED_ENV_NAMES`・`checkRestoreConfig`・`MS_PER_MINUTE`・`stageTimeoutMs`・`restoreStageTimeoutMs`・`RESTORE_STAGE_TIMEOUT_MINUTES`・`LEDGER_FILE`・`CATALOG_DIR`・`RESTORED_CATALOG_DIR`・`ARCHIVE_ENTRIES`・`CATALOG_SNAPSHOT_SQL`・`CATALOG_CSV_FILES`・`CatalogCsvFile`・`RESTORE_FIXUPS_BUILDER_SCRIPT`・`CATALOG_VERIFY_SCRIPT`・`PYTHON_COMMAND`・`CATALOG_VERIFY_SUMMARY_LINE`・`LEDGER_VERSIONS_SQL`・`LEDGER_VERSION_PATTERN`・`MIGRATIONS_DIR`・`RESET_STORAGE_POLICIES_SQL`・`LedgerSummary`・`parseLedgerVersions`・`checkCatalogCapture`・`parseCatalogVerifySummary`・`ledgerChecks`・`RESTORE_STAGES`・`RUN_TUNING_ENV`・`OPTIONAL_VARIABLE_NAMES`・`resolveRunTuning`・`siblingKeys`・`verifyChecksum`・`buildR2LifecycleConfig`・`buildR2LockCommands`・`REPORT_STEP_RESERVE_MINUTES`・`RUN_STEP_TIMEOUT_MINUTES`・`RUN_REPORT_FILE_NAME`・`RUN_REPORT_SCHEMA_VERSION`・`STEP_OUTCOMES`・`DUMP_COMPLETE_TRAILER`・`DATA_DUMP_FINAL_LINE`・`COPY_END_LINE`・`SCHEMA_TABLE_LINE_PATTERN`・`PARTITION_BY_LINE_PREFIX`・`DATA_COPY_LINE_PATTERN`・`parseCopyLine`・`parseSchemaTableLine`・`ROUNDTRIP_JOB_TIMEOUT_MINUTES`・`BACKUP_CONCURRENCY_GROUP`・`ROUNDTRIP_CONCURRENCY_GROUP`・`LOCAL_SLOT_DEFAULT`・`LOCAL_SLOT_MIN`・`LOCAL_SLOT_MAX`・`LOCAL_SLOT_ENV`・`RUN_ID_OUTSIDE_ACTIONS`・`RUN_ATTEMPT_OUTSIDE_ACTIONS`・`GIT_SHA_OUTSIDE_ACTIONS`・`runIdentityFromEnv`・`R2LifecycleAgeCondition`・`R2LifecycleRule`・`DumpCounts`・`DataSqlScan`・`SchemaSqlScan`・`RunFailure`・`BackupRunReport`・`scanDataSql`・`scanSchemaSql`・`toRunReport`・`parseRunReport`・`planBackupIssue`・`IMAGE_PULL_FALLBACK_SCRIPT`・`IMAGE_PULL_UNAVAILABLE_EXIT_CODE`・`PG_IMAGE_REPOSITORY`・`DEFAULT_IMAGE_REGISTRY`・`DATA_DUMP_SCHEMAS`・`BACKUP_AUDIT_RESULTS`・`BackupAuditResult`・`backupAuditActionType`・`BACKUP_AUDIT_ACTION_TYPES`・`PSQL_SCRIPTS`・`PsqlScriptName`・`REMOTE_PG_SSLMODE_QUERY`・`LOCAL_PG_SSLMODE_QUERY`・`ROLES_TOLERATED_SQLSTATE`・`PSQL_SQLSTATE_ERROR_LINE`・`RESTORE_COUNT_SQL`・`STAGE_DEFAULT_REASON`・`COMMAND_NOT_FOUND_EXIT_CODE`・`CommandFailedError`・`CommandTimeoutError`・`unexpectedFailureReport`・`buildResetSql`・`countRoleRestoreErrors`・`parseLocalDbUrl`・`parseRestoreCounts`・`AuditRow`・`buildAuditSql`・`BackupIssueGitHub`・`CliDeps`・`runCli` を含む。FAILURE_REASONS に `image_pull_unavailable`・`catalog_failed`、STAGES と STAGE_TIMEOUT_MINUTES と STAGE_DEFAULT_REASON に `catalog`、RESTORE_STAGES に `config`、PSQL_SCRIPTS に `catalog`・`cron_dry_run`、BackupManifest に `cron_jobs`、RestoreCheckResult に `cron_jobs`。内部の関数 (export しない): `restoreDatabase`・`dumpDatabase`・`captureCatalog`・`resetForRestore`・`countRestored`・`verifyRestoredCatalog`・`cronDryRun`・`localPgUrl`)、`scripts/baseline/build_restore_fixups.py` (§5.5。`python3 <カタログ dir> <schema.sql> <出力>`。`build_baseline.py` の 3 つの関数をつなぐ。終了 0 / 1 / 2) |
| 書庫の中身 | `ARCHIVE_ENTRIES` の 7 つ (`roles.sql`・`schema.sql`・`data.sql`・`fixups.sql`・`cron_jobs.sql`・`ledger.txt`・`catalog/` の CSV 7 つ)。manifest に `ledger` (`LedgerSummary`) と `cron_jobs` |
| テスト (新設) | §15 の新しいファイル 11 本 (`tests/backup-db.test.ts`・`tests/db-backup-workflow.test.ts`・`tests/backup-audit-record-migration-contract.test.ts`・`tests/integration/security/backup-audit-record.test.ts`・`tests/integration/security/backup-app-triggers.test.ts`・`src/__tests__/lib/backups/core.test.ts`・`tests/super-admin-backups-route.test.ts`・`tests/super-admin-backups-page.test.tsx`・`src/__tests__/lib/ops-alerts/recipient.test.ts`・`src/__tests__/api/cron/backup-freshness.test.ts`・`src/__tests__/lib/emails/ops/backup-stale.test.ts`) + `tests/backup-restore-runbook.test.ts` (段 D) |
| migration | `supabase/migrations/<番号はマージ時に確定>_backup_audit_record.sql`、`supabase/rollbacks/<番号はマージ時に確定>_backup_audit_record.down.sql` |
| DB の関数 | `public.record_backup_audit(text, jsonb)` |
| lib | `src/lib/backups/core.ts` (§5.3 の export 全部。`BACKUP_FRESHNESS_CRON_INTERVAL_HOURS`・`BACKUP_STALE_ALERT_JITTER_MARGIN_HOURS`・`DR_TEST_LIST_LIMIT`・`BackupStatusSource`・`DR_TEST_ENVIRONMENT_LABELS`・`DR_TEST_SMOKE_LABELS`・`DR_TEST_FIELDS`・`DrTestField`・`drTestErrorResponseSchema`・`DR_TEST_INVALID_INPUT_FALLBACK_MESSAGE`・`DrTestFieldErrors`・`drTestErrorsFromResponse`・`DR_TEST_RECORDER_ROLE`・`isBackupAuditRow`・`isDrTestAuditRow` を含む。内部の関数 (export しない): `pickBackupRow`・`pickDrTestRow`)、`src/lib/ops-alerts/recipient.ts` (`resolveOpsAlertRecipient`, `OpsAlertRecipient`) |
| メール文面 | `src/lib/emails/ops/backup-stale.ts` (`renderBackupStaleEmail`, template `ops_backup_stale`) |
| route (運営) | `src/app/api/super-admin/backups/route.ts` (GET)、`src/app/api/super-admin/backups/dr-tests/route.ts` (POST) |
| route (cron) | `src/app/api/cron/backup-freshness/route.ts` (GET)。`vercel.json` に `{ "path": "/api/cron/backup-freshness", "schedule": "37 5 * * *" }` |
| 画面 | `src/app/super-admin/backups/page.tsx`。layout の `superAdminOperationsNavItems` に 1 行 |
| 監査 action_type | `backup.daily.completed` / `backup.daily.failed` / `backup.weekly.completed` / `backup.weekly.failed` / `backup.annual.completed` / `backup.annual.failed` (target_type `database_backup`)、`dr.test.monthly.pitr` / `dr.test.quarterly.restore` / `dr.test.annual.drill` (target_type `dr_test`) |
| ops_alert_state のキー | `backup_stale` |
| R2 | バケット `homegohan-db-backups` (variable で変えられる)、接頭辞 `daily/` `weekly/` `annual/`、Lifecycle 4 ルール、lock 3 ルール |
| GitHub の secrets / variables | §13 |
| R2 の API トークン | 取得用 (Object Read & Write。GitHub の secret) と復元用 (Object Read only。オーナーのパスワードマネージャー)。どちらもバケット `homegohan-db-backups` だけ (§4.4) |
| スクリプトが読む・渡す環境変数 (secrets / variables のほか。どれも新しく設定するものではない) | §13 の「自動で入れる」「step の env」「既存のライブラリ」「子に渡す」「オーナーの手元だけ」の 5 行 (`GITHUB_REPOSITORY`・`GITHUB_RUN_ID`・`GITHUB_RUN_ATTEMPT`・`GITHUB_SHA`・`RUNNER_TEMP`・`GH_TOKEN`・`TIER_INPUT`・`RUN_OUTCOME`・`RUN_URL`・`SUPABASE_IMAGE_REGISTRIES`・`SUPABASE_IMAGE_PULL_ROUNDS`・`SUPABASE_IMAGE_PULL_WAIT_UNIT`・`SUPABASE_INTERNAL_IMAGE_REGISTRY`・`LOCAL_CI_SLOT`・`AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY`・`NEW_DB_URL`・`restore` が手元のシェルから読む R2 の 4 つ) |
| data-testid | `backups-tier-daily` / `backups-tier-weekly` / `backups-tier-annual` / `backups-stale-badge` / `dr-tests-latest` / `dr-test-form` / `dr-test-form-error` / `dr-test-field-error-<項目>` (`<項目>` は `DR_TEST_FIELDS` の 9 つ) / `backups-list` / `dr-tests-list` |
| run → report の結果ファイル | `$RUNNER_TEMP/db-backup-result.json` (`BackupRunReport`。job の中だけ。artifact にしない) |
| 手順書 | `docs/operations/backup-restore.md` (6 章の新しいプロジェクトの接続先は、オーナーの手元の環境変数 `NEW_DB_URL`、5 章・6 章の (1) の R2 は手元のシェルの `RESTORE_REQUIRED_ENV_NAMES`。値は書かない) |
| 既存ファイルの変更 | `src/app/api/cron/app-log-alerts/route.ts` (宛先の読み口を `resolveOpsAlertRecipient` に)、`src/lib/env.ts` (`OPS_ALERT_EMAIL` の readOnlyBy を `src/lib/ops-alerts/recipient.ts` に、description に backup-freshness を足す)、`.env.example` (OPS_ALERT_EMAIL の注記に鮮度の通知)、`src/app/super-admin/layout.tsx` (nav 1 行)、`vercel.json` (cron 1 本)、`src/types/database.types.ts` と `packages/shared/src/database.types.ts` (作り直し)、`docs/design/operator/08-cron-batches.md` §3.0 / §3.2 / §5 (専権 PATCH。§18.1)、`docs/design/operator/10-logs-and-mail-retry.md` §2 の 1 文 (§19)、`ENV_SETUP.md`、番兵のテスト 6 本の 1 行ずつ (`tests/local-ci-workflow-sync.test.ts`・`src/__tests__/api/null-character-routes.test.ts`・`tests/admin-mutation-audit-coverage-1571.test.ts`・`tests/email-send-throttle-contract.test.ts`・`src/__tests__/lib/env.test.ts`・`tests/ai-usage-contract.test.ts`。§18) |

---

## 18. 既存の番兵 (契約テスト・走査テスト) の追随表

grep の語は、本設計が足す・変える名前 (tests/ と src/__tests__/ で反応するものを全列挙)。

| 番兵 | 反応する理由 (grep の語) | 直し方 | 段 |
|---|---|---|---|
| `tests/cron-secret-contract.test.ts` (CC-6: `src/app/api/cron/` 配下と `vercel.json` の crons のルートが `requireCronAuth` を `'@/lib/cron-auth'` から import して await) | 新しい route `src/app/api/cron/backup-freshness/route.ts`・`vercel.json` の `crons` | GET の最初に `const authError = await requireCronAuth(req); if (authError) return authError;`。CC-4: `CRON_SECRET` を自分で読まない | C |
| `tests/ai-usage-contract.test.ts` (「定期実行の入口の全数は CRON_ENTRYPOINTS の一覧どおり」= `scanCronEntrypoints()` が `vercel.json` の crons を `vercel:<path>` で数え、このテストファイルの中の定数 `CRON_ENTRYPOINTS` の key と toEqual。続く 2 つの it が、`vercel:` の行の route が実在し、AI 利用を記録せず (`consumeAiUsage` 0 回)、AI へ送るコードに届かないことを見る) | `vercel.json` に 3 本目 (`/api/cron/backup-freshness`) | `CRON_ENTRYPOINTS` に、`'vercel:/api/cron/app-log-alerts'` の行の次に `// #1129 DB バックアップの鮮度 (admin_audit_logs の最新の backup.daily.completed) を運用メールで知らせる。import は cron の認証・ログ・Supabase・メールだけ` のコメントと `'vercel:/api/cron/backup-freshness': 'DB バックアップが古くなったことを運用メールで知らせる (AI を使わない)',` の 1 行を足す。route は AI の SDK・Edge Function を import しない (§7.3) | C |
| `tests/ai-consent-enforcement.test.ts` (:227「Vercel の cron は、判定を呼ぶ route か、AI へ送らない route だけ」= `vercel.json` の crons の route が AI へ送るコードに届くなら `ENFORCED_ROUTES` に要る) | `vercel.json` の crons | 反応しない (確認のみ)。`backup-freshness/route.ts` は AI へ送るコードに届かないので一覧に足さない | C |
| `tests/feature-flag-cache-ttl-wiring.test.ts` (`vercel.json` に `FEATURE_FLAG_CACHE_TTL_ENV` の名前が無い) | `vercel.json` | 反応しない (確認のみ)。足すのは crons の 1 行だけ | C |
| `tests/log-cleanup-dau-snapshot-contract.test.ts` の describe「#1125 設計書の『いま』の記述が、木の実物と合っている」の 2 つの it: (a)「Vercel Cron: §3.0・§3.2 の注記・§5 の注記が vercel.json の crons をすべて挙げ、§3.0 と §3.2 の注記の本数が実数と同じ」= `vercel.json` の path の最後の部分 (`backup-freshness`。snake_case ではない) を、§3.0 (見出し〜§3.0.1)・§3.2 の `> ` 行・§5 の `> ` 行 (`## 5.` 〜 `### 5.1`) の 3 か所すべてにバッククォートつきで書き、§3.0 と §3.2 の注記の「`vercel.json` に登録されている Vercel Cron は … の N 本」の N が crons の数 / (b)「§3.2 の注記の『この表のほかの N 本』が、表の行数から実装済みの行を引いた数と同じ」= §3.2 の表の行 (縦棒とバッククォートで始まる行) の数 − 『実装済み』を含む行の数。ほかに、同じファイルの「#1125 の課金系の扱い」の it が、`#1125` を含む行に「作らない\|決めた\|新しい判断\|オーナー判断」を同居させないことを見る | `vercel.json` に 3 本目 (`backup-freshness`) | 08 の 5 か所 (§3.0 の本文・§3.2 の表の 2 行・§3.2 の注記・§5 の注記) を §18.1 の逐語の文に直す (専権 PATCH。段 C と同じ PR。ほかの文は変えない)。migration に `cron.schedule` は無いので pg_cron の数 (同じ describe の 3 つ目の it) は変わらない | C |
| `src/__tests__/api/cron/app-log-alerts.test.ts` (O-2 は自分のパスだけを filter) | `vercel.json` | 反応しない (確認のみ)。`OPS_ALERT_EMAIL` の stubEnv の it が、読み口の置き換え後も同じ結果 | C |
| `tests/env-source-scan.test.ts` (6: readOnlyBy の変数は、そのファイルだけが値を読む) | `process.env.OPS_ALERT_EMAIL` | `src/lib/env.ts` の `OPS_ALERT_EMAIL.readOnlyBy` を `'src/lib/ops-alerts/recipient.ts'` に。`app-log-alerts/route.ts` から `process.env.OPS_ALERT_EMAIL` の読み取りを消す (`resolveOpsAlertRecipient` に置き換え)。`backup-freshness/route.ts` も直接読まない。`OPS_ALERT_*THRESHOLD` / `COOLDOWN` の readOnlyBy は変えない (鮮度の cron はクールダウンを定数で持つ) | C |
| `src/__tests__/lib/env.test.ts` (:419 以降。readOnlyBy の [名前, パス] を sorted で toEqual) | `OPS_ALERT_EMAIL` の行 | `['OPS_ALERT_EMAIL', 'src/app/api/cron/app-log-alerts/route.ts']` を `['OPS_ALERT_EMAIL', 'src/lib/ops-alerts/recipient.ts']` に (並びはそのまま。コメントに「#1129 鮮度の cron と共有」を足す)。同じ it の typeOnly の `@ts-expect-error` は変えない | C |
| `tests/email-send-throttle-contract.test.ts` (`sendEmail(` を呼ぶファイルは throttle を通すか EXEMPT_EMAIL_SENDERS に理由。EXEMPT_EMAIL_SENDERS はこのテストファイルの中の定数で、別のファイルには無い) | `src/app/api/cron/backup-freshness/route.ts` の `sendEmail(` | このテストファイルの EXEMPT_EMAIL_SENDERS に、`'src/app/api/cron/app-log-alerts/route.ts'` の行の次に `'src/app/api/cron/backup-freshness/route.ts': '宛先は環境変数 OPS_ALERT_EMAIL の固定アドレス 1 つだけ (未設定なら送らない) で、利用者は宛先も本文も指定できない。CRON_SECRET の Bearer 認証 (requireCronAuth) を通った Vercel Cron からしか動かない。送信は claim_ops_alert で原子的に権利を取った 1 回だけで、同じ通知は 23 時間に 1 通まで (日 1 回の cron なので実質 1 日 1 通) に制限される。本文は日時としきい値と画面の URL だけで、利用者の情報は含めない'` を足す | C |
| `src/__tests__/lib/emails/template-names.test.ts` | `render*Email` (`renderBackupStaleEmail`) | `template: 'ops_backup_stale',` を 1 つ・snake_case・一意 | C |
| `src/__tests__/lib/emails/templates-site-config.test.ts`、`tests/site-config-guard.test.ts` | メール文面のドメイン直書き | `getSiteUrl` / `getEmailFrom` だけを使う | C |
| `tests/supabase-service-role-client-scan.test.ts` | `getSupabaseAdmin` / `createClient` | cron と、運営の GET の super_admin の一覧 (`requireRole` の後の `user_profiles` の 1 本。§7.1) は canonical の `getSupabaseAdmin`、運営 route の `admin_audit_logs` の読み書きは `createClient` (`@/lib/supabase/server`)。`@supabase/supabase-js` の createClient を import しない (この走査は createClient の import の場所を見るだけで、`getSupabaseAdmin` を呼ぶ route を数えない。確認のみ) | B, C |
| `tests/api-raw-error-message-scan.test.ts` | 応答の本文 (`NextResponse.json`) | 固定の文だけ。500 は `internalError`。Zod の 400 は `src/lib/super-admin/validation-errors.ts` の `invalidInputResponse(parsed.error.issues)` / `invalidJsonBodyResponse()` (クーポン・プランの route と同じ。issue の文は schema に書いた日本語で、DB・例外の文は入らない) | B, C |
| `tests/super-admin-400-shape-1654.test.ts` (名指しの route の一覧 `OP_INVALID_INPUT_ROUTES` / `VALIDATION_ERROR_ROUTES` を読む。readdir しない) | `@/lib/super-admin/validation-errors` | 反応しない (確認のみ)。dr-tests の POST は同じ helper で同じ形を返し、その形は `tests/super-admin-backups-route.test.ts` が見る (この一覧には足さない) | B |
| `tests/lib-raw-error-message-scan.test.ts` (src/lib のオブジェクトリテラルの値に、エラーらしい名前・`.error` の `.message` を書くと数える) | `src/lib/backups/core.ts` / `recipient.ts` の戻り値 | 許可リストは変えない。`recipient.ts` は文を返さない。core.ts の `drTestErrorsFromResponse` が返す文は API の 400 の本文 (固定の文と schema の日本語) で DB の生のエラー文ではないが、オブジェクトリテラルの値に `parsed.data.error.message` を直接書くと走査に当たるので、§5.3 の正典どおり `form.push(…)` で積んでから `{ fields, form }` を返す (正典から書き方を変えない) | B, C |
| `tests/api-internal-error-routes.test.ts`、`tests/api-internal-error-routes-stage2.test.ts` | 決まった route を固定で import | 反応しない (確認のみ) | — |
| `src/__tests__/api/null-character-routes.test.ts` (ENTRIES と、本文を読む handler の一致。`BODY_READ_PATTERN` は `request.json()` と `readJsonBody(` を本文の読み取りに数える) | `readJsonBody(request)` で本文を読む新しい handler と `rejectNullCharacterBody` | ENTRIES に `{ file: 'super-admin/backups/dr-tests/route.ts', method: 'POST', load: async () => (await import('@/app/api/super-admin/backups/dr-tests/route')).POST }` を、`super-admin/coupons/[id]/apply/route.ts` の行の前に足す。GET の 2 本 (`super-admin/backups/route.ts`・`cron/backup-freshness/route.ts`) は本文を読まず `rejectNullCharacterBody` も呼ばない | B |
| `tests/admin-mutation-audit-coverage-1571.test.ts` (EXPECTED の表と変更系 handler の一致・`recordAdminAudit` のリテラルに `request`) | `src/app/api/super-admin/backups/dr-tests/route.ts` の POST | EXPECTED に `'src/app/api/super-admin/backups/dr-tests/route.ts POST': 'audited',` を `'src/app/api/super-admin/coupons/[id]/apply/route.ts POST'` の前に足す。`recordAdminAudit` は POST の本体で呼び、オブジェクトのリテラルに `request` を書く | B |
| `tests/admin-view-audit-1326.test.ts` ((b) admin / super-admin の route で `admin_audit_logs` への直接 INSERT と `x-forwarded-for` の直接読みが無い) | `admin_audit_logs` | GET は `.select` だけ (INSERT しない)。POST は `recordAdminAudit` だけ | B |
| `tests/role-check-source-scan.test.ts` | `requireRole(` | `requireRole(['super_admin'])` だけ。`roles` の手書き判定を書かない (GET の super_admin の一覧は PostgREST の `.contains('roles', [DR_TEST_RECORDER_ROLE])` で DB に絞らせ、route で `.roles` を判定しない。この走査が数えるのは `.roles` に配列の関数を `?.` などで呼ぶ書き方と `['owner', 'admin']` の配列で、`.contains('roles', …)` は当たらない。確認のみ) | B |
| `tests/next15-async-request-api-scan.test.ts` | `createClient(` / `params` | `await createClient()`。動的な区間は無い | B, C |
| `tests/admin-console-links.test.ts` | `href="/super-admin/backups"` | page.tsx を先に作ってから layout にリンクを足す | B |
| `tests/integration/security/super-admin-logs.test.ts` (:385 の describe「#1157 /super-admin/logs (画面)」。:386 のコメントのとおり `src/app/super-admin/layout.tsx` の下で描いた HTML に `href="/super-admin/logs"` と「アプリログ」が `toContain` で含まれ、admin・一般・未認証は 307 で `/login` へ戻されることを見る) | layout の `superAdminOperationsNavItems` に 1 行 (`/super-admin/backups`) | 反応しない (確認のみ)。nav に 1 行足しても既存の項目と文言は消えず (`toContain` で見る)、layout の権限ガード (`requireRole(['super_admin'])`) は変えない。足した行の `href` は page.tsx を先に作る (上の行) ので、描画で存在しない画面を指さない | B |
| `tests/database-types-migrations-contract.test.ts` | migration の `CREATE OR REPLACE FUNCTION public.record_backup_audit` | 両方の database.types.ts をローカルの Supabase から作り直す (手順はそのテストの冒頭。`__InternalSupabase` を残す) | A |
| `tests/integration/security/anon-definer-execute.test.ts` | `SECURITY DEFINER` | 関数は SECURITY INVOKER なので対象外 (確認のみ) | A |
| `tests/helpers/migration-cron-jobs.ts` (log-cleanup の 9 が使う)、`tests/edge-function-verify-jwt.test.ts` (DB に入る SQL として `supabase/migrations`・`supabase/baseline` の `.sql` だけを readdir) | `cron.schedule` / `cron.schedule_in_database` | 反応しない (確認のみ)。本設計の migration に `cron.schedule` は無い。`cron.schedule_in_database` の文字は `scripts/lib/backup-db.mjs` の `CRON_JOBS_SQL` と手順書・書庫の `cron_jobs.sql` にだけ出て、どちらの見張りも `scripts/`・`docs/` を読まない | A |
| `tests/migration-cron-job-names.test.ts` (#1561。helper `tests/helpers/migration-cron-jobs.ts` の単体テスト。describe「いまの supabase/migrations」が `collectMigrationCronJobs(MIGRATIONS_DIR)` で全 migration を読み、名前を解けない `cron.schedule` / `cron.schedule_in_database` の呼び出しが無いこと (`unresolved` が空) と #1561 の 2 つのジョブを含むことを見る。コメントの中は数えない) | 新しい migration `<番号はマージ時に確定>_backup_audit_record.sql` | 反応しない (確認のみ)。§5.2 の migration は関数 1 つで `cron.schedule` を含まない (コメントの pg_cron の言及は数えない) ので、`names` も `unresolved` も変わらない | A |
| `tests/integration/security/select-columns-exist.test.ts` | `.from('admin_audit_logs').select(…)` の列 | 運営の GET は `admin_audit_logs` の 7 列 (`id, created_at, action_type, target_type, actor_id, severity, details`) と `user_profiles` の `id`、鮮度の cron は `admin_audit_logs` の `created_at` の 1 列。どれも実在する (`target_type`・`actor_id` は origin/main の `prod_schema.sql` の表の定義にある)。変数で渡す select は走査に見えないことがあるので、route では文字列リテラルを書き、core の `BACKUP_AUDIT_SELECT` と同じであることを route のテストで突き合わせる | B, C |
| `lib/supabase/__tests__/middleware-legal-consent-api.test.ts`、`lib/supabase/__tests__/middleware-push-token-claim-exemption.test.ts` (src/app/api の全 route を middleware に通す) | 新しい route 3 本 | 反応しない (確認のみ)。運営の 2 本は同意の許可リストに入れない (未同意 × ENFORCE=on で 403 が期待どおり)。cron の 1 本は `/api/cron/` の既存の例外 (メンテナンス中も通す) にそのまま当たる。許可リストの中身は変えない | B, C |
| `tests/jst-today-source-scan.test.ts` (規則 G: `_at` の列を `.gte` / `.lt` で絞る・規則 I: サーバーで timeZone 無しの toLocale*) | `created_at` / 日時の表示 | 反応しない (確認のみ)。鮮度の cron は `.order('created_at').limit(1)` で読み、絞り込みをしない。メールの日時は `Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo' })` (app-log-error-spike と同じ) | C |
| `tests/mobile-super-admin-api-contract.test.ts` (モバイルの (super-admin) 画面が呼ぶ API の実在。2026-10-16 に削除した。#1598) | — | 反応しない (テストもモバイルの (super-admin) の区画も削除済み。本書はモバイルの画面を足さない) | — |
| `tests/rate-limit-single-implementation.test.ts` | `@upstash/ratelimit` | 反応しない (運営の route にレート制限は付けない。super_admin だけが呼ぶ) | — |
| `tests/local-ci-next-port.test.ts`、`src/__tests__/config/turnstile-config.test.ts` (`.github/workflows` を走査) | 新しい workflow | `-p` で Next を起こす行も TURNSTILE も無い (確認のみ) | A |
| `tests/local-ci-workflow-sync.test.ts` (`WORKFLOW_DIR` を readdir し、`on` に pull_request / pull_request_target を持つワークフローは WORKFLOW_STAGES / JOB_STAGES / EXCLUDED_WORKFLOWS のちょうど 1 つに入っていること) | `db-backup.yml` は `roundtrip-check` のために `on.pull_request` を持つ | `EXCLUDED_WORKFLOWS` に `".github/workflows/db-backup.yml"` を `deploy-supabase-migrations.yml` の行の次に足す。理由の文: `"backup ジョブは本番に接続して取得する (PR では動かない)。roundtrip-check ジョブはローカルのスタックの public を落として戻す破壊的な検査で、local-ci.sh の段が使う同じ枠のスタックと同居できない。scripts/backup-db.mjs・scripts/lib/backup-db.mjs・scripts/supabase-local.sh・この workflow を変える PR は CI のこのジョブの緑を待ってからマージする (手元では node scripts/backup-db.mjs roundtrip-local --slot <空いている枠> で同じ検査を流せる)"`。WORKFLOW_STAGES / JOB_STAGES・`scripts/local-ci.sh` は変えない | A |
| `tests/security-workflow.test.ts` (`workflowFiles()` が readdir。「PR の Checks を赤く残さない」= PR で動くワークフローのジョブに job 単位の `continue-on-error` が無い / 「Dependabot の PR ではシークレットを使うジョブを動かさない」= `findUnguardedSecretJobs`: pull_request で動くワークフローで、GITHUB_TOKEN 以外の secrets を参照するジョブは `if` に `github.actor != 'dependabot[bot]'` を含む。ワークフロー直下で secrets を参照すると全ジョブが対象) | `db-backup.yml` は pull_request で動き、`backup` ジョブが `secrets.SUPABASE_*`・`secrets.BACKUP_R2_*` を参照する | テストは変えない。workflow の側で満たす: `backup` ジョブの `if` に `github.actor != 'dependabot[bot]'` を (`github.event_name != 'pull_request'` と並べて) 書く。secrets はジョブ (またはステップ) の `env` だけで参照し、ワークフロー直下の `env` に書かない。どのジョブにも job 単位の `continue-on-error` を付けない (inventory の失敗はスクリプトの中で吸収する。§4.7)。`roundtrip-check` は secrets を参照しない (GITHUB_TOKEN も要らない)。`tests/db-backup-workflow.test.ts` が同じ条件を自分でも見る (§15) | A |
| `tests/no-auto-merge-workflow.test.ts` (readdir した全ワークフローの本文に `gh pr merge`・自動マージ・`gh pr review --approve`・`claude/**` が無い) | 新しい workflow の本文 | 反応しない (確認のみ)。Issue の操作は `scripts/consistency-check.mjs` の `createGitHub` (REST) で行い、`gh pr` を書かない。`claude/**` の文字列を書かない | A |
| `tests/consistency-check.test.ts` | `scripts/lib/consistency-check.mjs` の `planIssueAction`・`scripts/consistency-check.mjs` の `createGitHub` を再利用 | 既存の関数を変えない (確認のみ)。変えたくなったら本設計の側に写す | A |
| `tests/integration-ci-coverage.test.ts` | `tests/integration/` の新しいファイル | `tests/integration/security/backup-audit-record.test.ts`・`tests/integration/security/backup-app-triggers.test.ts` は `tests/integration/security` の指定に当たる (確認のみ) | A |
| `tests/check-cron-secret-drift.test.ts` | `scripts/lib/cron-secret-drift.mjs` | 触らない (伏せ字の規則は backup-db.mjs に自前で持つ) | — |
| `tests/migration-file-version-integrity.test.ts` (#1636。`supabase/migrations` と `supabase/rollbacks` を readdir: 版の 14 桁が重ならない・1 行目の `-- migration:` / `-- rollback:` の名前が自分 (の対) のファイル名と一致・本文が案内する `supabase/rollbacks/<名>` が実在・戻し口に同じ名前の migration がある) | 新しい migration と戻し口 (`<版>_backup_audit_record.sql` / `.down.sql`) | テストは変えない。§5.2 の 1・2 行目の見出しと案内を、番号を確定するときに 5 か所そろえる。版はマージ直前に origin/main の最大より大きい 14 桁にし、ほかの migration と重ねない | A |
| `tests/heavy-unit-test-timeout.test.ts` (#1605「同じ型のファイルは時間切れを延ばしている」= tests・src・lib・packages の単体テストのうち、テスト・フックの中で `node:child_process` の関数を呼ぶ、または字下げした行で route / Edge Function を `import('…/route')` で読むファイルは、`applyHeavyUnitTestTimeout()` (一覧 `HEAVY_UNIT_TEST_FILES` のファイルだけが呼ぶ)・ファイルの `vi.setConfig(…)`・`resolveHeavyUnitTimeouts(` / `DEFAULT_UNIT_HEAVY_*` の個別の時間切れのどれかで延ばすか、例外の一覧 `SAME_TYPE_EXCEPTIONS` に載ること) | `tests/backup-db.test.ts` の it が `spawnSync('bash', ['-c', '. scripts/lib/supabase-image-pull.sh; echo $SIP_EXIT_PULL_UNAVAILABLE'])` と `spawnSync('python3', [RESTORE_FIXUPS_BUILDER_SCRIPT, …])` (補いの SQL の golden) で子プロセスを起こす | テストもヘルパーも一覧も変えない。`tests/backup-db.test.ts` の import の直後 (テスト・フックを登録する前) に `vi.setConfig(resolveHeavyUnitTimeouts(process.env));` を書く (`import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';`。テスト 30 秒・フック 60 秒。`applyHeavyUnitTestTimeout()` は一覧に足すことになるので呼ばない)。ほかの新しいテストは同じ型にしない: `src/__tests__/api/cron/backup-freshness.test.ts` と `tests/super-admin-backups-route.test.ts` は route をファイルの一番外側 (行頭) で 1 回だけ読み、テスト・フックの中で import しない (app-log-alerts.test.ts のようにテストの中で読み直すと同じ型になる)。`runCli` の report-issue のテストは偽の `github` を渡し、`gh` を起こさない。ほかの新しいテストは子プロセスを起こさない | A, B, C |
| `tests/supabase-image-pull.test.ts` (#1523。yml は deploy-supabase-migrations.yml・security-regression.yml・e2e-local.yml を名指しで読む。readdir しない) | `scripts/supabase-image-fallback.sh` と `scripts/lib/supabase-image-pull.sh` を backup-db.mjs が使う | 反応しない (2 つのスクリプトを変えない。確認のみ)。`db-backup.yml` の扱いは、このテストに足さず `tests/backup-db.test.ts` (fallback で包む argv・終了 75 の分け方・75 がライブラリの値と同じ) と `tests/db-backup-workflow.test.ts` で見る | A |
| `tests/e2e-api-paths.test.ts`、`tests/health-middleware-exemption.test.ts` | — | 反応しない (確認のみ) | — |
| `tests/local-ci-slot-consumers.test.ts` (1: `tests/e2e/`・`tests/integration/`・Maestro の TS / JS / YAML を構文木で走査し、ポート付きのループバックの URL は `??` / `\|\|` の右 (既定値) にだけ・その連なりの最初に枠の値を入れる環境変数 (`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` / `INTEGRATION_BASE_URL` / `PLAYWRIGHT_BASE_URL`) を読む・ポートの名前に枠 0 の値を入れない。2: `scripts/` と Maestro の `.sh` はローカル Supabase のポートとアプリのポートの URL を書かない) | 新しい `tests/integration/security/backup-audit-record.test.ts`・`tests/integration/security/backup-app-triggers.test.ts` (1 の走査の対象)。`scripts/backup-db.mjs`・`scripts/lib/backup-db.mjs` は `.sh` でないので 2 の対象外、本設計は `.sh` を足さない | テストは変えない。`backup-audit-record.test.ts`・`backup-app-triggers.test.ts` は §15 のとおり `process.env.NEXT_PUBLIC_SUPABASE_URL` などを読み (既定値の URL を書かない)、ポートの数字を書かない。`backup-db.mjs` もローカルの接続先は `supabase-local.sh env` の `SUPABASE_DB_URL` だけから取り (`parseLocalDbUrl`)、ポートを書かない (2 の対象外でも同じ規則にそろえる。`tests/backup-db.test.ts` の偽の `env` の出力の URL は tests/ の直下で、1 の対象外) | A |
| `tests/local-ci-slot.test.ts`・`tests/local-ci-slot-test-timeout.test.ts` (枠の値の表 `scripts/lib/local-ci-slot.sh`・`supabase-local.sh` の枠ごとの作業ディレクトリ / config.toml・`local-ci.sh` のロック、名指しの 3 ファイルの時間切れ) | `LOCAL_CI_SLOT` (`backup-db.mjs` が `supabase-local.sh` に渡す) | 反応しない (確認のみ)。どちらも名指しのファイルだけを読み、readdir しない。`local-ci-slot.sh`・`supabase-local.sh` は変えない。`LOCAL_SLOT_MAX` と `LCS_SLOT_MAX` の一致は `tests/backup-db.test.ts` が見る (§15) | A |

### 18.1 `docs/design/operator/08-cron-batches.md` の 5 か所の逐語 (段 C の専権 PATCH)

置き換える前の文は origin/main の 08 にあるとおり。どの行にも `#1125` を足さない (同じテストファイルの「#1125 の課金系の扱い」の it が、`#1125` を含む行に「作らない|決めた|新しい判断|オーナー判断」が無いことを見る)。

**並行の案件との順序 (逐語より優先する規則):** origin/main にある設計 `cross/16-auth-history-sessions.md` (段 B で Vercel Cron `login-alerts` を足す。同書 §23 の 08 の行・§22 N-32) と `mobile/06-push-send.md` (段 B で `push-outbox` を足す。同書 §13.2 の 08 の行) も、同じ 08 の §3.0 の本文・§3.2 の注記・§5 の注記の同じ文に 1 本ずつ足し、`vercel.json` の `crons` と `tests/ai-usage-contract.test.ts` の `CRON_ENTRYPOINTS` にも 1 行ずつ足す。どれが先にマージされるかは決まっていない。下の ①④⑤ の「前」「後」の逐語は、段 C の PR の時点の origin/main の `vercel.json` の crons が 2 本 (`process-menu-queue`・`app-log-alerts`) のときの形とする。ほかの案件が先に足していたら、逐語の「前」が当たらないので、次の規則で直す:

- (a) 名前の列挙: その時点の文の列挙の最後 (「の N 本」「だけで」の直前) に、`・` でつないで ①④⑤ の「後」と同じ項目 (`` `backup-freshness` (§3.2 の `backup_freshness`。#1129) `` など) を足す。先にある項目の書き方・括弧・並びは変えない。括弧の中に「の <数> 本」を書かない (cross/16 §23 と同じ注意。番兵の正規表現が先に当たる)。
- (b) 本数: 「の N 本」の N は、PR の時点の origin/main の `vercel.json` の crons の数 + 1 (2 本なら 3 本、ほかの案件が 1 本足していれば 4 本)。後から来る案件も同じ規則 (実数 + 1) で数えるので、どの順でマージしても 08 の本数は `vercel.json` の実数と合う。
- (c) 「この表のほかの 11 本」は変えない: ② の行は『実装済み』を含み、cross/16 が足す `login_alerts` の行も『実装済み』を含み、mobile/06 は表に行を足さないので、表の行数 − 『実装済み』を含む行の数は、どの順でも 11 のまま。
- (d) ② の行の置き場所: `app_log_alerts` の行の次 (cross/16 の `login_alerts` の行が先にあれば、その行の次)。③ は行の位置を変えない。
- (e) `vercel.json` の crons は配列の最後に足し、`CRON_ENTRYPOINTS` の行は `vercel:` で始まる行の最後の次に足す (§18 の ai-usage-contract の行の「`app-log-alerts` の行の次」は、ほかの案件が先に足していればその行の次と読む)。
- (f) ENV_SETUP.md の `CRON_SECRET` の行の列挙 (§19) も (a) と同じ規則 (最後に足し、「どちらも」のような 2 本を前提にした語は「どれも」にする)。
- (g) 直したら `tests/log-cleanup-dau-snapshot-contract.test.ts`・`tests/ai-usage-contract.test.ts`・`src/__tests__/api/cron/backup-freshness.test.ts` を offload で流して緑を確かめる。

① §3.0 の本文 (「§3.1 以降の表と各節は、設計時の計画であり」で始まる段落の最後の文):

```text
前: `vercel.json` に登録されている Vercel Cron は `process-menu-queue` と `app-log-alerts` (§3.2 の `app_log_alerts`。#1157) の 2 本である。
後: `vercel.json` に登録されている Vercel Cron は `process-menu-queue`・`app-log-alerts` (§3.2 の `app_log_alerts`。#1157)・`backup-freshness` (§3.2 の `backup_freshness`。#1129) の 3 本である。
```

② §3.2 の表の `app_log_alerts` の行の次に 1 行を足す (『実装済み』を含む):

```text
| `backup_freshness` (実装済み: #1129) | daily 14:37 | 最新の `backup.daily.completed` が 30 時間より古ければ `OPS_ALERT_EMAIL` へメールで通知 (`/api/cron/backup-freshness`。設計は cross/17 §7.3) |
```

③ §3.2 の表の `logical_backup` の行 (『実装済み』の語を入れない。Vercel Cron としては実装していない行として数える):

```text
前: | `logical_backup` | daily 02:00 | pg_dump → S3 |
後: | `logical_backup` | daily 02:00 | pg_dump → S3。Vercel Cron としては置かず、GitHub Actions の `db-backup.yml` (02:23 JST) が取って R2 に置く (cross/17) |
```

④ §3.2 の注記の 1 行目 (`> **2026-10-10 時点の状態**:` の後ろ。日付は実装のマージ日に替えてよい):

```text
前: `vercel.json` に登録されている Vercel Cron は `process-menu-queue` と `app-log-alerts` (この表の `app_log_alerts`。#1157) の 2 本。この表のほかの 11 本は、Vercel Cron としては実装されていない。
後: `vercel.json` に登録されている Vercel Cron は `process-menu-queue`・`app-log-alerts` (この表の `app_log_alerts`。#1157)・`backup-freshness` (この表の `backup_freshness`。#1129) の 3 本。この表のほかの 11 本は、Vercel Cron としては実装されていない (`logical_backup` は GitHub Actions で取る。cross/17)。
```

N が 11 のままの理由: 表は 12 行 → 13 行 (②を足す)、『実装済み』を含む行は 1 → 2 (`app_log_alerts` と `backup_freshness`)。13 − 2 = 11。

⑤ §5 の注記の 1 行目 (`> **2026-10-10 時点**:` で始まる行の中):

```text
前: `vercel.json` にあるのは `process-menu-queue` と `app-log-alerts` だけで、
後: `vercel.json` にあるのは `process-menu-queue`・`app-log-alerts`・`backup-freshness` (cross/17 §7.3) だけで、
```

---

## 19. 他の文書への追随表 (本設計では編集しない。実装の PR または docs PR で足す)

| 文書 | 追記 | 期日 |
|---|---|---|
| `docs/design/cross/CLAUDE.md` のファイル一覧 | `17-backup-automation.md` の行 (長期バックアップの自動化と DR 訓練の記録 / #1129 #1191)。欠番の注記に 14・16 を足す | 設計のマージと同日 |
| `docs/design/cross/07-dr-backup.md` | 冒頭に「バックアップの取得・保管・記録・訓練の記録は cross/17 が正」の注記。§4.1〜§4.3・§9・§11〜§14 の該当行に「cross/17 で置き換え」。§6.1 に「Pro でない間は cross/17 §9.2」、§7.1 の手順 4 を「`/super-admin/backups` で記録」に、§10 の表を `docs/operations/backup-restore.md` (復元手順) / `operator/09-runbook.md` §11 (DR ランブック) / `operator/09-runbook.md` §10.2 (報告テンプレート) に | 設計のマージと同日 |
| `docs/design/operator/08-cron-batches.md` §3.0・§3.2・§5 | §18.1 の 5 か所 (§3.0 の本文・§3.2 の表の 2 行・§3.2 の注記・§5 の注記。機械検査があるので実装の段 C と同じ PR) | 段 C |
| `docs/design/operator/07-audit-monitoring.md` §4.5 の隣 | 新しい族 `backup.*` (6 つ。`record_backup_audit`、actor 無し、target_type `database_backup`) と `dr.test.*` (3 つ。`recordAdminAudit`、target_type `dr_test`) の表と、読む側がこの印 (取得の行は actor 無し・target_type、訓練の行は target_type・actor が今の super_admin) で絞ること (本書 §7.1・§10) | 実装のマージと同日 |
| `admin_audit_logs` の INSERT のポリシー (Issue #1736。本書の範囲の外の既存の欠陥。本書は参照するだけ) | 古いポリシー `"Admins can create audit logs"` を外す migration (と authenticated の直接の INSERT をどう閉じるか) は #1736 の設計・実装で行う。入っても本書 §7.1・§7.3 の読み取りの絞り込みは外さない (書いた経路の印を見る守りを残す)。入ったら本書 §21 の「`admin_audit_logs` の INSERT」の行に、閉じた旨と #1736 の migration の名前を足す | #1736 のマージと同日 |
| `docs/design/operator/02-api-spec.md` | `GET /api/super-admin/backups`・`POST /api/super-admin/backups/dr-tests` の節 (本書 §7.1 / §7.2 を canonical とする旨) | 実装のマージと同日 |
| `docs/design/operator/03-ui-spec.md` §3.2 / §22 | super_admin のサイドバー「バックアップ・DR」 | 実装のマージと同日 |
| `docs/design/operator/09-runbook.md` §11.1 Step 4・§11.4 Step 3・§11.5 Step 6 | PITR が無い間の論理復元は `docs/operations/backup-restore.md` §5 / §6 | 実装のマージと同日 |
| `docs/design/operator/09-runbook.md` §11.5 Step 3 (origin/main 627〜628 行「Weekly Cold Backup (S3 Glacier) から…」「SHA256 + GPG 署名を検証」)・§15 テスト方針の E2E「PITR 復元テスト (月 1 回)」(756 行)・§17 未解決事項の「`logical_backup` cron (`pg_dump → S3`): S3 接続情報と IAM 権限の設定は本番環境構築時に確定」(767 行) | §11.5 Step 3: 「Weekly Cold Backup (R2 の `weekly/`。bucket lock の下) から最新の未侵害の対象物を選ぶ」「`sha256sum -c <base>.sha256` で検証し、age の秘密鍵で復号する (GPG の署名は置かない。cross/17 §3.2)」「新しい Supabase プロジェクトへの復元は `docs/operations/backup-restore.md` §6」に。§15: 「PITR 復元テスト (月 1 回。Pro になるまでは `skipped` で記録。cross/17 §9.2)」に。§17: 「`logical_backup` は cross/17 で GitHub Actions + R2 として決めた (秘密は §13・初回の設定は手順書 §2)」に置き換え、未解決の項目から外す | 実装のマージと同日 |
| `docs/design/cross/08-legal-compliance.md` §16.3 (法的保管義務の行) / §19 (GPG の行) | バックアップの保持期間 (§9.1) と、暗号化は age (GPG の体制の TODO を閉じる) | 実装のマージと同日 |
| `src/app/privacy/page.tsx` | §9.1 の文の追加 | 追記した (cross/20 §7 第12条。本文の正本は `src/lib/legal/privacy-text.ts`) |
| `ENV_SETUP.md` 「GitHub Actions secrets」 | secrets 2 つ・variables 3 つ (+ 任意の調整用 4 つ)。復元 (`node scripts/backup-db.mjs restore`) はオーナーの手元のシェルに R2 の 4 つ (`RESTORE_REQUIRED_ENV_NAMES`。キーは復元用の読み取り専用のトークン) を置くこと (値は書かない。手順書 §5)。GitHub が自動で入れるもの (`GITHUB_TOKEN`・`GITHUB_REPOSITORY`・`GITHUB_RUN_ID`・`GITHUB_RUN_ATTEMPT`・`GITHUB_SHA`・`RUNNER_TEMP`) は設定しなくてよいこと。`NEW_DB_URL` は手順書 §6 でオーナーの手元のシェルにだけ置く変数で、GitHub・Vercel には置かないこと (§13) | 段 D |
| `ENV_SETUP.md` の「3 つの保管場所」の表の Vercel の `CRON_SECRET` の行 (origin/main 88 行「Vercel Cron が `/api/cron/process-menu-queue` と `/api/cron/app-log-alerts`（どちらも `vercel.json` の `crons`）を呼ぶとき」) と、節「エラー急増の運用メール（`OPS_ALERT_EMAIL`）」の冒頭の段落 (origin/main 367 行「Vercel Cron が 15 分おきに `GET /api/cron/app-log-alerts` を呼び」) | 88 行: 列挙の最後に `/api/cron/backup-freshness` を足し、「どちらも」を「どれも」に (§18.1 の並行の規則 (f)。ほかの案件が先に足していればその後ろ)。367 行の段落の後ろに 1 文: 「同じ宛先に、DB バックアップが 30 時間より新しく取れていないことの通知も届きます (`GET /api/cron/backup-freshness`。日 1 回、14:37 JST。#1129)」 | 段 C (`vercel.json` に cron を足すのと同じ PR。どちらも `vercel.json` の crons の本数・名前を列挙する文) |
| `docs/design/operator/08-cron-batches.md` §3.0 の「過去の migration で登録されたジョブ (`catalog-import-*` の 5 本、`handson-tour-sandbox-cleanup`) もある」の文 (origin/main 39 行) | 文の後ろに「この 6 本も含め、本番の `cron.job` の定義は DB バックアップの書庫の `cron_jobs.sql` に入り、新しいプロジェクトへの復元で戻す (cross/17 §4.3・`docs/operations/backup-restore.md` §6)」を足す (§18.1 の 5 か所とは別の行で、`tests/log-cleanup-dau-snapshot-contract.test.ts` が見る本数・名前の列挙に触れない。`#1125` を書かない) | 段 C (08 の §18.1 の 5 か所と同じ PR) |
| `docs/design/operator/10-logs-and-mail-retry.md` §2 (関連要件と現行の事実) の「Vercel Cron: `vercel.json` に `process-menu-queue` (毎分) と `app-log-alerts` (15 分おき) の 2 本」(origin/main 59 行) | 列挙の最後に「`backup-freshness` (日 1 回。#1129・cross/17 §7.3)」を足し、本数を PR の時点の実数 + 1 に (§18.1 の並行の規則 (a)(b)) | 段 C |
| `docs/design/operator/07-audit-monitoring.md` §5.2 のアーカイブジョブの SQL の注釈「実際の S3 転送は Vercel Cron が担当」(origin/main 404 行) | 注釈の後ろに「(未実装の計画。DB の論理バックアップは cross/17 の GitHub Actions → R2 で、このアーカイブの転送は担わない。7 年アーカイブは別の設計。cross/17 §1・§21)」を足す。DB のバックアップの転送と取り違えないための注記で、アーカイブの設計そのものは変えない | 実装のマージと同日 |
| `docs/design/cross/09-testing.md` §17.1 Nightly Run の「DR 復元テスト (月 1 回、staging に PITR)」(origin/main 272 行) | 「DR 復元テスト (月 1 回、staging に PITR。Pro になるまでは行わず `/super-admin/backups` で `monthly_pitr` を `skipped` で記録する。論理バックアップの復元は、月曜の取得の restore_check と PR の `roundtrip-check` が受け持つ。cross/17 §4.8・§9.2・§15)」に | 実装のマージと同日 |
| `docs/design/00-architecture.md` の設計書のディレクトリの木の `cross/` (origin/main 332 行の `07-dr-backup.md` の行) | `07-dr-backup.md` の次に `17-backup-automation.md` の行を足す (ほかの欠けている冊は本書の範囲で足さない) | 設計のマージと同日 |
| `docs/design/operator/03-ui-spec.md` §32 `/super-admin/database` の「**バックアップ状態**: PITR 最終バックアップ日時 / Logical Backup 最終実行」(origin/main 647 行) | 「**バックアップ状態**: この画面では出さず、`/super-admin/backups` (cross/17 §7.4) へのリンクを置く (取得・訓練の記録の正は `admin_audit_logs` の `backup.*` / `dr.test.*` で、状態を出す画面は 1 か所)」に。`/super-admin/database` は origin/main に実装が無い (§20) | 実装のマージと同日 |
| `CLAUDE.md` (リポジトリ直下) 「マージ前の検査 (ローカル CI)」 | 箇条を 1 つ足す: 「`scripts/backup-db.mjs`・`scripts/lib/backup-db.mjs`・`scripts/supabase-local.sh`・`.github/workflows/db-backup.yml` を変える PR は、db-backup.yml の `roundtrip-check` ジョブ (ローカルのスタックでダンプ → 復元の往復) の緑を待ってからマージする。local-ci.sh には写していない (理由は `tests/local-ci-workflow-sync.test.ts` の `EXCLUDED_WORKFLOWS`)。手元では `node scripts/backup-db.mjs roundtrip-local --slot <空いている枠>` で同じ検査を流せる (終わったら `LOCAL_CI_SLOT=<その枠> bash scripts/supabase-local.sh stop` で止める。§4.7)」。今の「migration を含まない PR は local-ci.sh の 5 段が緑なら CI を待たずにマージしてよい」の例外になる。本設計・実装のレーンは CLAUDE.md を編集しない (オーケストレーターが足す) | 段 A のマージと同日 |
| `.env.example` `OPS_ALERT_EMAIL` の注記 | 鮮度の通知 (`/api/cron/backup-freshness`。日 1 回の確認で、古ければ 1 通) | 段 C |
| `docs/operations/backup-restore.md` | 新設 (§12) | 段 D |
| `supabase/baseline/README.md` 「ファイル」の表の下・「忠実度」 | `scripts/baseline/build_restore_fixups.py` が `build_baseline.py` の同じ 3 つの関数で DB バックアップの `fixups.sql` を作り、`snapshot_catalog.sql` と `verify_baseline.py` を DB バックアップの取得と復元の検査も使うこと (どれかを変える PR は、cross/17 の取得 (`tests/backup-db.test.ts` の golden と `CATALOG_CSV_FILES` の it、`roundtrip-check`) も赤くなりうる) | 段 D |
| `docs/operations/ci-supabase-image-pull.md` 「自動でしていること」と「ジョブごとの扱い」の表 | 1 行ずつ: `scripts/backup-db.mjs` が dump の 3 回と stats を `scripts/supabase-image-fallback.sh` で包み、restore_check と `roundtrip-check` は `supabase-local.sh start` を使う / DB バックアップ (db-backup の `backup` ジョブ) で取れなかったときは reason `image_pull_unavailable` の監査行と Issue が残る → 時間をおいて `workflow_dispatch` で取り直す (`roundtrip-check` は失敗したジョブだけを流し直す) | 段 D |
| `docs/design/cross/09-testing.md` (a11y の節)・`cross/05-i18n-a11y.md` §5.2 | `@axe-core/playwright` を入れて CI の検査を作るときの対象の画面に `/super-admin/backups` を入れる (本書は依存を足さない。§15) | axe を入れる設計・実装と同じ PR (後続。§21) |
| `supabase/.temp/*` | 触らない (link が書き換えるが、workflow はコミットしない) | — |

---

## 20. 既存実装との関連

| 資産 | 扱い |
|---|---|
| `.github/workflows/prod-schema-snapshot.yml` | 変えない。link・Docker の PG イメージ・pooler-url・PGPASSWORD の使い方をそのまま手本にする |
| `scripts/baseline/snapshot_catalog.sql`・`build_baseline.py`・`verify_baseline.py` | 変えない。catalog の段がカタログを取り (snapshot_catalog.sql)、補いの SQL を作り (build_baseline.py の 3 つの関数を、新設の `build_restore_fixups.py` から呼ぶ)、復元の検査が比べる (verify_baseline.py)。ローカルのベースラインの忠実度を確かめた (`supabase-local.sh verify` で errors 0) のと同じ道具 |
| `.github/workflows/migration-repair.yml`・`deploy-supabase-migrations.yml` | 変えない。台帳を版の一覧で戻す `migration repair --status applied` は migration-repair.yml と同じ CLI の操作。新しいプロジェクトで台帳が空のままだと、deploy-supabase-migrations.yml は全部のファイルを新しい migration として扱い (同ファイルの注記「台帳(remote)が空の場合は比較対象が無いため、全 LOCAL_ONLY を新規として許容する」)、統合版の最初の migration (本番スキーマ一式) から `db push` しようとして、復元した DB の上では落ちる。手順書 §6 の (5) で台帳を戻してから次の migration を出す |
| `.github/workflows/daily-consistency-check.yml`・`scripts/lib/consistency-check.mjs`・`scripts/consistency-check.mjs` | 変えない。Issue の作成・更新・クローズ (`planIssueAction`・`createGitHub`) を再利用する |
| `scripts/supabase-local.sh` | 変えない。復元の検査と往復のテストが `start` / `env` / `stop` を使う (`env` の `SUPABASE_DB_URL` を `parseLocalDbUrl` で読み、runner の psql で繋ぐ。§4.12) |
| `scripts/lib/cron-secret-drift.mjs` | 変えない。伏せ字の規則と「外部コマンドを差し替える」作りを写す |
| `src/lib/cron-auth.ts`・`supabase/functions/_shared/cron-secret.ts` | そのまま使う |
| `src/app/api/cron/app-log-alerts/route.ts` | 宛先の読み口だけ `resolveOpsAlertRecipient` に置き換える (動きは変えない) |
| `public.claim_ops_alert` / `public.release_ops_alert` / `public.ops_alert_state` | そのまま使う (キー `backup_stale`) |
| `public.admin_audit_logs` (表・RLS・既存のポリシー) | 変えない。`record_backup_audit` が INSERT するだけ。INSERT のポリシー 2 本が action_type と actor を見ない既存の欠陥は Issue #1736 で直す (本書は読む側の絞り込みだけを持つ。§7.1・§21) |
| `src/lib/admin/audit.ts` (`recordAdminAudit`)、`src/lib/api/errors.ts`、`src/lib/api/reject-null-character.ts`、`src/lib/auth/helpers.ts`、`src/lib/super-admin/validation-errors.ts` (`readJsonBody`・`invalidJsonBodyResponse`・`invalidInputResponse`。#1654) | そのまま使う |
| `src/lib/emails/send.ts`・`envelope.ts`・`src/lib/site-config.ts` | そのまま使う |
| `cross/07-dr-backup.md` | 本書が §4.1〜§4.3・§9・§11〜§14 を置き換える (§0.4)。編集は §19 |
| `operator/03-ui-spec.md` §32 `/super-admin/database` の「バックアップ状態」(設計だけ。origin/main に `src/app/super-admin/database/` も API も無い) | 統合しない・重ねない。バックアップと訓練の状態を出すのは本書の `/super-admin/backups` だけにし、§32 は同じ状態を出さずにリンクを置く (§19 の 03 §32 の行)。`/super-admin/database` を作るときは `GET /api/super-admin/backups` を読まずリンクだけにする (状態の読み方・鮮度の判定 `isBackupStale` を 2 か所に持たない) |
| `scripts/lib/local-ci-slot.sh`・`tests/helpers/local-ci-slot-values.ts` | 変えない。`restore` / `roundtrip-local` の `--slot` の範囲は `LCS_SLOT_MAX` に合わせ (`LOCAL_SLOT_MAX`)、枠は `supabase-local.sh` の `LOCAL_CI_SLOT` で渡す。一致は `tests/backup-db.test.ts` が `slotMaxOf` で見る |

---

## 21. 未解決事項 (オーナー / 法務の確認が要るもの。設計は上の既定で進める)

| 項目 | 本設計の既定 | 確認したいこと |
|---|---|---|
| annual の保持 | 7 年 (2,557 日)。07 の「永久」を置き換える | 法務として何年か。lock は後から短くできるかが R2 の文書に無い (短くするときは新しいバケットへ移す前提) |
| プライバシーポリシーの文 | 追記した (cross/20 §7 第12条) | 弁護士の確認を受けるかはオーナーの判断 (cross/20 §9.4) |
| 復元点より後の退会 | 再現しない (24 時間の窓を受け入れる)。手順書に明記 | 復元のときに利用者へ知らせるか |
| 暗号化の道具 | age (公開鍵。秘密鍵は CI に無い) | GPG を好むなら公開鍵の取り込みと `--trust-model always` の 2 行を手順書に足すだけで同じ構造にできる |
| age の秘密鍵の保管 | パスワードマネージャー + 印刷の控え | 誰が持つか・2 人目を置くか |
| Pro への移行の時期 | 07 §3.1 のまま (本番リリース前)。本書は Pro の前後で動きを変えない | 時期。移行後は月次 PITR テストを success で記録し始める |
| Supabase Storage のファイル (写真) | 範囲外 (DB の dump に入らない) | `rclone` で Storage の S3 互換 endpoint から同じ R2 へ写す層を足すか (別の設計) |
| DB が 5 GB を超えたとき | 平文の書庫を作らないパイプ (`tar \| zstd \| age`) への切り替え (`roundtrip-local` の検査は平文が要るので別の経路) | 切り替えの時期 (manifest の `db_size_bytes` で分かる) |
| data.sql の auth・storage の表の復元 | data は public・auth・storage だけ (`DATA_DUMP_SCHEMAS`。cron・net は入れない。CLI 2.62.10 の実物から決めた。§4.3)。auth・storage の COPY の表は復元の前に TRUNCATE する (§4.8)。それでも復元の検査で衝突した auth・storage の表は `DUMP_EXCLUDED_TABLES` に理由つきで足す (public・auth.users・auth.identities は除外しない) | 最初の往復テストと月曜の検査で、ローカルの GoTrue・Storage の版の差で落ちる表が無いかと、`verify_baseline.py` が errors にする差 (関数・表の所有者や `acl` の grantor の違い) が出ないかを確かめる (ローカルのベースラインは同じ道具で errors 0 を確かめてあるが、復元は public を落としてから流すので、同じ結果になることは往復の検査で初めて実物で分かる) |
| 運営のロール | super_admin だけ。訓練の記録は、記録した人が今も super_admin のものだけを画面に出す (役を外れた人・退会した人の記録は監査行に残るが画面に出ない。§7.1) | admin にも見せるか (記録は super_admin のまま)。役を外れた人の訓練の記録も画面に出すか |
| 鮮度の通知の宛先 | `OPS_ALERT_EMAIL` (エラー急増と同じ) | 分けるか |
| `admin_audit_logs` の DB 側の不変 | UPDATE / DELETE は RLS のまま (anon / authenticated だけに効く。postgres・service_role は消せる)。対象物の改ざんの検出は bucket lock の `.sha256` | 監査の表そのものに、所有者でも消せない仕組み (トリガー・別の保管先への写し) を足すか (operator/07 §5 の 7 年アーカイブと合わせて別の設計) |
| `admin_audit_logs` の INSERT | 本書はポリシーを変えない。既存の 2 本 (origin/main の `prod_schema.sql` の 9496 行 `"Admins can create audit logs"` = 本人が admin / super_admin / support なら actor_id も action_type も見ない、10111 行 `audit_logs_insert_admins` = actor_id = 本人と運営の 6 ロールだけを見る) と authenticated の INSERT の権限で、運営のロールの人は `backup.*` / `dr.test.*` の行を自分の JWT で直接書ける。読む側は書いた経路の印で絞る (§7.1・§7.3。後者のポリシーで書いた行は外れる) が、前者のポリシーが残る間は、actor_id を NULL にした `backup.*` の行と actor_id を super_admin の id にした `dr.test.*` の行は見分けられず、鮮度の判定・画面がその行を信じる (この偽装ができるのは admin / super_admin / support のロールの人だけ) | Issue #1736 で直す (古いポリシーを外す migration と、authenticated の直接の INSERT を閉じる形。本書の範囲の外)。直ったら §19 の #1736 の行のとおり、この行に閉じた旨を足す |
| GitHub の schedule の 60 日停止 | 鮮度の通知で気づく | 空のコミットを定期的に積む仕組みを足すか (本書は足さない) |
| 新しいプロジェクトへの復元の台帳 | 版の一覧 (`ledger.txt`) と CLI の `migration repair --status applied` (手順書 §6)。取得の時点の restore_check が、全部の版にファイルがあることを見る | 最初の年次の訓練で、新しいプロジェクトに実際に流して `migration list --linked` と次の `deploy-supabase-migrations.yml` が通ることを確かめる (ローカルの検査では、ローカルのスタックの台帳を置き換えないので repair そのものは通らない) |
| cron のジョブの定義の置き場 | 書庫の `cron_jobs.sql` (取得の時点の本番の `cron.job`)。`catalog-import-*` の 5 本と `handson-tour-sandbox-cleanup` は migration に登録の SQL が無いまま (本書では足さない) | 6 本の登録の SQL を migration に足して、木と本番の `cron.job` をそろえるか (別の設計。足しても書庫の `cron_jobs.sql` は残す: 本番で手で変えたジョブも戻すため)。`cron.schedule_in_database` を postgres で流せることは、最初の `roundtrip-check` の `cron_dry_run` (ローカル) と最初の年次の訓練 (新しいプロジェクト) で実物で確かめる |
| DB の関数の中の本番の URL | Edge Function を呼ぶ DB の関数は本番の URL を本文に持つ (`supabase/migrations` の 5 ファイル)。新しいプロジェクトが本番になるときは手順書 §6 の (6) で migration で替え、訓練では `cron_jobs.sql` を確定させない | URL を Vault (`project_url` など) に移して、復元先で関数を書き換えずに済む形にするか (別の設計) |
| 復元で比べない権限 | sequence の権限と、public・storage の外の権限は比べない (`verify_baseline.py` と `build_baseline.py` が扱う範囲 = ローカルのベースラインの忠実度と同じ) | 比べる範囲を広げるか (広げるなら `snapshot_catalog.sql`・`verify_baseline.py` を変える別の設計) |
| 画面の a11y の自動検査 (横断ルール F) | `@axe-core/playwright` はリポジトリに無いので足さない。新しい画面は構造の検査 (§7.4・§15) で受け持つ | axe の依存と CI のジョブをいつ・どの設計で入れるか (入れたらこの画面を対象に入れる。§19) |

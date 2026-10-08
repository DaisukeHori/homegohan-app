# CLAUDE.md — homegohan 開発メモ

このファイルはリポジトリ固有の規約・構造メモです。

---

## 会話の言語 (必須)

ユーザーとのやり取りは **必ず日本語** で行う。返答・進捗報告・質問 (選択肢を含む)・最終報告のすべてが対象。
GitHub に書く PR の説明・Issue / PR のコメント・コミットメッセージの本文も日本語で書く。
コード・SQL・コマンド・識別子・エラーメッセージなど、原文のまま示すべきものは英語のままでよい。

---

## テスト基盤

### ディレクトリ構成

| パス | フレームワーク | 備考 |
|------|------------|------|
| `tests/` (e2e 以外) | Vitest | `npm run test` で実行 |
| `tests/e2e/` | Playwright | `npm run test:e2e` で実行。Vitest の `exclude` 対象 |

### E2E テストの実行

```bash
# ローカル (開発サーバー自動起動)
npm run test:e2e

# 本番 / ステージング環境を対象にする場合
PLAYWRIGHT_BASE_URL=https://homegohan-app.vercel.app npm run test:e2e
```

E2E 用ユーザーの認証情報: 環境変数 `E2E_USER_EMAIL` / `E2E_USER_PASSWORD`。  
CI では GitHub Secrets に登録する。

### CI

`.github/workflows/e2e.yml` が PR で自動実行。Playwright レポートは artifact として 14 日間保持。

---

## 共通ヘルパー規約

### 構造化ログ

- **Next.js (API Routes / Server Components)**: `src/lib/db-logger.ts`
- **Supabase Edge Functions**: `supabase/functions/_shared/db-logger.ts`

いずれも `app_logs` テーブルへ構造化エラーを記録するユーティリティ。新規エンドポイント・Edge Function では必ずこれを利用する。

### 利用者が指定した宛先へのメール送信

利用者が指定したアドレスへメールを送る処理 (招待・参加リクエスト・譲渡提案など) は、必ず `src/lib/membership/invite-throttle.ts` の送信回数制限を通す (#1163。`tests/email-send-throttle-contract.test.ts` が検査する)。

### 栄養計算入力

`src/lib/build-nutrition-input.ts` に集約。栄養計算に必要な入力オブジェクトを組み立てる際は、このモジュールを経由する。直接構築しない。

### localStorage クリーンアップ

`src/lib/user-storage.ts` の `clearUserScopedLocalStorage()` を使う。  
サインアウト処理では **Supabase signOut を呼ぶ前に** このヘルパーを実行する。

---

## 無視対象

`homegohan-app/` ディレクトリ (旧ツリーの残骸) は無視する。編集・参照しない。

---

## Supabase 本番スキーマ変更ポリシー

本番 Supabase (project `flmeolcfutuwwbjmzyoz`) へのスキーマ変更は、必ず `supabase/migrations/*.sql` をファイル化して PR 経由でコミットすること。

**禁止**: Supabase MCP の `apply_migration` やダッシュボードの SQL Editor で本番に直接 DDL を当てること。

理由: #1064 で、秒精度のタイムスタンプ版 migration (MCP `apply_migration` 由来) とリポジトリの丸め連番版 migration がズレて `supabase db push` が全ブロックし、2 ヶ月間デプロイできない状態になった実例がある。スキーマ変更は必ずファイル化 → PR → CI の migration drift 検知を通すこと。

---

## ローカル / CI の Supabase (ベースライン方式)

ローカルと CI では本番スキーマの読み取り専用スナップショット (`supabase/baseline/`) を出発点にし、本番台帳より新しい migration だけを上に積む。詳細は `supabase/baseline/README.md`。

`supabase/migrations/` は #1116 で空 DB から流し直せるようにした。本番台帳の最大 version (`20261007112200`) 以下の migration は、最も古いファイル `20251126124224_create_meal_planner_tables.sql` に本番スキーマのベースラインとして統合し、ほかはプレースホルダにしてある (統合前の中身は git 履歴)。これらは本番では適用済みのため実行されない。**既存の migration ファイルは編集せず、変更は必ず新しい migration として追加する。**

```bash
bash scripts/supabase-local.sh start            # 起動
bash scripts/supabase-local.sh env .env.local   # 接続情報を .env.local へ
bash scripts/supabase-local.sh reset            # migration を追加・変更したら (= db reset)
npx vitest run --config vitest.integration.config.ts tests/integration/rls   # RLS / 権限の回帰テスト
```

- リポジトリの `supabase/` に対して `supabase start` / `supabase db reset` を直接実行しない (ローカル専用の設定 (project_id・認証のレート制限の緩和) と Kong の再起動対策は `scripts/supabase-local.sh` が入れる)。
- CI の `deploy-supabase-migrations.yml` は `supabase db diff --linked` で、空のシャドウ DB に全 migration を流してから本番と比べる。流せなければジョブが失敗する。
- PR では `.github/workflows/security-regression.yml` が同じ方法でローカルスタックを立て、`tests/integration/rls/` と `tests/integration/security/` と `tests/integration/handson-tour/` を実行する。
- 結合テストで行を INSERT するときは、返ってくる `error` を必ず確認する。握りつぶすと、列名の誤り (例: `meals` に `dish_name` 列は無く、`user_daily_meals` の日付列は `day_date`) で行が入らないまま、テストが空振りで通る / 原因の分かりにくい失敗になる。

---

## 家族 (family_*) を変える関数のロック順 (DB)

家族のメンバー・所属・代表者を変える関数 (`accept_family_invite` / `add_family_child` / `leave_family` / `remove_family_member` / `operator_force_dissolve_family` / `operator_force_representative_transfer` / `accept_family_representative_transfer` / `accept_child_promotion`) は、**最初に `family_groups` の行をロックし**、そのあとで子の行 (`family_invites` / `ownership_transfer_proposals` / `family_members` / `family_promotion_requests` / `user_profiles`) を触る (#1310)。代表者による家族の削除 (`DELETE FROM family_groups` + CASCADE) は、DELETE 文が最初に家族の行を取るので、もともとこの順になっている。

順番がそろっていないと、運営の強制解散・家族の削除と同時に走ったときに、解散済みの家族に active のメンバーが残る / デッドロック (40P01) する。

- 家族に関わる関数を `CREATE OR REPLACE` するときは、既存のロックを外さない。別の migration が同じ関数を書き換えているときは、最新の定義の上に積む (古い本文で上書きするとロックが消える)。
- 新しく足す家族の行のロックは `FOR NO KEY UPDATE` にする (`add_family_child` だけは #1213 のまま `FOR UPDATE`)。`FOR UPDATE` だと、子の行を先に持つ関数が最後に取る外部キーの確認 (`FOR KEY SHARE`) が待たされ、逆向きに待ち合ってデッドロックする。
- 子の行を先に取って、あとで家族の行を外部キーの確認で取る関数 (`create_family_invite` の再招待 / `request_child_promotion`) は、まだ家族の行を先に取らない。代表者の DELETE と同時に走ると、まれにどちらかがデッドロックで失敗する (既知。やり直せば通る)。
- 回帰テスト: `tests/integration/security/family-lock-order-race.test.ts`

---

## Claude Code Cloud (claude.ai/code) 動作要件

### 起動時 setup
- `.claude/settings.json` の SessionStart hook、または環境設定 UI の "Setup Script" に
  `bash scripts/setup-cccloud.sh` を登録すると依存解決される
- スクリプトは Cloud 環境のみで動作 (`CLAUDE_CODE_REMOTE` 等を検知)、ローカルでは no-op

### 環境変数
必須・任意の全変数は `.env.example` 参照。CCCloud では環境設定 UI の Environment Variables に同形式で貼り付け。
**注: 現状 CCCloud に専用シークレットストアは無し**。シークレット値は環境を編集できる人全員から見える前提で扱うこと (Stripe live key 等は CCCloud に置かない方針推奨)。

### 利用可能なコマンド (Cloud 動作可)
| 用途 | コマンド |
|---|---|
| 開発サーバー | `npm run dev` |
| Lint | `npm run lint` |
| 型チェック | `npm run typecheck` |
| Vitest unit | `npm test` |
| Playwright E2E | `npm run test:e2e` (要 PLAYWRIGHT_BASE_URL or 起動済 dev) |
| Supabase migration 確認 | `npx supabase@2.62.10 db diff` 等 |

### Cloud で **実行不可** なコマンド
- `npm run mobile:ios` / `mobile:android` (Xcode / Android SDK / シミュレータ依存)
- `eas build --local` (CocoaPods / Xcode 依存、TestFlight 提出は堀さんローカル)
- 任意の MCP ツール (ProxmoxMCP / SSH-MCP / Cloudflare 等のローカル MCP は CCCloud では未登録)

### Network 制約
CCCloud のデフォルト `Trusted` レベルでは Stripe / Supabase / Vercel API はホワイトリスト外。アクセス必要なら環境設定 > Network access で `Custom` を選び以下を追加:
```
*.supabase.co
api.stripe.com
api.vercel.com
api.x.ai
generativelanguage.googleapis.com
api.openai.com
api.resend.com
us.i.posthog.com
*.upstash.io
```
または `Full` (全許可)。

### 引き継ぎ
新セッション開始時は `docs/handover/2026-05-08.md` を Read してから着手 (リポジトリ内に複製済み、CCCloud / ローカル両方から読める)。

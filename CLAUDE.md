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

### 依存パッケージ・シークレットの検査と Dependabot (#1156)

- `.github/workflows/security.yml`:
  - **gitleaks**: PR で増えたコミットと main への push だけを検査し、見つかったら失敗する。
  - **npm audit**: 参考情報で、PR を止めない。critical が 0 件になったら、止める検査に切り替える。**`continue-on-error` は、ジョブではなく npm audit の「ステップ」に付ける。** ジョブに付けると、ワークフローは通っても、そのジョブの check run が失敗 (赤い ×) のまま残る。すると、すべての PR の Checks が赤くなり、毎日の整合性チェック (`scripts/lib/consistency-check.mjs`) も、止まっている PR を「赤のまま」に数える (`tests/security-workflow.test.ts` が、`pull_request` で動くワークフローのジョブ単位の `continue-on-error` を検出する)。
  - **依存関係レビュー**と **CodeQL**: リポジトリが公開の間だけ動く。非公開にすると自動でスキップされる。依存関係レビューは、リポジトリの Dependency graph が無効の間 (GitHub が依存の差分を 403 Forbidden で断る) だけ、レビューを飛ばして警告と Summary を出す (すべての PR を赤くしないため)。有効にすれば、次の PR から止める検査として働く。CodeQL のジョブそのものは止めないが、コードスキャンの結果を知らせる別の check run が付き、新しい重大なアラートが増えた PR では赤くなる。
- gitleaks の誤検知は `.gitleaks.toml` に**値そのもの**を足す (ファイル・ディレクトリ単位では除外しない)。1 行だけなら行末に `gitleaks:allow`。本物のキーが見つかったときは除外せず、そのキーを無効にして発行し直す (履歴から消すだけでは取り消せない)。gitleaks の版と SHA-256 は workflow に固定してある。上げるときはリリースの `checksums.txt` の値に合わせる。
- **テストに書くダミーの認証値** (`apiKey` / `token` / `secret` / `password` など) は、gitleaks の汎用ルール (generic-api-key) に掛かりやすい。掛かると PR の `security / gitleaks` が失敗するので、ダミーの値の行の末尾に `gitleaks:allow` と書く。ダミーでも、`sk-` や `ghp_` や JWT のような、本物のキーの書式にしない。
- `.github/dependabot.yml`: npm (ルートの package-lock.json が workspaces をまとめて管理) と GitHub Actions を週 1 回。マイナー・パッチは 1 本の PR にまとめる。Next / React / Expo / React Native は、メジャー更新 (Expo / React Native はマイナー更新も) の PR を出さない。計画して上げる (#1199)。自動承認・自動マージはしない。
- **Dependabot の PR には Actions のシークレットが渡されない。** `pull_request` で動き、`secrets.*` (`GITHUB_TOKEN` 以外) を使うジョブには `if: github.actor != 'dependabot[bot]'` を付ける。付け忘れると、依存更新の PR が毎回赤くなる (`tests/security-workflow.test.ts` が検査する)。

---

## 共通ヘルパー規約

### 構造化ログ

- **Next.js (API Routes / Server Components)**: `src/lib/db-logger.ts`
- **Supabase Edge Functions**: `supabase/functions/_shared/db-logger.ts`

いずれも `app_logs` テーブルへ構造化エラーを記録するユーティリティ。新規エンドポイント・Edge Function では必ずこれを利用する。

### 利用者が指定した宛先へのメール送信

利用者が指定したアドレスへメールを送る処理 (招待・参加リクエスト・譲渡提案など) は、必ず `src/lib/membership/invite-throttle.ts` の送信回数制限を通す (#1163。`tests/email-send-throttle-contract.test.ts` が検査する)。

### メール送信の結果と失敗の記録

メールは `src/lib/emails/send.ts` の `sendEmail(envelope)` で送る。戻り値は `{ ok, id, attempts, error }` で、配信の失敗では例外を投げない (#1193)。

- 失敗 (再試行を使い切った・400/403 など) と `RESEND_API_KEY` 未設定は、`sendEmail` が `createLogger('email')` で app_logs に残す。残すのは文面の名前 (`template`)・マスクした宛先・Resend のエラーコード・送った回数だけ。呼び出し側が戻り値を見なくても、失敗は記録される。
- 429 / 5xx / 通信エラーだけ、500ms・1s・2s の指数バックオフで最大 3 回再試行する (合計で最大 4 回)。同じ Idempotency-Key を付けるので二重送信にならない。再試行は呼び出し側の「試行回数」には数えない。
- 失敗したときに追加の処理 (送信記録の保存・画面への表示・文脈つきのログ) をする呼び出し側だけが、結果を見る。判定は `src/lib/emails/send-result.ts` の `isEmailFailure` / `emailFailureReasons` を使う。`RESEND_API_KEY` が無くて送らなかった結果は `ok: false` かつ `skipped: true` で、失敗には数えない。
- 新しい文面 (`render*Email`) は、返す封筒に `template` (snake_case の名前) を必ず入れる (`src/__tests__/lib/emails/template-names.test.ts` が検査する)。
- 呼び出し側のテストで `@/lib/emails/send` をモックしても、`send-result.ts` は別ファイルなので実物のまま使える。

### ロール認可

API Route (`src/app/api/**`) のロール認可は、共通ヘルパーを入口で呼ぶ。`getUser()` → `user_profiles` の取得 → ロール判定を route に手書きしない (#1161。`tests/role-check-source-scan.test.ts` が検査する)。

- 運営ロール (support / admin / super_admin など): `requireRole([...])` (`src/lib/auth/helpers.ts`)
- 組織の管理者 (所属組織の `org_role` が owner / admin): `requireOrgAdmin()` (同上。判定の実体は `src/lib/auth/org-admin.ts` の `isOrgAdmin`。roles 配列の `org_admin` は見ない)
- 他ユーザーの行を読む必要があるとき (`user_profiles` などは RLS で本人の行しか見えない) だけ、認可を通した**あとに** `getSupabaseAdmin()` (service_role) を使う。認可の前には使わない。使うときは、対象を絞る条件 (対象ユーザーの id など) を必ず付ける
- 500 の本文は汎用メッセージだけにし、DB の生のエラー文は返さない。詳細は上記の構造化ログに残す (#1172)。route では共通ヘルパー `internalError(routeName, error, ctx?)` (`src/lib/api/errors.ts`) を `return` する。構造化ログへの記録と、汎用の本文 `{ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' }` の返却を一度に行う。`error` は文字列のままにする (画面が `data.error` をそのまま表示するため。オブジェクトにすると描画で落ちる)。運営 API のように `error.message` を読むクライアントには `{ shape: 'nested' }` を渡す
- JSON 本文に `error.message` を入れている既存の route は `tests/api-raw-error-message-scan.test.ts` の許可リストに載っている。新しく足すとテストが落ちる。直したら許可リストの件数を減らす (0 件になったら行を消す)

### レート制限

`src/lib/rate-limit.ts` に集約する (#1197)。新しい制限は `RateLimitCategory` にカテゴリを足し、`checkRateLimit(key, category)` で判定する。route ごとに Upstash / in-memory の制限を自前で作らない (`tests/rate-limit-single-implementation.test.ts` が `@upstash/ratelimit` を使うファイルを検査する)。key は認証で確定した ID を使い、ログイン前の公開 API (お問い合わせ) だけクライアント IP を使う。

### AI の利用回数の記録

`src/lib/plan/entitlements.ts` に集約する (#1177)。AI を使う API ルートは、AI 事業者へ送る直前 (認証・同意の判定・`checkRateLimit`・入力の検証などの判定をすべて通ったあと) に、ユーザーの 1 回の操作につき 1 回 `await recordAiUsage(user.id, feature)` を呼ぶ。AI を実際に呼ばない経路 (キャッシュを返すだけなど) では呼ばない。**記録だけで、止めない** (上限と比べて止める処理・上限の値・拒否したときの応答は #1149 / T40 が入口ごとに設計して足す)。DB の関数 (`record_ai_usage`。`ai_usage_counters` に JST の日付で +1) が失敗してもログに残して先へ進む (記録の失敗で AI の機能を止めない)。プランの判定は `get_effective_plan` (個人の契約 -> 家族 -> 組織 -> `free`)。

- 順番は「同意の判定 (`requireAiConsent` / `checkUserAiConsent`、Edge は `requireAiConsentForUser` / `checkAiConsent`。#1154) → `recordAiUsage` → AI への送信」。同意が無くて止めた操作は記録しない。
- Edge Function は、ユーザーの JWT を確かめた経路で `recordEdgeAiUsage` (`supabase/functions/_shared/ai-usage.ts`) を呼ぶ。service role / cron の経路では呼ばない (Next.js が記録済み)。
- Next.js が Edge Function を**ユーザーの JWT で**呼ぶとき (`supabase.functions.invoke`) は、`headers: await aiUsageRecordedHeaders(user.id)` を付ける (署名つきの印。付けないと Edge 側でも記録して二重になる)。
- どの入口が記録するかは、同意の判定と同じ一覧 `tests/helpers/ai-consent-enforced-paths.ts` の `usage` の列に書く (入口の一覧は 1 つ)。新しい AI の入口を足したら、その一覧に行を足し、`tests/ai-consent-enforcement-routes.test.ts` の表に実際に呼ぶ行を足す (同意の判定 → 記録 → 送信の順は、この表が実際に route を呼んで確かめる)。`tests/ai-usage-contract.test.ts` は、記録を呼ぶファイル・機能名・公開ハンドラの一覧が `usage` の列と一致することを検査する。
- キューのテーブル (`weekly_menu_requests` / `meal_image_jobs`) は、service role の処理 (cron の `process-menu-queue`・Edge Function の `process-meal-image-jobs`) が AI へ送る。利用者 (authenticated) からは読むだけで、書けない (#1465。INSERT / UPDATE / DELETE の権限とポリシーを外した)。行を積む・書き換えるのは、本人の確認と記録を通った API ルートだけで、`src/lib/ai/ai-queue-writer.ts` の `getAiQueueWriter()` (service role) を変数名 `queueDb` で受けて書く (RLS が効かないので、UPDATE は `.eq('user_id', user.id)` で本人の行に絞る)。画面・モバイルからこの 2 つの表へ書かない。`tests/ai-usage-contract.test.ts` (migration から、利用者が書けないこと) と `tests/ai-queue-writes-contract.test.ts` (ソースから、書き込みが `queueDb` からだけであること)、`tests/integration/rls/ai-queue-writes.test.ts` (実 DB) が確かめる。

### 機能フラグ

機能の ON/OFF は `feature_flags` テーブル (運営画面 `/super-admin/flags` で切り替える) に置き、判定は `src/lib/feature-flags.ts` の `isFeatureEnabled(key, userId?)` を使う (#1148)。route や画面ごとに `feature_flags` / `system_settings` を自分で読まない (`tests/feature-flags-single-source.test.ts` が検査する)。以前の `system_settings` の `feature_flags` は、ログイン中のユーザー自身の権限で読んでいたため、admin 以外には値が届かなかった。

- 新しいフラグは、`FEATURE_FLAG_DEFAULTS` に「行が無い・読めないときの値」を足し、migration で `feature_flags` に行を作る (`ON CONFLICT (key) DO NOTHING`)。既定値は**止めない側**にする。クライアントに見せるフラグだけ `CLIENT_FEATURE_FLAG_KEYS` (`GET /api/feature-flags`) に足す。
- `isFeatureEnabled` は例外を投げない。行が無い・読み出しに失敗・待ちきれないときは既定値で答え、失敗は構造化ログに残す。値はサーバーのメモリに 30 秒覚えるので、切り替えの反映に最大 30 秒かかる (ミドルウェアは Edge、API route は Node で、メモリは別)。
- `ai_chat_enabled` は AI 相談の緊急停止スイッチ。通常は ON のまま使う。利用者の同意の有無で AI への送信を止めるのはこのスイッチではなく、同意の判定 (`requireAiConsent` / `checkUserAiConsent`、下の「外国の AI 事業者への提供の同意」の節) が担う (スイッチが ON でも、未同意なら送らない)。AI 相談の API を足すときは、認証のあと・レート制限の前に `aiChatDisabledResponse` (`src/lib/ai/ai-chat-gate.ts`) を呼ぶ。`maintenance_mode` はメンテナンスモード (admin / super_admin は通す。ミドルウェアが判定する)。
- 運営画面や E2E で既存のフラグを切り替えるテストは、本番の緊急スイッチを一瞬でも動かしてしまう。テストは専用のフラグを作って切り替え、終わったら消す。
- 「ロール認可」の節の「service_role で読むときは対象を絞る条件を付ける」の例外が 1 か所ある。運営画面の一覧が返す `active_user_count` (`src/lib/super-admin/flag-active-users.ts`) は、`requireRole(['super_admin'])` を通したあとに、サービスロールで `user_profiles` の全行を読んで人数を数える。集計なので絞り込みは付けられない。読むのは判定に要る 5 列 (id / roles / organization_id / plan_key_cached / created_at) だけで、返すのは人数だけ (メール・名前は読まない・返さない)。ユーザーが増えて重くなったら、DB 側で数える RPC に置き換える。

### 利用状況の計測 (PostHog は使わない)

PostHog による利用状況の計測は採用しない (オーナー判断 2026-10-08、#1166)。Web・モバイルとも SDK を取り除いてあるので、PostHog の import・依存・環境変数・CSP の許可先を足さない (`tests/posthog-not-adopted-contract.test.ts` が検査する)。画面の例外などの記録は、サーバーログ (`app_logs`) に残す (下の「エラー境界」を参照)。

### 状態色 (success / warning / error / danger)

`packages/shared/src/design-tokens.ts` の `STATUS_COLOR_TOKENS` に集約する (#590)。Web の home・pantry・health 配下の画面とモバイルの `colors.ts` は、これを import して使い、状態色の hex を直書きしない (`src/__tests__/config/status-color-tokens.test.ts` がこの範囲の画面を検査する)。週間献立など、ほかの画面には A 系の値の直書きがまだ残っている。その画面を触るときにトークンへ寄せる。

- 塗り (背景・枠線・アイコン・グラフの線や棒): `success` / `warning` / `error` / `danger` と、淡い下地の `*Light`
- 文字: `successText` / `warningText` / `dangerText`。WCAG の AA (4.5:1) を、白地・各 Light の下地・ページの背景・塗りの薄い透過の下地の上で満たす (`packages/shared/src/design-tokens.test.ts` が数値で確かめる)。塗りの色は白地で 4.5:1 に届かないので、文字には使わない。`error` の赤い文字にも `dangerText` を使う
- 値を変えるときは `design-tokens.ts` だけを直す。画面ごと・モバイルの `colors.ts` に同じ値を書き足さない
- 中立色 (bg / text / border など) と accent / purple / blue はまだ対象外 (画面ごとに値が違う。別の変更で揃える)

### 利用規約・プライバシーポリシーの版と再同意ゲート

「いま有効な版」と施行日は `packages/shared/src/legal-versions.ts` の `LEGAL_DOCUMENTS` に集約する (#1174)。`/terms`・`/privacy` の版・施行日の表示、同意の記録 (DB 関数 `accept_legal_documents` が `user_profiles` の `terms_version_accepted` / `privacy_version_accepted` / `legal_accepted_at` と `terms_acceptances` に書く)、再同意ゲートは、すべてこの定数を見る。内容が変わる改定をするときは、必ず `version` を上げる (上げると全員に再同意を求める)。版・施行日・同意文言は弁護士の確認を経て決める。

- ゲートは `lib/supabase/middleware.ts` (判定は `lib/legal-consent.ts`)。環境変数 `LEGAL_CONSENT_ENFORCE=on` のときだけ、未同意の人を `/legal-consent?next=...` へ回す。強制していない間は、`LEGAL_CONSENT_NOTICE=on` のときだけ `(main)` の画面の上にお知らせを出す。どちらも未設定 (既定) なら何も出さず、誰も止めない。2 つのフラグの読み方は `isLegalConsentFlagOn` で共有する (`ENV_SETUP.md` 参照)。本番は 2026-10-10 から `LEGAL_CONSENT_ENFORCE=on` (オーナー判断。版・施行日は仮置きのまま)。ゲートが掛かるのは Web の画面の取得だけで、モバイルのネイティブの画面と `/api/*` は通らない (#1442)。
- 対象外のパスは `isLegalConsentExemptPath` (`/terms` `/privacy` `/legal` `/legal-consent` `/contact` `/frozen` `/auth/*` `/api/*` `/handson-tour` と静的ファイル)。同意なしで開けないと困る画面 (認証の途中・問い合わせなど) を足すときは、ここと `tests/legal-consent-gate.test.ts` に足す。`/legal-consent` は初期設定の差し戻し (`resolveOnboardingRedirect`) からも除いてある (外すと、初期設定前の新規登録者が同意画面との間で無限にリダイレクトする)。
- 同意済みの版の 3 列は、特権列ガード (`guard_user_profiles_privileged` と `_on_insert`) の対象。書けるのは `accept_legal_documents` (SECURITY DEFINER。`auth.uid()` 本人の行だけ) だけ。この 2 本のガード関数を `CREATE OR REPLACE` するときは、既存の列を外さず、この 3 列も残す (`tests/integration/security/legal-documents-acceptance.test.ts` が検査する)。

### 栄養計算入力

`src/lib/build-nutrition-input.ts` に集約。栄養計算に必要な入力オブジェクトを組み立てる際は、このモジュールを経由する。直接構築しない。

### 外国の AI 事業者への提供の同意 (未同意なら AI へ送らない)

利用者のデータを外国の AI 事業者へ送る処理 (API Route・Edge Function・cron・ジョブ) は、送る手前で同意を判定する (#1154)。判定の本体は `supabase/functions/_shared/ai-consent.ts` の 1 か所で、Next.js は `src/lib/ai/consent-guard.ts` (`requireAiConsent` / `checkUserAiConsent`)、Edge Functions は `supabase/functions/_shared/ai-consent-guard.ts` から呼ぶ。全事業者 (`AI_CONSENT_PROVIDERS`) について現行の版 (`AI_CONSENT_VERSION`) の有効な同意が無ければ送らず 403 `AI_CONSENT_REQUIRED`、読めなければ 503 `AI_CONSENT_CHECK_FAILED` (fail-closed)。新しく AI へ送る経路を足したら判定を呼び、`tests/helpers/ai-consent-enforced-paths.ts` の一覧に載せ、未同意なら送らないことを実際に呼んで確かめる表 (API Route は `tests/ai-consent-enforcement-routes.test.ts`、Edge Function は `tests/ai-consent-enforcement-edge.test.ts`) に行を足す (送信先を足したら `tests/ai-consent-provider-inventory.test.ts` と事業者の一覧・DB の CHECK も直し、版を上げる)。画面は、AI の操作の先頭で `useAiConsent()` の `ensureAiConsent()` を呼び、戻り値が `"declined"` なら送らない。`consentModal` を JSX に描画する。利用者の操作で AI に送る fetch は `aiFetch` (`src/lib/ai/consent-required.ts`) を使い、`isAiConsentRequiredResponse(res)` なら自分のエラー表示を出さない (全画面共通の `AiConsentRequiredHost` が同意画面を出す)。画面を開くと自動で AI に頼む処理は `fetch` のまま、403 なら案内の一文だけを出す。保存・集計と AI を兼ねる API (健康診断・血液検査の保存、ホームの栄養の集計、相談を閉じる) は、未同意なら AI の部分だけを省いて応答の `aiSkipped` で知らせる。画面は `aiSkippedReasonOf` で読み、Web は `AiSkippedNotice` (`src/components/consent/`)、アプリは `apps/mobile/src/components/ai/AiSkippedNotice.tsx` で同意の案内を出す (`tests/ai-consent-skipped.test.ts` が、aiSkipped を返す API を呼ぶ画面の読み忘れを検査する)。案内の文面は `supabase/functions/_shared/ai-consent.ts` に 1 つだけ置き、案内が指す設定の項目 (`AI_CONSENT_SETTINGS_ENTRY_TITLE`) は Web の設定とアプリの設定タブの両方に置く (`tests/ai-consent-settings-entry.test.ts`)。アプリ (apps/mobile) は、AI の API を呼ぶ関数の中で `src/lib/ai-consent.ts` の `handleAiConsentRequiredError` (自動で送る処理は `isAiConsentRequiredError`、fetch を直接使うなら `isAiConsentRequiredResponse`) を呼んで同意画面へ案内する (`tests/ai-consent-mobile-entry-points.test.ts` が、`requireAiConsent` を呼ぶ API を呼ぶアプリの関数の判定漏れを構文木で検査する)。アプリでは、同意で止められたと分かった分岐で例外を投げ直さない (投げ直すと、呼び出し側の catch が「失敗しました」を案内に重ねて出す。`useV4MenuGeneration().generate` は案内を出して `null` を返す。同じテストが構文木で検査する)。受け付けたあとに止めた処理 (キューの献立生成・献立生成の続きの工程・買い物リストの作り直し) は、リクエストの行の失敗の欄 (`weekly_menu_requests.error_message` / `shopping_list_requests.result.error`) にコードではなく人向けの文 (`aiConsentDeniedStoredMessage`) を書き、続きの工程は `invokeMenuContinuation` で呼ぶ (呼んだ先が止めたら再試行も上書きもしない)。画面は失敗の欄を `handleStoredAiConsentFailure` (Web: `src/lib/ai/consent-required.ts`、アプリ: `apps/mobile/src/lib/ai-consent.ts`) に通し、true なら自分のエラー表示を出さない (書く側は `tests/ai-consent-stored-failure.test.ts`、読む側の通し忘れは `tests/ai-consent-stored-failure-readers.test.ts` が構文木で検査する)。同意の記録・撤回は `POST /api/ai/consent` / `POST /api/ai/consent/revoke` だけが service role で書く。文面を変えたら必ず `AI_CONSENT_VERSION` も変える。`tests/ai-consent-entry-points.test.ts` が Web の画面の入口を検査する。e2e のテスト用アカウントは同意済みにしてある (`scripts/lib/e2e-ai-consent.ts`、`tests/e2e/helpers/ai-consent.ts`。同意画面そのものを試す spec だけ `test.use({ aiConsentGranted: false })`)。

### 環境変数

読む環境変数の一覧は `src/lib/env.ts` (zod のスキーマ。公開用 `NEXT_PUBLIC_*` とサーバー用に分け、必須/任意を区別する) に集約する (#1182)。

- **必須** (Supabase の接続情報 3 つ: `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`) は、`src/lib/env-required.ts` の `getSupabaseUrl()` などで取り出す。欠けていれば、サーバーのログに `[env] missing required env: <変数名>` を 1 行出して (ブラウザでは出さない。例外を誰が捕まえても残る)、`MissingEnvError` を投げる (message は固定の文で変数名を含まない。変数名は列挙されない `envName` に持ち、例外が `src/lib/db-logger.ts` の `error()` (`internalError()` 経由を含む) に渡れば構造化ログの metadata `missing_env_name` にも記録される。値は記録しない)。route の 500 は `internalError()` で返す (本文に変数名を出さない。#1172)。service_role のクライアントは `lib/supabase/server.ts` の `getSupabaseAdmin()` を使い、route ごとに自前の取り出しを書かない (自前の取り出しが、変数名入りの文を 500 の本文に返していた。`tests/env-source-scan.test.ts` が、必須の変数名を例外・応答の文字列に書いていないかを検査する)。middleware は欠けていれば `internalError()` の汎用 500 を返す (認証は素通りさせない)。**`process.env.X!` と書かない** (`tests/env-source-scan.test.ts` が検査する)。API route では、認証とレート制限のあと・DB に書き込む前に取り出す (未ログインの呼び出しに設定の不足を教えない。書き込んだあとで気づくと、Edge Function を呼べないまま、リクエストの行を作って失敗として記録する (週間献立は、消した献立を戻す) だけの無駄な動きになる)。
- **任意** (メール・レート制限・AI・課金など) は `src/lib/env.ts` の `getOptionalEnv(name)` で取り出す。無ければ `undefined` を返し、プロセスごとに 1 回だけ警告を出す。**任意の変数が無いことで本番を止めない**。既存の `process.env.X` の読み取りは、ほかの作業と重ならないところから順に置き換える途中 (新しく書くコードは `getOptionalEnv` を使う)。
- 値を読む場所を 1 か所に決めている変数 (一覧の `readOnlyBy`) は、`check:env` の案内のために名前だけが一覧にあり、`getOptionalEnv` では読めない。`CRON_SECRET` / `CRON_SECRET_PREVIOUS` を読むのは `src/lib/cron-auth.ts` だけ (`tests/cron-secret-contract.test.ts` の CC-4)、同意ゲートのフラグ `LEGAL_CONSENT_ENFORCE` / `LEGAL_CONSENT_NOTICE` を読むのは `lib/legal-consent.ts` だけ (middleware は Edge Runtime なので `getOptionalEnv` を使えない)。`tests/env-source-scan.test.ts` が、本番コードでそのファイルだけが読んでいることを検査する。
- `env-required.ts` は何も import しない。ブラウザ向け (`lib/supabase/client.ts`) と Edge Runtime (middleware・`runtime = 'edge'` の route) のコードは `env.ts` を import しない (zod は最小のスキーマでも minify 後に約 59 KB、gzip 約 16 KB 加わるため。`tests/env-source-scan.test.ts` が到達性を検査する)。`env.ts` は `scripts/check-env.mjs` が Node.js から直接読むため、静的に import してよいのは zod だけ。
- 新しい環境変数は、`env.ts` の一覧 (必須にするのは、無いとアプリが動かないものだけ。無いと何が起きるかも書く) と `.env.example` の両方に足す。逆に、採用をやめたサービスの変数を `.env.example` から消すときは、一覧からも消す (`tests/env-source-scan.test.ts` が、Web の本番コードが名前を書いて読む変数が一覧に無いとき (`NODE_ENV`・`NEXT_RUNTIME` を除く) と、一覧の変数が `.env.example` に無いときに失敗する)。`npm run check:env` が `.env.local` などを一覧に照らして検査する (CI には組み込まない。CI にシークレットが無いため)。
- **モバイル** (`apps/mobile`) は `src/lib/env.ts`。`EXPO_PUBLIC_*` は `process.env.EXPO_PUBLIC_X` と名前を直接書く (`process.env[name]` はビルド時に置き換わらず、リリースビルドで常に undefined になる)。必須の `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` が無いと、`lib/supabase.ts` は存在しない接続先のクライアントを作らず、開発中は読み込み時に例外、リリースビルドは `app/_layout.tsx` が設定エラーの画面を出す (足りない変数名を画面に出すのは開発ビルドだけ。リリースビルドでは `lib/supabase.ts` が端末のログに残す)。モバイルの jest では `process.env` を差し替えず、同じオブジェクトを書き換える (`expo/virtual/env` が読み込み時の `process.env` を握るため)。

### localStorage クリーンアップ

`src/lib/user-storage.ts` の `clearUserScopedLocalStorage()` を使う。  
サインアウト処理では **Supabase signOut を呼ぶ前に** このヘルパーを実行する。

### Web のログアウト画面と、モバイルアプリの WebView への通知

Web の画面で利用者がログアウトするときは、`clearUserScopedLocalStorage()` → `notifyNativeSignOut()` (`src/lib/native-auth-bridge.ts`) → `supabase.auth.signOut()` → `broadcastSignOut()` (`src/lib/user-storage.ts`) の順に呼ぶ (#1038)。
`signOut()` の前に `notifyNativeSignOut()` を呼ばないと、`signOut()` の途中の `SIGNED_OUT` が `session-expired` としてネイティブへ先に届き、ネイティブが `user_push_tokens` のこの端末の行を消せなくなる。
`broadcastSignOut()` は `signOut()` のあとに呼ぶ (先に呼ぶと同じタブが `/login` へ移り、`signOut()` が途中で止まる)。`tests/native-sign-out-order-source-scan.test.ts` が検査する。

### 退会 (アカウント削除)

退会の本体は `src/lib/account-deletion.ts` の `deleteAccount()` (#1175)。`POST /api/account/delete` はこれを呼ぶだけにする (退会の入口を増やすときも同じ)。route に手順を書き足さない。`deleteAccount()` は失敗を `ACCOUNT_DELETE_FAILED` (`request_id` と段階 `step` つき) の結果で返し、詳細は `src/lib/db-logger.ts` で `app_logs` に残す。route はそれを `src/lib/api/errors.ts` の `internalError()` (#1172。汎用メッセージだけの 500。`request_id`・段階・DB の生のエラー文は本文に出さない) で返す。

- **`auth.users` を指す外部キーには、必ず `ON DELETE` を書く。** `NO ACTION` のままだと、参照する行が 1 件でも残っている利用者・運営者の `auth.admin.deleteUser` が外部キー違反で失敗する。本人だけの記録は `CASCADE`、サポート・会計・運営者の記録は行を残して `SET NULL` (列は NULL を許す形にする)。`tests/integration/security/auth-users-fk-on-delete.test.ts` が検査する。
- 退会後も行が残る表に、利用者の生のメールアドレスを入れる列を足したら、`prepare_account_deletion` (migration `20261010000100`) で伏せるか、伏せない理由を同じテストの一覧 (H) に書く。
- 利用者のファイルを置く Storage は、先頭のフォルダを `<user_id>/` にする (`src/lib/storage-paths.ts`)。退会はこのフォルダを丸ごと消す (`src/lib/account-deletion-storage.ts`)。それ以外の場所に置くと、DB の URL から辿れるものだけが消える。

### エラー境界 (画面の描画中の例外を受ける)

画面の描画中に起きた例外を受ける境界が無いと、Web ではルート全体を置き換える `global-error.tsx` まで、モバイルではアプリ全体のクラッシュまで届く (#1207)。新しい route group / layout を足すときは、境界も足す。

- **Web**: layout (`layout.tsx`) を持つ区画には、同じ階層に `error.tsx` を置く。中身は共通部品 `src/components/error/RouteError.tsx` を返すだけにする (手書きしない)。`RouteError` は「再試行」(`router.refresh()` + `reset()`)・戻るリンク・記録 (`src/lib/report-boundary-error.ts`) をそろえる。`reset()` だけではサーバーコンポーネントの例外から復帰できないため、`router.refresh()` を一緒に呼ぶ。例外の文面・スタックは画面に出さず、出すのは `digest` だけ。記録に URL / パスを入れない (`/invite/{token}` など URL に秘密が入るページがあるため)。`tests/route-error-boundaries.test.tsx` が配置と表示を検査する。
- **モバイル**: `apps/mobile/app` の `_layout.tsx` は、すべて `export function ErrorBoundary` を持ち、`src/components/ErrorFallback.tsx` を返す。expo-router は、この export がある layout の中の例外だけを受ける (無いと誰にも受けられない)。Provider の外 (ルートの境界) でも描画されるので、`ErrorFallback` は hooks や Provider に頼らない。`apps/mobile/__tests__/app/error-boundaries.test.tsx` が全 layout を検査する。記録は `apps/mobile/src/lib/error-report.ts`。送り先はサーバーログ (`POST /api/log`。サーバー側で秘密情報をマスクしてから `app_logs` に保存する) だけで、外部の計測サービスには送らない (#1166)。例外の文面とスタックは切り詰め、画面のパス (ルート名) は記録しない。`apps/mobile/__tests__/lib/error-report.test.ts` が、送り先と送る内容を固定している。

---

## Web アプリは Next 14 + React 18 (React 19 / Next 15 前提の API は使わない)

- Web アプリ (`src/`) は **Next.js 14 + React 18** で動く。React 19 / Next 15 ではない (モバイルの `apps/mobile` だけが Expo 53 + React 19)。`docs/design/` には Next 15 / React 19 前提の記述が残っているが、実装の現状はこの節が正。
- **React 19 / Next 15 前提の API は `src/` で使わない**: `use` / `useActionState` / `useOptimistic` (`react`)、`useFormStatus` (`react-dom`)。ESLint の `no-restricted-imports` と `no-restricted-properties` が `src/**` で止める (#1199)。`import * as React from 'react'` も同じルールに掛かるので、名前付き import (`import { useState } from 'react'`) を使う。`import React from 'react'` のあとの `React.use(...)` なども止まる。
  - 禁止する理由は、Next 15 / React 19 前提の書き方を持ち込まないため。Next 14 の App Router が同梱する React (canary) には `use` / `useOptimistic` / `useFormStatus` が実在するが、`useActionState` は無く、Next 14 の `params` は Promise ではない。
  - ルールの対象は `src/**` だけ。モバイルと、ルート直下の `components/` ・ `lib/` (`@/` の別名の逃げ先 `./*` 経由で Web からも使われる) は対象外。そこにも React 19 / Next 15 前提の API を書かない。
- **型検査ではこれらを止められない。止めているのは上の ESLint ルールだけなので、外さないこと。** Next 14 の型 (`next/types/index.d.ts`) が `react/experimental` と `react-dom/experimental` (canary の型) を読み込むため、`@types/react` が 18 系でも `use` / `useOptimistic` / `useActionState` / `useFormStatus` は `npm run typecheck` を通る。この前提は `tests/eslint-react19-guard.test.ts` が確かめる。
- Next 14 のページでは `params` は Promise ではなく普通のオブジェクト。`use(params)` は実行時に例外になる (#1275)。クライアントページでは `useParams()` を使う。
- 型の版は実行時の React にそろえてある。ルート `package.json` の `@types/react` / `@types/react-dom` は **18 系**。これで React 19 の型にしかない書き方 (例: `<Context value={...}>`) は型検査で落ちる (上の API は止まらない)。モバイルは自前の `@types/react ~19.0.10` を `apps/mobile/node_modules` に入れ子で持ち、`apps/mobile/tsconfig.json` の `paths` で `react` の型をそれに固定している (外すとモバイルの型エラーが増える)。ルートの型だけを 19 系に上げない。`tests/react-types-version-contract.test.ts` が検査する。
- React 19 / Next 15 への移行は別タスク。やるときは `react` と `@types/react` を一緒に上げ、`eslint.config.mjs` のルールとそのテスト (`tests/eslint-react19-guard.test.ts`)、`apps/mobile/tsconfig.json` の固定、この節も更新する。
- ルートで依存を更新する `npm install` は、`react-native` の peer (`react@^19`) とルートの `react@18` が衝突して ERESOLVE になることがある (モバイルが React 19 を入れ子で持つ構成のため)。その場合は `npm install --package-lock-only --legacy-peer-deps` で `package-lock.json` だけ更新し、続けて `npm install --package-lock-only` を 1 回実行して形をそろえる。差分が意図した変更だけであることと `npm ci --dry-run` が通ることを確認する。

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

## マージ前の検査 (ローカル CI)

PR の検査は `bash scripts/local-ci.sh` でローカルに回せる (CI の ci.yml・mobile-test.yml・security-regression.yml・e2e-local.yml と同じコマンド・同じ件数、security.yml の gitleaks (シークレットの検査) と同じ版・同じ設定・同じ範囲 (PR で増えるコミット)。TZ=UTC・main を取り込んだマージ状態・まっさらな worktree で回す)。

- migration を含まない PR は、local-ci.sh の 5 段 (secrets・unit・mobile・integration・e2e) が緑で、出力の Markdown (sha と件数) を PR 本文に貼れば、CI の完了を待たずにマージしてよい (オーナー判断 2026-10-09)。CI の結果はマージ後に確かめ、赤なら直す。
- secrets 段 (gitleaks) が赤のときはマージしない。リポジトリは公開なので、main に入った秘密は取り消せない (本物のキーなら無効にして発行し直す。ダミーなら `.gitleaks.toml` か行末の `gitleaks:allow`)。
- 依存 (`package.json` / `package-lock.json`) を変える PR は、security.yml の dependency review (high 以上の既知の脆弱性がある版を入れていないか) の緑を待ってからマージする。これは GitHub の Dependency graph を使うので、ローカルでは再現できない。
- PR で動くワークフローのうち local-ci.sh に写していないもの (と理由) は `tests/local-ci-workflow-sync.test.ts` の `EXCLUDED_WORKFLOWS` / `EXCLUDED_JOBS` にある。PR で動くワークフロー・ジョブを足したら、local-ci.sh に写すか、そこに理由を書く (書かないと `npm test` が落ちる)。
- migration (`supabase/migrations/**`) を含む PR は、Deploy Supabase Migrations の PR ジョブ (本番台帳とのドリフト検知) の緑を待ってからマージする。これはローカルでは再現できない。
- 本番への反映 (Vercel・`db push`・functions deploy) は従来どおり PR → main → CI の経路だけ。

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
*.upstash.io
```
または `Full` (全許可)。

### 引き継ぎ
新セッション開始時は `docs/handover/2026-05-08.md` を Read してから着手 (リポジトリ内に複製済み、CCCloud / ローカル両方から読める)。

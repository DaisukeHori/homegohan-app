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
  - **npm audit**: 本番で動く依存 (`npm audit --omit=dev`) に critical の脆弱性があれば失敗し、PR を止める (#1444 で critical が 0 件になったので切り替えた)。high 以下は止めず、件数を Summary に出す。止めない検査に戻すときは、**`continue-on-error` をジョブではなく npm audit の「ステップ」に付ける。** ジョブに付けると、ワークフローは通っても、そのジョブの check run が失敗 (赤い ×) のまま残る。すると、すべての PR の Checks が赤くなり、毎日の整合性チェック (`scripts/lib/consistency-check.mjs`) も、止まっている PR を「赤のまま」に数える (`tests/security-workflow.test.ts` が、`pull_request` で動くワークフローのジョブ単位の `continue-on-error` を検出する)。
  - **依存関係レビュー**と **CodeQL**: リポジトリが公開の間だけ動く。非公開にすると自動でスキップされる。依存関係レビューは、リポジトリの Dependency graph が無効の間 (GitHub が依存の差分を 403 Forbidden で断る) だけ、レビューを飛ばして警告と Summary を出す (すべての PR を赤くしないため)。有効にすれば、次の PR から止める検査として働く。CodeQL のジョブそのものは止めないが、コードスキャンの結果を知らせる別の check run が付き、新しい重大なアラートが増えた PR では赤くなる。
- gitleaks の誤検知は `.gitleaks.toml` に**値そのもの**を足す (ファイル・ディレクトリ単位では除外しない)。1 行だけなら行末に `gitleaks:allow`。本物のキーが見つかったときは除外せず、そのキーを無効にして発行し直す (履歴から消すだけでは取り消せない)。gitleaks の版と SHA-256 は workflow に固定してある。上げるときはリリースの `checksums.txt` の値に合わせる。
- **テストに書くダミーの認証値** (`apiKey` / `token` / `secret` / `password` など) は、gitleaks の汎用ルール (generic-api-key) に掛かりやすい。掛かると PR の `security / gitleaks` が失敗するので、ダミーの値の行の末尾に `gitleaks:allow` と書く。ダミーでも、`sk-` や `ghp_` や JWT のような、本物のキーの書式にしない。
- `.github/dependabot.yml`: npm (ルートの package-lock.json が workspaces をまとめて管理) と GitHub Actions を週 1 回。マイナー・パッチは 1 本の PR にまとめる。Next / React / Expo / React Native は、メジャー更新 (Expo / React Native はマイナー更新も) の PR を出さない。計画して上げる (#1199・#1444)。自動承認・自動マージはしない。
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

メールは `src/lib/emails/send.ts` の `sendEmail(envelope)` で送る。`sendEmail(envelope)` は送信待ち (`email_outbox`) に登録し、送るのは worker (`/api/cron/email-outbox`)。戻り値は `{ ok, id, attempts, error }` で (`ok: true` は送信待ちに登録した。`id` は `email_outbox.id`)、失敗では例外を投げない (#1193)。

- 登録の時点の失敗 (文面の不備 `invalid_envelope`・宛先停止リスト `suppressed`・登録の失敗 `outbox_failed`) と `RESEND_API_KEY` 未設定は、`sendEmail` が `createLogger('email')` で app_logs に残す。送信の失敗は worker が行 (`last_error_code`) と app_logs (`cron/email-outbox`) に残す。残すのは文面の名前 (`template`)・マスクした宛先・エラーコードだけ。呼び出し側が戻り値を見なくても、失敗は記録される。
- 再試行は worker が行う: 429 / 5xx / 通信エラーだけ、1 分 → 5 分 → 15 分 → 1 時間 → 4 時間の間隔で、最初の 1 回を含めて最大 `EMAIL_OUTBOX_MAX_ATTEMPTS` 回 (既定 6 回) 送る (docs/design/operator/10-logs-and-mail-retry.md §6.1)。行に保存した同じ Idempotency-Key を付けるので二重送信にならない。使い切った・直らない失敗は届けられなかった (dead) になり、運用メール (`OPS_ALERT_EMAIL`) で知らせ、`/super-admin/email-outbox` で再送できる。再試行は呼び出し側の「試行回数」には数えない。
- 失敗したときに追加の処理 (送信記録の保存・画面への表示・文脈つきのログ) をする呼び出し側だけが、結果を見る。判定は `src/lib/emails/send-result.ts` の `isEmailFailure` / `emailFailureReasons` を使う。`RESEND_API_KEY` が無くて送らなかった結果は `ok: false` かつ `skipped: true` で、失敗には数えない。
- 新しい文面 (`render*Email`) は、返す封筒に `template` (snake_case の名前) を必ず入れる (`src/__tests__/lib/emails/template-names.test.ts` が検査する)。
- 呼び出し側のテストで `@/lib/emails/send` をモックしても、`send-result.ts` は別ファイルなので実物のまま使える。

### ロール認可

API Route (`src/app/api/**`) のロール認可は、共通ヘルパーを入口で呼ぶ。`getUser()` → `user_profiles` の取得 → ロール判定を route に手書きしない (#1161。`tests/role-check-source-scan.test.ts` が検査する)。

- 運営ロール (support / admin / super_admin など): `requireRole([...])` (`src/lib/auth/helpers.ts`)
- 組織の管理者 (所属組織の `org_role` が owner / admin): `requireOrgAdmin()` (同上。判定の実体は `src/lib/auth/org-admin.ts` の `isOrgAdmin`。roles 配列の `org_admin` は見ない)
- 他ユーザーの行を読む必要があるとき (`user_profiles` などは RLS で本人の行しか見えない) だけ、認可を通した**あとに** `getSupabaseAdmin()` (service_role) を使う。認可の前には使わない。使うときは、対象を絞る条件 (対象ユーザーの id など) を必ず付ける
- 500 の本文は汎用メッセージだけにし、DB の生のエラー文は返さない。詳細は上記の構造化ログに残す (#1172)。route では共通ヘルパー `internalError(routeName, error, ctx?)` (`src/lib/api/errors.ts`) を `return` する。構造化ログへの記録と、汎用の本文 `{ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' }` の返却を一度に行う。`error` は文字列のままにする (画面が `data.error` をそのまま表示するため。オブジェクトにすると描画で落ちる)。運営 API のように `error.message` を読むクライアントには `{ shape: 'nested' }` を渡す
- 応答の本文 (`NextResponse.json` / SSE の `JSON.stringify` など) に、捕まえたエラーの `message` / `details` / `hint`・`String(err)`・エラーのオブジェクトそのものを入れない。4xx で理由を伝えるときは、こちらで決めた固定の文を返す (DB の結果のエラー文も、catch で受けた例外の文面も、4xx でも返さない。try の中で `if (error) throw error` すると DB の生のエラーが catch に届くため。例外の文面を 4xx で返してよいのは、`err instanceof AuthError` など文面をこちらで書いている例外のクラスに絞り込んだ分岐の中だけ)。`tests/api-raw-error-message-scan.test.ts` が src/app/api の全 route を走査し、1 件でもあれば落ちる (#1172 第 2 段で既存の違反を全部直し、許可リストは無くした)。ただしこの走査はよくある書き方の見張りで、網羅はしない (捕まえない書き方はテストの冒頭に列挙してある。保証の本体は route のコードで、レビューで見る)。外 (Edge Function・外部 API) の応答の JSON の `error` も本文に入れない (Edge Function は DB のエラー文を包んで返すことがある。ログにだけ残す)。外の応答の JSON をまるごと本文に返さない (成功の応答にも失敗の文が入ることがある。返すのは必要な値だけ)
- route が本文に入れる値を作る src/lib のヘルパー (結果の `error` / `message` を返すもの) も、DB の生のエラー文を結果に入れない。DB の失敗は固定の文にし、元のエラーは構造化ログ (`createLogger(...).error`) か、route が `internalError()` に渡す `cause` にだけ残す (例: `applyUserBan` の `kind: 'internal'` + `cause`、`createOrgInviteWithEmail` の `internalCause`)。`tests/lib-raw-error-message-scan.test.ts` が src/lib を走査し、結果のオブジェクトにエラーの `message` / `details` / `hint` を入れていたら落ちる (本文に届かないことを確かめたものだけ、理由つきの許可リストに件数で固定)
- DB の列に保存された失敗の文 (Edge Function と Next.js の API が書く列。#1478 より前の行には、Edge Function が catch で捕まえた例外の文面が残っている) を本文に返すときも、こちらで書いた文 (同意の文など、画面が見分ける文) だけをそのまま返し、それ以外は固定の文にする (#1172)。`weekly_menu_requests.error_message` は `src/lib/weekly-menu-request-error.ts` (状態の確認の API とアカウントのデータ書き出し)、`shopping_list_requests.result.error` は `src/lib/shopping-list-request-error.ts` (状態の確認の API) を通す。書く側の Edge Function (generate-menu-v4 / v5・regenerate-shopping-list-v2) も、例外の文面を書かず `supabase/functions/_shared/stored-failure-messages.ts` の定型の文を書き、元の文は console と構造化ログにだけ残す (#1478)。Realtime や直接の select で行を受ける画面は、Web (フック `useV4MenuGeneration` と、買い物リストの作り直しの行も受ける週の献立の画面) は `weeklyMenuRequestErrorMessageForDisplay` / `shoppingListRequestErrorMessageForDisplay`、アプリ (生成のフック `useV4MenuGeneration`) は `apps/mobile/src/lib/menu-request-error.ts` の `menuRequestErrorMessageForDisplay` を通す (#1576。アプリの週の献立・買い物リストのネイティブの画面は、通常の操作で届かないので #1598 で消した。`tests/request-error-display-screens.test.ts` が画面のソースを見張る)。進まなくなった行の印 (`stale_request_timeout`) は行には英語のまま書き、本文・画面では日本語の文 (`MENU_REQUEST_STALE_DISPLAY_MESSAGE`) にする。`ai_action_logs.result.error` (#1172 の前の AI 相談のアクションが DB の生のエラー文を入れていた) と `recipe_requests.error_message` は、アカウントのデータ書き出し (`src/lib/account-export-tables.ts` の transform) で空でなければ固定の文にする。この書き方は `tests/api-raw-error-message-scan.test.ts` の走査では捕まえない (冒頭の「この検査の限界」)。書き出しの表は `tests/account-export-tables.test.ts` が、失敗の文が入りうる名前の列 (error / failure / result) に生のエラー文を入れて transform を通し、出ないことを確かめる (名前で見る見張り)

### レート制限

`src/lib/rate-limit.ts` に集約する (#1197)。新しい制限は `RateLimitCategory` にカテゴリを足し、`checkRateLimit(key, category)` で判定する。route ごとに Upstash / in-memory の制限を自前で作らない (`tests/rate-limit-single-implementation.test.ts` が `@upstash/ratelimit` を使うファイルを検査する)。key は認証で確定した ID を使い、ログイン前の公開 API (お問い合わせ) だけクライアント IP を使う。

### AI の利用回数の上限と記録

`src/lib/plan/entitlements.ts` に集約する (#1177 / #1149)。AI の利用は 1 日 (JST の暦日) の全機能の合計の回数で数え、プランごとの上限 (DB の `ai_daily_limits`。free = 1 日 3 回・pro と family_basic = 30 回・family_pro = 50 回 (billing/03 §6.5)。究極モードも合計の 1 回に数える。自分の行が無いプランは free の値。運営画面 `/super-admin/llm/quotas` から保存) と、プラン × 機能ごとの上限 (DB の `ai_plan_feature_caps`。0 = そのプランでは使えない。止めたときは 403 `AI_FEATURE_NOT_IN_PLAN`) を超えたら止める。AI を使う API ルートは、AI 事業者へ送る直前 (認証・同意の判定・`checkRateLimit`・入力の検証などの判定をすべて通ったあと) に、ユーザーの 1 回の操作につき 1 回 `const aiUsage = await consumeAiUsage(user.id, feature)` を呼び、`if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage)` で止める。判定と記録は DB の `consume_ai_usage` が 1 回の呼び出しで原子的に行う (上限に達していれば記録せずに止め、達していなければ +1。同じ利用者・同じ日は 1 本ずつ判定する)。記録の DB 関数 (`record_ai_usage`) を入口から直接呼ばない。AI を実際に呼ばない経路 (キャッシュを返すだけなど) では呼ばない。DB の関数が失敗したときはログに残して許可する (判定の失敗で AI の機能を止めない)。プランの判定は `get_effective_plan` (個人の契約 -> 家族 -> 組織 -> `free`)。

- 止め方は入口ごとに決める (`tests/helpers/ai-consent-enforced-paths.ts` の一覧の上の表): 利用者が押した操作は 429 `AI_DAILY_LIMIT` (固定の文・`retryAfter` = 次の JST 0 時までの秒数)、保存と AI の分析を一緒にする操作 (健康診断・血液検査・相談を閉じる) は保存だけして `aiSkipped: AI_DAILY_LIMIT`、料理画像の副作用は画像だけ見送る、キューに積む操作は積む時点で判定する。
- 上限に数えない機能 (`AI_UNMETERED_FEATURES`): 画面を開く・保存するだけで呼ばれる AI。`nutrition_advice_auto` (ホームの栄養のアドバイス・栄養士のコメントの自動の取得) と `meal_image_auto` (料理を保存・更新したときに付ける料理画像。AI 相談の update_meal も同じ。利用者が押して画像を作る `POST /api/ai/image/generate` は `image_generation` で上限に数える)。1 日の上限の合計には入れないが、どれで数えるかの材料はクライアントが送る値なので、機能ごとの 1 日の安全弁 (DB の `ai_unmetered_daily_caps`。既定は `nutrition_advice_auto` = 30・`meal_image_auto` = 20。`AI_UNMETERED_DAILY_CAP_DEFAULTS` と同じ値。行の無い機能は 20) を `consume_ai_usage` が判定し、超えたら `allowed: false` を返す (入口は上の止め方で止める)。値を変えるときは DB の行を更新する。上限に数えない機能を足すときは、`AI_UNMETERED_FEATURES`・DB の `c_unmetered`・安全弁の既定の行の 3 か所をそろえる (`tests/ai-usage-contract.test.ts` が突き合わせる)。
- 究極モード (#1142): 1 日の上限とは別に、利用者ごと・1 日 (JST) の回数の上限を持つ。`ai_plan_feature_caps` に行のあるプランでは行の値 (free 0 / pro 2 / family_basic 2 / family_pro 3。billing/03 §6.5。0 は使えない = 錠) で、`consume_ai_usage_capped` は環境変数の上限を使わず `consume_ai_usage_at` に任せる。行の無いプラン (組織のプランなど) にだけ環境変数の上限が効く (既定 `AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT` = 1。環境変数 `AI_ULTIMATE_MODE_DAILY_LIMIT` で上書き。Vercel と Edge Functions の secrets に同じ値。一覧 `src/lib/env.ts` では Web で値を読むのは `src/lib/plan/entitlements.ts` だけ (`readOnlyBy`))。機能名 `menu_generation_ultimate` (上限に数える機能。1 日の上限の合計にも 1 回入る) で数え、`consumeAiUsage` / `consumeEdgeAiUsage` が機能名を見て DB の `consume_ai_usage_capped` (機能ごとの上限 → 1 日の上限を同じロックの中で判定) を呼ぶ。究極モードかどうかは本文の `ultimateMode` が真偽値の `true` のときだけ (`isUltimateModeRequested`。`src/lib/ai/ultimate-mode.ts`)、数える機能名と生成に渡す値をこの結果でそろえる。止めたときは 429 `AI_DAILY_LIMIT` で本文に `cappedFeature` が付き、文は究極モードの文 (`aiDailyLimitMessageOfDenied`)。機能ごとの上限を持つ機能を足すときは `AI_CAPPED_FEATURES` (`_shared/ai-usage-core.ts`) と `AI_DAILY_CAPPED_FEATURES` (`_shared/ai-daily-limit.ts`) をそろえる (`tests/ai-usage-contract.test.ts` が突き合わせる)。
- 写真の「オート」(判別 `POST /api/ai/classify-photo` → 解析 `analyze-*`) は 1 回の操作を 1 回と数える。判別が `consumeAiUsage` で数えたあと `issueAiUsageGrant` で数え済みの印を作って応答の `aiUsageGrant` で返し、画面 (Web `src/app/(main)/meals/new/page.tsx`。モバイルのスキャンのタブはこの画面を WebView で出す。以前のネイティブの `apps/mobile/app/meals/new.tsx` は届かない画面として消した。#1598) は続く解析の本文の `aiUsageGrant` に入れて送る。解析は `redeemAiUsageGrant` が true (署名・期限 10 分・本人・機能が合い、DB の `claim_ai_usage_grant` で印をはじめて使用済みにできた) のときだけ数えずに `AI_USAGE_COVERED_BY_GRANT` で進み、それ以外は `consumeAiUsage` で数える。判別だけを無料にする形にしない (判別は解析の結果まで返すので抜け道になる)。
- 数えたあと、AI へ送る前に DB の処理が失敗して何も送らなかったとき (生成のリクエストの行の insert の失敗など) は `refundAiUsage(user.id, feature, aiUsage)` で 1 回を戻す (上限に数えない機能も戻す。安全弁の回数に入るので)。AI へ送ったあとの失敗では戻さない。
- 順番は「同意の判定 (`requireAiConsent` / `checkUserAiConsent`、Edge は `requireAiConsentForUser` / `checkAiConsent`。#1154) → `consumeAiUsage` → AI への送信」。同意が無くて止めた操作は数えない。
- Edge Function は、ユーザーの JWT を確かめた経路で `consumeEdgeAiUsage` (`supabase/functions/_shared/ai-usage.ts`) を呼び、上限なら `aiDailyLimitEdgeResponse` で止める。service role / cron の経路では呼ばない (Next.js が数え済み)。
- 画面: Web は `aiFetch` が 429 `AI_DAILY_LIMIT` を見つけると全画面共通の `AiDailyLimitHost` が固定の文を出す。モバイルは `getApi()` がこの Error を固定の文の `AiDailyLimitError` に置き換える (生の文字列を出さない)。`getApi()` を通らない生の fetch (AI 相談のシートのストリーミングの送信) は、失敗の応答から `errorOfFailedResponse` (`apps/mobile/src/lib/failed-response.ts`。503 の緊急停止・メンテナンス中も同じ関数で固定の文にする) で Error を作って投げる (生の fetch の呼び出しの分類は `tests/ai-daily-limit-mobile-raw-fetch.test.ts`)。文は `supabase/functions/_shared/ai-daily-limit.ts` (Web・モバイル・Edge 共用)。
- Next.js が Edge Function を**ユーザーの JWT で**呼ぶとき (`supabase.functions.invoke`) は、`headers: await aiUsageRecordedHeaders(user.id)` を付ける (署名つきの印。付けないと Edge 側でも数えて二重になる)。
- どの入口が記録するかは、同意の判定と同じ一覧 `tests/helpers/ai-consent-enforced-paths.ts` の `usage` の列に書く (入口の一覧は 1 つ)。新しい AI の入口を足したら、その一覧に行を足し、`tests/ai-consent-enforcement-routes.test.ts` の表に実際に呼ぶ行を足す (同意の判定 → 上限の判定と記録 → 送信の順と、上限に達したときに送らないことは、この表が実際に route を呼んで確かめる)。`tests/ai-usage-contract.test.ts` は、`consumeAiUsage` を呼ぶファイル・機能名・結果を見ていること・公開ハンドラの一覧が `usage` の列と一致することを検査する。
- キューのテーブル (`weekly_menu_requests` / `meal_image_jobs`) は、service role の処理 (cron の `process-menu-queue`・Edge Function の `process-meal-image-jobs`) が AI へ送る。利用者 (authenticated) からは読むだけで、書けない (#1465。INSERT / UPDATE / DELETE の権限とポリシーを外した)。Next.js で行を積む・書き換えるのは、本人の確認と記録を通った API ルートだけで、`src/lib/ai/ai-queue-writer.ts` の `getAiQueueWriter()` (service role) を変数名 `queueDb` で受けて書く (RLS が効かないので、UPDATE は `.eq('user_id', user.id)` で本人の行に絞る)。`meal_image_jobs` には、ほかに次も service role で書く: 献立の生成の Edge Function (`generate-menu-v5` / `generate-menu-v4`) の `saveMealToDb` (`supabase/functions/_shared/save-meal.ts` → `_shared/meal-image-jobs.ts` の `enqueueMealImageJobs`。生成のリクエストの持ち主の行)、積み直しの道具 (`scripts/requeue-pending-meal-images.ts`・中身は `scripts/lib/meal-image-backfill.ts`。本番への一括の書き込みなのでオーナーの承認のあとに流す)、処理中のまま止まったジョブを取り戻す pg_cron のジョブ `requeue-stale-meal-image-jobs` (`public.requeue_stale_meal_image_jobs()`。#1561)。待ちのまま残ったジョブは pg_cron のジョブ `process-pending-meal-image-jobs` が 5 分ごとに拾い、`process-meal-image-jobs` を起こす (#1561)。画面・モバイルからこの 2 つの表へ書かない。`tests/ai-usage-contract.test.ts` (migration から、利用者が書けないこと) と `tests/ai-queue-writes-contract.test.ts` (ソースから、書き込みが `queueDb` からだけであること)、`tests/integration/rls/ai-queue-writes.test.ts` (実 DB) が確かめる。

### 機能フラグ

機能の ON/OFF は `feature_flags` テーブル (運営画面 `/super-admin/flags` で切り替える) に置き、判定は `src/lib/feature-flags.ts` の `isFeatureEnabled(key, userId?)` を使う (#1148)。route や画面ごとに `feature_flags` / `system_settings` を自分で読まない (`tests/feature-flags-single-source.test.ts` が検査する)。以前の `system_settings` の `feature_flags` は、ログイン中のユーザー自身の権限で読んでいたため、admin 以外には値が届かなかった。

- 新しいフラグは、`FEATURE_FLAG_DEFAULTS` に「行が無い・読めないときの値」を足し、migration で `feature_flags` に行を作る (`ON CONFLICT (key) DO NOTHING`)。既定値は**止めない側**にする。画面が前もって確かめるフラグだけ `CLIENT_FEATURE_FLAG_KEYS` (`GET /api/feature-flags`) に足す (いま、この API を呼んでいる画面は無い。#1457)。
- `isFeatureEnabled` は例外を投げない。行が無い・読み出しに失敗・待ちきれないときは既定値で答え、失敗は構造化ログに残す。値はサーバーのメモリに 30 秒覚えるので、切り替えの反映に最大 30 秒かかる (proxy (`src/proxy.ts`) と API route はメモリを共有するとは限らない)。
- `ai_chat_enabled` は AI 相談の緊急停止スイッチ。通常は ON のまま使う。利用者の同意の有無で AI への送信を止めるのはこのスイッチではなく、同意の判定 (`requireAiConsent` / `checkUserAiConsent`、下の「外国の AI 事業者への提供の同意」の節) が担う (スイッチが ON でも、未同意なら送らない)。AI 相談の API を足すときは、認証のあと・レート制限の前に `aiChatDisabledResponse` (`src/lib/ai/ai-chat-gate.ts`) を呼ぶ。利用者の JWT で直接呼べる Edge Function `knowledge-gpt` も、JWT の経路で認証の直後・同意の判定の前に同じスイッチを見る (`supabase/functions/_shared/ai-chat-flag.ts` の `aiChatDisabledResponseForUser`。判定は Next.js と共用の `_shared/feature-flag-eval.ts`、読めないときは ON。#1486。`tests/ai-chat-flag-edge.test.ts`)。`maintenance_mode` はメンテナンスモード (admin / super_admin は通す。ミドルウェアが判定する。止めないパスは `src/lib/maintenance-mode.ts` の `isMaintenanceExemptPath`。画面は `/login`・`/auth/*`・`/terms`・`/privacy`・`/legal`・`/contact` を通し、`/signup` と、その画面が呼ぶ API (お問い合わせの送信など) は止める。#1486)。
- 緊急停止中 (503 `AI_CHAT_DISABLED`)・メンテナンス中 (503 `MAINTENANCE_MODE`) の応答を受けた画面は、本文の文字列 (JSON) を出さず、code から決めた固定の文を出す (#1457)。どちらの本文も平らな形 `{ error: 固定の文, code, retryAfter }` で、`error` は文字列にする (Web の画面が `data.error` をそのまま出しても落ちない。#1486)。文と code の置き場は `packages/shared/src/service-unavailable.ts` の 1 つ (サーバーの応答も同じ値)。モバイルは `getApi()` がこの 503 を `ServiceUnavailableError` (message が固定の文) に置き換えて投げ直す。`getApi()` を通らない生の fetch でアプリの API を呼ぶ場所は、失敗の応答から `errorOfFailedResponse` (`apps/mobile/src/lib/failed-response.ts`。429 `AI_DAILY_LIMIT` も同じ関数で固定の文にする) で例外を作る (AI 相談は `tests/mobile-service-unavailable-raw-fetch.test.ts`、アプリの API を呼ぶ生の fetch の全部は `tests/ai-daily-limit-mobile-raw-fetch.test.ts` が見張る。#1486)。モバイルは、同意の状況を読めなかった 503 `AI_CONSENT_CHECK_FAILED` も同じく固定の文 (`AI_CONSENT_CHECK_FAILED_MESSAGE`) にする (#1486)。
- `system_settings` の `feature_flags` 行は、もう何も読まない。運営のシステム設定の API・画面では読み取り専用 (`src/lib/super-admin/retired-settings.ts`。GET は `read_only` / `note` を付け、PUT は 409 `SETTING_READ_ONLY`)。行は消していない。
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

- ゲートは `lib/supabase/middleware.ts` (判定は `lib/legal-consent.ts`)。環境変数 `LEGAL_CONSENT_ENFORCE=on` のときだけ、未同意の人を `/legal-consent?next=...` へ回す。強制していない間は、`LEGAL_CONSENT_NOTICE=on` のときだけ `(main)` の画面の上にお知らせを出す。どちらも未設定 (既定) なら何も出さず、既存の利用者は止めない。ただし、初めてサインインした新規の人 (初期設定を始めておらず、いまの版に未同意) は、フラグに関わらず `/auth/callback` が `resolveFirstSignInDestination` で同意画面へ回す (#1435)。2 つのフラグの読み方は `isLegalConsentFlagOn` で共有する (`ENV_SETUP.md` 参照)。本番は 2026-10-10 から `LEGAL_CONSENT_ENFORCE=on` (オーナー判断)。いまの版・施行日は `v2026.3` / `2026-10-22` (#1930。billing/03 段 E で有料プランの条文を足した)。それより前は `v2026.2` / `2026-10-21` (#1917。退会の条件)、`v2026.1` / `2026-10-19` (#1901 の設計書 cross/20。#1918 で公開)。施行日は公開 (デプロイ) の日。`/api/*` は middleware の `/api` の分岐 (403 `LEGAL_CONSENT_REQUIRED`。許可リストは `packages/shared/src/legal-consent-api.ts`) で止める (#1442・設計書 cross/13a)。同意ゲートは生年月日の未入力と、保護者の同意とのつながりが無い 18 歳未満も同意画面へ回す (#1173・cross/14)。モバイルはルートのゲート (`GET /api/legal/status` と `/api` の 403) で、同意が要る間はアプリの画面を Web の `/legal-consent` の WebView 1 つにする (#1442・設計書 cross/13b)。
- 対象外のパスは `isLegalConsentExemptPath` (`/terms` `/privacy` `/legal` `/legal-consent` `/contact` `/frozen` `/auth/*` `/api/*` `/handson-tour` と静的ファイル)。同意なしで開けないと困る画面 (認証の途中・問い合わせなど) を足すときは、ここと `tests/legal-consent-gate.test.ts` に足す。`/legal-consent` は初期設定の差し戻し (`resolveOnboardingRedirect`) からも除いてある (外すと、初期設定前の新規登録者が同意画面との間で無限にリダイレクトする)。
- 同意済みの版の 3 列は、特権列ガード (`guard_user_profiles_privileged` と `_on_insert`) の対象。書けるのは `accept_legal_documents` (SECURITY DEFINER。`auth.uid()` 本人の行だけ) だけ。この 2 本のガード関数を `CREATE OR REPLACE` するときは、既存の列を外さず、この 3 列も残す (`tests/integration/security/legal-documents-acceptance.test.ts` が検査する)。

### JST の暦日 (今日・期間・日付のずらし)

DB の日付列は JST の暦日で、Vercel / Edge の実行環境は UTC (#1433・#1463)。サーバーの「今日」・期間・月は `src/lib/jst-day-ranges.ts` (`jstToday` / `jstDayOffset` / `mondayWeekRange` / `sundayWeekRange` / `jstDayRangeTimestamps` など。Edge は `supabase/functions/_shared/jst-date.ts`)、日付のずらしは `addDaysToDate` (`@/lib/date-utils`) で求め、`toISOString().slice(0, 10)`・`parseLocalDate` / `setDate` + `formatLocalDate` のようなローカル時刻・UTC の暦日に頼る書き方をしない。外から受け取った日付は `isCalendarDate` (Zod は `src/lib/calendar-date-schema.ts` の `CalendarDateSchema`) で確かめてから DB や上の関数に渡す (存在しない日付が DB まで届くと 500、範囲の外の日付は `addDaysToDate` が RangeError)。timestamptz の列を日付で絞るときは `jstDayRangeTimestamps` / `jstOptionalDayRangeTimestamps` で JST 0 時の時刻にする。
`tests/jst-today-source-scan.test.ts` が書き方 (規則 A〜J) を構文木で検査し、直した箇所が JST の関数を呼び続けていることも確かめる (例外は理由つきの許可リストに書く)。

### 栄養計算入力

`src/lib/build-nutrition-input.ts` に集約。栄養計算に必要な入力オブジェクトを組み立てる際は、このモジュールを経由する。直接構築しない。

### 外国の AI 事業者への提供の同意 (未同意なら AI へ送らない)

利用者のデータを外国の AI 事業者へ送る処理 (API Route・Edge Function・cron・ジョブ) は、送る手前で同意を判定する (#1154)。判定の本体は `supabase/functions/_shared/ai-consent.ts` の 1 か所で、Next.js は `src/lib/ai/consent-guard.ts` (`requireAiConsent` / `checkUserAiConsent`)、Edge Functions は `supabase/functions/_shared/ai-consent-guard.ts` から呼ぶ。全事業者 (`AI_CONSENT_PROVIDERS`) について現行の版 (`AI_CONSENT_VERSION`) の有効な同意が無ければ送らず 403 `AI_CONSENT_REQUIRED`、読めなければ 503 `AI_CONSENT_CHECK_FAILED` (fail-closed)。新しく AI へ送る経路を足したら判定を呼び、`tests/helpers/ai-consent-enforced-paths.ts` の一覧に載せ、未同意なら送らないことを実際に呼んで確かめる表 (API Route は `tests/ai-consent-enforcement-routes.test.ts`、Edge Function は `tests/ai-consent-enforcement-edge.test.ts`) に行を足す (送信先を足したら `tests/ai-consent-provider-inventory.test.ts` と事業者の一覧・DB の CHECK も直し、版を上げる)。画面は、AI の操作の先頭で `useAiConsent()` の `ensureAiConsent()` を呼び、戻り値が `"declined"` なら送らない。`consentModal` を JSX に描画する。利用者の操作で AI に送る fetch は `aiFetch` (`src/lib/ai/consent-required.ts`) を使い、`isAiConsentRequiredResponse(res)` なら自分のエラー表示を出さない (全画面共通の `AiConsentRequiredHost` が同意画面を出す)。画面を開くと自動で AI に頼む処理は `fetch` のまま、403 なら案内の一文だけを出す。保存・集計と AI を兼ねる API (健康診断・血液検査の保存、ホームの栄養の集計、相談を閉じる) は、未同意なら AI の部分だけを省いて応答の `aiSkipped` で知らせる。画面は `aiSkippedReasonOf` で読み、Web は `AiSkippedNotice` (`src/components/consent/`)、アプリは `apps/mobile/src/components/ai/AiSkippedNotice.tsx` で同意の案内を出す (`tests/ai-consent-skipped.test.ts` が、aiSkipped を返す API を呼ぶ画面の読み忘れを検査する)。案内の文面は `supabase/functions/_shared/ai-consent.ts` に 1 つだけ置き、案内が指す設定の項目 (`AI_CONSENT_SETTINGS_ENTRY_TITLE`) は Web の設定とアプリの設定タブの両方に置く (`tests/ai-consent-settings-entry.test.ts`)。アプリ (apps/mobile) は、AI の API を呼ぶ関数の中で `src/lib/ai-consent.ts` の `handleAiConsentRequiredError` (自動で送る処理と、fetch を直接使って失敗の応答から `errorOfFailedResponse` で Error を作る処理は `isAiConsentRequiredError`) を呼んで同意画面へ案内する (`tests/ai-consent-mobile-entry-points.test.ts` が、`requireAiConsent` を呼ぶ API を呼ぶアプリの関数の判定漏れを構文木で検査する)。アプリでは、同意で止められたと分かった分岐で例外を投げ直さない (投げ直すと、呼び出し側の catch が「失敗しました」を案内に重ねて出す。`useV4MenuGeneration().generate` は案内を出して `null` を返す。同じテストが構文木で検査する)。受け付けたあとに止めた処理 (キューの献立生成・献立生成の続きの工程・買い物リストの作り直し) は、リクエストの行の失敗の欄 (`weekly_menu_requests.error_message` / `shopping_list_requests.result.error`) にコードではなく人向けの文 (`aiConsentDeniedStoredMessage`) を書き、続きの工程は `invokeMenuContinuation` で呼ぶ (呼んだ先が止めたら再試行も上書きもしない)。画面は失敗の欄を `handleStoredAiConsentFailure` (Web: `src/lib/ai/consent-required.ts`、アプリ: `apps/mobile/src/lib/ai-consent.ts`) に通し、true なら自分のエラー表示を出さない (書く側は `tests/ai-consent-stored-failure.test.ts`、読む側の通し忘れは `tests/ai-consent-stored-failure-readers.test.ts` が構文木で検査する)。同意の記録・撤回は `POST /api/ai/consent` / `POST /api/ai/consent/revoke` だけが service role で書く。文面を変えたら必ず `AI_CONSENT_VERSION` も変える。`tests/ai-consent-entry-points.test.ts` が Web の画面の入口を検査する。e2e のテスト用アカウントは同意済みにしてある (`scripts/lib/e2e-ai-consent.ts`、`tests/e2e/helpers/ai-consent.ts`。同意画面そのものを試す spec だけ `test.use({ aiConsentGranted: false })`)。

### 環境変数

読む環境変数の一覧は `src/lib/env.ts` (zod のスキーマ。公開用 `NEXT_PUBLIC_*` とサーバー用に分け、必須/任意を区別する) に集約する (#1182)。

- **必須** (Supabase の接続情報 3 つ: `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`) は、`src/lib/env-required.ts` の `getSupabaseUrl()` などで取り出す。欠けていれば、サーバーのログに `[env] missing required env: <変数名>` を 1 行出して (ブラウザでは出さない。例外を誰が捕まえても残る)、`MissingEnvError` を投げる (message は固定の文で変数名を含まない。変数名は列挙されない `envName` に持ち、例外が `src/lib/db-logger.ts` の `error()` (`internalError()` 経由を含む) に渡れば構造化ログの metadata `missing_env_name` にも記録される。値は記録しない)。route の 500 は `internalError()` で返す (本文に変数名を出さない。#1172)。service_role のクライアントは `lib/supabase/server.ts` の `getSupabaseAdmin()` を使い、route ごとに自前の取り出しを書かない (自前の取り出しが、変数名入りの文を 500 の本文に返していた。`tests/env-source-scan.test.ts` が、必須の変数名を例外・応答の文字列に書いていないかを検査する)。middleware は欠けていれば `internalError()` の汎用 500 を返す (認証は素通りさせない)。**`process.env.X!` と書かない** (`tests/env-source-scan.test.ts` が検査する)。必須の変数を名前で読むのは `env-required.ts` だけで、ほかの場所で `process.env.X` を読んで `!url` と自前で判定しない・テンプレートリテラルに `${process.env.X}` と直接埋め込まない (空白だけの値を通す・`undefined/functions/v1/...` へ通信するため。#1434。同じテストが検査する)。欠けていてよい場所 (ログの書き込み・`/api/health` の死活監視・通知メールなど縮退してよい処理) では、getter を呼んで `isMissingEnvError()` で受ける。Edge Function を service_role の鍵で呼ぶときの鍵 (古い別名 `SERVICE_ROLE_JWT` を先に読む) は `getEdgeFunctionServiceRoleKey()`。API route では、認証とレート制限のあと・DB に書き込む前に取り出す (未ログインの呼び出しに設定の不足を教えない。書き込んだあとで気づくと、Edge Function を呼べないまま、リクエストの行を作って失敗として記録する (週間献立は、消した献立を戻す) だけの無駄な動きになる)。
  - service_role のクライアントを `getSupabaseAdmin()` 以外で作ってよいのは、`tests/supabase-service-role-client-scan.test.ts` の許可の一覧 (`SUPABASE_JS_CLIENT_ALLOWLIST`。理由つき) にあるファイルだけ。`src/lib/db-logger.ts` が一覧に残るのは、ブラウザ向けのページ (`src/app/(main)/meals/new/page.tsx` の `logToServer`) からも import され、`next/headers` を読む `lib/supabase/server.ts` を取り込めないため (app_logs への insert にだけ使い、接続情報が欠けていれば例外を投げずに書かない。クライアントの設定は `getSupabaseAdmin()` とそろえる。#1162)。
- **任意** (メール・レート制限・AI・課金など) は `src/lib/env.ts` の `getOptionalEnv(name)` で取り出す。無ければ `undefined` を返し、プロセスごとに 1 回だけ警告を出す。**任意の変数が無いことで本番を止めない**。既存の `process.env.X` の読み取りは、ほかの作業と重ならないところから順に置き換える途中 (新しく書くコードは `getOptionalEnv` を使う)。
- 値を読む場所を 1 か所に決めている変数 (一覧の `readOnlyBy`) は、`check:env` の案内のために名前だけが一覧にあり、`getOptionalEnv` では読めない。`CRON_SECRET` / `CRON_SECRET_PREVIOUS` を読むのは `src/lib/cron-auth.ts` だけ (`tests/cron-secret-contract.test.ts` の CC-4)、同意ゲートのフラグ `LEGAL_CONSENT_ENFORCE` / `LEGAL_CONSENT_NOTICE` を読むのは `lib/legal-consent.ts` だけ (全リクエストの前に動く proxy (`src/proxy.ts`) から読むので、zod を持つ `env.ts` の `getOptionalEnv` を使わない)。`tests/env-source-scan.test.ts` が、本番コードでそのファイルだけが読んでいることを検査する。
- `env-required.ts` は何も import しない。ブラウザ向け (`lib/supabase/client.ts`)・全リクエストの前に動く proxy (`src/proxy.ts`)・毎分呼ばれる cron の route (`src/app/api/cron/process-menu-queue/route.ts`) のコードは `env.ts` を import しない (zod は最小のスキーマでも minify 後に約 59 KB、gzip 約 16 KB 加わるため。`tests/env-source-scan.test.ts` が到達性を検査する)。`env.ts` は `scripts/check-env.mjs` が Node.js から直接読むため、静的に import してよいのは zod だけ。
- 新しい環境変数は、`env.ts` の一覧 (必須にするのは、無いとアプリが動かないものだけ。無いと何が起きるかも書く) と `.env.example` の両方に足す。逆に、採用をやめたサービスの変数を `.env.example` から消すときは、一覧からも消す (`tests/env-source-scan.test.ts` が、Web の本番コードが名前を書いて読む変数が一覧に無いとき (`NODE_ENV`・`NEXT_RUNTIME` を除く) と、一覧の変数が `.env.example` に無いときに失敗する)。`npm run check:env` が `.env.local` などを一覧に照らして検査する (CI には組み込まない。CI にシークレットが無いため)。
- **モバイル** (`apps/mobile`) は `src/lib/env.ts`。`EXPO_PUBLIC_*` は `process.env.EXPO_PUBLIC_X` と名前を直接書く (`process.env[name]` はビルド時に置き換わらず、リリースビルドで常に undefined になる)。必須の `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` が無いと、`lib/supabase.ts` は存在しない接続先のクライアントを作らず、開発中は読み込み時に例外、リリースビルドは `app/_layout.tsx` が設定エラーの画面を出す (足りない変数名を画面に出すのは開発ビルドだけ。リリースビルドでは `lib/supabase.ts` が端末のログに残す)。モバイルの jest では `process.env` を差し替えず、同じオブジェクトを書き換える (`expo/virtual/env` が読み込み時の `process.env` を握るため)。

### localStorage クリーンアップ

`src/lib/user-storage.ts` の `clearUserScopedLocalStorage()` を使う。  
サインアウト処理では **Supabase signOut を呼ぶ前に** このヘルパーを実行する。  
消すキーの一覧は `packages/shared/src/user-scoped-storage.ts` の 1 か所だけに持つ (キーそのものは `USER_SCOPED_LOCAL_STORAGE_KEYS`、後ろに ID が付くキー (`familyViewState_<familyId>` など) の接頭辞は `USER_SCOPED_LOCAL_STORAGE_KEY_PREFIXES`。#1599)。モバイルアプリのネイティブのログアウト・退会 (`apps/mobile/src/lib/signOut.ts`) は、次に開く WebView で、Web のページが読み込まれる前に同じ一覧のキーと接頭辞のキーを消させる (`apps/mobile/src/lib/webViewUserStorageCleanup.ts`。#1037)。ネイティブの掃除は `apps/mobile/src/lib/userScopedLocalData.ts` の `clearUserScopedLocalData` にまとめてあり、ログアウト・退会のほか、`AuthProvider` が起動時に失効を見つけたとき・起動時に未ログインと決まったとき・`SIGNED_OUT` のときも同じものを通す (#1599 / #1615。経路ごとの順は `AuthProvider.tsx` の先頭の表。`SIGNED_OUT` のときだけは、このあとのログアウトが読む push token の値を残す)。キーを足すときは共有の一覧に足すだけでよい。

### Web のログアウト画面と、モバイルアプリの WebView への通知

Web の画面で利用者がログアウトするときは、`clearUserScopedLocalStorage()` → `notifyNativeSignOut()` (`src/lib/native-auth-bridge.ts`) → `supabase.auth.signOut()` → `broadcastSignOut()` (`src/lib/user-storage.ts`) の順に呼ぶ (#1038)。
`signOut()` の前に `notifyNativeSignOut()` を呼ばないと、`signOut()` の途中の `SIGNED_OUT` が `session-expired` としてネイティブへ先に届き、ネイティブが `user_push_tokens` のこの端末の行を消せなくなる。
`broadcastSignOut()` は `signOut()` のあとに呼ぶ (先に呼ぶと同じタブが `/login` へ移り、`signOut()` が途中で止まる)。`tests/native-sign-out-order-source-scan.test.ts` が検査する。

### 退会 (アカウント削除)

退会の本体は `src/lib/account-deletion.ts` の `deleteAccount()` (#1175)。`POST /api/account/delete` はこれを呼ぶだけにする (退会の入口を増やすときも同じ)。route に手順を書き足さない。`deleteAccount()` は失敗を `ACCOUNT_DELETE_FAILED` (`request_id` と段階 `step` つき) の結果で返し、詳細は `src/lib/db-logger.ts` で `app_logs` に残す。route はそれを `src/lib/api/errors.ts` の `internalError()` (#1172。汎用メッセージだけの 500。`request_id`・段階・DB の生のエラー文は本文に出さない) で返す。

- **`auth.users` を指す外部キーには、必ず `ON DELETE` を書く。** `NO ACTION` のままだと、参照する行が 1 件でも残っている利用者・運営者の `auth.admin.deleteUser` が外部キー違反で失敗する。本人だけの記録は `CASCADE`、サポート・会計・運営者の記録は行を残して `SET NULL` (列は NULL を許す形にする)。`tests/integration/security/auth-users-fk-on-delete.test.ts` が検査する。
- 退会後も行が残る表に、利用者の生のメールアドレスを入れる列を足したら、`prepare_account_deletion` (migration `20261010000100`) で伏せるか、伏せない理由を同じテストの一覧 (H) に書く。
- 退会と書き出しの画面 (Web) は 3 つ: 設定 (`/settings`)・凍結中の `/frozen/account`・利用規約とプライバシーポリシーに同意する前の `/legal-consent/account` (#1901・設計書 cross/20 Q-23。同意画面の下のパスなので同意ゲートと初期設定の差し戻しの対象外)。後の 2 つは共通の部品 `src/components/account/AccountSelfServicePanel.tsx` を使い、呼ぶ API は `POST /api/account/delete` と `GET /api/account/export` (どちらも同意の許可リストと凍結中の許可リストにある) だけ。アプリは `apps/mobile/app/settings/account.tsx`。
- 利用者のファイルを置く Storage は、先頭のフォルダを `<user_id>/` にする (`src/lib/storage-paths.ts`)。退会はこのフォルダを丸ごと消す (`src/lib/account-deletion-storage.ts`)。それ以外の場所に置くと、DB の URL から辿れるものだけが消える。

### エラー境界 (画面の描画中の例外を受ける)

画面の描画中に起きた例外を受ける境界が無いと、Web ではルート全体を置き換える `global-error.tsx` まで、モバイルではアプリ全体のクラッシュまで届く (#1207)。新しい route group / layout を足すときは、境界も足す。

- **Web**: layout (`layout.tsx`) を持つ区画には、同じ階層に `error.tsx` を置く。中身は共通部品 `src/components/error/RouteError.tsx` を返すだけにする (手書きしない)。`RouteError` は「再試行」(`router.refresh()` + `reset()`)・戻るリンク・記録 (`src/lib/report-boundary-error.ts`) をそろえる。`reset()` だけではサーバーコンポーネントの例外から復帰できないため、`router.refresh()` を一緒に呼ぶ。例外の文面・スタックは画面に出さず、出すのは `digest` だけ。記録に URL / パスを入れない (`/invite/{token}` など URL に秘密が入るページがあるため)。`tests/route-error-boundaries.test.tsx` が配置と表示を検査する。
- **モバイル**: `apps/mobile/app` の `_layout.tsx` は、すべて `export function ErrorBoundary` を持ち、`src/components/ErrorFallback.tsx` を返す。expo-router は、この export がある layout の中の例外だけを受ける (無いと誰にも受けられない)。Provider の外 (ルートの境界) でも描画されるので、`ErrorFallback` は hooks や Provider に頼らない。`apps/mobile/__tests__/app/error-boundaries.test.tsx` が全 layout を検査する。記録は `apps/mobile/src/lib/error-report.ts`。送り先はサーバーログ (`POST /api/log`。サーバー側で秘密情報をマスクしてから `app_logs` に保存する) だけで、外部の計測サービスには送らない (#1166)。例外の文面とスタックは切り詰め、画面のパス (ルート名) は記録しない。`apps/mobile/__tests__/lib/error-report.test.ts` が、送り先と送る内容を固定している。

---

## Web アプリは Next 16 + React 19 (#1444・#1621)

- Web アプリ (`src/`) は **Next.js 16 + React 19** で動く (#1444 で Next 14 + React 18 から 15 に、#1621 で 16 に上げた)。モバイルの `apps/mobile` は Expo 58 + React 19.3 (#1591 で 53 から上げた) で、ルートとは別の版の `react` を `apps/mobile/node_modules` に入れ子で持つ (モバイルの React は react-native に入っているレンダラーと「完全に同じ版」でないと動かないため)。
- **バンドラーは Turbopack (Next 16 の既定)。** #1621 では `--webpack` で webpack に固定していたが、#1745 で Turbopack に移った (`package.json` の `dev` / `build` に `--webpack` を付けない。`tests/next16-bundler-contract.test.ts` が固定する)。e2e のビルドの Google Fonts のモック (`tests/e2e/fixtures/google-fonts-mock.cjs`・#1330) は Turbopack でも効く形にしてある: 他のモジュールを `require` しない・CSS の URL をそのままの文字列のキーで並べる (JavaScript の Proxy オブジェクトは不可)・CSS に `src: url(...)` を書かない (Turbopack はその URL へ必ず取りに行く)。`src/app/layout.tsx` の next/font/google の指定を変えたら、モックの `FONT_REQUESTS` も同じに直す (`tests/e2e-google-fonts-mock.test.ts` が突き合わせる)。`next.config.mjs` に `webpack()` を書かない (Next 16 は Turbopack の build を止める)。
- **ミドルウェアは `src/proxy.ts` (Next 16 の proxy。Node.js runtime。#1744)。** Next 16 で `middleware` のファイルの規約は非推奨になり `proxy` に変わった (`middleware` と `proxy` を両方置くと `next build` が失敗する)。`proxy` は Node.js runtime でしか動かず、`config` に `runtime` を書くと `next build` が失敗するので、`config` には `matcher` だけを書く。route の `runtime = 'edge'` も Next 16 で非推奨 (`next build` が警告を出す) なので使わない (`tests/next16-proxy-convention.test.ts` が検査する)。
- **lint は ESLint 9 + `eslint-config-next` 16 の flat config。** `next build` は lint を動かさない (Next 16 で `next lint` と `next.config` の `eslint` の項目は無くなった)。`eslint-plugin-react-hooks` 7 の React Compiler 向けのルールは切ってあり (このアプリは React Compiler を使っていない)、効かせるのは rules-of-hooks と exhaustive-deps だけ (`eslint.config.mjs` の `REACT_COMPILER_RULES_OFF`。`tests/eslint-next16-config.test.ts` が検査する)。
- **ページ・レイアウト・route handler の `params` / `searchParams` は Promise。** サーバーでは `await props.params`、クライアントのページでは `use(props.params)` か `useParams()` で読む。`cookies()` / `headers()` / `draftMode()` も Promise を返すので `await` する。`lib/supabase/server.ts` の `createClient()` は `cookies()` を読むので非同期 (`await createClient()`)。Next 15 にあった同期のまま読む互換の道は、Next 16 で無くなった。画像を作るメタデータのファイル (`opengraph-image` / `twitter-image` / `icon` / `apple-icon`) の `params` / `id` と、`sitemap` の `id` も Promise (Next 16)。
- **キャッシュの既定は Next 14 と違う。** Next 15 は、`fetch` をキャッシュせず (`no-store`)、GET の route handler も毎回動かす。ブラウザの中のルーターのキャッシュ (Client Router Cache) は、動的なページを使い回さない (0 秒) のが既定になった。
  - ルーターのキャッシュは、Next 14 と同じ時間 (動的 30 秒・静的 300 秒) を `next.config.mjs` の `experimental.staleTimes` で明示している (`src/__tests__/config/next-config-client-router-cache.test.ts` が固定する。Next 16 の既定も Next 15 と同じ)。
  - 画像の最適化 (`/_next/image`) が最適化した画像を使い回す最短の時間は、Next 15 の既定 (60 秒) を `images.minimumCacheTTL` で明示している (Next 16 の既定は 4 時間。食事写真・冷蔵庫写真の署名付き URL の期限 (既定 1 時間) より長く使い回さないため。`src/__tests__/config/next-config-images.test.ts` が固定する)。
  - `fetch` と GET の route handler は Next 15 の既定 (キャッシュしない) のまま。Next 14 の「既定でキャッシュする」動きは、古い件数・古いログを返す不具合のもとで、キャッシュさせたくない所には `cache: 'no-store'` や `dynamic = 'force-dynamic'` を書いてあった (残してある)。キャッシュしたい `fetch` を足すときは、`cache: 'force-cache'` か `next: { revalidate }` を明示する。
- 型の版は実行時の React にそろえてある。ルート `package.json` の `@types/react` / `@types/react-dom` は **19 系** (19.2)。モバイルは自前の `@types/react ~19.3.0` を `apps/mobile/node_modules` に入れ子で持ち、`apps/mobile/tsconfig.json` の `paths` で `react` の型をそれに固定している (Web とモバイルで型の版が違う間は外さない)。`tests/react-types-version-contract.test.ts` が検査する。
- テストの `act` は `react` から import する (`import { act } from 'react'`)。`react-dom/test-utils` の `act` は React 19 で非推奨 (呼ぶたびに警告が出る)。 Web では `react-dom/test-utils` と `react-test-renderer` の import (動的 import・require を含む) を `eslint.config.mjs` のルールが止める (`tests/react19-deprecated-imports-guard.test.ts` が検査する。モバイルの `apps/mobile` は対象外) (#1621)。
- テストで `next/headers` をモックするときは、`cookies` / `headers` / `draftMode` を Promise を返す形 (`async () => …` など) で書く。同期の値を返すと、本番コードが `await` を忘れてもテストが通ってしまう (`tests/next15-async-request-api-scan.test.ts` が検査する。#1621)。
- ルートで依存を更新する `npm install` が、ルートと `apps/mobile` の React の版の違いで ERESOLVE になることがある。その場合は `npm install --package-lock-only --legacy-peer-deps` で `package-lock.json` だけ更新し、続けて `npm install --package-lock-only` を 1 回実行して形をそろえる。差分が意図した変更だけであることと `npm ci --dry-run` が通ることを確認する。Expo の SDK の更新のように、モバイルの依存の版をまとめて変えるときは、1 回で作り直すと `react-native` ほかが `apps/mobile/node_modules` に入れ子になる。mobile/07 §10.1 の 2 段 (先に版を変える依存を宣言から外して作り直し、次に戻す) で作り、§9.11 の検査を通す。

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
- `scripts/backup-db.mjs`・`scripts/lib/backup-db.mjs`・`scripts/supabase-local.sh`・`.github/workflows/db-backup.yml` を変える PR は、db-backup.yml の `roundtrip-check` ジョブ (ローカルのスタックでダンプ → 復元の往復) の緑を待ってからマージする。local-ci.sh には写していない (理由は `tests/local-ci-workflow-sync.test.ts` の `EXCLUDED_WORKFLOWS`)。手元では `node scripts/backup-db.mjs roundtrip-local --slot <空いている枠>` で同じ検査を流せる (終わったら `LOCAL_CI_SLOT=<その枠> bash scripts/supabase-local.sh stop` で止める。設計 cross/17 §4.7)。上の「migration を含まない PR は CI の完了を待たずにマージしてよい」の例外 (#1765)。
- secrets 段 (gitleaks) が赤のときはマージしない。リポジトリは公開なので、main に入った秘密は取り消せない (本物のキーなら無効にして発行し直す。ダミーなら `.gitleaks.toml` か行末の `gitleaks:allow`)。
- 依存 (`package.json` / `package-lock.json`) を変える PR は、security.yml の dependency review (high 以上の既知の脆弱性がある版を入れていないか) と npm audit (本番の依存に critical が無いか) の緑を待ってからマージする。これらは GitHub の Dependency graph と npm のレジストリ (脆弱性データベース) を使うので、ローカルでは再現できない。
- PR で動くワークフローのうち local-ci.sh に写していないもの (と理由) は `tests/local-ci-workflow-sync.test.ts` の `EXCLUDED_WORKFLOWS` / `EXCLUDED_JOBS` にある。PR で動くワークフロー・ジョブを足したら、local-ci.sh に写すか、そこに理由を書く (書かないと `npm test` が落ちる)。
- migration (`supabase/migrations/**`) を含む PR は、Deploy Supabase Migrations の PR ジョブ (本番台帳とのドリフト検知) の緑を待ってからマージする。これはローカルでは再現できない。
- 本番への反映 (Vercel・`db push`・functions deploy) は従来どおり PR → main → CI の経路だけ。

---

## 家族 (family_*) を変える関数のロック順 (DB)

家族のメンバー・所属・代表者を変える関数 (`accept_family_invite` / `add_family_child` / `leave_family` / `remove_family_member` / `operator_force_dissolve_family` / `operator_force_representative_transfer` / `accept_family_representative_transfer` / `accept_child_promotion` / `dissolve_family_by_representative` / `family_dissolve_apply`) は、**最初に `family_groups` の行をロックし**、そのあとで子の行 (`family_invites` / `ownership_transfer_proposals` / `family_members` / `family_promotion_requests` / `user_profiles`) を触る (#1310)。家族の行の削除 (`DELETE FROM family_groups` + CASCADE。#1917 の続きから利用者は直接消せず、消すのは解散から 90 日の purge と service_role だけ) は、DELETE 文が最初に家族の行を取るので、もともとこの順になっている。

課金の側で家族の行を書くもの:
- 課金の写像 `billing_apply_stripe_subscription`: 家族プランの同期で `family_groups` の行を UPDATE してから `user_profiles` の行を UPDATE する (`docs/design/billing/01-billing-core.md` §6.4 (9) の 10.)。
- `family_groups` のトリガー `family_groups_billing_plan_follow_representative` (関数 `billing_family_plan_follow_representative`): グループの作成と代表者の交代で advisory `billing-user:<新しい代表者>` を取る (代表者の交代では家族の行のロックのあと。作成では INSERT の BEFORE トリガーの中。billing/01 §6.4 (10))。
- 手動付与の関数 3 本 (`billing_grant_manual_subscription` / `billing_revoke_manual_subscription` / `billing_expire_manual_subscription_for_user`): 家族の同期は `family_groups` の行 → `user_profiles` の行の順。1 トランザクションで扱う利用者は 1 人だけで、期限切れの日次のプロシージャ `billing_expire_manual_subscriptions` は利用者ごとに COMMIT する (全員を 1 トランザクションにすると、前の利用者の `user_profiles` の行を持ったまま次の利用者の `family_groups` の行を待ち、逆向きになる)。`docs/design/billing/02-manual-plan-grant.md` §6。

順番がそろっていないと、運営の強制解散・家族の削除と同時に走ったときに、解散済みの家族に active のメンバーが残る / デッドロック (40P01) する。

- 家族に関わる関数を `CREATE OR REPLACE` するときは、既存のロックを外さない。別の migration が同じ関数を書き換えているときは、最新の定義の上に積む (古い本文で上書きするとロックが消える)。
- 新しく足す家族の行のロックは `FOR NO KEY UPDATE` にする (`add_family_child` だけは #1213 のまま `FOR UPDATE`)。`FOR UPDATE` だと、子の行を先に持つ関数が最後に取る外部キーの確認 (`FOR KEY SHARE`) が待たされ、逆向きに待ち合ってデッドロックする。
- 課金の写像を変えるときも、家族の行を `user_profiles` より先に取る。
- 子の行を先に取って、あとで家族の行を外部キーの確認で取る関数 (`create_family_invite` の再招待 / `request_child_promotion`) は、まだ家族の行を先に取らない。家族の行の DELETE (#1917 の続きから利用者は直接消せず、消すのは解散から 90 日の purge と service_role だけ) と同時に走ると、まれにどちらかがデッドロックで失敗する (既知。やり直せば通る)。
- 回帰テスト: `tests/integration/security/family-lock-order-race.test.ts`・`tests/integration/rls/billing-apply-subscription-rpc.test.ts` のテスト 106 (写像と運営の強制解散・家族の行の削除 (service_role) が同時に走っても 40P01 にならない)・`tests/integration/rls/billing-manual-grant-rpc.test.ts` のテスト 41・47・57 (期限切れのジョブと家族の操作・代表者の交代が同時に走っても 40P01 にならない)。代表者を書く 3 つの関数 (作成・譲渡の承諾・運営の強制譲渡) は、`family_groups` のトリガー `trg_representative_not_deleting` (`20261023150000`) で advisory `account_deletion_guard:<新しい代表者>` を取る (課金のトリガーの advisory `billing-user:<新しい代表者>` のあと)。取る位置は、譲渡の承諾と運営の強制譲渡では家族の行・子の行のあと、作成では新しい家族の行の INSERT のとき (そのあとで `family_members` と本人の `user_profiles` を書く)。退会の印はこの lock を取るだけで、家族の側と衝突する行を持たないので、待ちの輪はできない (組織の節の「退会の印」の行)

## 組織 (organizations) を変える関数のロック順 (DB)

組織の所属・役割・解散を変える関数は、**最初に `organizations` の行を `FOR NO KEY UPDATE` でロックし**、そのあとで `user_profiles` の行を触る (`supabase/migrations/20261022140000_org_transfer_toctou.sql`・`20261022100000_org_invite_dissolved.sql`)。所属や役割の判定は、判定に使う行をロックしてから行う (ロックの外で判定すると、判定のあとに所属が外れた行へ `org_role` を書いて CHECK `user_profiles_org_consistency` (23514) になる)。

- 解散 (`dissolve_org_by_owner`・`operator_force_dissolve_org`): `organizations` の行 → 後始末 (全員の `user_profiles` → `org_license_pools`)。呼び出した本人の行・オーナーの行を先に取らない (オーナーでない人も API から呼べるので、本人の行を先に取ると、組織の行のあとにその人の行を取る関数と逆向きになり 40P01 になる)。本人がオーナーかは組織の行を取ったあとで判定する (`NOT_ORG_OWNER`)。
- 譲渡の承諾 (`accept_org_owner_transfer`): 提案の行 → `organizations` の行 → 承諾者の `user_profiles` → 旧オーナーの `user_profiles` (どれも `FOR NO KEY UPDATE`) を取ってから判定する。解散した組織なら `ORG_ALREADY_DISSOLVED`、承諾者の所属が外れていれば `TRANSFER_ACCEPTOR_NOT_IN_ORG`、提案者がもうオーナーでなければ `NOT_ORG_OWNER`。
- 運営の強制譲渡 (`operator_force_owner_transfer`): `organizations` の行 → 新オーナーの `user_profiles` を取ってから `TARGET_NOT_IN_ORG` を判定する。
- 招待の承諾 (`accept_org_invite`): 招待の行 (`FOR UPDATE`) → `organizations` の行 (`FOR NO KEY UPDATE`。`status` が `active` でなければ `ORG_ALREADY_DISSOLVED`) → 承諾者の `user_profiles` → `org_license_pools`。
- 退会の所属の解放 (`release_user_membership`): 所属の組織をロックを取らずに読み、`organizations` の行 → 本人の `user_profiles` (どちらも `FOR NO KEY UPDATE`) を取ってから判定する → `org_license_pools` (`supabase/migrations/20261022160000_release_membership_owner_race.sql`)。本人が組織の行の `owner_id` なら `IS_ORG_OWNER` で止めて所属を外さない (退会の findBlocker のあとに譲渡の承諾・運営の強制譲渡でオーナーになった人の所属を外すと、`owner_id` が所属の無い人を指す組織が残る。退会の本体は findBlocker をやり直して 409 にする)。ロックの下で読み直した所属が無ければ何もしない、別の組織なら `CONFLICT_RETRY` (その組織の行を取っていないので外さない。退会は削除せずに失敗にし、やり直しで片付く)。
- 脱退 (`leave_org`)・除名 (`remove_org_member`): 組織の行は取らず、本人 / 対象の `user_profiles` を 1 行だけ取る (`FOR NO KEY UPDATE`) → `org_license_pools`。除名は呼び出し元の行をロックしない (組織の行を取らずに `user_profiles` を 2 行取ると、組織の行の下で承諾者の行 → 旧オーナーの行を取る譲渡の承諾と逆向きになりうる)。
- 運営の強制譲渡の旧オーナーの行への書き込みは、その組織に在籍しているときだけ (`AND organization_id = p_organization_id`。`20261022160000`)。所属の外れた行に `org_role` を書くと 23514 になる。
- 退会の印 (`account_deletion_guards`。`supabase/migrations/20261023130000_account_deletion_owner_guard.sql`): 退会の本体は findBlocker の前に `begin_account_deletion_guard` で印を付け、`organizations` の BEFORE INSERT のトリガー `trg_organizations_owner_not_deleting` (関数 `organizations_owner_not_deleting()`) は新しい印のある人を `owner_id` にした INSERT を `OWNER_ACCOUNT_DELETING` で止める (運営の作成 API は 409)。どちらも、その人の id の advisory lock (`'account_deletion_guard:' || user_id`。トランザクションの間) を取ってから印を読み書きする。組織の作成は (2) の新しい行のあとにこの lock を取り、印は lock だけを取る (段の行を持たない) ので、待ちの輪はできない。トリガーは INSERT だけに付ける (譲渡の UPDATE は `release_user_membership` の `IS_ORG_OWNER` が受け持つ)。回帰テスト: `tests/integration/security/account-deletion-owner-guard.test.ts` (GD-1〜GD-10)・`tests/account-deletion-owner-guard-migration-contract.test.ts`。家族の代表者も同じ印で止める: `family_groups` の BEFORE INSERT OR UPDATE OF representative_id のトリガー `trg_representative_not_deleting` (関数 `family_groups_representative_not_deleting`。`supabase/migrations/20261023150000_account_deletion_family_representative_guard.sql`) は、新しい印のある人を代表者にする作成・譲渡の承諾・運営の強制譲渡を `REPRESENTATIVE_ACCOUNT_DELETING` で止める (NULL (解散) と値を変えない UPDATE は止めない。同じ advisory lock を、譲渡の承諾と運営の強制譲渡では家族の行・子の行のあとに、作成では新しい家族の行の INSERT のとき (そのあとで子の行を書く) に取る。名前は特権列のガード `trg_guard_family_groups_privileged` より後ろに並べ、ログインユーザーの直接の変更は先に 42501 で止める)。回帰テスト: `tests/integration/security/account-deletion-family-rep-guard.test.ts` (FR-1〜FR-11)・`tests/account-deletion-family-rep-guard-migration-contract.test.ts`。退会が deleteUser の前に止まったら (409・途中の失敗)、退会の本体は返す前に `end_account_deletion_guard` で印を消す (`supabase/migrations/20261024120000_account_deletion_guard_release.sql`。同じ advisory lock を取ってから消す。lock だけを取るので待ちの輪はできない)。deleteUser を呼んだあとに止まったときは消さない。回帰テスト: `tests/integration/security/account-deletion-guard-release.test.ts` (GR-1〜GR-9)・`tests/account-deletion-guard-release-migration-contract.test.ts`。
- 段の順: (1) 提案の行・招待の行 → (2) `organizations` の行 → (3) `user_profiles` → (4) `org_license_pools`。どの関数もこの順にしか取らず、ある段の行を持ったまま前の段の行を待たない (取らない段は飛ばす)。(3) の行を 2 つ以上取るのは (2) の組織の行を持っている関数だけ。`organizations.owner_id` を書くのは組織の行を持った関数 (譲渡の承諾・運営の強制譲渡・解散の後始末) だけなので、組織の行を取ったあとに読んだ `owner_id` は commit まで変わらない (オーナーを読んでから行を取り直すループは要らない)。新しく組織の所属・役割を書く関数を足すときもこの順に合わせ、`user_profiles` の行を組織の行より先に取らない。
- 組織の行の削除 (`DELETE FROM organizations` + CASCADE。#1917 の続き (`20261023100000`) からオーナーは直接消せず、消すのは運営 (super_admin・MFA 済み) と service_role だけ。組織をやめるのは解散の RPC) は、この段の順になっていない。DELETE 文が最初に (2) の組織の行を取り、そのあとで外部キーの CASCADE / SET NULL が子の表の行を触る (触る順は外部キーのトリガーの順で、段の順に合わせていない)。子の表には (1) の招待の行 (`organization_invites`。CASCADE) が入るので、組織の行を持ったまま招待の行を待つ。招待の行を先に取ってから組織の行を待つ招待の承諾 (`accept_org_invite`) と同時に走ると、まれにどちらかがデッドロック (40P01) で失敗する (既知。やり直せば通る)。回帰テスト: `tests/integration/rls/organizations-no-owner-direct-delete.test.ts` の O-9 (DELETE が組織の行を持ったまま、招待の行を持つ接続を待つこと)。
- 新しく足す組織の行のロックは `FOR NO KEY UPDATE` にする (家族と同じ理由。`FOR UPDATE` だと外部キーの確認 (`FOR KEY SHARE`) と待ち合う)。
- 回帰テスト: `tests/integration/security/org-transfer-toctou.test.ts` (OT-18〜OT-23 がオーナーでない人の解散と、組織の行のあとにその人の行を取る関数の組。OT-25 が譲渡の commit をまたいだ運営の強制解散と新しいオーナーの解散が、組織の行に並んだ順に通ること)・`org-transfer-toctou-release-membership.test.ts` (退会の所属の解放と譲渡の承諾・運営の強制譲渡の同時の実行。RM-1〜RM-12)・`org-invite-dissolved.test.ts`・`self-dissolve.test.ts` の D-9・D-15。文面の契約は `tests/org-transfer-toctou-migration-contract.test.ts` (組織の行を最初に取る規則を、関数の最新の定義で見る)・`tests/release-membership-owner-race-migration-contract.test.ts`・`tests/org-invite-dissolved-migration-contract.test.ts`。

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

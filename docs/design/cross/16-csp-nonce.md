# 本番 CSP の script-src から 'unsafe-inline' を外す (nonce 方式への移行) 設計

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-16 | 新設 (Issue #1169 の設計ゲート・A 型 4 相) |

要件の正本は Issue #1169 の本文 (コメント 0 件)。本書はその上で決めた範囲と設計で、Issue と食い違ったら本書が正。
ファイル名 (cross/16) は設計ゲートの指定による (cross/ の既存は 01〜09・12・13a・15)。

前提 (本書が従う条件): ローンチ前で利用者ゼロ (正しい形で作る)。本番の DB に触らない。

---

## 0. 外形固定と分冊判定 (相 1)

### 0.1 発注と決めること

Issue #1169: `next.config.mjs` の CSP は `script-src 'self' 'unsafe-inline' …` のまま (`'unsafe-eval'` は #275 / PR #280 で削除済み)。`'unsafe-inline'` が有効な限り script-src はインラインスクリプトによる XSS に対してほぼ無力。予告されていた「nonce 移行の別 Issue」は存在しなかった。実装すべきことは nonce ベース CSP への移行。

本書で決めること (列挙):

1. nonce の生成と受け渡し: middleware で毎リクエストの nonce を作り、CSP ヘッダーと Next の script に渡す経路 (Next 15 App Router の公式の方式)。既存の middleware (同意ゲート・認証・メンテナンス・運営のリダイレクト等) との合成順 → §4
2. 静的に配信しているページ (SSG / ISR) が nonce 方式で動的レンダリングになる影響の範囲と扱い → §5
3. インラインのスクリプト・style の全列挙と移し方。style-src の扱い → §6
4. report-only で先に出して違反を集める段を置くか (受け口・app_logs への記録) と強制に切り替える条件 → §7
5. 開発 (unsafe-eval) とテスト (e2e・Playwright)、モバイルの WebView への影響 → §8
6. 機械検査: 本番の CSP に 'unsafe-inline' が script-src に無いこと・インラインのスクリプトを足したら赤になる走査 → §21

### 0.2 要件行列

| # | 要件 | 出どころ | 本書の節 |
|---|---|---|---|
| R-1 | 本番の CSP の `script-src` に `'unsafe-inline'` が無い | #1169 (本文) | §9.1, §21 |
| R-2 | インラインスクリプトは nonce 方式で許可する (hash や外部ファイル化は列挙した箇所ごとに決める) | #1169「nonce ベース CSP への移行」 | §4, §6 |
| R-3 | nonce は毎リクエスト一意・推測不能 (CSP3 の 128 ビット以上) で、応答は共有キャッシュに乗らない | nonce の定義 (Next 公式 CSP ガイド「unpredictable and unique for every request」) | §4, §5 |
| R-4 | 既存の middleware の分岐 (凍結・メンテナンス・同意・オンボーディング・`is_native_app`) の挙動を変えない。どの分岐の応答にも CSP が付く | 決めること 1 | §4, §12.1 |
| R-5 | 静的化していたページが動的になる範囲を列挙し、性能への影響と代替案を書く | 決めること 2 | §5 |
| R-6 | インラインの script / style・外部スクリプト (Turnstile・Speed Insights) を全列挙し、それぞれの移し方を決める。`style-src` は据え置くか外すかを理由つきで決める | 決めること 3 | §6 |
| R-7 | 違反の報告の受け口を持ち、`app_logs` に残す。report-only と強制の切り替えと条件を決める | 決めること 4 | §7, §11 |
| R-8 | 開発 (`next dev`) で `'unsafe-eval'` が要る間は dev だけに付ける。e2e (本番ビルド) は nonce 方式のまま通る | 決めること 5・`next.config.mjs` の現行の分岐 | §8 |
| R-9 | モバイルの WebView で開く Web の画面 (注入 JS・Turnstile の iframe) に影響が無い | 決めること 5 | §8.3 |
| R-10 | 機械検査: 本番の方針の `script-src` に `'unsafe-inline'` が無いこと・インラインの `<script>` を足したら赤になる走査・CSP が二重に付かないこと | 決めること 6 | §21 |
| R-11 | 新しい環境変数は `src/lib/env.ts` の一覧・`.env.example`・`ENV_SETUP.md` にそろえ、値を読むのは 1 ファイル | `tests/env-source-scan.test.ts` の規則 | §9.6, §18 |
| R-12 | 本文を読む新しい route は入口で NULL 文字を 400 で断り、回数制限は `src/lib/rate-limit.ts` のカテゴリで持つ。5xx の本文に生のエラー文を入れない | `src/__tests__/api/null-character-routes.test.ts`・`tests/rate-limit-single-implementation.test.ts`・`tests/api-raw-error-message-scan.test.ts` | §9.4, §9.5, §11 |
| R-13 | モバイルの `WEB_VIEW_EMBED_ORIGINS` と Web の `frame-src` の突き合わせ (Jest) を壊さない | `apps/mobile/__tests__/lib/webViewBridge.test.ts` | §18 |
| R-14 | 設計の正典コードに `as any`・マジックナンバーを置かない (意味のある数は名前つきの定数 + 根拠) | 設計の絶対条件 | §9 |

### 0.3 ユーザーシナリオ (16 本。トレースは §3.3)

| # | シナリオ |
|---|---|
| S-1 | 未ログインの訪問者が LP (`/`) を開く。ページは動的に描画され、Next のインラインスクリプトに nonce が付き、ハイドレーションが動く。CSP 違反は 0 件 |
| S-2 | 訪問者がログイン画面 (`/login`) を開く。Cloudflare Turnstile の `api.js` (外部スクリプト) とウィジェットの iframe が読み込まれ、トークンが出る |
| S-3 | ログイン済みで未同意 (`LEGAL_CONSENT_NOTICE=on`・強制なし) の利用者が `/home` を開く。middleware が応答を作り直しても (`withLegalConsentPendingHeader`)、nonce は同じ値のまま画面に届き、お知らせも出る |
| S-4 | 凍結中の利用者が `/home` を開く。307 で `/frozen` へ回される。リダイレクトにも CSP が付き、`/frozen` の描画も nonce つき |
| S-5 | メンテナンス中に未ログインの人が `/home` を開く。503 の決まった HTML (インライン `<style>` だけ・スクリプト無し) が返り、`style-src 'unsafe-inline'` のまま表示が崩れない |
| S-6 | 画面が `POST /api/meals` を呼ぶ。JSON の応答に CSP が付くだけで、API の挙動は変わらない |
| S-7 | 攻撃者が XSS で `<script>…</script>` を差し込む (例: AI の応答を HTML にする経路の穴の再発)。nonce を持たないので実行されず、ブラウザが `POST /api/csp-report` に違反を報告し、`app_logs` に warn が 1 行残る |
| S-8 | 攻撃者が nonce を推測・再利用しようとする。nonce は 128 ビットの乱数で毎リクエスト違い、応答は共有キャッシュに乗らない (全ページ動的 = `no-store`) ので、前の応答の nonce は次の応答では無効 |
| S-9 | 開発者が `next dev` で画面を開く。`'unsafe-eval'` が dev だけに付き、HMR が動く。インラインスクリプトは dev でも nonce つき |
| S-10 | CI の e2e (`next build && next start`) が走る。`auth-turnstile.spec.ts` の `securitypolicyviolation` の収集は 0 件のまま。新しい `csp-nonce.spec.ts` が nonce と報告の受け口を確かめる |
| S-11 | モバイル App の WebView が `/home?mode=app` を開く。ネイティブが注入する JS (タブの横取り・利用者別の localStorage の掃除) は CSP の対象外なので今までどおり動く。Turnstile の iframe は `frame-src` で読める |
| S-12 | 運営が Vercel で `CSP_REPORT_ONLY=on` にして再デプロイする。ヘッダー名が `Content-Security-Policy-Report-Only` に変わり、違反は止まらず報告だけ届く。条件を満たしたら外して強制に戻す |
| S-13 | 利用者のブラウザ拡張がスクリプトを差し込み、CSP が止める。報告の `blocked_uri` は他オリジン (`chrome-extension` など) で、運営は自分のコード由来 (`inline` / 自オリジン) と区別して読む |
| S-14 | 攻撃者が `/api/csp-report` に偽の報告を大量に POST する。IP ごとの回数制限 (429)・8 KiB 超 (413)・Content-Type 違い (415)・JSON でない / 形が違う (400)・NULL 文字 (400) で断り、`app_logs` は膨らまない |
| S-15 | クライアントが `x-csp-nonce: evil` と `content-security-policy: script-src 'nonce-evil'` をリクエストヘッダーに付けて送る。middleware が捨てて付け直すので、Next とページが読むのは middleware の値だけ |
| S-16 | 将来、開発者が `<script dangerouslySetInnerHTML>` や `next/script` を足す。`tests/csp-no-inline-script.test.ts` が赤になり、外部ファイル化か `getCspNonce()` + 許可リスト (理由つき) を案内する |

### 0.4 分冊判定

| 目安 | 本設計 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える見込み (約 1,100 行) | 当たる |
| 消費先レーン 3 以上 | middleware / ルートの layout / `next.config.mjs` / 報告の route / テスト・番兵の 5 面 | 当たる |
| 共有面 2 つ以上 | `src/lib/rate-limit.ts` のカテゴリ・`packages/shared` の同意の許可リスト・`src/lib/env.ts` の一覧 (どれも行を足すだけ) | 当たる (改定が要るものは無い) |

**結論: 1 冊で書く (核と配線に分けない)。** 理由: 新設するのは純関数 2 ファイル + route 1 本で、既存の関数・ポリシー・表を変えない (共有面には行を足すだけ)。nonce の経路 (middleware → Next → 画面) と報告の経路 (ブラウザ → route → app_logs) は互いに独立で、冊をまたいで追う流れが無い。代わりに実装 WF を 2 段 (§16) に分け、段ごとに 2 枚レビューを閉じる。

### 0.5 用語

| 語 | 意味 |
|---|---|
| 方針 (policy) | `Content-Security-Policy` ヘッダーの値の文字列 (`buildContentSecurityPolicy` の戻り値) |
| nonce | 1 リクエストにつき 1 つ作る乱数 (base64・24 文字)。方針の `'nonce-…'` と `<script nonce="…">` が一致したスクリプトだけ実行される |
| 強制 (enforce) | `Content-Security-Policy` で返す。違反を止め、報告も送る (既定) |
| 報告だけ (report-only) | `Content-Security-Policy-Report-Only` で返す。違反を止めず、報告だけ送る (`CSP_REPORT_ONLY=on`) |
| 報告 (report) | ブラウザが `report-uri` の先へ `application/csp-report` で POST する JSON (`{ "csp-report": {…} }`) |
| 受け口 | `POST /api/csp-report` (`src/app/api/csp-report/route.ts`) |

---

## 1. 目的・スコープ

- 目的: 本番の `script-src` から `'unsafe-inline'` を外し、Next が生成するインラインスクリプトだけを毎リクエストの nonce で許可する。差し込まれたスクリプトは実行されず、違反は `app_logs` で見える。
- 範囲 (本書で作るもの): CSP を組み立てる純関数 1 ファイル・nonce を画面へ渡すヘルパー 1 ファイル・middleware の配線・ルートの layout の動的化とインラインスクリプトの削除・`next.config.mjs` からの CSP の撤去・違反の報告の受け口 (route 1 本 + 純関数 1 ファイル)・回数制限のカテゴリ 1 つ・同意の許可リストの行 1 つ・環境変数 1 つ・テスト (単体・走査・e2e) と既存の番兵の追随。
- 範囲外: `style-src` の nonce 化 (§6.3 で据え置きの理由。§22 Q-2)・`base-uri` / `form-action` / `upgrade-insecure-requests` の追加 (§22 Q-1)・`report-to` / `Reporting-Endpoints` (§22 Q-3)・モバイル App 自身のコード変更 (Jest の突き合わせの参照先だけ直す)・CSP の報告を運用メール (エラー急増) に数えること (§22 Q-6)。

## 2. 関連要件

- Issue #1169 (本文)。関連 #275 / PR #280 (`'unsafe-eval'` の削除)・#1165 (Turnstile の CSP)・#1179 (Speed Insights と CSP)・#1166 (PostHog の撤去)・#1174 / #1442 (同意ゲートと middleware の分岐)・#1148 (メンテナンス)・#1030 (凍結)・#1493 (`POST /api/log` と回数制限)・#1182 / #1434 (環境変数の規則)・#1657 (NULL 文字)。
- `docs/design/CLAUDE.md` §4 (snake_case)・§6 (監査ログは本件に無し: 運営の操作が無い)。`cross/04` §4 (エラーコード)。`cross/13a` §6.4 (同意の許可リスト)。`cross/06` (レート制限)。`operator/10` (app_logs のビューア)。`mobile/01` §7 (WebView と `frame-src`)。
- 一次情報 (本書が依拠するもの): Next 15 公式ガイド「Content Security Policy」(nonce は middleware で毎リクエスト作り、リクエストヘッダー `Content-Security-Policy` と `x-nonce` に載せ、応答にも同じ値を付ける。nonce を使うページは動的レンダリング必須。Next は framework script・ページのバンドル・Next 生成のインライン script / style・`nonce` prop を持つ `<Script>` に自動で付与する)。Next 15.5 の実装 `server/app-render/app-render.js` は **リクエストヘッダー** `content-security-policy` (無ければ `content-security-policy-report-only`) から `getScriptNonceFromHeader` で `script-src` (無ければ `default-src`) の `'nonce-…'` を読む。nonce に HTML のエスケープ文字 (`&` `>` `<` U+2028 U+2029) があると例外 (base64 には含まれない)。Cloudflare Turnstile 公式「Content Security Policy」: nonce を使わない明示の代替は `script-src https://challenges.cloudflare.com` と `frame-src https://challenges.cloudflare.com` (pre-clearance を使うなら `connect-src 'self'`)。`@vercel/speed-insights` 2.0.0 の `inject` は `document.createElement("script")` に `src` を付けて差し込み、インラインの script 要素は作らない (`window.si` は JS の代入)。

---

## 3. 構想 (相 2) と構造裁定 (相 3)

### 3.1 構造

```
ブラウザ                         src/middleware.ts                                   Next (App Router)                     画面・route
GET /home ─────────────────▶ nonce = generateCspNonce()                                                           
                             policy = buildContentSecurityPolicy({ nonce, isDev, supabaseUrl })
                             request.headers: x-csp-nonce / Content-Security-Policy を捨てて付け直す
                             res = await updateSession(request)   ← 既存の分岐 (凍結・メンテ・同意・初期設定・API)
                             res.headers.set(CSP ヘッダー名, policy)
                             is_native_app Cookie (既存)
                             return res ─────────────────────────▶ リクエストヘッダーの CSP から nonce を読み、
                                                                  Next 生成の <script> に nonce を付ける ────▶ 画面は読まない
                                                                  (必要なら getCspNonce() で x-csp-nonce を読む)   (全ページ動的: ルート layout の force-dynamic)
◀──── 応答 (Content-Security-Policy: … script-src 'self' 'nonce-…' …; report-uri /api/csp-report) ──────────────

違反 (nonce の無い <script> など)
POST /api/csp-report ──────▶ updateSession (同意の許可リスト: telemetry) ──▶ route: NULL 文字 → 回数制限 (IP) → Content-Type → 8 KiB → JSON → Zod
                                                                                   → createLogger('csp-report').warn(...) → 204
                                                                                   (app_logs: level warn / source api-route / function_name csp-report)
```

- 方針の正本は `src/lib/security/csp.ts` の 1 か所 (`next.config.mjs` には CSP を書かない)。理由: nonce は静的な設定文字列に入れられない。`next.config.mjs` と middleware の両方が CSP を返すと応答に 2 つ並び、ブラウザは両方を満たすものしか通さないので、nonce 無しの方が nonce つきのスクリプトを止める (§21 で二重化を機械検査)。
- nonce の受け渡しは Next 公式と同じ「リクエストヘッダーに CSP と `x-csp-nonce` を載せる」。既存の `updateSession` が内部で `NextResponse.next({ request })` を作るので、呼ぶ前に `request.headers` に載せる (同じファイルの `withLegalConsentPendingHeader` が `x-legal-consent-pending` で使っている書き方。`request.headers.set` が本番で効くことは、同意のお知らせの e2e (`legal-consent-gate.spec.ts`・`next start`) が証明している)。
- 全ページを動的にする (ルートの layout に `export const dynamic = 'force-dynamic'`)。静的化した HTML には nonce が入らず、Next のインラインスクリプトが止まるため (§5)。
- 既存の唯一のインラインスクリプト (ルート layout の旧ダークモードの掃除) は削除する (§6.1)。アプリ自身のインラインスクリプトは 0 本になり、nonce を読む画面は無い。将来のために `getCspNonce()` を用意し、走査テストが案内する。
- 報告は `report-uri /api/csp-report` の 1 本。受け口は未認証で、IP 単位の回数制限と本文の上限で守り、`app_logs` に warn で残す (運営は `/super-admin/logs` で `function_name = csp-report` で絞る)。
- 既定は強制。report-only の段は置かない (理由は §7.1)。`CSP_REPORT_ONLY=on` は戻すためのスイッチ。

### 3.2 代替案の比較と裁定 (1 回だけ)

| 案 | 中身 | 退ける理由 / 採る理由 |
|---|---|---|
| A. nonce を middleware で作り、全ページを動的にする (本書) | Next 公式の方式。方針は 1 か所。アプリのインラインスクリプトは 0 本にする | **採る。** 縁の発生源 (静的ページの nonce 不在・方針の二重化・画面ごとの nonce 読み) を構造で消す。残るのは「middleware が毎回付ける」の 1 点 |
| B. hash 方式 (`'sha256-…'`) で静的ページを静的のまま保つ | インラインスクリプトの hash を方針に書く | 退ける。Next App Router のインラインスクリプト (`self.__next_f.push([...])` の RSC ペイロード) はページ・リクエストごとに中身が変わり、hash を事前に決められない。Next 公式も「静的ページでは nonce を入れられない」と述べ、hash の代替として挙げるのは実験的な SRI (webpack 限定・インラインは対象外) だけ |
| C. `'strict-dynamic'` + nonce (Next 公式の例) | ホストの許可を捨て、nonce つきスクリプトが作るスクリプトを信頼する | 退ける。Turnstile の `api.js` と Speed Insights の `script.js` はどちらも `createElement('script')` で読まれるので動くが、Cloudflare が「nonce を使わない明示の代替」として文書化しているのはホストの許可であり、現行の許可 (`https://challenges.cloudflare.com`・`*.vercel-scripts.com`・`'self'`) をそのまま残す方が、既存の e2e (`auth-turnstile.spec.ts`) と Jest の突き合わせ (`frame-src`) を変えずに済む。`'strict-dynamic'` は後から足せる (§22 Q-5) |
| D. 静的ページだけ `'unsafe-inline'` を残す (方針を 2 通り持つ) | 公開ページは静的のまま、保護ページだけ nonce | 退ける。#1169 の要求 (本番の `script-src` に `'unsafe-inline'` が無い) を満たさない。XSS の被害は公開ページ (ログイン画面のフィッシング) でも同じ |
| E. report-only の段を数週間置いてから強制に切り替える | 本番で違反を集めてから強制 | 退ける (段としては)。利用者ゼロで集まる違反は無く、代わりに e2e (全画面の CSP 違反 0 件) と整合ゲートの実機確認で確かめる。報告の受け口と `CSP_REPORT_ONLY` のスイッチは残し、ローンチ後に問題が出たときの戻し方にする (§7) |

「縁の発生源を消すより単純な構造は無いか」への答え: A より単純なのは「`next.config.mjs` の文字列から `'unsafe-inline'` を消すだけ」だが、それは Next のインラインスクリプトを全部止めて画面が動かなくなる (nonce か hash が必須)。A で確定し、以後は構造を蒸し返さない (仕上げ中の構造疑義は裁定への差し戻し事由として扱う)。

### 3.3 シナリオのトレース (構造 A で手で走らせた記録)

| # | 経路 | 結果 |
|---|---|---|
| S-1 | matcher 対象 → nonce 生成 → request header に CSP / `x-csp-nonce` → `updateSession`: 未ログイン × 公開パス → `supabaseResponse` → 応答ヘッダーに CSP → Next: ルート layout が `force-dynamic` なので描画はリクエスト時 → request header の CSP から nonce → `<script nonce>` → ブラウザ: 方針の nonce と一致 → 実行 | 一致 (違反 0) |
| S-2 | S-1 と同じ経路で `/login` → 画面の `loadTurnstileApi` が `createElement('script')` に `src=https://challenges.cloudflare.com/...` → 方針の `script-src` のホストで許可 → ウィジェットの iframe は `frame-src` のホストで許可 → トークン | 一致 (`auth-turnstile.spec.ts` が確かめる) |
| S-3 | `updateSession`: ログイン済み → 同意の判定 `banner` → `withLegalConsentPendingHeader(request, supabaseResponse)`: `request.headers.set('x-legal-consent-pending','1')` → `NextResponse.next({ request })` を作り直す → この `request` は middleware が CSP を載せたのと同じオブジェクトなので CSP / `x-csp-nonce` も転送される → middleware が応答ヘッダーの CSP を付ける → `(main)/layout.tsx` が `x-legal-consent-pending` を読む → Next が同じ nonce を付ける | 一致 (`tests/middleware-csp.test.ts` が、作り直した応答でも request header の nonce が応答の nonce と同じことを確かめる) |
| S-4 | `updateSession` が `NextResponse.redirect(/frozen)` を返す → middleware が CSP を付けて返す (3xx に本文は無く害は無い) → ブラウザが `/frozen` を GET → S-1 と同じ | 一致 |
| S-5 | `updateSession` が `maintenancePageResponse()` (503 HTML。`<style>` のみ・`<script` 無し。`src/__tests__/lib/maintenance-mode.test.ts` が固定) を返す → CSP が付く → `style-src 'unsafe-inline'` で `<style>` は有効 | 一致 |
| S-6 | `/api/*` の分岐 → `supabaseResponse` (JSON の route へ) → CSP が付く → JSON には CSP の効く要素が無い | 一致 |
| S-7 | 差し込まれた `<script>` に nonce が無い → ブラウザが止める → `report-uri` へ POST (`application/csp-report`・同一オリジン・Cookie つき) → middleware: `/api/csp-report` は同意の許可リスト (telemetry) にあり、凍結・メンテナンスは既存どおり → route: NULL 文字なし → IP の回数制限 OK → Content-Type OK → 8 KiB 以下 → JSON → Zod OK → `toCspViolationLogEntry` (URL のクエリ・#・トークンらしい区間を落とす) → `createLogger('csp-report').warn` → 204 | 一致 (`app_logs` に `level=warn, source=api-route, function_name=csp-report`) |
| S-8 | `generateCspNonce` は `crypto.getRandomValues` の 16 バイト → base64 → 毎回違う (`tests`: 100 回で重複なし)。動的ページの応答は Next が `Cache-Control: private, no-cache, no-store, …` を付け、保護ページは `updateSession` が `private, no-store` を付ける → CDN に乗らない → 同じ nonce の HTML が他の人に配られない | 一致 |
| S-9 | `isDev = process.env.NODE_ENV === 'development'` → `script-src` に `'unsafe-eval'` が足される → HMR の `eval` が動く。nonce の経路は本番と同じ (Next は dev でも request header から読む) | 一致 |
| S-10 | CI は `next build && next start` (dev ではない) → `'unsafe-eval'` 無し・nonce あり → `auth-turnstile.spec.ts` は `securitypolicyviolation` を集め Cloudflare 向けが 0 件 → `csp-nonce.spec.ts` は `/` と `/login` で違反 0 件・インライン script の `nonce` が全部ある・nonce が要求ごとに違う・受け口の 204 / 400 / 413 / 415 | 一致 |
| S-11 | WebView は同じ URL を同じ CSP で読む。`injectedJavaScriptBeforeContentLoaded` / `injectedJavaScript` は WebView (iOS `WKUserScript` / Android `evaluateJavascript`) が注入する側のスクリプトで、文書の `script-src` の対象ではない。注入 JS は `eval` / `new Function` を使わない (`apps/mobile/src/lib/webViewBridge.ts`・`webViewUserStorageCleanup.ts` の grep で 0 件。本番の方針は今も `'unsafe-eval'` 無し)。Turnstile の iframe は `frame-src` と `WEB_VIEW_EMBED_ORIGINS` で今までどおり | 一致 (iOS / Android の実機で §15 の整合項目として確かめる) |
| S-12 | `isCspReportOnly()` が `on` → ヘッダー名が `Content-Security-Policy-Report-Only` (request header も同じ名前。Next は `content-security-policy-report-only` からも nonce を読む) → 違反は止まらず報告だけ届く → §7.3 の条件で外す | 一致 |
| S-13 | 拡張のスクリプトは nonce が無い → 止まる → 報告の `blocked_uri` が `chrome-extension` / 他オリジン → `scrubCspReportUri` は http(s) 以外はスキームだけ残す (`chrome-extension:`) → 運営は `inline` / 自オリジンの行だけを自分のコード由来として見る | 一致 |
| S-14 | `rejectNullCharacterBody` (NULL 文字 → 400) → `checkRateLimit(ip, 'csp-report')` (30 回/分・300 回/日 → 429) → `isCspReportContentType` (違えば 415) → 本文の `TextEncoder` のバイト数 > 8 KiB → 413 → `JSON.parse` 失敗 → 400 → `CspReportBodySchema.safeParse` 失敗 → 400 | 一致 (どの 4xx も `app_logs` に書かない) |
| S-15 | middleware が `x-csp-nonce`・`Content-Security-Policy`・`Content-Security-Policy-Report-Only` の 3 つを `delete` してから `set` → Next が読むのは middleware の値 → 応答の nonce と一致 | 一致 |
| S-16 | `tests/csp-no-inline-script.test.ts` が構文木で `<script>` / `<Script>` 要素・`next/script` の import・`<script` を含む文字列を見つける → 許可リスト (空) に無い → 赤 → 文言が外部ファイル化か `getCspNonce()` + 許可リスト (理由 + `nonce` 属性) を案内 | 一致 |

---

## 4. nonce の経路と既存 middleware との合成順 (R-2, R-3, R-4)

### 4.1 順序 (1 リクエスト)

1. `src/middleware.ts` `middleware(request)`: `attachCspToRequest(request)` — nonce を作り、方針を組み立て、`request.headers` から `x-csp-nonce`・`Content-Security-Policy`・`Content-Security-Policy-Report-Only` を捨て、`x-csp-nonce` と (強制なら `Content-Security-Policy`、報告だけなら `Content-Security-Policy-Report-Only`) を載せる。`request.headers.set` は try / catch で包まない (`x-legal-consent-pending` は「出せなくても画面は止めない」ので包んでいるが、CSP の request header が載らないと Next が nonce を付けられず、強制の方針が全ページを止める。載せられない環境なら middleware の例外として 500 で止まる方が、黙って壊れるより分かりやすい)。
2. `updateSession(request)` (既存。変えない): `NextResponse.next({ request })` を 1 度作り、分岐ごとに `redirect` / `NextResponse.json` / `maintenancePageResponse()` / `internalError()` / `withLegalConsentPendingHeader` での作り直し / `supabaseResponse` のどれかを返す。どの経路も `request` は同じオブジェクトなので、1. で載せた request header は転送される (`NextResponse.next({ request })` は作った時点の `request.headers` を `x-middleware-request-*` として Next に渡す)。
3. `middleware` が戻った応答に `res.headers.set(ヘッダー名, 方針)` を付ける (すべての戻り値に対して。`NextResponse.next()` の応答ヘッダーは最終の応答に写される — 既存の `Cache-Control: private, no-store` と同じ経路)。
4. `is_native_app` Cookie (既存。変えない)。
5. Next: 画面の描画時に request header の CSP から nonce を読み、Next 生成の `<script>` に付ける。route handler は request header を読めるが読まない。画面は `getCspNonce()` で `x-csp-nonce` を読める (今は呼ぶ画面が無い)。

### 4.2 保証

| 応答の経路 (updateSession の戻り値) | 応答ヘッダーの CSP | request header の nonce が Next に届く |
|---|---|---|
| `supabaseResponse` (`NextResponse.next`) | 付く (3.) | 届く (画面は nonce つき) |
| `withLegalConsentPendingHeader` で作り直した `NextResponse.next({ request })` | 付く | 届く (同じ `request`) |
| `NextResponse.redirect` (未ログイン・凍結・同意・初期設定) | 付く (本文無し) | 不要 |
| `NextResponse.json` 403 (凍結・同意) / `maintenanceApiResponse()` 503 | 付く | 不要 |
| `maintenancePageResponse()` 503 HTML | 付く (`<style>` は `style-src 'unsafe-inline'` で有効) | 不要 (Next は描画しない) |
| `internalError()` 500 (必須の環境変数が無い) | 付く | 不要 |
| matcher の外 (`_next/static`・`_next/image`・`_vercel/`・`favicon.ico`・`manifest.json`・`robots.txt`・`sw.js`・`workbox-`・`api/health`・画像拡張子) | 付かない (文書ではない。画像拡張子の存在しないパスの 404 HTML だけが残存: §22 Q-4) | – |

### 4.3 matcher

変えない。Next 公式はプリフェッチ (`next-router-prefetch` / `purpose: prefetch`) の除外を勧めるが、プリフェッチの応答 (RSC) も `updateSession` を通すのが既存の挙動で、nonce の生成は乱数 16 バイトで無視できる。`tests/health-middleware-exemption.test.ts`・`tests/speed-insights-middleware-1179.test.ts`・`lib/supabase/__tests__/middleware-legal-consent-api.test.ts` の「`/api` で外すのは `api/health$` だけ」はそのまま緑。

## 5. 静的ページの動的化 (R-5)

### 5.1 なぜ全ページか

Next は nonce をリクエスト時の描画で付ける。ビルド時に静的化 (SSG / ISR) した HTML には nonce が無く、そのページに nonce つきの方針を返すと Next のインラインスクリプト (`self.__next_f.push(...)` の RSC ペイロード・bootstrap) が止まり、ハイドレーションも RSC の受け取りも壊れる。方針は全パスに同じ nonce 方式で返すので、全ページを動的にする。

### 5.2 やり方

`src/app/layout.tsx` (ルートの layout) に `export const dynamic = 'force-dynamic'` を書く。ルートは全ルートの祖先なので、配下の全 page が動的になる (`(main)/layout.tsx`・`admin/layout.tsx` の同じ指定と、個々の page の指定は残す。重なっても害は無く、diff を小さくする)。公式ガイドの `await connection()` と効果は同じで、宣言なので `tests/csp-no-inline-script.test.ts` が `import('@/app/layout')` の `dynamic` を機械検査できる。

### 5.3 動的になるページ (現状、祖先の layout にも自身にも動的のマーカーが無いもの。ファイル内のマーカーの機械分類で、ビルドの実測ではない)

`src/app/page.tsx` (LP)・`about`・`company`・`contact`・`faq`・`guide`・`legal`・`news`・`pricing`・`privacy`・`terms`・`onboarding/{page,complete,resume,welcome}`・`(operator)/operator/membership/{audit,families/inactive,orgs/inactive,families/[id]/transfer,orgs/[id]/transfer}`・`super-admin/{page,audit-logs,coupons/[id],coupons/new,experiments/*,exports/*,feature-packages/[id],feature-packages/new,flags,flags/new,infra/*,llm/*,logs,plans/[id],plans/[id]/price-change,plans/new}`・`not-found` (`/_not-found`)。`(auth)/*`・`frozen/*`・`legal-consent`・`invite/[token]`・`family/promotions/[token]`・`handson-tour/*`・`super-admin/{coupons,feature-packages,plans}` の一覧は自身にマーカーがあり、`(main)`・`(org)`・`(support)`・`admin` 配下は祖先の layout が動的。`generateStaticParams`・`revalidate = N`・`force-static` の指定は `src/app` に無い (grep 0 件) ので衝突しない。

### 5.4 影響と扱い

| 項目 | 現行 | 設計後 | 扱い |
|---|---|---|---|
| 公開ページの配信 | ビルド時の HTML を CDN から | リクエストごとにサーバーで描画 (データ取得は無いので描画は軽い。Vercel の関数の起動が加わる) | 受け入れる。ローンチ前の整合ゲートで LP の Lighthouse (目標 ≥ 90。`docs/design/CLAUDE.md` E) を実測し、下回れば §22 Q-7 |
| 応答のキャッシュ | 公開ページは CDN に乗りうる | `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` (Next の動的ページの既定) | nonce の一意性 (R-3) に必要 |
| ブラウザのルーターのキャッシュ | 静的 300 秒 / 動的 30 秒 (`next.config.mjs` の `staleTimes`) | 全ページ動的の 30 秒 | 受け入れる (戻る・進むで RSC を取り直す回数が増える) |
| ビルドの出力 | `○` (Static) と `ƒ` (Dynamic) が混在 | すべて `ƒ` | 整合ゲートで `next build` の表を見る (`○` が 1 つも無い。`/_not-found` も `ƒ`) |
| ISR / PPR | 使っていない | 使えない | 変化なし |

## 6. インラインのスクリプト・style と外部スクリプトの全列挙と移し方 (R-6)

### 6.1 スクリプト

| # | 箇所 | 種類 | 移し方 | 理由 |
|---|---|---|---|---|
| I-1 | `src/app/layout.tsx` の `<script dangerouslySetInnerHTML>` (`localStorage.removeItem('darkMode')` と `classList.remove('dark')`) | アプリのインラインスクリプト (唯一) | **削除** (`<head>` ごと) | 旧ダークモードの掃除で、いまのコードに `dark` クラスを付ける処理も `darkMode` キーを読む処理も無い (grep 0 件: 残るのは PreparingNotice の `tone: 'dark'` と Turnstile の `theme` の型だけ)。利用者ゼロなので消す古い値も無い。残すなら `getCspNonce()` + `nonce` 属性で動くが、死んだコードを nonce つきで残す理由が無い。`tests/inner-html-contract.test.ts` の許可リストからも外す (§18) |
| I-2 | Next が生成するインライン (`self.__next_f.push`・bootstrap・dev の overlay) | フレームワーク | Next が nonce を付ける | request header の CSP から読む (§2 の一次情報) |
| I-3 | `src/components/SpeedInsightsClient.tsx` → `@vercel/speed-insights` 2.0.0 | 外部スクリプト (`createElement('script')` + `src`。本番 `/_vercel/speed-insights/script.js`、dev `https://va.vercel-scripts.com/v1/speed-insights/script.debug.js`) | 変更なし | `'self'` と `*.vercel-scripts.com` で許可済み。インラインの script 要素は作らない (`window.si` は代入) |
| I-4 | `src/lib/auth/turnstile.ts` `loadTurnstileApi` (`createElement('script')` + `src=https://challenges.cloudflare.com/turnstile/v0/api.js`) | 外部スクリプト | 変更なし (nonce 属性は付けない) | ホストの許可を残す (Cloudflare の明示の代替)。`'strict-dynamic'` を使わないので nonce は要らない |
| I-5 | `next/script`・解析タグ (GA / PostHog)・Stripe.js | 無い (`src` に `next/script` の import 0 件・PostHog は #1166 で撤去・Stripe はサーバー側) | 足すときは `getCspNonce()` を `nonce` に渡し、走査の許可リストに理由を書く | §21 |
| I-6 | `src/components/AIChatBubble.tsx` の `dangerouslySetInnerHTML` (`parseMarkdown` の戻り値) | HTML (script を含まない) | 変更なし | `markdown-lite.ts` がエスケープする。万一 script が混じっても nonce が無く止まる (多層防御) |
| I-7 | `public/sw.js` | 無い (matcher の除外は先回り) | 変更なし | – |

### 6.2 style

| # | 箇所 | 種類 | 移し方 |
|---|---|---|---|
| T-1 | `src/app/(main)/badges/page.tsx:142`・`src/components/AIChatBubble.tsx:1548` の `<style jsx global>` (styled-jsx) | インライン `<style>` 要素 | 据え置き (`style-src 'unsafe-inline'`) |
| T-2 | `src/app/(main)/favorites/page.tsx:347` の素の `<style>` | インライン `<style>` 要素 | 据え置き |
| T-3 | React の `style={…}` prop (`src` に約 2,272 行) | `style` 属性 | 据え置き (nonce は属性に効かない。`style-src-attr` の許可は `'unsafe-inline'` か `'unsafe-hashes'` + hash しか無い) |
| T-4 | `src/lib/maintenance-mode.ts` の `MAINTENANCE_PAGE_HTML`・`src/app/(auth)/auth/native-bridge/route.ts` の `LEGACY_CLOSED_HTML` の `<style>` | 決まった HTML の中のインライン style | 据え置き |
| T-5 | `src/app/global-error.tsx` の `style={…}` | `style` 属性 | 据え置き |

### 6.3 `style-src` の判断: 据え置く (`'self' 'unsafe-inline'`)

- 理由 1: T-3 の `style` 属性 2,272 箇所は nonce で許可できず、hash 化は現実的でない。`style-src-elem` だけ nonce にしても属性のために `style-src-attr 'unsafe-inline'` が要り、守りの実益が小さい。
- 理由 2: #1169 の対象は `script-src`。style の差し込みの害 (見た目の改変・CSS による限定的な情報の漏れ) は `img-src` / `connect-src` の許可先が絞られている今、script より小さい。
- 後続: styled-jsx の nonce 対応 (`StyleRegistry`) と `style` 属性の棚卸しを別 Issue にする (§22 Q-2)。

## 7. 違反の報告と report-only (R-7)

### 7.1 段としての report-only は置かない

利用者ゼロの本番で集まる違反は無い。代わりに (a) e2e で `/` と `/login` の `securitypolicyviolation` が 0 件、(b) Turnstile の e2e が 0 件、(c) 整合ゲートで全画面を開いて開発者ツールの CSP 違反が 0 件、を確かめてから出す。報告の受け口は強制のまま常設し (強制でも報告は送られる)、ローンチ後に問題が出たときは `CSP_REPORT_ONLY=on` で止めずに集める側へ戻せる。

### 7.2 受け口と記録

- 方針に `report-uri /api/csp-report` を書く (`report-to` は使わない: `Reporting-Endpoints` の追加と 2 つ目の本文の形 (`application/reports+json`) が要り、Firefox は未対応。§22 Q-3)。`'report-sample'` を `script-src` に書き、止めたインラインスクリプトの先頭 40 文字を報告に含める (どのスクリプトかを運営が見分けるため)。
- 受け口 `POST /api/csp-report` は未認証。守りは順に NULL 文字 (400) → IP ごとの回数制限 `csp-report` (30 回/分・300 回/日 → 429) → Content-Type (`application/csp-report` か `application/json` 以外は 415) → 本文 8 KiB 超 (413) → JSON と Zod (400)。通ったものだけ `createLogger('csp-report').warn(...)` で `app_logs` に残す (保存は待たない。応答は 204)。
- 記録は `level=warn` (運用のエラー急増メールは `error` だけを数えるので鳴らない)・`source=api-route`・`function_name=csp-report`・`message = "CSP violation: <effective-directive> blocked <blocked-uri>"`・`metadata` は §9.3 の `CspViolationLogMetadata`。URL はクエリ・`#`・ユーザー名・パスワードを落とし、トークンらしい区間 (16 文字以上・英数字と `_` `-` だけ・数字を含む) を `[redacted]` にする (`/invite/<token>`・`/family/promotions/<token>`・UUID を残さない)。`original-policy` と `referrer` は保存しない。利用者は特定しない (`user_id` 無し。セッションを読まない)。
- 運営の読み方: `/super-admin/logs` (operator/10 §9) で `function_name = csp-report`。`blocked_uri` が `inline` / `eval` / 自オリジンのものが自分のコード由来、他オリジン (`chrome-extension:` / `moz-extension:` / 広告ブロッカーなど) は利用者側の環境由来。Vercel の preview では Vercel toolbar (`https://vercel.live`) が止まり報告される (`document_uri` のホストが preview のものなので見分けられる)。

### 7.3 `CSP_REPORT_ONLY` と強制へ戻す条件

| 値 | ヘッダー名 (応答と request) | 挙動 |
|---|---|---|
| 未設定 / `on` 以外 (既定) | `Content-Security-Policy` | 違反を止め、報告も送る |
| `on` (大文字小文字と前後の空白は区別しない。`LEGAL_CONSENT_*` と同じ読み方) | `Content-Security-Policy-Report-Only` | 違反を止めず、報告だけ送る |

- 使う場面: ローンチ後に、ある画面でスクリプトが止まる報告が集まったとき。`on` にして再デプロイ (Vercel の環境変数は再デプロイ後に効く) → 原因の修正を出す → 外して再デプロイ。
- 強制へ戻す条件: 直近 7 日の `csp-report` の行のうち、`blocked_uri` が `inline` / `eval` / 自オリジンのものが 0 件。他オリジンの報告は数えない。
- `on` のままにしない: `tests/e2e/csp-nonce.spec.ts` は `Content-Security-Policy` (強制) を期待するので、CI の起動では `on` にしない。

## 8. 開発・テスト・WebView (R-8, R-9)

### 8.1 開発 (`next dev`)

`script-src` に `'unsafe-eval'` を足す (現行と同じ分岐)。nonce の経路は本番と同じ。Playwright のローカル実行 (`playwright.config.ts` の `webServer` は `npm run dev`) もこの方針で動く。`page.evaluate` / `page.addInitScript` は CDP 経由でページの CSP の対象外 (e2e は `addScriptTag` を使っていない: grep 0 件)。

### 8.2 e2e (CI は `next build && next start`)

- `tests/e2e/auth-turnstile.spec.ts` (変更なし): 本物の `api.js` と iframe が nonce 方式の CSP で動くことを確かめる (Cloudflare 向けの `securitypolicyviolation` 0 件)。`helpers/turnstile-offline.ts` の差し替えも URL は本物なのでホストの判定を受ける。
- `tests/e2e/adversarial-deep.spec.ts` F-1 / F-2・`tests/e2e/bug-140-145-security-auth.spec.ts` (変更なし): `/` の応答に `content-security-policy` と `frame-ancestors 'none'` があることは middleware の付与で満たす。
- `tests/e2e/csp-nonce.spec.ts` (新設。§15): nonce・違反 0 件・受け口。

### 8.3 モバイルの WebView

- 注入 JS (`injectedJavaScriptBeforeContentLoaded` / `injectedJavaScript`) は WebView が注入する側のスクリプトで、文書の `script-src` の対象にならない。`eval` / `new Function` を使っていない (grep 0 件) ので `'unsafe-eval'` の有無も関係ない (本番は今も無し)。
- Turnstile の iframe は `frame-src` のまま。`WEB_VIEW_EMBED_ORIGINS` も変えない。Jest の突き合わせの参照先 (`next.config.mjs` → `src/lib/security/csp.ts`) だけ直す (§18)。
- 整合ゲートで iOS / Android の実機で `/login` (Turnstile) と `/home` (タブの横取り) を開いて確かめる。

---

## 9. 正典コード (定数 / 純関数 / Zod / 型)

### 9.1 `src/lib/security/csp.ts` (Edge Runtime で動く。何も import しない)

```ts
// src/lib/security/csp.ts
// #1169 本番の CSP を nonce 方式にする正典: 方針の文字列・nonce の生成・ヘッダー名・報告先。
// middleware (Edge Runtime) から読むので、このファイルは何も import しない (zod・Node の API・@/lib/env を持ち込まない。
// src/lib/env-required.ts と同じ理由)。環境変数を名前で読むのは CSP_REPORT_ONLY だけ (src/lib/env.ts の一覧の readOnlyBy)。
// 方針の正本はここだけ。next.config.mjs には Content-Security-Policy を書かない (二重に付くと nonce つきのスクリプトが止まる。
// src/__tests__/config/next-config-headers.test.ts が見張る)。

/** 強制する CSP の応答ヘッダー名 */
export const CSP_HEADER = 'Content-Security-Policy';
/** 報告だけの CSP の応答ヘッダー名 (CSP_REPORT_ONLY=on のとき。違反を止めず報告だけする) */
export const CSP_REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';
/** middleware が画面 (Server Component) へ nonce を渡すリクエストヘッダー。Next 公式の x-nonce と同じ役目 */
export const CSP_NONCE_HEADER = 'x-csp-nonce';
/** 違反の報告の受け口 (POST。src/app/api/csp-report/route.ts) */
export const CSP_REPORT_PATH = '/api/csp-report';
/** nonce の乱数の長さ (バイト)。CSP3 は 128 ビット以上を求める。base64 で 24 文字になる */
export const CSP_NONCE_BYTES = 16;
/** generateCspNonce の戻り値の形 (base64)。これ以外を方針に入れない (ヘッダーへの差し込みを防ぐ) */
export const CSP_NONCE_PATTERN = /^[A-Za-z0-9+\/]+={0,2}$/;
/**
 * Cloudflare Turnstile の api.js とウィジェットの iframe のオリジン。src/lib/auth/turnstile.ts の TURNSTILE_SCRIPT_SRC と同じ
 * (src/__tests__/config/turnstile-config.test.ts が突き合わせる)。下の frame-src の行にも同じ値を文字どおりに書いてある
 * (apps/mobile の Jest が "frame-src 'self' https://…" の 1 行を文字列として読み、WEB_VIEW_EMBED_ORIGINS と突き合わせるため)
 */
export const CSP_TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
/** CSP_REPORT_ONLY を有効とみなす唯一の値 (lib/legal-consent.ts の LEGAL_CONSENT_FLAG_ON と同じ読み方) */
const CSP_REPORT_ONLY_FLAG_ON = 'on';
/** Supabase のクラウド (本番) のホストの末尾。これ以外 (ローカルの Supabase) のときだけ origin を方針に足す */
const SUPABASE_CLOUD_HOST_SUFFIX = '.supabase.co';

export interface CspBuildInput {
  /** このリクエストの nonce (generateCspNonce の戻り値) */
  nonce: string;
  /** next dev か (webpack の HMR が 'unsafe-eval' を要る)。呼ぶ側が process.env.NODE_ENV === 'development' を渡す */
  isDev: boolean;
  /** NEXT_PUBLIC_SUPABASE_URL (src/lib/env-required.ts の getSupabaseUrl() の値。無ければ undefined) */
  supabaseUrl: string | undefined;
}

export interface SupabaseLocalOrigins {
  /** http(s) の origin (例: http://127.0.0.1:54321) */
  http: string;
  /** Realtime 用の ws(s) の origin (例: ws://127.0.0.1:54321) */
  ws: string;
}

/**
 * ローカルの Supabase (scripts/supabase-local.sh の http://127.0.0.1:54321 など) にブラウザから接続できるよう、
 * NEXT_PUBLIC_SUPABASE_URL が *.supabase.co 以外のときだけ、その origin (と Realtime 用の ws / wss) を返す。
 * 本番 (*.supabase.co)・未設定・URL でない値は null (方針は変わらない)。next.config.mjs にあった判定をそのまま移した
 */
export function supabaseLocalOrigins(supabaseUrl: string | undefined): SupabaseLocalOrigins | null {
  if (supabaseUrl === undefined) return null;
  try {
    const url = new URL(supabaseUrl);
    if (url.hostname.endsWith(SUPABASE_CLOUD_HOST_SUFFIX)) return null;
    return { http: url.origin, ws: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` };
  } catch {
    return null;
  }
}

/** 1 リクエストにつき 1 つの nonce (16 バイトの乱数を base64 にした 24 文字)。Edge Runtime・Node・ブラウザのどれでも動く Web Crypto で作る */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(CSP_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 方針の文字列。ディレクティブの順と許可先は next.config.mjs にあった CSP を引き継ぎ、script-src だけを変えた:
 *   'unsafe-inline' を外し、'nonce-<nonce>' と 'report-sample' (止めたインラインの先頭 40 文字を報告に含める) を足す。
 * style-src は据え置き (docs/design/cross/16-csp-nonce.md §6.3)。report-uri は違反の報告の受け口。
 */
export function buildContentSecurityPolicy(input: CspBuildInput): string {
  if (!CSP_NONCE_PATTERN.test(input.nonce)) {
    throw new Error('CSP nonce must be base64');
  }
  const local = supabaseLocalOrigins(input.supabaseUrl);
  const supabaseImgSrc = local ? ` ${local.http}` : '';
  const supabaseConnectSrc = local ? ` ${local.http} ${local.ws}` : '';
  return [
    "default-src 'self'",
    // #1165: Cloudflare Turnstile の api.js。#1179: Speed Insights (本番は 'self'、dev は *.vercel-scripts.com)
    `script-src 'self' 'nonce-${input.nonce}'${input.isDev ? " 'unsafe-eval'" : ''} 'report-sample' *.vercel-scripts.com ${CSP_TURNSTILE_ORIGIN}`,
    // frame-src を書くと default-src へのフォールバックが無くなるので 'self' も書く。この 1 行は apps/mobile の Jest が文字どおりに読む
    "frame-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: *.supabase.co images.unsplash.com${supabaseImgSrc}`,
    // #1166: PostHog の送信先は許可しない
    `connect-src 'self' *.supabase.co *.vercel.app wss://*.supabase.co${supabaseConnectSrc}`,
    "frame-ancestors 'none'",
    "font-src 'self'",
    "object-src 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join('; ');
}

/** 方針の文字列を { ディレクティブ名 → 許可先の配列 } にする (テストと e2e が使う。空の区切りは飛ばす) */
export function cspDirectivesOf(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    directives.set(tokens[0], tokens.slice(1));
  }
  return directives;
}

/**
 * 報告だけ (Content-Security-Policy-Report-Only) にするか。環境変数 CSP_REPORT_ONLY が on のときだけ true (既定は強制)。
 * この変数を名前で読むのはこの関数だけ (src/lib/env.ts の一覧の readOnlyBy)。
 */
export function isCspReportOnly(value: string | undefined = process.env.CSP_REPORT_ONLY): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === CSP_REPORT_ONLY_FLAG_ON;
}

/** この環境で返す CSP のヘッダー名 (強制か報告だけか) */
export function cspHeaderName(reportOnly: boolean): string {
  return reportOnly ? CSP_REPORT_ONLY_HEADER : CSP_HEADER;
}
```

### 9.2 `src/lib/security/csp-nonce.ts` (Server Component / route から nonce を読む。Node 側)

```ts
// tsc:skip (新設モジュール @/lib/security/csp を import するため、独立の検査では解決できない)
// src/lib/security/csp-nonce.ts
import { headers } from 'next/headers';
import { CSP_NONCE_HEADER } from '@/lib/security/csp';

/**
 * このリクエストの CSP の nonce (middleware が x-csp-nonce に載せた値)。middleware の外 (matcher の除外パス・ビルド時) は null。
 * アプリのインラインスクリプトは 0 本なので今は呼ぶ画面が無い。どうしてもインラインの script や next/script が要るときは、
 * これを `nonce` 属性に渡し、tests/csp-no-inline-script.test.ts の許可リストに理由を書く。
 * headers() は await の直下で呼ぶ (tests/next15-async-request-api-scan.test.ts の規則 1)
 */
export async function getCspNonce(): Promise<string | null> {
  return (await headers()).get(CSP_NONCE_HEADER);
}
```

### 9.3 `src/lib/security/csp-report.ts` (報告の形・検証・ログの形。Node 側。zod を使う)

```ts
// src/lib/security/csp-report.ts
// #1169 違反の報告 (report-uri が送る application/csp-report) の形・上限・app_logs に残す形。route (src/app/api/csp-report/route.ts) はこれだけを呼ぶ。
import { z } from 'zod';

/** 受け付ける Content-Type (ブラウザは application/csp-report。curl やテストは application/json も可)。media type の部分だけを小文字で比べる */
export const CSP_REPORT_CONTENT_TYPES = ['application/csp-report', 'application/json'] as const;
/** 本文の上限 (バイト)。実際の報告は original-policy (約 700 バイト) を含めて 1〜2 KB。余裕を見つつ、大きな本文で CPU を使わせない */
export const CSP_REPORT_MAX_BYTES = 8 * 1024;
/** 保存する URL (document_uri / blocked_uri / source_file) の上限 (文字) */
export const CSP_REPORT_URI_MAX_CHARS = 2048;
/** 保存するディレクティブ名の上限 (文字) */
export const CSP_REPORT_DIRECTIVE_MAX_CHARS = 256;
/** 'report-sample' がブラウザに載せるインラインの先頭の文字数 (CSP3 の定め)。それより長い値も切る */
export const CSP_REPORT_SCRIPT_SAMPLE_MAX_CHARS = 40;
/** 保存する User-Agent の上限 (文字) */
export const CSP_REPORT_USER_AGENT_MAX_CHARS = 256;
/** URL のパスの区間を「トークンらしい」とみなす最小の長さ (招待トークン・UUID は 16 文字以上。画面の名前は短いか数字を含まない) */
export const CSP_REPORT_TOKEN_SEGMENT_MIN_CHARS = 16;
/** トークンらしい区間の置き換え */
export const CSP_REPORT_REDACTED_SEGMENT = '[redacted]';
/** app_logs の function_name (運営の画面 /super-admin/logs で絞る語)。createLogger に渡す */
export const CSP_REPORT_LOG_FUNCTION_NAME = 'csp-report';

/** 4xx の本文の code (cross/04 §4.2 に [NEW] で足す) */
export const CSP_REPORT_ERROR_CODES = {
  invalid: 'CSP_REPORT_INVALID',
  tooLarge: 'CSP_REPORT_TOO_LARGE',
  unsupportedMediaType: 'CSP_REPORT_UNSUPPORTED_MEDIA_TYPE',
} as const;

/** 0 以上の整数。数値でない・負の値は undefined にして落とす (報告を 400 にしない) */
const optionalCount = z.number().int().nonnegative().optional().catch(undefined);

/**
 * application/csp-report の本文 { "csp-report": {…} }。知らないキーは捨てる (zod の既定)。
 * 文字列の長さはここでは縛らない (本文全体の上限 CSP_REPORT_MAX_BYTES で抑え、保存時に切る)。報告を落とさないため
 */
export const CspReportSchema = z.object({
  'document-uri': z.string().optional(),
  referrer: z.string().optional(),
  'blocked-uri': z.string().optional(),
  'effective-directive': z.string().optional(),
  'violated-directive': z.string().optional(),
  'original-policy': z.string().optional(),
  disposition: z.enum(['enforce', 'report']).optional().catch(undefined),
  'source-file': z.string().optional(),
  'line-number': optionalCount,
  'column-number': optionalCount,
  'status-code': optionalCount,
  'script-sample': z.string().optional(),
});
export const CspReportBodySchema = z.object({ 'csp-report': CspReportSchema });
export type CspReport = z.infer<typeof CspReportSchema>;
export type CspReportBody = z.infer<typeof CspReportBodySchema>;

/** app_logs の metadata (snake_case)。null は報告に無かった項目 */
export type CspViolationLogMetadata = {
  effective_directive: string | null;
  violated_directive: string | null;
  blocked_uri: string | null;
  document_uri: string | null;
  source_file: string | null;
  line_number: number | null;
  column_number: number | null;
  disposition: 'enforce' | 'report' | null;
  status_code: number | null;
  script_sample: string | null;
  user_agent: string | null;
};

export interface CspViolationLogEntry {
  message: string;
  metadata: CspViolationLogMetadata;
}

export interface CspViolationLogContext {
  /** リクエストの User-Agent (無ければ null) */
  userAgent: string | null;
}

/** Content-Type が受け付ける種類か (パラメータ `; charset=…` は無視。大文字小文字は区別しない) */
export function isCspReportContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return (CSP_REPORT_CONTENT_TYPES as readonly string[]).includes(mediaType);
}

/** 本文のバイト数 (UTF-8)。Content-Length を信じず、読んだ本文で数える */
export function cspReportByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/** 招待トークン・UUID のような区間か (16 文字以上・英数字と _ - だけ・数字を含む)。画面の名前 (representative-transfer など) は数字を含まないので当たらない */
function isTokenLikeSegment(segment: string): boolean {
  return (
    segment.length >= CSP_REPORT_TOKEN_SEGMENT_MIN_CHARS && /^[A-Za-z0-9_-]+$/.test(segment) && /[0-9]/.test(segment)
  );
}

/** パスのトークンらしい区間を [redacted] にする (/invite/<token>・/family/promotions/<token>・/meals/<uuid> などを残さない) */
export function maskTokenLikeSegments(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (isTokenLikeSegment(segment) ? CSP_REPORT_REDACTED_SEGMENT : segment))
    .join('/');
}

/**
 * 報告の URL を保存できる形にする。
 *   - http(s) の URL: origin + パス (クエリ・#・ユーザー名・パスワードを落とし、トークンらしい区間を [redacted] に)
 *   - それ以外の URL (data: / blob: / chrome-extension: / about: など): スキームだけ (中身に攻撃の本文が入りうる)
 *   - URL でない値 (CSP の語 inline / eval / self / data など): そのまま (上限まで)
 *   - 無い・空: null
 */
export function scrubCspReportUri(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return truncate(trimmed, CSP_REPORT_URI_MAX_CHARS);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return parsed.protocol;
  return truncate(`${parsed.origin}${maskTokenLikeSegments(parsed.pathname)}`, CSP_REPORT_URI_MAX_CHARS);
}

/** 報告 1 件を app_logs の 1 行 (message + metadata) にする。original-policy と referrer は残さない。利用者は特定しない */
export function toCspViolationLogEntry(report: CspReport, context: CspViolationLogContext): CspViolationLogEntry {
  const effectiveDirective = report['effective-directive'] ? truncate(report['effective-directive'], CSP_REPORT_DIRECTIVE_MAX_CHARS) : null;
  const violatedDirective = report['violated-directive'] ? truncate(report['violated-directive'], CSP_REPORT_DIRECTIVE_MAX_CHARS) : null;
  const blockedUri = scrubCspReportUri(report['blocked-uri']);
  const metadata: CspViolationLogMetadata = {
    effective_directive: effectiveDirective,
    violated_directive: violatedDirective,
    blocked_uri: blockedUri,
    document_uri: scrubCspReportUri(report['document-uri']),
    source_file: scrubCspReportUri(report['source-file']),
    line_number: report['line-number'] ?? null,
    column_number: report['column-number'] ?? null,
    disposition: report.disposition ?? null,
    status_code: report['status-code'] ?? null,
    script_sample: report['script-sample'] ? truncate(report['script-sample'], CSP_REPORT_SCRIPT_SAMPLE_MAX_CHARS) : null,
    user_agent: context.userAgent ? truncate(context.userAgent, CSP_REPORT_USER_AGENT_MAX_CHARS) : null,
  };
  return {
    message: `CSP violation: ${effectiveDirective ?? violatedDirective ?? 'unknown'} blocked ${blockedUri ?? 'unknown'}`,
    metadata,
  };
}
```

### 9.4 `src/app/api/csp-report/route.ts`

```ts
// tsc:skip (新設モジュール @/lib/security/csp-report を import するため、独立の検査では解決できない)
// src/app/api/csp-report/route.ts
/**
 * CSP の違反の報告の受け口 (#1169)。ブラウザが方針の report-uri へ application/csp-report で POST する。
 * 未認証 (報告はセッションの有無によらず届く)。守りは IP ごとの回数制限 (csp-report) と本文の上限。
 * 通った報告だけを app_logs に warn で残す (運営は /super-admin/logs で function_name = csp-report で絞る)。
 * 4xx はどれも app_logs に書かない (偽の報告で表を膨らませない)。本文に生のエラー文・環境変数名を入れない。
 */
import { NextRequest, NextResponse } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { internalError } from '@/lib/api/errors';
import { createLogger } from '@/lib/db-logger';
import { checkRateLimit, rateLimitExceededResponse, type RateLimitResult } from '@/lib/rate-limit';
import {
  CSP_REPORT_ERROR_CODES,
  CSP_REPORT_LOG_FUNCTION_NAME,
  CSP_REPORT_MAX_BYTES,
  CspReportBodySchema,
  cspReportByteLength,
  isCspReportContentType,
  toCspViolationLogEntry,
} from '@/lib/security/csp-report';

const ROUTE_NAME = 'POST /api/csp-report';
/** 受け付けたときの応答 (本文無し。ブラウザは応答を読まない) */
const ACCEPTED_STATUS = 204;
/** 4xx の本文の文 (固定) */
const INVALID_REPORT_MESSAGE = '報告の形が不正です';

function badRequest(status: 400 | 413 | 415, code: string): NextResponse {
  return NextResponse.json({ error: INVALID_REPORT_MESSAGE, code }, { status });
}

/** ログイン前の公開 API と同じく、プロキシが付けるクライアント IP を回数制限の key にする (src/app/api/contact/route.ts と同じ取り方) */
function clientIpOf(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';
}

export async function POST(request: NextRequest) {
  // 本文の NULL 文字は入口で 400 (#1657。一覧は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  let rateLimit: RateLimitResult;
  try {
    rateLimit = await checkRateLimit(clientIpOf(request), 'csp-report');
  } catch (error) {
    // Upstash への問い合わせが例外: fail-closed (判定できないなら通さない。contact と同じ)
    return internalError(ROUTE_NAME, error);
  }
  if (!rateLimit.success) return rateLimitExceededResponse(rateLimit);

  if (!isCspReportContentType(request.headers.get('content-type'))) {
    return badRequest(415, CSP_REPORT_ERROR_CODES.unsupportedMediaType);
  }
  const text = await request.text();
  if (cspReportByteLength(text) > CSP_REPORT_MAX_BYTES) return badRequest(413, CSP_REPORT_ERROR_CODES.tooLarge);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return badRequest(400, CSP_REPORT_ERROR_CODES.invalid);
  }
  const parsed = CspReportBodySchema.safeParse(json);
  if (!parsed.success) return badRequest(400, CSP_REPORT_ERROR_CODES.invalid);

  const entry = toCspViolationLogEntry(parsed.data['csp-report'], { userAgent: request.headers.get('user-agent') });
  // 保存は待たない (createLogger は console に出し、app_logs への insert は非同期)。応答は常に 204
  createLogger(CSP_REPORT_LOG_FUNCTION_NAME).warn(entry.message, entry.metadata);
  return new NextResponse(null, { status: ACCEPTED_STATUS });
}
```

### 9.5 `src/lib/rate-limit.ts` への差分

```ts
// tsc:skip (既存のファイルへの差分。全文は実装で)
export type RateLimitCategory =
  | 'generation'
  // … 既存のカテゴリはそのまま …
  | 'client-log'
  | 'csp-report';

// 【公開フォーム系】に足す説明:
// - csp-report: ブラウザが CSP の違反を報告する API (#1169。POST /api/csp-report。ログイン前でも届くので key はクライアント IP)。
//   壊れたデプロイでは 1 画面につき止まったスクリプトの数 (数件) の報告が出る。30 回/分は 1 人の操作を十分に上回り、
//   偽の報告の連打で app_logs (保持 30 日) を膨らませない。直近 24 時間の 300 回は 1 人の実際の使い方を十分に上回る値
const CATEGORY_RULES: Record<RateLimitCategory, readonly RateRule[]> = {
  // … 既存のカテゴリはそのまま …
  'csp-report': [
    { name: 'csp-report', max: 30, windowSec: MINUTE_SEC },
    { name: 'csp-report-daily', max: 300, windowSec: DAY_SEC },
  ],
};
```

### 9.6 `src/lib/env.ts` への差分 (`SERVER_ENV_VARS`)

```ts
// tsc:skip (既存のファイルへの差分。全文は実装で)
  CSP_REPORT_ONLY: {
    required: false,
    description:
      "本番の CSP を『報告だけ』(Content-Security-Policy-Report-Only) にするスイッチ (#1169)。'on' のときだけ違反を止めず、/api/csp-report へ報告だけ送らせる",
    whenMissing: '強制する (既定)。nonce の無いインラインスクリプトは止まり、報告も届く',
    // middleware (Edge Runtime) が読むので、zod を持つこのファイルの getOptionalEnv は使えない。読み方 (on だけ) を csp.ts の isCspReportOnly に 1 つ置く
    readOnlyBy: 'src/lib/security/csp.ts',
  },
```

`.env.example` (LEGAL_CONSENT_NOTICE の節の後に):

```
# ---- CSP を「報告だけ」にする (#1169、オプション) ----
# 本番の Content-Security-Policy は script-src に 'unsafe-inline' を持たず、毎リクエストの nonce で Next のスクリプトだけを許す。
# ローンチ後に、ある画面でスクリプトが止まる報告 (app_logs の function_name = csp-report) が集まったときの戻し方。
#   未設定 / on 以外: 強制する (既定)。違反は止まり、報告も届く
#   on: Content-Security-Policy-Report-Only で返し、違反を止めず報告だけ届かせる。直近 7 日に inline / eval / 自オリジンの報告が 0 件になったら外す
# サーバー側 (middleware) だけで読む (NEXT_PUBLIC_ にしない)。値の読み方は LEGAL_CONSENT_ENFORCE と同じ。Vercel で変えた場合は、再デプロイ後に効く
# CSP_REPORT_ONLY=off
```

`ENV_SETUP.md`: 「任意の環境変数: CSP を『報告だけ』にする (`CSP_REPORT_ONLY`)」の節を `LEGAL_CONSENT_NOTICE` の節の後に足す (上と同じ内容)。

### 9.7 `src/middleware.ts` (全文)

```ts
// tsc:skip (新設モジュール @/lib/security/csp を import するため、独立の検査では解決できない)
import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { getSupabaseUrl } from '@/lib/env-required'
import {
  CSP_HEADER,
  CSP_NONCE_HEADER,
  CSP_REPORT_ONLY_HEADER,
  buildContentSecurityPolicy,
  cspHeaderName,
  generateCspNonce,
  isCspReportOnly,
} from '@/lib/security/csp'

/** Supabase の URL (ローカルの Supabase なら方針に origin を足す)。無ければ undefined (updateSession が 500 で止める。ここでは止めない) */
function supabaseUrlOrUndefined(): string | undefined {
  try {
    return getSupabaseUrl()
  } catch {
    return undefined
  }
}

/**
 * #1169: このリクエストの nonce と方針を作り、リクエストヘッダーに載せる (Next は content-security-policy から nonce を読み、
 * 画面は x-csp-nonce から読める)。クライアントが同じ名前のヘッダーを送ってきても、捨てて付け直す (#1174 の x-legal-consent-pending と同じ)。
 * updateSession は NextResponse.next({ request }) を作るので、呼ぶ前に載せる。
 * request.headers.set は try / catch で包まない (載せられないと Next が nonce を付けられず、強制の方針が全ページを止める。黙って壊れるより止まる)
 */
function attachCspToRequest(request: NextRequest): { headerName: string; policy: string } {
  const nonce = generateCspNonce()
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    supabaseUrl: supabaseUrlOrUndefined(),
  })
  const headerName = cspHeaderName(isCspReportOnly())
  request.headers.delete(CSP_NONCE_HEADER)
  request.headers.delete(CSP_HEADER)
  request.headers.delete(CSP_REPORT_ONLY_HEADER)
  request.headers.set(CSP_NONCE_HEADER, nonce)
  request.headers.set(headerName, policy)
  return { headerName, policy }
}

export async function middleware(request: NextRequest) {
  const csp = attachCspToRequest(request)
  const res = await updateSession(request)
  // どの分岐の応答 (next / redirect / 403 / 503 / 500) にも同じ方針を付ける
  res.headers.set(csp.headerName, csp.policy)

  // ?mode=app が付いていれば is_native_app Cookie をセット (既存。変えない)
  const isAppMode = request.nextUrl.searchParams.get('mode') === 'app'
  const existingCookie = request.cookies.get('is_native_app')?.value
  if (isAppMode && existingCookie !== '1') {
    res.cookies.set('is_native_app', '1', {
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
    })
  }

  return res
}

export const config = {
  // matcher は変えない (既存のコメントと正規表現をそのまま)
  matcher: [
    '/((?!_next/static|_next/image|_vercel/|favicon\\.ico|manifest\\.json|robots\\.txt|sw\\.js|workbox-|api/health$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
```

### 9.8 `src/app/layout.tsx` への差分

```ts
// tsc:skip (Server Component。JSX を含むので型検査は実装の tsc で行う)
// 足す (import の後):
// #1169: CSP の nonce は毎リクエスト違うので、全ページを動的に描画する (静的化した HTML には nonce が入らず、Next の
// インラインスクリプトが止まる)。ルートの layout に書くと配下の全ルートが動的になる (docs/design/cross/16-csp-nonce.md §5)
export const dynamic = 'force-dynamic';

// 消す: <head> とその中の <script dangerouslySetInnerHTML={{ __html: `… localStorage.removeItem('darkMode') …` }} /> (§6.1 I-1)。
// <html lang="ja" …> の直下は <body> だけになる (metadata は Next が入れる)。
// Speed Insights のコメントの「CSP (next.config.mjs) は script-src / connect-src の 'self' で足り」を
// 「CSP (src/lib/security/csp.ts) は …」に直す。
```

### 9.9 `next.config.mjs` への差分

- 消す: `isDev`・`supabaseLocalOrigins`・`supabaseImgSrc`・`supabaseConnectSrc` と、`headers()` の `'/(.*)'` の `Content-Security-Policy` の項 (値とコメント)。
- 残す: `X-Frame-Options`・`X-Content-Type-Options`・`X-XSS-Protection`・`Strict-Transport-Security`・`/handson-tour/sample-meal.webp` の `Cache-Control`。
- 足す (コメント): 「CSP は `src/middleware.ts` が毎リクエスト nonce つきで付ける (`src/lib/security/csp.ts`)。ここに `Content-Security-Policy` を書くと応答に 2 つ並び、ブラウザは両方を満たすものしか通さないので nonce つきのスクリプトが止まる。`src/__tests__/config/next-config-headers.test.ts` が見張る」。

### 9.10 `packages/shared/src/legal-consent-api.ts` への差分

```ts
// tsc:skip (既存の一覧への 1 行。全文は実装で)
  { path: '/api/log', match: 'exact', reason: 'telemetry', note: '画面・端末の失敗の報告の受け口。運用のログ' },
  { path: '/api/csp-report', match: 'exact', reason: 'telemetry', note: 'ブラウザが送る CSP の違反の報告の受け口。利用者のデータではなく運用のログ。未同意の人の画面の違反も残す' },
```

凍結の `FROZEN_ALLOWED_API_PATHS` と `isMaintenanceExemptPath` には足さない (足すのは「本人がサービスから離れる操作」だけ、の原則。凍結中・メンテナンス中の報告は捨ててよい: 凍結の画面にスクリプトは無く、メンテナンスの HTML にもスクリプトは無い)。

## 10. facade 契約 (関数シグネチャと呼び出し側)

| 関数 / 定数 | 置き場 | 呼ぶ側 | 契約 |
|---|---|---|---|
| `buildContentSecurityPolicy(input: CspBuildInput): string` | `src/lib/security/csp.ts` | `src/middleware.ts`、テスト | 純関数。`input.nonce` が base64 でなければ throw。戻り値は `; ` 区切りの 10 ディレクティブ |
| `generateCspNonce(): string` | 同上 | `src/middleware.ts` | 16 バイトの乱数の base64 (24 文字)。毎回違う |
| `cspDirectivesOf(policy: string): Map<string, string[]>` | 同上 | テスト・e2e | 純関数 |
| `isCspReportOnly(value?: string): boolean` | 同上 | `src/middleware.ts` (引数なし)、テスト (引数あり) | `on` だけ true。`CSP_REPORT_ONLY` を名前で読む唯一の場所 |
| `cspHeaderName(reportOnly: boolean): string` | 同上 | `src/middleware.ts` | `Content-Security-Policy` / `Content-Security-Policy-Report-Only` |
| `supabaseLocalOrigins(url?: string): SupabaseLocalOrigins \| null` | 同上 | `buildContentSecurityPolicy`、テスト | `next.config.mjs` から移した判定 |
| `CSP_HEADER` / `CSP_REPORT_ONLY_HEADER` / `CSP_NONCE_HEADER` / `CSP_REPORT_PATH` / `CSP_NONCE_BYTES` / `CSP_NONCE_PATTERN` / `CSP_TURNSTILE_ORIGIN` | 同上 | middleware・テスト | 文字どおり |
| `getCspNonce(): Promise<string \| null>` | `src/lib/security/csp-nonce.ts` | (今は無し) Server Component / route | `x-csp-nonce` を読む |
| `CspReportSchema` / `CspReportBodySchema` / `CspReport` / `CspReportBody` | `src/lib/security/csp-report.ts` | route、テスト | zod。知らないキーは捨てる |
| `isCspReportContentType(contentType: string \| null): boolean` | 同上 | route | media type の部分だけで判定 |
| `cspReportByteLength(text: string): number` | 同上 | route | UTF-8 のバイト数 |
| `scrubCspReportUri(value?: string): string \| null` / `maskTokenLikeSegments(pathname: string): string` | 同上 | `toCspViolationLogEntry`、テスト | 純関数 (§7.2 の規則) |
| `toCspViolationLogEntry(report: CspReport, context: CspViolationLogContext): CspViolationLogEntry` | 同上 | route、テスト | 純関数。`metadata` は snake_case |
| `checkRateLimit(ip, 'csp-report')` | `src/lib/rate-limit.ts` (既存の関数にカテゴリを足す) | route | 30 回/分・300 回/日 |
| `createLogger(CSP_REPORT_LOG_FUNCTION_NAME).warn(message, metadata)` | `src/lib/db-logger.ts` (既存) | route | `app_logs` に `source=api-route`・`function_name=csp-report` |

## 11. API 仕様: `POST /api/csp-report`

| 項目 | 値 |
|---|---|
| 認証 | なし (セッションは読まない。middleware の `/api` の分岐は通るが、同意の許可リストにある) |
| Content-Type | `application/csp-report` または `application/json` (`; charset=…` は可)。それ以外は 415 |
| 本文 | `{ "csp-report": { "document-uri", "referrer", "blocked-uri", "effective-directive", "violated-directive", "original-policy", "disposition", "source-file", "line-number", "column-number", "status-code", "script-sample" } }` (すべて任意。知らないキーは捨てる)。8 KiB 以下 |
| 成功 | 204 (本文無し)。`app_logs` に 1 行 (保存は待たない) |
| 失敗 | §13 のエラー表。4xx は `app_logs` に書かない |
| 回数制限 | `csp-report` (クライアント IP。30 回/分・300 回/日)。超えたら `rateLimitExceededResponse` の 429 (`{ error, code: 'RATE_LIMITED', retryAfter }`) |
| runtime | Node (既定)。`export const dynamic` は書かない (POST は動的) |
| キャッシュ | 無し |

## 12. 表 3 点

### 12.1 ①全パターン表 (リクエストの種類 × middleware の経路 → CSP の付き方)

| # | リクエスト | matcher | updateSession の戻り | 応答の CSP | request header の nonce | Next が nonce を付ける |
|---|---|---|---|---|---|---|
| P-1 | 画面 GET (公開: `/` `/login` `/privacy` …)・未ログイン | 対象 | `NextResponse.next` | あり | あり | あり (全ページ動的) |
| P-2 | 画面 GET (保護: `/home` …)・ログイン済み | 対象 | `NextResponse.next` + `Cache-Control: private, no-store` | あり | あり | あり |
| P-3 | 画面 GET・同意のお知らせ (`banner`) | 対象 | `withLegalConsentPendingHeader` で作り直した `NextResponse.next({ request })` | あり | あり (同じ `request`) | あり |
| P-4 | 画面 GET・未ログインの保護パス | 対象 | `redirect(/login?next=…)` | あり | – | – |
| P-5 | 画面 GET・凍結 / 同意 (`redirect`) / 初期設定の差し戻し | 対象 | `redirect` | あり | – | – |
| P-6 | 画面 GET・メンテナンス中 (運営以外) | 対象 | `maintenancePageResponse()` 503 HTML | あり (`<style>` は `style-src 'unsafe-inline'`) | – | – |
| P-7 | RSC の取得 (`?_rsc`)・プリフェッチ | 対象 | `NextResponse.next` | あり | あり | (ペイロードに script 無し) |
| P-8 | Server Action (POST の画面 URL) | 対象 | `NextResponse.next` | あり | あり | – |
| P-9 | `/api/*` (JSON) | 対象 | `next` / 403 (凍結・同意) / 503 / 500 | あり (JSON に効く要素は無い) | あり (route は読まない) | – |
| P-10 | `POST /api/csp-report` | 対象 | `next` (同意の許可リスト。凍結 403 / メンテ 503 は既存どおり) | あり | – | – |
| P-11 | route handler の HTML (`/auth/native-bridge` の 426) | 対象 | `NextResponse.next` | あり (応答ヘッダーの写し) | – | – (`<style>` のみ) |
| P-12 | `updateSession` の 500 (必須の環境変数が無い) | 対象 | `internalError()` | あり | – | – |
| P-13 | matcher の外 (`_next/static` `_next/image` `_vercel/` `favicon.ico` `manifest.json` `robots.txt` `sw.js` `workbox-` `api/health` 画像拡張子) | 外 | – | なし | – | – |
| P-14 | 画像拡張子の存在しないパス (`/x.png`) の 404 HTML | 外 | – | なし (残存。§22 Q-4) | – | 無し (方針も無いので止まらない) |
| P-15 | `CSP_REPORT_ONLY=on` × P-1〜P-12 | 対象 | 同上 | `Content-Security-Policy-Report-Only` | request も同じ名前 (Next は `-report-only` からも読む) | あり |
| P-16 | `next dev` × P-1〜P-12 | 対象 | 同上 | あり + `'unsafe-eval'` | あり | あり |
| P-17 | クライアントが `x-csp-nonce` / `content-security-policy*` を送る × P-1 | 対象 | 同上 | middleware の値 | middleware の値 (捨てて付け直す) | middleware の nonce |

### 12.2 ②状態比較表 (現行 vs 設計後)

| 項目 | 現行 | 設計後 |
|---|---|---|
| CSP の置き場 | `next.config.mjs` `headers()` の `'/(.*)'` (静的な文字列) | `src/lib/security/csp.ts` (純関数) + `src/middleware.ts` (毎リクエスト)。`next.config.mjs` には無い |
| `script-src` | `'self' 'unsafe-inline' [dev: 'unsafe-eval'] *.vercel-scripts.com https://challenges.cloudflare.com` | `'self' 'nonce-<24 文字>' [dev: 'unsafe-eval'] 'report-sample' *.vercel-scripts.com https://challenges.cloudflare.com` |
| `style-src` | `'self' 'unsafe-inline'` | 同じ (据え置き) |
| `default-src` / `frame-src` / `img-src` / `connect-src` / `frame-ancestors` / `font-src` / `object-src` | 現行の値 | 同じ |
| 報告 | 無し | `report-uri /api/csp-report` → `app_logs` (warn / `csp-report`) |
| 報告だけ (report-only) | 無し | `CSP_REPORT_ONLY=on` でヘッダー名が変わる |
| CSP が付く応答 | `headers()` が当たる全応答 (matcher の外も) | middleware の全応答 (matcher の外には付かない: §22 Q-4) |
| アプリのインラインスクリプト | 1 本 (ルート layout の旧ダークモードの掃除) | 0 本 |
| nonce を画面へ渡す経路 | 無し | `x-csp-nonce` + `getCspNonce()` (呼ぶ画面は無し) |
| ページの描画 | 公開ページ・一部の運営ページは静的化しうる | 全ページ動的 (ルート layout の `force-dynamic`) |
| ブラウザのルーターのキャッシュ | 静的 300 秒 / 動的 30 秒 | 全ページ 30 秒 |
| 回数制限のカテゴリ | 15 | 16 (`csp-report`) |
| 同意の許可リスト (`/api`) | 13 行 | 14 行 (`/api/csp-report` telemetry) |
| 環境変数の一覧 | – | `CSP_REPORT_ONLY` (任意・`readOnlyBy: src/lib/security/csp.ts`) |
| `src/app/api` の route | N 本 | N + 1 本 |
| モバイルの Jest の突き合わせ先 | `next.config.mjs` の `"frame-src …"` | `src/lib/security/csp.ts` の同じ形の 1 行 |
| 既存テストの固定点 (`'unsafe-inline'` を期待) | `next-config-headers.test.ts:49`・`turnstile-config.test.ts:48` | 期待を反転 (無いこと) |
| Lighthouse (LP) | 静的 | 動的 (整合ゲートで実測) |

### 12.3 ③状態遷移表 (状態 × 操作 → 遷移先・ガード・副作用)

状態 = 本番の方針の出し方 (`enforce` / `report-only`) と、報告の受け口の状態。

| 状態 | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| `enforce` (既定) | リクエスト到着 (matcher 対象) | `enforce` | – | nonce 生成 → request header → updateSession → 応答に `Content-Security-Policy` |
| `enforce` | nonce の無い `<script>` が描画される (XSS・拡張) | `enforce` | – | ブラウザが止める + `POST /api/csp-report` |
| `enforce` | `CSP_REPORT_ONLY=on` にして再デプロイ | `report-only` | 値が `on` (大小・空白は無視) | ヘッダー名が `-Report-Only` に。違反は止まらない |
| `report-only` | nonce の無い `<script>` | `report-only` | – | 実行される + 報告 (`disposition: report`) |
| `report-only` | 直近 7 日に inline / eval / 自オリジンの報告 0 件 → 環境変数を外して再デプロイ | `enforce` | 条件 (§7.3) | ヘッダー名が戻る |
| 受け口 (待機) | 報告 POST・NULL 文字あり | 待機 | `rejectNullCharacterBody` | 400 `INVALID_CHARACTER`。ログ無し |
| 受け口 | 報告 POST・IP の回数が 30/分 or 300/日 超 | 待機 | `checkRateLimit` | 429 `RATE_LIMITED`。ログ無し |
| 受け口 | 報告 POST・Content-Type が違う | 待機 | `isCspReportContentType` | 415 `CSP_REPORT_UNSUPPORTED_MEDIA_TYPE` |
| 受け口 | 報告 POST・本文 > 8 KiB | 待機 | `cspReportByteLength` | 413 `CSP_REPORT_TOO_LARGE` |
| 受け口 | 報告 POST・JSON でない / 形が違う | 待機 | `JSON.parse` / `CspReportBodySchema` | 400 `CSP_REPORT_INVALID` |
| 受け口 | 報告 POST・有効 | 待機 | – | `app_logs` に warn 1 行 (URL はスクラブ) → 204 |
| 受け口 | Upstash の判定が例外 | 待機 | fail-closed | 500 `INTERNAL_ERROR` (構造化ログに原因) |
| 受け口 | 凍結中の利用者の報告 / メンテナンス中 | 待機 | 既存の分岐 | 403 / 503 (報告は捨てる。許容) |
| コード (CI) | `<script>` / `<Script>` / `next/script` / `<script` を含む文字列を足す | 赤 | `tests/csp-no-inline-script.test.ts` の許可リストに無い | 実装者に外部ファイル化か `getCspNonce()` + 許可リストを案内 |
| コード (CI) | `next.config.mjs` に CSP を書き戻す | 赤 | `next-config-headers.test.ts` | 二重化を防ぐ |
| コード (CI) | `frame-src` に他オリジンを足す | 赤 (モバイルの Jest) | `WEB_VIEW_EMBED_ORIGINS` に無い | モバイルにも足させる (既存の規律) |
| コード (CI) | ルート layout の `dynamic` を外す | 赤 | `tests/csp-no-inline-script.test.ts` | 静的化の再発を防ぐ |

## 13. エラー表

| HTTP | code | どこで | 本文 | 備考 |
|---|---|---|---|---|
| 400 | `INVALID_CHARACTER` (既存) | `rejectNullCharacterBody` | `{ error, code }` | 本文の NULL 文字 |
| 400 | `CSP_REPORT_INVALID` [NEW] | route | `{ error: '報告の形が不正です', code }` | JSON でない / `csp-report` のオブジェクトが無い |
| 413 | `CSP_REPORT_TOO_LARGE` [NEW] | route | 同上 | 本文 > `CSP_REPORT_MAX_BYTES` (8 KiB) |
| 415 | `CSP_REPORT_UNSUPPORTED_MEDIA_TYPE` [NEW] | route | 同上 | Content-Type が `application/csp-report` / `application/json` 以外 |
| 429 | `RATE_LIMITED` (既存) | `rateLimitExceededResponse` | `{ error, code, retryAfter }` | `csp-report` の超過 |
| 500 | `INTERNAL_ERROR` (既存) | `internalError` | 固定の文 | Upstash の判定の例外 (fail-closed) |
| 403 / 503 | `AUTH_ACCOUNT_FROZEN` / `MAINTENANCE_MODE` (既存) | middleware | 既存 | 凍結中・メンテナンス中の報告 (捨てる) |
| – | middleware の例外 | `request.headers.set` が失敗 | Next の 500 | 起きない前提 (§4.1)。起きたら全ページが 500 になり、黙って壊れるより先に気づく |

`[NEW]` の 3 つは `cross/04` §4.2 に足す (§19)。プレフィックス `CSP_` は `LEGAL_` と同じく機能の名前で、`cross/04` §4.1 の表には無い (足すときに §4.1 に 1 行足すかは §19 の行で判断)。

## 14. シーケンス

```mermaid
sequenceDiagram
  participant B as ブラウザ
  participant M as src/middleware.ts
  participant U as updateSession
  participant N as Next (描画)
  participant R as POST /api/csp-report
  participant L as app_logs
  B->>M: GET /home
  M->>M: nonce = generateCspNonce(); policy = buildContentSecurityPolicy({nonce,...})
  M->>M: request.headers: x-csp-nonce / Content-Security-Policy を捨てて付け直す
  M->>U: updateSession(request)
  U-->>M: next | redirect | 403 | 503 | 500
  M->>M: res.headers.set(Content-Security-Policy, policy)
  M-->>N: (next のとき) request header 経由で policy
  N->>N: script-src の 'nonce-…' を読み <script nonce> に付ける (全ページ動的)
  N-->>B: HTML + Content-Security-Policy
  B->>B: nonce の無い <script> は止める
  B->>R: POST /api/csp-report (application/csp-report)
  R->>R: NULL 文字 → 回数制限(IP) → Content-Type → 8 KiB → JSON → Zod
  R->>L: createLogger('csp-report').warn(message, metadata)  (待たない)
  R-->>B: 204
```

## 15. テスト一覧 (it 名)

単体 (vitest)。環境は `// @vitest-environment node` を付ける (Web Crypto・`TextEncoder` を Node の実装で使う)。

| ファイル | it |
|---|---|
| `src/__tests__/lib/security/csp.test.ts` (新) | `本番の方針: script-src は 'self'・'nonce-<nonce>'・'report-sample'・*.vercel-scripts.com・https://challenges.cloudflare.com を持ち、'unsafe-inline' と 'unsafe-eval' を持たない` / `dev の方針: script-src に 'unsafe-eval' が足され、'unsafe-inline' は無い` / `style-src は 'self' 'unsafe-inline' のまま (据え置き)` / `default-src・frame-src・frame-ancestors・font-src・object-src は next.config.mjs にあった値と同じ` / `frame-src の 1 行は "frame-src 'self' https://challenges.cloudflare.com" と文字どおりに書いてある (apps/mobile の Jest が読む)` / `report-uri は /api/csp-report` / `本番の Supabase (*.supabase.co) では connect-src / img-src に個別の origin を足さない` / `ローカルの Supabase (http://127.0.0.1:54321) は connect-src (http / ws) と img-src に足す` / `nonce が base64 でなければ throw` / `generateCspNonce: 24 文字の base64 で、100 回で重複しない` / `cspDirectivesOf: 方針を名前 → 許可先にする (空の区切りは飛ばす)` / `isCspReportOnly: 'on' (大小・前後の空白は無視) だけ true。off / 空 / true / 1 / undefined は false` / `cspHeaderName: 強制と報告だけでヘッダー名が変わる` / `CSP_TURNSTILE_ORIGIN は src/lib/auth/turnstile.ts の TURNSTILE_SCRIPT_SRC のオリジンと同じで、script-src と frame-src の両方にある` |
| `src/__tests__/lib/security/csp-report.test.ts` (新) | `CspReportBodySchema: ブラウザが送る形 (Chrome / Firefox / Safari の例) を通し、知らないキーは捨てる` / `csp-report が無い・オブジェクトでない本文は失敗` / `line-number が負・文字列なら落として通す (報告を 400 にしない)` / `isCspReportContentType: application/csp-report と application/json (charset つき・大文字) は true、text/plain と null は false` / `scrubCspReportUri: http(s) はクエリ・#・ユーザー名・パスワードを落として origin + パス` / `scrubCspReportUri: /invite/<token>・/family/promotions/<token>・UUID の区間は [redacted]、representative-transfer のような名前は残る` / `scrubCspReportUri: data: / blob: / chrome-extension: はスキームだけ、inline / eval / self はそのまま、空は null` / `toCspViolationLogEntry: message は "CSP violation: <effective> blocked <blocked>"、metadata は snake_case の 11 キーで original-policy と referrer を含まない` / `toCspViolationLogEntry: script_sample は 40 文字、user_agent は 256 文字に切る` / `cspReportByteLength: UTF-8 のバイト数 (日本語は 3 バイト)` |
| `src/__tests__/lib/security/csp-nonce.test.ts` (新) | `getCspNonce: headers() の x-csp-nonce を返す (next/headers のモックは Promise を返す形)` / `無ければ null` |
| `tests/middleware-csp.test.ts` (新。`@/lib/supabase/middleware` の updateSession をモック) | `応答に Content-Security-Policy が付き、script-src の nonce が request header の x-csp-nonce と同じ` / `request header の content-security-policy にも同じ方針が載る (Next が読む経路)` / `updateSession が redirect / 403 JSON / 503 HTML / 500 を返しても CSP が付く` / `updateSession が NextResponse.next({ request }) を作り直しても (x-legal-consent-pending を足す経路) request header の nonce は変わらない` / `2 回の要求で nonce が違う` / `クライアントが送った x-csp-nonce・content-security-policy・content-security-policy-report-only は捨てられ、middleware の値だけが残る` / `CSP_REPORT_ONLY=on なら応答と request header の名前が Content-Security-Policy-Report-Only になり、Content-Security-Policy は付かない` / `NODE_ENV=development なら 'unsafe-eval' が付く` / `?mode=app の is_native_app Cookie は今までどおり付く` |
| `src/__tests__/api/csp-report-route.test.ts` (新。`@/lib/db-logger` の createLogger をモック) | `application/csp-report の有効な報告は 204 で、createLogger('csp-report').warn が message と metadata (スクラブ済み) で 1 回呼ばれる` / `application/json でも 204` / `Content-Type が text/plain なら 415 CSP_REPORT_UNSUPPORTED_MEDIA_TYPE で warn は呼ばれない` / `8 KiB を超える本文は 413 CSP_REPORT_TOO_LARGE` / `JSON でない本文・csp-report の無い本文は 400 CSP_REPORT_INVALID` / `NULL 文字を含む本文は 400 INVALID_CHARACTER (回数制限より前)` / `同じ IP から 31 回目は 429 RATE_LIMITED (in-memory)。x-forwarded-for の先頭を key にする` / `checkRateLimit が例外を投げたら 500 INTERNAL_ERROR (fail-closed)` / `セッションを読まない (createClient を呼ばない)` |
| `src/__tests__/lib/rate-limit-csp-report.test.ts` (新) | `csp-report は 30 回/分と 300 回/日の 2 つの規則` |
| `tests/csp-no-inline-script.test.ts` (新。走査) | `src / lib / components (テストを除く) に <script> / <Script> の JSX 要素が無い (許可リストは空)` / `next/script を import していない` / `文字列・テンプレートに "<script" を含むものが無い (HTML の文字列に script を埋めない)` / `許可リストの各項目は理由と nonce 属性を持つ (いまは空)` / `走査が機能している: 偽の <script> を含む文字列を解析すると見つける` / `src/app/layout.tsx は dynamic = 'force-dynamic' を export する (全ページ動的)` |
| `src/__tests__/config/next-config-headers.test.ts` (改) | 消す: `script-src 'self' 'unsafe-inline'` と `style-src 'self' 'unsafe-inline'` の `toContain`、CSP の connect-src / img-src の 4 つの it (csp.test.ts へ移す)。足す: `headers() に Content-Security-Policy が無い (CSP は middleware が付ける。二重に付けない)` / `X-Frame-Options・X-Content-Type-Options・X-XSS-Protection・HSTS は残る`。残す: PostHog の 2 つ・F6-08 |
| `src/__tests__/config/turnstile-config.test.ts` (改) | `loadCspDirectives` を `cspDirectivesOf(buildContentSecurityPolicy({ nonce: 'dGVzdA==', isDev: false, supabaseUrl }))` に替える。it 名の「self / unsafe-inline / vercel-scripts」を「self / nonce / vercel-scripts」に。`'unsafe-inline'` の `toContain` を `not.toContain` に |
| `tests/speed-insights-1179.test.tsx` (改) | CSP の節: `next.config.mjs` を読む代わりに `buildContentSecurityPolicy` を使う。it `script-src と connect-src に 'self' がある` は同じ |
| `tests/inner-html-contract.test.ts` (改) | `ALLOWED_HTML_SINKS` から `src/app/layout.tsx` を消す (許可リストの古さの it が赤になるため)。ファイル頭の説明の行も消す |
| `lib/supabase/__tests__/middleware-legal-consent-api.test.ts` (改) | スナップショットに `{ path: '/api/csp-report', match: 'exact', reason: 'telemetry' }` を `/api/log` の次に足す |
| `src/__tests__/api/null-character-routes.test.ts` (改) | 表に `{ file: 'csp-report/route.ts', method: 'POST', load: async () => (await import('@/app/api/csp-report/route')).POST }` を足す |
| `src/__tests__/lib/env.test.ts` (改) | `readOnlyBy` の一覧に `['CSP_REPORT_ONLY', 'src/lib/security/csp.ts']` (`CRON_SECRET_PREVIOUS` の次) と it 名の列挙に `CSP_REPORT_ONLY` |
| `apps/mobile/__tests__/lib/webViewBridge.test.ts` (改。Jest) | `NEXT_CONFIG_PATH` を `WEB_CSP_SOURCE_PATH = path.resolve(__dirname, '../../../../src/lib/security/csp.ts')` に。describe 名とエラー文の `next.config.mjs` を `src/lib/security/csp.ts` に。正規表現 `/"frame-src\s+([^"]+)"/` は同じ |
| `tests/e2e/csp-nonce.spec.ts` (新。Playwright) | `/ の応答の Content-Security-Policy は 1 つだけ (headersArray) で、script-src は 'nonce-…' を持ち 'unsafe-inline' を持たない` / `2 回の要求で nonce が違う` / `/ と /login を開くと securitypolicyviolation が 0 件で、src の無い <script> はすべて nonce を持つ (script.nonce)` / `/login でメールアドレスを入力すると値が残る (ハイドレーションが動く)` / `script-src と frame-src に https://challenges.cloudflare.com がある` / `POST /api/csp-report: application/csp-report は 204、text/plain は 415、JSON でない本文は 400、9 KiB の本文は 413` |

整合ゲート (デプロイ後) で人が確かめる項目: `next build` の表に `○` が無い (`/_not-found` も `ƒ`)・本番の全画面 (利用者・運営) を開いて開発者ツールの CSP 違反 0 件・`/super-admin/logs` に `csp-report` の行が 0 件 (自分のコード由来)・LP の Lighthouse・iOS / Android の WebView で `/login` と `/home`・存在しないパスと `error.tsx` の表示に CSP が付くか (§22 Q-4 / Q-8 の実測)。

## 16. 段分け (実装 WF は 1 本・同じ worktree。段ごとに 2 枚レビューを閉じる)

| 段 | 中身 | 触るファイル |
|---|---|---|
| 1. 受け口 | `csp-report.ts`・route・回数制限のカテゴリ・同意の許可リストの行・テスト 3 本・番兵 2 本の追随。方針はまだ変えない (報告は届かない) | `src/lib/security/csp-report.ts`、`src/app/api/csp-report/route.ts`、`src/lib/rate-limit.ts`、`packages/shared/src/legal-consent-api.ts`、`src/__tests__/lib/security/csp-report.test.ts`、`src/__tests__/api/csp-report-route.test.ts`、`src/__tests__/lib/rate-limit-csp-report.test.ts`、`lib/supabase/__tests__/middleware-legal-consent-api.test.ts`、`src/__tests__/api/null-character-routes.test.ts` |
| 2. 方針 | `csp.ts`・`csp-nonce.ts`・middleware・ルート layout・`next.config.mjs`・環境変数・走査・e2e・番兵の追随・コメントの参照先 | `src/lib/security/csp.ts`、`src/lib/security/csp-nonce.ts`、`src/middleware.ts`、`src/app/layout.tsx`、`next.config.mjs`、`src/lib/env.ts`、`.env.example`、`ENV_SETUP.md`、`src/__tests__/lib/security/csp.test.ts`、`src/__tests__/lib/security/csp-nonce.test.ts`、`tests/middleware-csp.test.ts`、`tests/csp-no-inline-script.test.ts`、`tests/e2e/csp-nonce.spec.ts`、`src/__tests__/config/next-config-headers.test.ts`、`src/__tests__/config/turnstile-config.test.ts`、`tests/speed-insights-1179.test.tsx`、`tests/inner-html-contract.test.ts`、`src/__tests__/lib/env.test.ts`、`apps/mobile/__tests__/lib/webViewBridge.test.ts`、コメントだけ: `src/lib/auth/turnstile.ts`・`apps/mobile/src/lib/webViewBridge.ts`・`apps/mobile/src/components/web/WebViewScreen.tsx`・`tests/e2e/README.md`・`tests/e2e/adversarial-deep.spec.ts` (F-1 の古い説明) |

段 1 を先にするのは、方針が `report-uri /api/csp-report` を指した時点で受け口が実在するようにするため (404 への報告を出さない)。

## 17. 新設一覧

| 種類 | 名前 |
|---|---|
| ファイル | `src/lib/security/csp.ts`、`src/lib/security/csp-nonce.ts`、`src/lib/security/csp-report.ts`、`src/app/api/csp-report/route.ts`、`src/__tests__/lib/security/csp.test.ts`、`src/__tests__/lib/security/csp-report.test.ts`、`src/__tests__/lib/security/csp-nonce.test.ts`、`src/__tests__/api/csp-report-route.test.ts`、`src/__tests__/lib/rate-limit-csp-report.test.ts`、`tests/middleware-csp.test.ts`、`tests/csp-no-inline-script.test.ts`、`tests/e2e/csp-nonce.spec.ts` |
| 関数 | `buildContentSecurityPolicy`、`generateCspNonce`、`cspDirectivesOf`、`isCspReportOnly`、`cspHeaderName`、`supabaseLocalOrigins`、`getCspNonce`、`isCspReportContentType`、`cspReportByteLength`、`scrubCspReportUri`、`maskTokenLikeSegments`、`toCspViolationLogEntry`、(middleware 内) `attachCspToRequest`、`supabaseUrlOrUndefined`、(route 内) `clientIpOf`、`badRequest` |
| 定数 | `CSP_HEADER`、`CSP_REPORT_ONLY_HEADER`、`CSP_NONCE_HEADER`、`CSP_REPORT_PATH`、`CSP_NONCE_BYTES`、`CSP_NONCE_PATTERN`、`CSP_TURNSTILE_ORIGIN`、`CSP_REPORT_CONTENT_TYPES`、`CSP_REPORT_MAX_BYTES`、`CSP_REPORT_URI_MAX_CHARS`、`CSP_REPORT_DIRECTIVE_MAX_CHARS`、`CSP_REPORT_SCRIPT_SAMPLE_MAX_CHARS`、`CSP_REPORT_USER_AGENT_MAX_CHARS`、`CSP_REPORT_TOKEN_SEGMENT_MIN_CHARS`、`CSP_REPORT_REDACTED_SEGMENT`、`CSP_REPORT_LOG_FUNCTION_NAME`、`CSP_REPORT_ERROR_CODES` |
| 型 / Zod | `CspBuildInput`、`SupabaseLocalOrigins`、`CspReportSchema`、`CspReportBodySchema`、`CspReport`、`CspReportBody`、`CspViolationLogMetadata`、`CspViolationLogEntry`、`CspViolationLogContext` |
| route | `POST /api/csp-report` |
| ヘッダー | 応答 `Content-Security-Policy` (middleware 発) / `Content-Security-Policy-Report-Only`、request `x-csp-nonce` |
| 回数制限のカテゴリ | `csp-report` (`csp-report` 30/分・`csp-report-daily` 300/日) |
| 同意の許可リストの行 | `/api/csp-report` (exact・telemetry) |
| 環境変数 | `CSP_REPORT_ONLY` (任意・サーバー・`readOnlyBy: src/lib/security/csp.ts`) |
| エラーコード | `CSP_REPORT_INVALID` (400)、`CSP_REPORT_TOO_LARGE` (413)、`CSP_REPORT_UNSUPPORTED_MEDIA_TYPE` (415) |
| app_logs の語 | `function_name = csp-report`、`level = warn` |
| 消すもの | `src/app/layout.tsx` の `<head>` と `<script dangerouslySetInnerHTML>`、`next.config.mjs` の `Content-Security-Policy`・`isDev`・`supabaseLocalOrigins`・`supabaseImgSrc`・`supabaseConnectSrc` |
| テーブル・列・RLS・Storage | 無し |

## 18. 既存の番兵 (契約テスト・走査テスト) の追随表

grep の語 = 本設計が足す・変える・移すものの名前で `tests/` `scripts/` `src/__tests__/` `lib/**/__tests__/` `apps/mobile/__tests__/` `packages/*/src/*.test.ts` を引いた結果。

| 番兵 | grep の語 (反応するもの) | いま | 直し方 | 段 |
|---|---|---|---|---|
| `src/__tests__/config/next-config-headers.test.ts` | `"script-src 'self' 'unsafe-inline'"`・`"style-src 'self' 'unsafe-inline'"`・`Content-Security-Policy` | `headers()` の CSP に `'unsafe-inline'` を期待 (F6-09)・CSP の connect-src / img-src を検査 | §15 のとおり (期待を「CSP が無い」に反転。CSP の中身の it は `csp.test.ts` へ) | 2 |
| `src/__tests__/config/turnstile-config.test.ts` | `loadCspDirectives`・`'unsafe-inline'`・`next.config.mjs` | `headers()` から CSP を読む | `buildContentSecurityPolicy` + `cspDirectivesOf` に替える。`'unsafe-inline'` は `not.toContain` | 2 |
| `tests/speed-insights-1179.test.tsx` | `next.config.mjs`・`sourcesOf`・`Content-Security-Policy` | `headers()` から CSP を読む | `buildContentSecurityPolicy` に替える | 2 |
| `tests/inner-html-contract.test.ts` | `'src/app/layout.tsx'`・`ダークモード` | 許可リストにルート layout | 行を消す (消さないと「許可リストが古い」の it が赤) | 2 |
| `tests/csp-no-inline-script.test.ts` (新) | `<script`・`next/script`・`force-dynamic` | – | 新設 (§21) | 2 |
| `apps/mobile/__tests__/lib/webViewBridge.test.ts` | `NEXT_CONFIG_PATH`・`"frame-src`・`next.config.mjs に frame-src の指定が見つからない` | `next.config.mjs` を読む | 参照先を `src/lib/security/csp.ts` に。正規表現は同じ (csp.ts の frame-src の行を文字どおりの 1 行に保つ) | 2 |
| `lib/supabase/__tests__/middleware-legal-consent-api.test.ts` | `'/api/log', match: 'exact', reason: 'telemetry'`・`src/app/api の全 route` | 許可リストのスナップショット・全 route の表 | スナップショットに `/api/csp-report` の行。全 route の表は自動 (route を足すと未同意 × ENFORCE=on で通ることを許可リストが説明する) | 1 |
| `packages/shared/src/legal-consent-api.test.ts` | `EXEMPT_SAMPLES`・`/api/logx` | 似た名前は deny | 任意: `EXEMPT_SAMPLES` に `/api/csp-report`、`NOT_EXEMPT_SAMPLES` に `/api/csp-reportx` | 1 |
| `src/__tests__/api/null-character-routes.test.ts` | `'log/route.ts'`・`rejectNullCharacterBody` | 本文を読む handler の表 | 表に `csp-report/route.ts` の行 (無いと「洗い漏れ」の it が赤) | 1 |
| `src/__tests__/lib/env.test.ts` | `'LEGAL_CONSENT_NOTICE', 'lib/legal-consent.ts'`・`readOnlyBy` | `readOnlyBy` の一覧のスナップショット | `['CSP_REPORT_ONLY', 'src/lib/security/csp.ts']` を足す (sort 順は `CRON_SECRET_PREVIOUS` の次)。it 名の列挙にも足す | 2 |
| `tests/env-source-scan.test.ts` | `process.env.CSP_REPORT_ONLY`・`.env.example` | 一覧の全変数が `.env.example` にある・名前で読むのは `readOnlyBy` のファイルだけ | `.env.example` に `CSP_REPORT_ONLY` を書く。csp.ts 以外で読まない。csp.ts の文字列に変数名を書かない | 2 |
| `tests/rate-limit-single-implementation.test.ts` | `@upstash/ratelimit` | 共通ヘルパーだけが import | route は `checkRateLimit` を使う (変更なし) | 1 |
| `tests/api-raw-error-message-scan.test.ts` | `NextResponse.json`・`error.message` | 生のエラー文を本文に入れない | route の 4xx は固定の文、500 は `internalError` (変更なし) | 1 |
| `tests/next15-async-request-api-scan.test.ts` | `headers()`・`params` | `headers()` は await の直下 | `getCspNonce` は `(await headers()).get(...)`。route は `params` 無し (変更なし) | 2 |
| `tests/supabase-service-role-client-scan.test.ts` | `@supabase/supabase-js` | `createClient` は一覧のファイルだけ | route は `createLogger` だけ (変更なし) | 1 |
| `tests/jst-today-source-scan.test.ts` | `toISOString`・`_at` | 日付の書き方 | 新設コードに日付の処理は無い (変更なし) | – |
| `tests/health-middleware-exemption.test.ts`・`tests/speed-insights-middleware-1179.test.ts`・`src/__tests__/lib/maintenance-mode.test.ts` | `from '@/middleware'`・`config.matcher` | matcher の固定 | matcher は変えない (変更なし)。`@/middleware` の import が `@/lib/security/csp` を連れてくるが副作用は無い | 2 |
| `tests/design-system-1058.test.ts` | `src/app/layout.tsx`・`<html lang="ja"`・`skip-link` | ルート layout の a11y の固定 | `<html lang="ja">`・スキップリンク・`#main-content` は残す (変更なし) | 2 |
| `tests/posthog-not-adopted-contract.test.ts` | `next.config.mjs`・`posthog` | PostHog の語が無い | 変更なし (CSP を消しても PostHog は出ない) | 2 |
| `src/__tests__/lib/maintenance-mode.test.ts:263` | `not.toContain('<script')` | メンテナンス HTML に script 無し | 変更なし (本設計の前提) | – |
| `tests/e2e/adversarial-deep.spec.ts` F-1 / F-2・`tests/e2e/bug-140-145-security-auth.spec.ts` | `content-security-policy`・`frame-ancestors` | `/` の応答に CSP | 変更なし (middleware が付ける)。F-1 の「現状: next.config.mjs に CSP が設定されていない」の説明は古いので直す (コメントだけ) | 2 |
| `tests/e2e/auth-turnstile.spec.ts` | `securitypolicyviolation`・`next.config.mjs` | Turnstile が CSP で止まらない | 変更なし (本設計の受入の一部)。コメントの `next.config.mjs` を `src/lib/security/csp.ts` に | 2 |
| `tests/ai-consent-enforcement.test.ts` | `src/middleware.ts` | middleware が AI へ送るコードに届かない | 変更なし (csp.ts は AI に触れない) | 2 |
| `src/__tests__/api/log.test.ts`・`tests/api-security-cluster.test.ts` | `/api/log`・`'client-log'` | 既存の受け口 | 変更なし | – |
| `tests/test-speed-ratchet.test.ts` (記録のみ) | – | 1 ファイル 5 秒の予算 | 新しいテストは route の import を最小にし、走査は `QUICK_FILTER` (語を含むファイルだけ構文木にする) で速くする | 1, 2 |

## 19. 他の文書への追随表 (本設計では編集しない。マージと同日の docs PR で足す)

| 文書 | 直すこと | 期日 |
|---|---|---|
| `docs/design/cross/CLAUDE.md` ファイル一覧 | `16-csp-nonce.md` の行 (担当範囲: 本番の CSP の nonce 方式・違反の報告の受け口。要件参照: #1169) を足し、「10〜12 は欠番」の文を実在 (12・15 あり) に合わせる | マージと同日 |
| `docs/design/cross/13a-legal-consent-api-server.md` §6.4 | `/api/csp-report` (exact・`telemetry`・理由は §9.10 の note) の行を `/api/log` の次に足し、対象の route の本数を +1 | 段 1 のマージと同日 |
| `docs/design/cross/04-api-conventions.md` §4.2 | `CSP_REPORT_INVALID` (400)・`CSP_REPORT_TOO_LARGE` (413)・`CSP_REPORT_UNSUPPORTED_MEDIA_TYPE` (415) を `[NEW]` で足す (LEGAL 系と同じ節の作り) | 段 1 のマージと同日 |
| `docs/design/mobile/01-architecture.md` §7 | 「Web の CSP (`next.config.mjs` の `frame-src`)」「Jest が `next.config.mjs` と突き合わせる」を `src/lib/security/csp.ts` に | 段 2 のマージと同日 |
| `docs/design/operator/07-audit-monitoring.md` §7.3 | 「CSP (`next.config.mjs`) の `script-src` / `connect-src`」を `src/lib/security/csp.ts` に | 段 2 のマージと同日 |
| `docs/design/operator/10-logs-and-mail-retry.md` §9 (app_logs のビューア) | 絞り込みの例に `function_name = csp-report` (CSP の違反) を 1 行 | 任意 |
| `docs/design/00-architecture.md` のファイル木 | `middleware.ts # セッション同期 (既存)` に「+ CSP の nonce (#1169)」 | 任意 |
| `tests/e2e/README.md`・`ENV_SETUP.md`・`.env.example` | 実装の PR で直す (設計正典ではない。§9.6・§18) | 段 2 |

## 20. 既存実装との関連

| 区分 | 対象 |
|---|---|
| 保持 (変えない) | `lib/supabase/middleware.ts` (`updateSession`) の全分岐、matcher、`lib/legal-consent.ts`、`src/lib/maintenance-mode.ts`、`src/lib/auth/turnstile.ts` (コメントの参照先だけ)、`src/components/SpeedInsightsClient.tsx`、`src/lib/markdown-lite.ts`、`src/components/AIChatBubble.tsx`、styled-jsx の 2 箇所、`apps/mobile` のコード (コメントの参照先だけ)、`src/app/api/log/route.ts` |
| 変更 | `src/middleware.ts` (CSP の付与)、`src/app/layout.tsx` (インラインスクリプトの削除・`force-dynamic`)、`next.config.mjs` (CSP の撤去)、`src/lib/rate-limit.ts` (カテゴリ)、`src/lib/env.ts` (一覧)、`packages/shared/src/legal-consent-api.ts` (行)、`.env.example`、`ENV_SETUP.md` |
| 新規 | §17 |
| 削除 | ルート layout のインラインスクリプト、`next.config.mjs` の CSP と `supabaseLocalOrigins` (csp.ts へ移す) |

## 21. 機械検査 (R-10)

| 検査 | どこで | 赤になる条件 |
|---|---|---|
| 本番の方針の `script-src` に `'unsafe-inline'` と `'unsafe-eval'` が無い | `src/__tests__/lib/security/csp.test.ts` | `buildContentSecurityPolicy({ isDev: false })` の `script-src` にどちらかがある |
| `next.config.mjs` の `headers()` に CSP が無い (二重化の防止) | `src/__tests__/config/next-config-headers.test.ts` | `'/(.*)'` の `headers` に `Content-Security-Policy` がある |
| 本番の応答に CSP ヘッダーが 1 つだけで nonce を持つ | `tests/e2e/csp-nonce.spec.ts` (`headersArray`) | 2 つ以上・nonce 無し・`'unsafe-inline'` あり |
| インラインスクリプトを足したら赤 | `tests/csp-no-inline-script.test.ts` | `src` / `lib` / `components` (テストを除く) の構文木に (a) JSX の `<script>` / `<Script>` 要素、(b) `next/script` の import / export / 動的 import / require、(c) `<script` (大小を区別しない) を含む文字列・テンプレートのどれかがあり、`ALLOWED_INLINE_SCRIPTS` (理由 + `nonce` 属性の必須) に無い。構文木で見るのでコメントには反応しない。限界: `createElement('script')` + `textContent` でインラインを作る書き方は捕まらない (HTML の差し込みは `tests/inner-html-contract.test.ts` が見る)。走査は `QUICK_FILTER = /<script|next\/script/i` を含むファイルだけ構文木にする |
| 全ページ動的 | 同上 | `import('@/app/layout')` の `dynamic` が `'force-dynamic'` でない |
| middleware の全経路に CSP | `tests/middleware-csp.test.ts` | updateSession のどの戻り値でも応答に CSP が無い・request header の nonce と不一致 |
| `frame-src` と `WEB_VIEW_EMBED_ORIGINS` の一致 | `apps/mobile/__tests__/lib/webViewBridge.test.ts` (既存) | `csp.ts` の `frame-src` の行に他オリジンを足してモバイルに足さない |
| 環境変数の規律 | `tests/env-source-scan.test.ts`・`src/__tests__/lib/env.test.ts` (既存) | `.env.example` に無い・csp.ts 以外で読む |
| 本文を読む route の入口 | `src/__tests__/api/null-character-routes.test.ts` (既存) | 表に無い・`rejectNullCharacterBody` を呼ばない |

## 22. 未解決事項 (設計は上の既定で進める)

| # | 事項 | 既定 |
|---|---|---|
| Q-1 | `base-uri 'self'`・`form-action 'self'`・`upgrade-insecure-requests` は Next 公式の例にあり、nonce 方式と相性がよい (`<base>` の差し込みで相対パスのスクリプトの参照先を変えられる穴を塞ぐ) が、#1169 の範囲 (`script-src`) の外 | 足さない。別 Issue の候補として報告する |
| Q-2 | `style-src` の nonce 化 (styled-jsx の `StyleRegistry` + `nonce`・`style` 属性 2,272 箇所の棚卸し・メンテナンス HTML と `LEGACY_CLOSED_HTML` の `<style>` への nonce) | 据え置き (§6.3)。別 Issue の候補 |
| Q-3 | `report-to` + `Reporting-Endpoints` (Chromium の新しい報告の経路)。`report-uri` は非推奨だが全ブラウザが送る | `report-uri` だけ。Chromium が `report-uri` を落とした時点で足す |
| Q-4 | matcher の外のパス (画像拡張子の存在しないパスなど) の 404 HTML に CSP が付かない。`headers()` に CSP を戻すと二重化するので、matcher の除外を狭めるか `headers()` に matcher の除外だけを当てる `source` を書くかの 2 択 | 残存として受け入れる (404 の画面は固定の内容で、XSS の差し込み口が無い)。整合ゲートで実測し、付けたければ matcher 外のパスだけの `headers()` を別 Issue で |
| Q-5 | `'strict-dynamic'` の採用 (ホストの許可を捨て、nonce つきスクリプトが作るスクリプトを信頼する)。Turnstile・Speed Insights は `createElement('script')` なので動く | 採らない (§3.2 C)。ホストの許可を減らしたくなったら別 Issue |
| Q-6 | CSP の報告を運用メール (エラー急増 #1157) に数えるか | 数えない (warn)。ローンチ後に件数を見て決める |
| Q-7 | 全ページ動的化で LP の Lighthouse が 90 を下回ったとき | 整合ゲートで実測してから: LP だけ静的に戻す案は nonce と両立しないので、描画の軽量化 (フォントの preload・画像) で対処する |
| Q-8 | 画面の描画中の例外 (`error.tsx` / `global-error.tsx`) の応答に middleware の CSP ヘッダーが写るか | 写る想定 (middleware の応答ヘッダーは最終の応答に写される)。整合ゲートで実測。写らなければ `global-error.tsx` の `style` 属性は影響なし (style は据え置き) で、スクリプトは Next の bootstrap だけなので nonce が要る → 実測の結果で別途 |
| Q-9 | Vercel の preview の Vercel toolbar (`https://vercel.live`) の報告が `app_logs` に混ざる | 混ざる (`document_uri` のホストで見分ける)。preview の報告を捨てる判定 (`VERCEL_ENV`) は環境変数の一覧の規律に新しい行が要るので、必要になったら足す |

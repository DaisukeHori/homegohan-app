# maestro/flows/meals — スキャンのタブ (食事の記録)

スキャンのタブ (`tab-meals`) は WebView です (`apps/mobile/app/(tabs)/meals.tsx` の `WebViewScreen path="/meals/new" testID="webview-meals"`)。
タブの中身は Web の食事の記録の画面 (`src/app/(main)/meals/new/page.tsx`) で、モードの選択・撮影・解析・保存・入力の検証はすべて WebView の中の Web の画面です。

maestro はネイティブの部分 (タブ・WebView の表示・バックグラウンドからの復帰) だけを確かめます。
WebView の中の Web の画面を操作する検査は、Web の e2e (Playwright。`tests/e2e/`) の役目です (#1552)。

以前あったネイティブの食事の新規作成の画面 (`apps/mobile/app/meals/new.tsx`) は、タブから行けない画面だったので消しました (#1598)。
食事の記録は WebView の中の Web の画面に一本化したので、この画面のための flow は足しません。
食事の詳細 (`apps/mobile/app/meals/[id].tsx`) は、通知のタップ先 (`apps/mobile/src/lib/notificationRoute.ts` の `/meals/:id`) として残っています。

## いまの flow

| flow | 確かめること |
|---|---|
| `01-scan-tab-opens-webview.yaml` | スキャンのタブを開くと `webview-meals` が出て、読み込みが終わる。ホームのタブへ移って戻っても、スキャンのタブの WebView に戻れる |
| `02-scan-tab-bg-fg.yaml` | スキャンのタブを開いたままバックグラウンド → フォアグラウンドに戻しても、スキャンのタブの WebView のまま |

## 外した flow (#1552)

以前の flow は、ソースに無い testID (`meals-screen`・`meals-add-button`・`meal-list`・`home-meal-fab`・`meal-name-error` など) を期待していました。
食事のタブがネイティブの画面だったころの想定で、いまのアプリでは動きません。flow ごとの判断は次のとおりです。

| 以前の flow | 判断 | 理由 / 代わりの検査 |
|---|---|---|
| 01 mode-meal-capture-analyze-save | 外す | 撮影 → 解析 → 保存は WebView の中の Web の画面。Web の e2e: `tests/e2e/02-meal-photo.spec.ts` |
| 02 auto-mode-classification | 外す | 自動の判別は Web の画面。Web の e2e: `tests/e2e/image-classification-validation.spec.ts`・`tests/e2e/bug-64-65-image-classify.spec.ts` |
| 03 fridge-pantry-register | 外す | 冷蔵庫の写真の登録は Web の画面 |
| 04 health-checkup-ocr | 外す | 健康診断の読み取りは Web の画面。参考: 健診の登録の画面 (`/health/checkups/new`) の読み取りは `tests/e2e/bug-98-103-checkup-ocr-upload.spec.ts` (スキャンのタブのモードからの読み取りは対象外) |
| 05 weight-scale-save | 外す | 体重計の写真の保存は Web の画面 |
| 06 gallery-existing-photo | 外す | 写真の選択は Web の画面 (WebView の中のファイルの選択) |
| 07 manual-input | 外す | 手入力の食事の保存は Web の画面 |
| 08 favorites-search-unheart | 外す | お気に入りは食事のタブの中に無い (`meals-favorites-tab` は無い)。アプリのお気に入りは WebView の中の Web の画面。Web の e2e: `tests/e2e/bug-104-favorites-system.spec.ts` |
| 09〜12 validation (料理名が空・カロリーが文字・負の値・未来の日付) | 外す | 入力の検証は Web の画面 |
| 13 validation-gallery-permission-denied | 外す | 写真の選択は Web の画面 (WebView の中のファイルの選択) |
| 14〜16 api-error (解析の 500・画像のアップロードの失敗・保存の失敗) | 外す | 失敗の見せ方は Web の画面 |
| 17 api-error-favorites-delete-fail | 外す | お気に入りは食事のタブの中に無い (08 と同じ) |
| 18〜22 adversarial (料理名の XSS・500 字・カロリー 99999・同じ写真の連続・4K 画像) | 外す | 入力と画像の扱いは Web の画面 |
| 23 adversarial-favorites-search-sqli | 外す | お気に入りは食事のタブの中に無い (08 と同じ) |
| 24 state-capture-bg-fg | 直す → `02-scan-tab-bg-fg.yaml` | バックグラウンドからの復帰でタブの WebView が残るかは、ネイティブの部分として確かめる。撮影中の Web の画面の状態は Web の画面の検査 |
| 25 state-analyzing-bg-fg | 直す → `02-scan-tab-bg-fg.yaml` | 24 と同じ |
| 26 state-save-modal-close | 外す | 保存のあとの表示は Web の画面 |
| 27 state-week-crossing-date | 外す | 日付の選択は Web の画面 |
| 28 photo-meal-analysis | 外す | 写真の解析の結果は Web の画面。Web の e2e: `tests/e2e/02-meal-photo.spec.ts` |

01 の「スキャンのタブを開く」部分は `01-scan-tab-opens-webview.yaml` に残しました。

## testID の検査

maestro の flow が期待する testID がソースに実在することは、`tests/maestro-flow-testids.test.ts` (vitest) が確かめます。
新しく flow を書いたら、期待する testID が `apps/mobile` か `src` のソースにあることを確かめてください。

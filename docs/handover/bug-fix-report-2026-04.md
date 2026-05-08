# 2026-04 バグ修正パス レポート

> 対象期間: 2026-04-29 22:00 JST 〜 2026-04-30 02:00 JST  
> リポジトリ: DaisukeHori/homegohan-app  
> ブランチ: main (直 push 体制)

---

## 1. 概要

2026-04 の集中修正パスでは、事前に起票された **38 件のバグ Issue をすべて close** した。
作業は main ブランチへの直接 push 体制で進行し、レビュープロセスは省略してスピードを優先。

主な成果は 3 点。

- **38 件全 close** — High/Medium/Low にわたる機能バグ・UI バグ・アクセシビリティ不備を網羅的に解消
- **main 直 push 体制** — PR を挟まず 23 コミットを main に直接積み、修正サイクルを高速化
- **Playwright E2E 基盤の導入 (Phase 0)** — `@playwright/test 1.59.1` + `playwright.config.ts` + `.github/workflows/e2e.yml` を整備し、各バグ修正と対応する `bug-XX-*.spec.ts` (29 ファイル) を追加。CI での回帰防止資産として機能する

---

## 2. 修正済 Issue 一覧

| Issue # | バグ番号 | タイトル (要約) | 修正コミット | spec ファイル |
|---------|---------|----------------|------------|-------------|
| #15 | Bug-01 | 6日連続生成が Edge Function タイムアウトでサイレント失敗 | `4a600f3` | *(vitest: tests/v5-retry-strategy.test.ts)* |
| #16 | Bug-02 | 「既存の献立も作り直す」チェックボックスが ON のまま再表示 | `3877bb3`, `7bda02d` | `bug-02-existing-meals-checkbox-default.spec.ts` |
| #19 | Bug-03 | 進捗バー消失後もバックエンドで生成継続 (UI/サーバ状態乖離) | `4c2ca3b` | `bug-03-progress-bar-server-sync.spec.ts` |
| #20 | Bug-04 | 生成完了直後に献立が一時的に「0 kcal、空欄」表示 | `4c2ca3b` | `bug-04-cache-refetch-after-generation.spec.ts` |
| #21 | Bug-05 | 「1日献立変更」モーダルの日付デフォルトが今日固定 | `f0cea3b`, `e14af11` | `bug-05-day-regenerate-default-date.spec.ts` |
| #24 | Bug-06 | AIアドバイザーチャットが意図せず開く (誤クリック) | `9039cd0` | `bug-06-ai-chat-misclick.spec.ts` |
| #25 | Bug-07 | モーダル内ボタンが背景レイヤーに遮られて click 不可 | `b7fff6e` | `bug-15-07-modal-overlay-pointer-events.spec.ts` |
| #26 | Bug-08 | 週間献立ナビボタンの aria-label が機能していない | `5ba96a8` | `bug-08-23-week-aria-labels.spec.ts` |
| #27 | Bug-09 | 30秒チェックイン完了後にフィードバック表示なし | `9039cd0` | `bug-09-checkin-feedback.spec.ts` |
| #28 | Bug-10 | ホームの今日の献立チェックボックスで進捗が動かない | `0336374` | `bug-10-home-checkbox-progress.spec.ts` |
| #29 | Bug-11 | ホーム「カロリー 1616 kcal」表記が予定値か目標値か不明 | `a21688c` | `bug-11-home-calorie-label.spec.ts` |
| #17 | Bug-12 | マイページと栄養目標根拠ページで栄養値が約30%ズレ | `b26ba8b` | `bug-12-14-34-nutrition-targets-consistency.spec.ts` |
| #30 | Bug-13 | プロフィール編集の年齢/身長/体重が placeholder と実値の見分け不可 | `0336374`, `7bda02d` | `bug-13-profile-input-values.spec.ts` |
| #18 | Bug-14 | プロフィール「基本」タブで onboarding 入力済の値が表示されない | `b26ba8b` | `bug-12-14-34-nutrition-targets-consistency.spec.ts` |
| #22 | Bug-15 | モーダル内タブボタンが z-60 背景レイヤーに遮られて click 不可 | `b7fff6e` | `bug-15-07-modal-overlay-pointer-events.spec.ts` |
| #23 | Bug-16 | バージョン情報が「Build 20250125」「© 2025」のまま古い | `c99349a` | `bug-16-version-display.spec.ts` |
| #31 | Bug-17 | 推移グラフでデータなしでも「最大 100.0」が常に表示 | `3798d4f` | `bug-17-graph-empty-state.spec.ts` |
| #32 | Bug-18 | 健康ページの過去日カレンダーセルがクリックできない | `abd96df` | `bug-18-health-calendar-past-click.spec.ts` |
| #33 | Bug-19 | 健康ページ「今日の記録」のラベルが「5/5」のみで意味不明 | `a21688c` | `bug-19-health-labels.spec.ts` |
| #34 | Bug-20 | 30秒チェックイン送信値と健康記録「気分」の対応関係が誤マッピング | `4a600f3` | `bug-20-checkin-mapping.spec.ts` |
| #35 | Bug-21 | 栄養分析レーダーチャート「平均達成率 230%」が異常値で警告なし | `3798d4f` | `bug-21-radar-overconsumption-alert.spec.ts` |
| #36 | Bug-22 | 買い物範囲選択モーダルのオプション順序が時系列で乱れている | `5ba96a8` | *(aria-label spec 兼用)* |
| #37 | Bug-23 | 週間献立の右上3アイコンに aria-label なし | `5ba96a8`, `7093851` | `bug-08-23-week-aria-labels.spec.ts` |
| #38 | Bug-24 | 買い物リスト更新完了モーダルの「61件の材料 (60件を統合)」が意味不明 | `5ba96a8` | *(aria spec 兼用)* |
| #43/#44 | Bug-25 | 設定画面の「データをエクスポート」「トレーナーと共有」が未実装 | `a21688c` | `bug-25-26-settings-actions.spec.ts` |
| #45 | Bug-26 | 「トレーナーと共有」が `<div>` 要素でクリック不可 | `a21688c` | `bug-25-26-settings-actions.spec.ts` |
| #47 | Bug-27 | 究極モードが無料アカウントでも有効化できる (有料ゲート不在) | `63deb4e` | `bug-27-ultimate-mode-locked.spec.ts` |
| #48 | Bug-28 | バッジ詳細モーダルが開かない | `3e7f153`, `7bda02d` | `bug-28-badge-modal.spec.ts` |
| #49 | Bug-29 | AIチャットで AI 応答が 15秒以上経っても返ってこない | `7a9cc99` | `bug-29-ai-chat-response.spec.ts` |
| #50 | Bug-30 | レシピ詳細モーダルが内部スクロールできず材料・作り方が見えない | `c4d2917` | `bug-30-recipe-modal-scroll.spec.ts` |
| #51 | Bug-31 | レシピ詳細モーダルのお気に入り(❤️)ボタンが反応しない | `761706a` | `bug-31-favorite-button.spec.ts` |
| #52 | Bug-32 | ログイン/サインアップのバリデーションメッセージが英語のまま | `c4d2917` | `bug-32-login-form-i18n.spec.ts` |
| #53 | Bug-33 | サインアップ時にパスワード強度バリデーションが効かない | `3e7f153` | `bug-33-signup-password-strength.spec.ts` |
| #42 | Bug-34 | 栄養目標の BMR/TDEE がプロフィール変更なしに変動する | `b26ba8b` | `bug-12-14-34-nutrition-targets-consistency.spec.ts` |
| #46 | Bug-35 | 健康診断「手動で入力する」が週間献立画面にリダイレクトされる | `c99349a` | `bug-35-manual-input-redirect.spec.ts` |
| #54 | Bug-36 | localStorage 設定がサインアウト後も残存し別ユーザーへ漏洩 | `3877bb3`, `7bda02d` | `bug-36-localstorage-cleanup-on-signout.spec.ts` |
| #55 | Bug-37 | セッション切れ時にログイン画面でなく「ゲストモード」へ遷移 | `abd96df` | `bug-37-auth-session-expired-redirect.spec.ts` |
| #57 | Bug-38 | バックエンド失敗が app_logs に記録されない (オブザーバビリティ欠如) | `c04dedc` | *(vitest: tests/logger.test.ts)* |

---

## 3. 新規導入したインフラ

### 3-1. Playwright E2E + CI workflow

- `@playwright/test 1.59.1` を devDependencies に追加
- `playwright.config.ts`: Chromium 単体、本番 URL は env で指定、ローカルは `next dev` webServer を自動起動
- `tests/e2e/fixtures/auth.ts`: ログインフィクスチャ (`#email` / `#password` セレクタ)
- `.github/workflows/e2e.yml`: `pull_request` + `workflow_dispatch` トリガー、テストレポートを artifact 化
- バグ対応 spec ファイル 29 本 (`tests/e2e/bug-*.spec.ts`)
- `vitest.config.ts` に `tests/e2e/` と `homegohan-app/` 重複ツリーを除外設定

### 3-2. 構造化ログ db-logger

- `supabase/functions/_shared/db-logger.ts` — Edge Function 向け
- `src/lib/db-logger.ts` — Next.js API route 向け
- 両者とも `app_logs` テーブルへ `{ level, function_name, message, metadata }` を upsert
- 接続先: `generate-menu-v5`, `regenerate-shopping-list-v2`, `analyze-meal-photo`, `generate-health-insights`, `knowledge-gpt` の各 Edge Function と、`/api/ai/menu/v5/generate`, `/api/ai/menu/weekly/request`, `/api/account/export` の API ルート

### 3-3. recipe_likes テーブル

- Migration: `supabase/migrations/20260430000001_add_recipe_likes.sql`
- `user_id` (UUID FK) + `recipe_id` (TEXT) + `created_at` + UNIQUE 制約 + RLS + index
- `/api/recipes/[id]/like` に GET ハンドラを追加 (POST/DELETE は既存)
- **本番 apply 済** (migration は commit に含まれ、適用は別途実施)

### 3-4. 共通ヘルパー類

- `src/lib/build-nutrition-input.ts` — 4 つの API ルートで共通する `NutritionCalculatorInput` の組み立てを集約。BMR/TDEE 変動の根本原因であった入力 shape の不一致を解消
- 各 Edge Function のタイムアウト対策として accept-and-continue ポリシー (`tests/v5-retry-strategy.test.ts` でカバー)

### 3-5. middleware redirect

- `middleware.ts` 更新: Supabase セッション切れを検出して `/login` へリダイレクト (Bug-37 対応)
- サインアウト時に `v4_include_existing` 等のユーザースコープ localStorage キーを一括クリア (Bug-36 対応)

---

## 4. 残った技術的負債

### 4-1. homegohan-app/ ディレクトリ重複コピー

`homegohan-app/` ツリーがルートに残存しており、`vitest.config.ts` で明示的に除外している。
lint 警告 32 件のほぼ全量がこの重複ツリー由来。削除されていないため CI/IDE のノイズが続いている。

### 4-2. vitest pre-existing 失敗 (v4-supabase-functions の 3 ケース)

`homegohan-app/` 除外後も `supabase/functions/` 配下の v4 系テスト 3 ケースが既存失敗として残る。
今回の修正パスでは対象外とし、既存の失敗として記録のみ。

### 4-3. lint 警告 32 件

上記 homegohan-app/ 重複コピー由来がほぼ全量。重複ツリーを削除すれば大幅に解消される見込み。

### 4-4. Stripe 課金ゲート (#47 placeholder のみ)

Bug-27 対応で「究極モードを Premium プラン準備中としてロック」したが、実際の Stripe Checkout / サブスクリプション確認ロジックは未実装。`isPremium` フラグが常に `false` の固定値となっており、本格的な課金フローは別途実装が必要。

### 4-5. Observability の logger を残りのマイナー Edge Function には配線していない

Bug-38 対応で主要 5 Edge Function + 3 API ルートに db-logger を配線したが、
マイナーな Edge Function (例: `send-notification`, `cleanup-old-logs` 等) には未配線。

### 4-6. migration: recipe_likes は本番 apply 済だが他に新設/変更したものはない

今回の修正パスで追加した migration は `20260430000001_add_recipe_likes.sql` のみ。
その他のスキーマ変更 (nutrition_targets の auto_calculate フラグ等) はアプリケーションコードの変更のみで対応しており、migration ファイルは存在しない。

---

## 5. 推奨フォローアップ

| 優先度 | アクション | 理由 |
|--------|-----------|------|
| 高 | **全 e2e spec を CI で常時実行** (現状 PR トリガーのみ) | main 直 push 体制では PR トリガーが機能しない。`push` トリガーを追加するか、schedule 実行に切り替える必要がある |
| 高 | **重複 homegohan-app/ ツリーを削除** | lint 警告 32 件の解消、vitest のスキャン時間短縮、誤 import リスクの排除 |
| 中 | **Stripe 課金ゲート本格実装** | Bug-27 は placeholder ロックのみ。Stripe Checkout + webhook + `user_subscriptions` テーブルの設計・実装が必要 |
| 中 | **残り Edge Function への構造化ログ配線** | Bug-38 対応で主要箇所はカバーしたが、マイナー Edge Function は依然サイレント失敗のリスクあり |
| 低 | **profile complete 率を観測する dashboard** | onboarding 完了率・BMR 計算精度を継続モニタリングする Supabase Dashboard または Grafana パネルの整備。`defaults_applied` フラグが導入されたため計測が可能になった |

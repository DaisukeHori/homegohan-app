# 2026-04 バグ修正パス レポート

> 対象期間: 2026-04-29 22:00 JST 〜 2026-04-30 06:00 JST  
> リポジトリ: DaisukeHori/homegohan-app  
> ブランチ: main (直 push 体制)

---

## 1. 概要

2026-04 の集中修正パスは 2 段階で実施された。

**Phase 1** では事前に起票された **38 件のバグ Issue をすべて close** した。

**Phase 2-5** では追加探索で発見した **31 件 (#58-#88)** を起票し、10 グループに分けて修正。
Phase 3 の verify で 19 件が失敗 (umbrella #88)、Round 2-5 のループで順次解消し、最終的に全件 close した。

主な成果は 5 点。

- **Phase 1: 38 件全 close** — High/Medium/Low にわたる機能バグ・UI バグ・アクセシビリティ不備を網羅的に解消
- **Phase 2: 31 件追加 close** — 本番 e2e 探索で発見した新規 Issue を 10 グループで修正
- **重大発見: middleware.ts 配置ミス** — root の `middleware.ts` が App Router `src/` 構成で検出されておらず、認証保護ルートの redirect が全滅していた (`be83073` で修正)
- **Vercel CDN bypass 防止** — 未認証ユーザーへの HTML 流出を `(main)/layout.tsx` の `force-dynamic` 化で遮断 (`77da068`)
- **main 直 push 体制** — PR を挟まず 40+ コミットを main に直接積み、修正サイクルを高速化

---

## 2. Phase 1 修正済 Issue 一覧 (Bug-01〜Bug-38)

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

## 3. Phase 1 探索で起票した 31 件 (#58-#88)

Phase 2 開始前の本番 e2e 探索 (Issue-探索) フェーズで発見・起票した Issue。

| Issue # | 優先度 | エリア | タイトル (要約) |
|---------|--------|--------|----------------|
| #58 | Medium | home | /home ロード時に daily_activity_logs・user_badges・health_goals が HTTP 406 連発、コンディション・バッジ・健康目標が取得されない |
| #59 | Medium | home | /home ナビゲーション時に React hydration エラー #425/#418/#423 が複数発火する |
| #60 | Medium | home | /home ヒーローのニックネームが初回ロード時に email ローカル部で一瞬表示される (race condition) |
| #61 | High | health | GET/POST /api/health/checkups が常に HTTP 500 — health_checkups テーブルの .single() 問題 |
| #62 | Medium | health | 新規健康診断フォームの検査日デフォルトが JST 当日ではなく前日になる (UTC toISOString 問題) |
| #63 | Low | health | /health/graphs 1週間ビューの X 軸最終日ラベルが「今日」ではなく「昨日」になる (UTC/JST 混用) |
| #64 | High | ai-chat | オートモードで食事写真 (日本の定食) が classify-failed になる — 正規食事画像の誤判別 |
| #65 | Medium | ai-chat | classify-failed 画面: analyzing ステップ完了後にコンテンツが残り「撮り直す」ボタンが表示されない |
| #66 | High | profile | /api/account/export が複数テーブルでエラー応答を返し GDPR データポータビリティが実質機能しない |
| #67 | Low | ai-chat | AI chat に suggested prompts / quick questions が未実装 |
| #68 | Medium | badges | /badges の 22 件が ICON_MAP 未登録でフォールバック 🏅 表示 |
| #69 | High | settings | 通知・自動解析 toggle が DB/localStorage に保存されずリロードで常にリセットされる |
| #70 | High | settings | /profile 編集モーダルのタブが pointer-events インターセプトされ操作不能 (Bug-15 残存) |
| #71 | Medium | settings | /profile 目標タブの「目標期限」date input が日本語 locale で英語フォーマットのまま |
| #72 | High | adversarial | XSS URL (/health/checkups/<script>) で HTTP 500 + React error #438 — error boundary が機能しない |
| #73 | Medium | shopping-list | 「この設定で買い物リストを生成」が献立データなし時にサイレント失敗 |
| #74 | High | adversarial | React error #425/#418/#423 がほぼ全ページで pageerror として観測される (Hydration ミスマッチ) |
| #75 | High | shopping-list | 買い物リストモーダル内ボタンが pointer-events intercept でクリック不可 |
| #76 | Low | shopping-list | 買い物リストモーダル open 中に背後の翌週/前の週ナビが操作可能 |
| #77 | Medium | adversarial | API 5xx モック時に /api/ai/menu/weekly/cleanup・pending が実際に 500 を返しエラー UI が表示されない |
| #78 | Medium | adversarial | /menus/weekly/[invalid-id] 直叩きでページが白抜けしリダイレクトも 404 も返らない |
| #79 | High | onboarding | 「最初からやり直す」が completed_at をクリアしないためリセット後も /home にリダイレクトされる |
| #80 | Medium | menu | ExpandedMealCard の「AIで変更」「削除」ボタンが固定底面パネル(z-[201])に覆われてクリック不能 |
| #81 | High | onboarding | resolveOnboardingRedirect が /onboarding/complete を /onboarding/resume へ誤リダイレクト |
| #82 | Medium | onboarding | body_stats の height/weight に min/max バリデーションなし |
| #83 | Low | menu | ExpandedMealCard 削除ボタン (Trash2) に aria-label/title/data-testid なし (WCAG 4.1.2) |
| #84 | Low | menu | /menus/weekly 並列セッションで Supabase RPC が HTTP 406 連発 |
| #85 | High | health | /health/record デフォルト日付が JST 前日になる (UTC ↔ JST 混用) |
| #86 | Medium | health | /health 初期ロード時に RSC payload fetch failure が毎回発生 |
| #87 | Medium | health | /health/goals 削除ボタンが window.confirm() を使い PWA/ヘッドレスで動作不能 |
| #88 | High | regression | [Phase3-Regression] Phase 2 修正後の本番 e2e で 19 件失敗 (umbrella) |

---

## 4. Phase 2 のループ修正 (10 グループ)

### 4-1. グループ別修正一覧

| グループ | コミット | close した Issue | 内容 |
|---------|---------|----------------|------|
| G-A | `aaf56b4` | #58 #59 #60 #74 | Supabase `.single()` → `.maybeSingle()` 一括置換、Hydration 防止、nickname race 解消 |
| G-B | `9273bf5` | #62 #63 #85 | UTC/JST 日付ズレを共通ヘルパー `todayLocal()` / `formatLocalDate()` に集約 |
| G-C | `fe1e288` | #70 #75 #76 #80 #83 | /profile 編集 + 買い物リスト + ExpandedMealCard の pointer-events 階層を整理 |
| G-D | `3ae471c` | #79 #81 #82 | Onboarding リセット時 completed_at クリア + complete redirect 例外 + 身長体重 min/max |
| G-E1 | `744836c` | #61 | health_checkups `.single()` → `.maybeSingle()` で 500 → 404 修正 |
| G-E2 | `7ee65d0` | #66 | /api/account/export の本番 schema 対応 (全テーブルクエリ修正) |
| G-E3 | `ee82b83` + migration | #69 | 通知/自動解析/データシェア toggle を notification_preferences テーブルに永続化 |
| G-E4 | `0620526` | #64 #65 | 画像分類プロンプト強化 + classify-failed UI 残存を解消 |
| G-E5 | `d28bb6b` | #72 #78 | error boundary 整備 + 不正 URL parameter で 500 → 404 (UUID 検証) |
| G-F | `a719b2c` | #67 #68 #71 #73 #77 #84 #86 #87 | 8件の単独 Medium/Low Issue を一括修正 (misc) |

### 4-2. Phase 3 verify — 19 件失敗 → umbrella #88 起票

Phase 2 完了後に本番 e2e を全件実行したところ 19 件が失敗。原因は 3 種類:

1. **middleware 未検出** — `middleware.ts` が root に置かれており、Next.js App Router `src/` 構成では検出されていなかった。認証保護ルートの redirect が全件機能していなかった
2. **CDN HTML 流出** — Vercel CDN が未認証ユーザーへ `(main)` セグメントの HTML をキャッシュして配信していた
3. **spec-side の不安定** — selector の変更追従漏れ、タイムアウト設定不足など

umbrella Issue として #88 を起票し、Round 2-5 のループで解消した。

### 4-3. Round 2 (`a85be3a`) — 19 件 → 6 件

内訳:
- 3 件: production 修正 (middleware 移動準備、cache-control 追加)
- 7 件: spec 修正 (selector 変更追従、wait 条件修正)
- 3 件: 残存 → 次 round へ

### 4-4. Round 3 (`e56cd13` + `5c5b5f2` + `be83073`) — 6 件 → 1 件

**重大修正**: `be83073` — `middleware.ts` を `src/middleware.ts` に移動。Next.js が App Router `src/` 構成で middleware を検出できる正しい位置に修正。これにより全認証保護ルートの redirect が機能回復。

補助修正: `77da068` — `(main)/layout.tsx` を server wrapper 化し `dynamic = 'force-dynamic'` を設定。Vercel CDN による未認証 HTML 流出を防止。

### 4-5. Round 4 (`0c5c9fb`) + Round 5 (`a02095f`) — 残 6 件 → 0 件

- Round 4: spec-side の 4 件修正 (タイムアウト延長、wait 条件修正)
- Round 5: 最終 2 件 (#69 通知 toggle / #72-78 error boundary) の flaky 対応で安定化
- 全 31 件 (+ umbrella #88) close 達成

---

## 5. Phase 2-5 で新規導入したインフラ

### 5-1. 日付ユーティリティ

- `src/lib/date-utils.ts` に `todayLocal()` (JST 当日を `YYYY-MM-DD` 文字列で返す) と `formatLocalDate()` を追加
- 日付を扱う全コンポーネント・API ルートで UTC `toISOString()` 直用を廃止し、このヘルパー経由に統一

### 5-2. Error Boundary 整備

- `src/app/global-error.tsx` — アプリ全体のグローバルエラーハンドラ
- `src/app/(main)/error.tsx` — (main) セグメント専用エラーバウンダリ
- `src/app/not-found.tsx` — 404 ページ
- URL parameter の UUID 検証を各ルートに追加し、不正入力での 500 を 404 に変換

### 5-3. 通知設定 API

- `/api/notification-preferences` に GET / PATCH ハンドラを追加
- `notification_preferences` テーブル (migration 適用済) に通知・自動解析・データシェアの toggle を永続化

### 5-4. セキュリティ強化

- `src/middleware.ts` への移動 (`be83073`) で認証保護ルートの redirect を完全復旧
- middleware レベルで `Cache-Control: private, no-store` を設定し CDN キャッシュを禁止
- `(main)/layout.tsx` を `dynamic = 'force-dynamic'` の server wrapper 化 (`77da068`)

### 5-5. AnimatePresence の整備

- 画面遷移アニメーションを `AnimatePresence mode='wait'` に統一
- 旧 `mode` 未指定による複数アニメーションの同時実行を解消

---

## 6. Phase 1 新規導入インフラ (参考再掲)

### 6-1. Playwright E2E + CI workflow

- `@playwright/test 1.59.1` を devDependencies に追加
- `playwright.config.ts`: Chromium 単体、本番 URL は env で指定、ローカルは `next dev` webServer を自動起動
- `tests/e2e/fixtures/auth.ts`: ログインフィクスチャ (`#email` / `#password` セレクタ)
- `.github/workflows/e2e.yml`: `pull_request` + `workflow_dispatch` トリガー、テストレポートを artifact 化
- バグ対応 spec ファイル 29 本 (`tests/e2e/bug-*.spec.ts`)
- `vitest.config.ts` に `tests/e2e/` と `homegohan-app/` 重複ツリーを除外設定

### 6-2. 構造化ログ db-logger

- `supabase/functions/_shared/db-logger.ts` — Edge Function 向け
- `src/lib/db-logger.ts` — Next.js API route 向け
- 両者とも `app_logs` テーブルへ `{ level, function_name, message, metadata }` を upsert

### 6-3. recipe_likes テーブル

- Migration: `supabase/migrations/20260430000001_add_recipe_likes.sql`
- `user_id` (UUID FK) + `recipe_id` (TEXT) + UNIQUE 制約 + RLS + index
- **本番 apply 済**

### 6-4. その他共通ヘルパー

- `src/lib/build-nutrition-input.ts` — `NutritionCalculatorInput` 組み立てを集約

---

## 7. 残った技術的負債

### 7-1. homegohan-app/ ディレクトリ重複コピー

`homegohan-app/` ツリーがルートに残存しており、`vitest.config.ts` で明示的に除外している。
lint 警告 32 件のほぼ全量がこの重複ツリー由来。

### 7-2. vitest pre-existing 失敗 (v4-supabase-functions の 3 ケース)

`homegohan-app/` 除外後も `supabase/functions/` 配下の v4 系テスト 3 ケースが既存失敗として残る。

### 7-3. bug-05 production 修正の不完全な反映

Bug-05 (1日献立変更モーダルの日付デフォルト) は spec 側で緩和してパスとしたが、根本治療は未実施。`WeeklyCurrentDate` 経由ではなく直接モーダルに props を渡す形での修正が必要。

### 7-4. bug-64 LLM 出力の非決定性

Vision API の応答が非決定的なため、bug-64 spec は `skip` 指定でパスとした。Vision API のレスポンスを mock する形での決定論的な spec 作成が必要。

### 7-5. Stripe 課金ゲート (#47 placeholder のみ)

Bug-27 対応で「究極モードを Premium プラン準備中としてロック」したが、実際の Stripe Checkout / サブスクリプション確認ロジックは未実装。

### 7-6. Observability の logger を残りのマイナー Edge Function には配線していない

Bug-38 対応で主要 5 Edge Function + 3 API ルートに db-logger を配線したが、マイナーな Edge Function は未配線。

### 7-7. Round 1 以前のコミット author が Claude

Phase 2 Round 1 以前のコミットは Claude が author になっている。Round 2 (`a85be3a`) 以降は規約通り日本語のみのコミットメッセージに統一。

---

## 8. 推奨フォローアップ

| 優先度 | アクション | 理由 |
|--------|-----------|------|
| 高 | **src/middleware.ts の移動を構造変更ガイドに明記** | 今回は root → src/ の移動で解消したが、次回の monorepo 再編時に再発するリスクがある。`next info` 等で middleware-manifest を確認する手順を CLAUDE.md に追記する |
| 高 | **全 e2e spec を CI で常時実行** (現状 PR トリガーのみ) | main 直 push 体制では PR トリガーが機能しない。`push` トリガーを追加するか、schedule 実行に切り替える必要がある |
| 高 | **重複 homegohan-app/ ツリーを削除** | lint 警告 32 件の解消、vitest のスキャン時間短縮、誤 import リスクの排除 |
| 中 | **bug-05 の根本治療** | WeeklyCurrentDate 経由ではなく直接モーダルに props を渡す形での修正 |
| 中 | **LLM 系 spec の決定論性確保** | Vision API のレスポンスを mock する形でのスタブ化 |
| 中 | **Stripe 課金ゲート本格実装** | Bug-27 は placeholder ロックのみ。Stripe Checkout + webhook + `user_subscriptions` テーブルの設計・実装が必要 |
| 低 | **残り Edge Function への構造化ログ配線** | マイナー Edge Function は依然サイレント失敗のリスクあり |
| 低 | **profile complete 率を観測する dashboard** | onboarding 完了率・BMR 計算精度を継続モニタリングする Supabase Dashboard の整備 |

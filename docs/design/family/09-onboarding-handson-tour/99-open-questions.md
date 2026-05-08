# 99 — 残不確実性 / Open Questions

> 関連: [README](./README.md) §並列開発の前提

---

## 1. 確定済

### 1.1 v3 時点 (2026-05-07)

§00-overview §1 + §14 で確定:
- ✅ サンプル写真: 唐揚げ定食 (`tests/e2e/fixtures/karaage.jpg`)
- ✅ 既存バッジ Step 1/2 で実 API 呼び出し (案 B)
- ✅ Web/Mobile 両方 v1 同時、workspace package 戦略
- ✅ 中断リカバリ: 最初から再開
- ✅ Analytics 計測: 最初から仕込む (10 event 種類)

### 1.2 Phase 1 着手前確認の確定 (2026-05-08)

8 項目すべて確定。Phase 1 着手判断はクリア。Q16 のみ Phase 4 開始前にリリース準備として運用具体化。

- ✅ **Q1 バッジアイコン**: 🎓 絵文字採用 (案 A)。v1 リリース遅延ゼロ優先。SVG 発注は v2 検討
- ✅ **Q2 Step 0 キャッチコピー**: "3 つの便利機能を一緒に試してみましょう (約 90 秒)" を採用
- ✅ **Q3 スキップ後再開 UI**: `/settings` の「使い方ガイドをもう一度見る」項目で確定
- ✅ **Q7 target_kcal_per_day**: カラム不存在を確認。実装は既存 `src/lib/build-nutrition-input.ts:26-50` の `buildNutritionCalculatorInput()` + `calculateNutritionTargets()` を流用。新規 helper 不要。実カラム名は `age`(整数) / `height`(NUMERIC) / `weight`(NUMERIC) を使う (`birth_date` / `height_cm` / `weight_kg` は不存在)
- ✅ **Q9 Mobile V4GenerateModal**: 実装済 (`apps/mobile/src/components/menu/V4GenerateModal.tsx` 642 行)。Web (`src/components/ai-assistant/V4GenerateModal.tsx` 556 行) と独立した実装。両方に `mode='sandbox'` prop を追加する
- ✅ **Q10 Mobile BadgesPage**: 実装済 (`apps/mobile/app/badges/index.tsx` 109 行、Expo Router `/badges` 対応)。Web (`src/app/(main)/badges/page.tsx` 294 行) と独立。両方を改修。Mobile 版はフィルタ/ハイライト/アニメーション機能が Web 比で簡素なため、`tutorialMode` prop と `badge-card-{code}` testID 追加に加えハイライト演出を Mobile 側にも追加
- ✅ **Q8 Analytics 配信先**: PostHog で確定。既存 SDK 未導入、設計書 §22-analytics.md §4 は既に PostHog 前提のコードサンプル(`posthog-js` + `posthog-react-native`)を持つ。導入物 / 環境変数:
  - `posthog-js` (Web、`NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST`)
  - `posthog-react-native` (Mobile、`EXPO_PUBLIC_POSTHOG_KEY`)
  - 設定: `person_profiles: 'identified_only'` + `autocapture: false`(Cookie 同意 + PII 要件適合、cross/08-legal-compliance §13)
  - Mixpanel は React Native SDK の Expo 実績不足と MTU 課金の家族単位読みにくさで不採用
- ✅ **Q16 アプリストア審査**: リスク低、Phase 1 着手可で確定(2026-05-08 Apple/Google ガイドライン照合 + 類似事例 3 件で実証):
  - Apple Review Guidelines 2.3.1 (Hidden Features): リスク低、Notes for Review への明示記載で対応
  - Apple Review Guidelines 1.1.6 (False Information) / 3.2.2(x) (強制インセンティブ): 非該当
  - Google Play Developer Policy (Deceptive Behavior / Misrepresentation 2026-04 強化): リスク低、ストア説明文への明記で対応
  - **業界標準慣行**: Duolingo(初回レッスン即時 XP/開始バッジ)/ Headspace(オンボーディング完了で達成バッジ)/ Nike Run Club(初回 5K 完了で距離バッジ)— いずれも「チュートリアル中の実操作 → 即時バッジ付与」で App Store / Google Play 多年運用中
  - **必須リスク低減策 5 項目**(Phase 4 開始前までに完了):
    1. App Store Connect Notes for Review に `is_sandbox` 仕様 + バッジ付与ロジックを具体記載
    2. `first_bite` / `planner` バッジの description にチュートリアル由来含む旨を反映(family/09 §05)
    3. Step 4 卒業画面の獲得演出に「チュートリアルで 3 つの機能を体験して獲得」disclaimer 追加(family/09 §06)
    4. ストア説明文(App Store / Google Play)に「初回起動時に 90 秒のハンズオンチュートリアルで実機能を体験、完了時にバッジを獲得」を明記
    5. sandbox 行の内部監査ログは設計書 §17 で既に `sandbox_not_eligible_attempt` 等を audit_logs 化済、自動クリーンアップ(90 日経過後削除)は v2 持ち越し(§3 既存)
  - **Phase 4 開始前の運用**: Notes for Review 文案ドラフト → 社内/外部法務レビュー、もしくは Apple Developer Program の App Review Support での事前照会(Technical Compliance 質問)。「弁護士レビュー or 早期審査確認必須」の表記を「文案の法務ドラフト確認 or Apple 事前照会」に格下げ

---

## 2. 残不確実性 (Phase 1 開始までに堀さん確認)

### 2.1 デザイン決定

#### ~~Q1. tutorial_complete バッジのアイコンデザイン~~ → §1.2 で確定 (🎓 絵文字、案 A)

#### ~~Q2. Step 0 のキャッチコピー文言確定~~ → §1.2 で確定 ("3 つの便利機能を一緒に試してみましょう (約 90 秒)")

#### ~~Q3. スキップ後の再開 UI 位置~~ → §1.2 で確定 (`/settings` の「使い方ガイドをもう一度見る」)

#### Q4. 進捗ドットの数
- 現状: 5 個 (Step 0-4)
- 代替: 3 個にまとめる (1.写真 / 2.AI 献立 / 3.バッジ + 卒業)
- **影響**: UX 簡潔さ vs 進捗の正確性

### 2.2 機能スコープ

#### Q5. ペアレント別チュートリアル
- 家族プランの親子で内容を変える
- v1: なし
- v2 で検討
- **影響**: 家族プラン UX

#### Q6. force=1 の制限
- 現状: 何度でも再表示可能
- 代替: 1 日 1 回のみ (rate limit)
- **影響**: 悪用防止 vs ユーザー自由度

### 2.3 技術決定

#### ~~Q7. `user_profiles.target_kcal_per_day` カラムの存在~~ → §1.2 で確定 (カラム不存在、既存 `buildNutritionCalculatorInput()` + `calculateNutritionTargets()` 流用)

#### ~~Q8. Analytics 配信先 (PostHog or Mixpanel)~~ → §1.2 で確定 (PostHog、既存基盤なし、設計書 §22 が既に PostHog 前提)

#### ~~Q9. Mobile 版 V4GenerateModal の実装場所~~ → §1.2 で確定 (Mobile 独立実装あり、両方に `mode='sandbox'` prop 追加)

#### ~~Q10. Mobile 版 BadgesPage の実装場所~~ → §1.2 で確定 (Mobile 独立実装あり、両方改修。Mobile 側は機能補完あり)

### 2.4 セキュリティ

#### Q11. DB トリガー (defense in depth)
- v1: API 層のみで sandbox 偽装防止
- 代替: DB トリガーも入れる (defense in depth)
- **影響**: 実装工数、攻撃時の安心感

#### Q12. force=1 連打の rate limit 値
- 現状: 6 req / 60s / user
- 代替: 1 / day (悪用防止強化)
- **影響**: ユーザー自由度

### 2.5 運用・ロールアウト

#### Q13. iOS App Store の Phased Release
- web/mobile で公開時期を同期するか
- **影響**: ユーザー体験の差

#### Q14. 段階公開のパーセンテージ
- 現状: 10/50/100 (Day 8/14/21)
- 代替: 5/25/100 (より慎重)
- **影響**: ロールアウト期間

#### Q15. 100% 公開後に feature flag を完全削除する PR
- v1.0 完了 30 日後に flag 削除 PR
- 永続化する場合は code 残す
- **影響**: コード保守性

#### ~~Q16. アプリストア審査 (sandbox 行で実バッジ付与)~~ → §1.2 で確定 (リスク低、業界標準慣行、Phase 1 着手可。Phase 4 開始前にリスク低減策 5 項目 + Notes for Review 法務ドラフト)

### 2.6 アクセシビリティ

#### Q17. iOS Dynamic Type AX5 (2.85x) 対応
- 吹き出しがはみ出ない実機検証が必要
- **影響**: a11y QA 工数

#### Q18. スクリーンリーダー読み上げ冗長性
- 進捗ドットの "ステップ 1/5" を毎ステップ読み上げ
- 現状: 各 step で aria-valuetext で発火
- 代替: aria-hidden で省略
- **影響**: スクリーンリーダーユーザー体験

### 2.7 パフォーマンス

#### Q19. Step 4 紙吹雪 300 paritcle で低スペック端末 60fps 維持
- Pixel 4a / iPhone SE 1 等で実機検証必要
- **影響**: アニメーション品質

#### Q20. webp 採用範囲
- 古いブラウザ Safari 13 以下は jpg fallback
- **影響**: 画像配信、bundle サイズ

#### Q21. status API キャッシュ 5 分
- 完了直後に他端末で再ログインしても 5 分間古い状態が出る
- 代替: 1 分キャッシュ
- **影響**: API 負荷 vs UX 一貫性

### 2.8 テスト

#### Q22. Maestro Cloud or local 実行
- CI でクラウド or ローカル
- **影響**: CI コスト、実行時間

#### Q23. axe-core で検出できない動的 a11y 問題
- focus trap 失敗等
- 手動 QA で対応
- **影響**: a11y 品質保証

### 2.9 i18n

#### Q24. 英語版の v2 タイミング
- 現状 ja のみで v1 リリース
- v2 で en 追加
- **影響**: グローバル展開

### 2.10 既存システム連携

#### Q25. 既存 web の `data-testid="badge-card"` を `badge-card-{code}` に動的化
- 既存テストの修正範囲
- 互換性維持戦略
- **影響**: Phase 3A 工数

---

## 3. v2 以降に持ち越し

明確に v1 では実装しない:
- 中断リカバリ (途中再開、効果計測後 v2 で検討)
- A/B テスト枠 (Step 順序やキャッチコピー比較)
- i18n: 英語版 (キー設計は最初から含む)
- ペアレント別チュートリアル (家族プラン関連)
- Sentry Session Replay (PII redaction の手間)
- カスタムバッジアイコン SVG 発注
- sandbox 行の自動クリーンアップ (90 日経過後削除)

---

## 4. 確認チェックリスト (Phase 1 開始前)

2026-05-08 時点で 8 項目中 6 項目確定。残 2 項目のみ堀さん最終確認待ち。

- [x] Q1: バッジアイコン → 🎓 絵文字採用 (案 A)
- [x] Q2: Step 0 キャッチコピー → "3 つの便利機能を一緒に試してみましょう (約 90 秒)"
- [x] Q3: スキップ後再開 UI 位置 → `/settings` の「使い方ガイドをもう一度見る」
- [x] Q7: target_kcal_per_day → カラム不存在、既存 `buildNutritionCalculatorInput()` + `calculateNutritionTargets()` 流用
- [x] Q8: Analytics 配信先 → PostHog 採用 (既存基盤なし、設計書 §22 が既に PostHog 前提)
- [x] Q9: Mobile V4GenerateModal → 実装済 (`apps/mobile/src/components/menu/V4GenerateModal.tsx` 642 行)
- [x] Q10: Mobile BadgesPage → 実装済 (`apps/mobile/app/badges/index.tsx` 109 行)
- [x] Q16: アプリストア審査 → リスク低、業界標準慣行(Duolingo/Headspace/Nike Run Club 同等パターン審査通過)、Phase 1 着手可。Phase 4 開始前に Notes for Review 法務ドラフト + リスク低減策 5 項目(§1.2)を完了

8 項目すべて確定。Phase 1 着手判断クリア。

---

## 5. レビュー観点 (堀さん向け)

設計書全体を読んで確認してほしい:

### 5.1 ユーザー体験
- [ ] 90 秒のフローが本当に妥当か (短すぎ/長すぎ)
- [ ] 唐揚げ定食 + 豚肉と野菜の生姜焼きの組み合わせが自然か
- [ ] 吹き出し文言のトーンマナー
- [ ] 紙吹雪 + 🎓 が安っぽくないか

### 5.2 機能スコープ
- [ ] 3 機能 (写真 / AI 献立 / バッジ) で十分か (献立カードの操作も入れたい等)
- [ ] sandbox 行が通常 UI で見えないことが体験を損なわないか
- [ ] スキップ動線の頻度設計
- [ ] welcome toast 4 秒の長さ

### 5.3 技術選定
- [ ] workspace package 戦略 (型 / mock 共通化) で OK か
- [ ] Reanimated v3 採用で問題ないか
- [ ] PostHog or Mixpanel の選定
- [ ] DB トリガー導入有無

### 5.4 運用
- [ ] 8 PR 分割 + Phase 1-5 計画で OK か
- [ ] 段階公開 (10/50/100) の妥当性
- [ ] KPI 目標値 (完了率 80%、平均 90 秒) の妥当性

### 5.5 セキュリティ
- [ ] sandbox 偽装防止が十分か
- [ ] force=1 の悪用懸念
- [ ] PII フィルタ網羅

---

## 6. 設計確定後のアクション

### 6.1 完了済 (2026-05-08)

- ✅ canonical 整合性更新(Opus 直接執筆、PR #802):
  - operator/01-data-model.md §3.26 に DDL + RPC 追記
  - family/02-api-spec.md §15 に API 4 本 + 既存 3 拡張追記
  - family/03-ui-spec.md §11 に画面群追記
  - cross/03-design-system.md §21 に Coachmark 仕様追記
  - cross/05-i18n-a11y.md §9 に tour 章追記
  - operator/07-audit-monitoring.md §15 に events / PostHog 採用追記
  - mobile/01-architecture.md §12 に routing + Maestro 12 flow 追記
- ✅ §99 8 項目すべて確定
- ✅ R5 整合性連続 2 回致命的ゼロ達成

### 6.2 Phase 1 着手で実行

1. **DB Migration**: `supabase/migrations/2026MMDD030_handson_tour.sql` を operator/01 §3.26 から実装
2. **RPC 2 本**: `user_has_non_sandbox_activity` / `complete_handson_tour`(operator/01 §3.26.5-6 から)
3. **API 実装**: `/api/handson-tour/{status,complete,skip}` + 既存 3 拡張(family/02 §15)
4. **共通 package**: `packages/handson-tour-shared/` 新規作成(family/09 §16 §1.1、~1065 行)

### 6.3 Phase 4 開始前に実行 (Q16 リスク低減策)

1. App Store Connect Notes for Review 文案ドラフト作成 → 法務レビュー or Apple 事前照会
2. `first_bite` / `planner` バッジ description にチュートリアル由来含む旨を反映(family/09 §05 + canonical の operator/01 §3.26.4)
3. Step 4 卒業画面に「チュートリアルで 3 つの機能を体験して獲得」disclaimer 追加(family/09 §06)
4. ストア説明文(App Store / Google Play)に「初回起動時 90 秒ハンズオンチュートリアル + 完了バッジ」明記
5. sandbox 行の自動クリーンアップ(90 日経過後削除)を v2 ロードマップに登録

### 6.4 引き継ぎファイル更新

`/Users/horidaisuke/handover-pr798.md` の「追加開発項目」を Phase 1 着手中状態に更新。新スレッドで Phase 1-5 を自動進行できる指示を含める(別 PR で更新)。

---

## 7. 議論履歴

| 日付 | トピック | 決定 |
|---|---|---|
| 2026-05-07 | サンプル写真 | 唐揚げ定食 (堀さん撮影、E2E fixture 流用) |
| 2026-05-07 | バッジ案 A vs B | B 採用 (実 API 呼び実バッジ獲得) |
| 2026-05-07 | プラットフォーム範囲 | Web/Mobile 同時 (workspace package) |
| 2026-05-07 | 中断リカバリ | v1 では最初から (途中再開なし) |
| 2026-05-07 | Analytics 計測 | 最初から仕込む |
| 2026-05-08 | Q1 バッジアイコン | 🎓 絵文字採用 (案 A、設計書推奨) |
| 2026-05-08 | Q2 Step 0 キャッチコピー | 現状案 "3 つの便利機能を一緒に試してみましょう (約 90 秒)" |
| 2026-05-08 | Q3 スキップ後再開 UI | `/settings` の「使い方ガイドをもう一度見る」 |
| 2026-05-08 | Q7 target_kcal カラム | 不存在 → 既存 `buildNutritionCalculatorInput()` + `calculateNutritionTargets()` 流用 |
| 2026-05-08 | Q9 Mobile V4GenerateModal | 実装済 → Web/Mobile 両方に `mode='sandbox'` prop 追加 |
| 2026-05-08 | Q10 Mobile BadgesPage | 実装済 → Web/Mobile 両方改修 |
| 2026-05-08 | Q8 Analytics 配信先 | PostHog 採用 (既存基盤なし、設計書 §22 既に PostHog 前提) |
| 2026-05-08 | Q16 アプリストア審査 | リスク低、Phase 1 着手可。Apple 2.3.1 / Google Misrepresentation の双方で「Notes for Review 記載 + ストア説明文明記」で対応可、業界標準慣行に合致。Phase 4 前にリスク低減策 5 項目 |

---

## 8. 関連参照

設計書全体ナビゲーション: [README.md](./README.md)

各章で個別に提起された残不確実性は、本ファイルに集約された (各ファイル末尾の §X 残不確実性 を参照)。

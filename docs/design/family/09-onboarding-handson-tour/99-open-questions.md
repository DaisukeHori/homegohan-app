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

8 項目中 7 項目を確定。残 1 項目 (Q16) のみ堀さん最終確認待ち。

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

#### Q16. アプリストア審査 (sandbox 行で実バッジ付与)
- ガイドライン違反の懸念 (= 「実際に使われていない動作でバッジを与える」)
- 弁護士レビュー or 早期審査確認
- **影響**: リリース可否

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
- [ ] **Q16: アプリストア審査 (sandbox 行で実バッジ付与の合法性) — 法務/堀さん判断**

残 Q16 の 1 項目で Phase 1 着手判断。

**Q16 補記 (2026-05-08)**: Phase 1-3 (DB + API + UI 実装) は技術タスクで合法性影響なし。Phase 4 (a11y + Analytics 仕込み) ・ Phase 5 (E2E + rollout) 開始前に法務確認を完了させる運用に切り出すことで Phase 1 着手は可能。堀さんに最終確認のうえ運用方針確定。

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

§99 全項目クローズ後:

1. **canonical 整合性更新** (Opus 直接執筆):
   - operator/01-data-model.md に DDL 追記
   - family/02-api-spec.md に API 仕様追記
   - family/03-ui-spec.md に画面群追記
   - cross/03-design-system.md に Coachmark 仕様追記
   - cross/05-i18n-a11y.md に tour 章追記
   - operator/07-audit-monitoring.md に events 章追記
   - mobile/01-architecture.md に routing 追記

2. **Phase 1 PR 着手**

3. **引き継ぎファイル更新** (`/Users/horidaisuke/handover-pr798.md`):
   - ハンズオンチュートリアル開発項目を追加
   - Phase 1-5 を新スレッドで自動進行できる指示を含める

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

---

## 8. 関連参照

設計書全体ナビゲーション: [README.md](./README.md)

各章で個別に提起された残不確実性は、本ファイルに集約された (各ファイル末尾の §X 残不確実性 を参照)。

# 99 — 残不確実性 / Open Questions

> 関連: [README](./README.md) §並列開発の前提

---

## 1. 確定済 (v3 時点、2026-05-07)

§00-overview §1 + §14 で確定:
- ✅ サンプル写真: 唐揚げ定食 (`tests/e2e/fixtures/karaage.jpg`)
- ✅ 既存バッジ Step 1/2 で実 API 呼び出し (案 B)
- ✅ Web/Mobile 両方 v1 同時、workspace package 戦略
- ✅ 中断リカバリ: 最初から再開
- ✅ Analytics 計測: 最初から仕込む (10 event 種類)

---

## 2. 残不確実性 (Phase 1 開始までに堀さん確認)

### 2.1 デザイン決定

#### Q1. tutorial_complete バッジのアイコンデザイン
- **選択肢 A**: 🎓 絵文字 (フォールバック、v1 これで OK) ← 推奨
- **選択肢 B**: 専用 SVG icon (v1 で発注、デザイナーアサイン必要)
- **影響**: v1 リリーススケジュール、A なら遅延なし

#### Q2. Step 0 のキャッチコピー文言確定
- 現状案: "3 つの便利機能を一緒に試してみましょう (約 90 秒)"
- 代替案 1: "3 つの機能を試して、homegohan を使いこなしましょう"
- 代替案 2: "{nickname} さんに合った機能を 90 秒で体験"
- **影響**: ハンズオン開始率に直結

#### Q3. スキップ後の再開 UI 位置
- 現状案: `/settings` の「使い方ガイドをもう一度見る」項目
- 代替案: profile タブ内、または home の右上アイコン
- **影響**: 再開到達率

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

#### Q7. `user_profiles.target_kcal_per_day` カラムの存在
- operator/01-data-model 確認が必要
- 存在しない場合は計算 helper 関数を新規実装
- **影響**: Step 1 の "目標 kcal の X%" 表示

#### Q8. Analytics 配信先 (PostHog or Mixpanel)
- operator/07 で確定が必要
- 既存の analytics 基盤がない場合、v1 で導入決定
- **影響**: SDK 選定、コスト

#### Q9. Mobile 版 V4GenerateModal の実装場所
- researcher: web 中心の確認、mobile は未確認
- 存在しない場合: web 流用 or mobile 新規実装
- **影響**: §03/§13 の sandbox prop 仕様、Phase 3B 工数

#### Q10. Mobile 版 BadgesPage の実装場所
- 同上
- **影響**: Phase 3B

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

堀さんから以下の回答を得てから Phase 1 着手:

- [ ] Q1: バッジアイコン (🎓 絵文字 OK か / 専用 SVG 発注か)
- [ ] Q2: Step 0 キャッチコピー確定
- [ ] Q3: スキップ後再開 UI 位置 (`/settings` で OK か)
- [ ] Q7: target_kcal_per_day カラム or 計算式
- [ ] Q8: Analytics 配信先 (PostHog / Mixpanel / その他)
- [ ] Q9: Mobile V4GenerateModal の存在確認
- [ ] Q10: Mobile BadgesPage の存在確認
- [ ] Q16: アプリストア審査の事前確認 (sandbox 行で実バッジ付与の合法性)

これら 8 項目で Phase 1 着手判断。

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

---

## 8. 関連参照

設計書全体ナビゲーション: [README.md](./README.md)

各章で個別に提起された残不確実性は、本ファイルに集約された (各ファイル末尾の §X 残不確実性 を参照)。

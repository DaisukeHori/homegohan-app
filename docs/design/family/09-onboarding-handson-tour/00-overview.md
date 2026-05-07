# 00 — 概要 / 目的 / KPI

> 関連: [README](./README.md) / [01-trigger-flow](./01-trigger-flow.md)

---

## 1. 課題 (As-Is)

### 1.1 現状フロー
新規ユーザーは `/auth/signup` → メール確認 → `/onboarding/welcome` → `/onboarding/questions` (30 問) → `/onboarding/complete` → `/home` まで遷移する。`/home` 到達時点で:

- 食事の写真追加機能の存在を知らない (画面下部の +FAB は気付かれづらい)
- 週間献立 AI 生成は左サイドバー or 別タブにあり、初回ホームから視界に入らない
- バッジ機能は profile タブ深部、初回起動時には触らない

結果として:
- 7 日継続率が新規登録者の **40%** 推定 (目標は 70%)
- 7 日以内に `meal_logs` を 1 件以上追加するアクティベーション率が **60%** 推定
- 14 日以内にバッジを 1 つでも獲得する率が **35%** 推定

### 1.2 仮説
「最初の 90 秒で 3 つの主要機能を **実際に触らせる**」ことで、機能認知 → 試行 → バッジ獲得 → 継続の好循環に乗せる。

教科書的な onboarding tour (機能紹介スライド) ではなく、**ハンズオン形式 (実際に画面の指示に従って画面ぽちぽち)** にすることで習得率を高める。

---

## 2. To-Be (本機能の解像度)

### 2.1 タッチポイント
- onboarding/complete API レスポンスで `next_route: '/handson-tour'` を返却
- /home マウント時にも検証フォールバック (直リンク / アプリ再起動経由)
- /settings に「使い方ガイドをもう一度見る」エントリ (= 後日再開)

### 2.2 体験ストーリー (90 秒)

```
00:00  Step 0 ウェルカム「{nickname} さん、ようこそ!」
       ─ 【はじめる】タップ
00:08  Step 1 写真からの食事追加 (サンドボックス)
       ─ 唐揚げ定食写真が自動選択済
       ─ 「写真 1 枚で記録できます」吹き出し
       ─ 【保存】タップ
       ─ first_bite バッジ実際に獲得 ⭐
00:38  Step 2 AI で献立を作る (サンドボックス)
       ─ 「明日の夜だけ」「簡単メニュー」プリセット済
       ─ 【生成する】タップ
       ─ 豚肉と野菜の生姜焼きが提案
       ─ 【献立に追加】タップ
       ─ planner バッジ実際に獲得 ⭐
01:08  Step 3 バッジ確認
       ─ 「もう 2 つ獲得しています!」
       ─ 14 種のバッジ一覧 (3 つ目は半透明)
       ─ 【次へ】
01:22  Step 4 卒業
       ─ 🎓 「卒業おめでとう!」
       ─ tutorial_complete バッジ実際に獲得 ⭐
       ─ 【ホームへ】
01:30  Step 5 通常ホーム + welcome toast 4 秒
```

合計 **3 つのバッジを実獲得**、機能認知だけでなく「使えた」体験を提供。

---

## 3. KPI

### 3.1 KPI ツリー

```
継続率 (7日 / 14日)
├── ハンズオン到達率 (= onboarding 完了到達者 / signup 完了)
│   └── 目標: 95% (auto-trigger 確実、ロール除外 5% 前後)
├── ハンズオン開始率 (= 【はじめる】タップ / 表示)
│   └── 目標: 95% (= スキップ率 5% 以下)
├── ハンズオン完了率 (= 【ホームへ】タップ / 開始)
│   └── 目標: 80% (各ステップ離脱率を 5% 以下に維持)
├── ハンズオン平均完走時間
│   └── 目標: < 90 秒 (95 percentile < 150 秒)
└── 完了 vs スキップ群の継続率差
    └── 目標: 7 日 +15pp、14 日 +10pp
```

### 3.2 副次 KPI
- ハンズオン中の **エラー率** (mock 失敗、卒業 API 失敗) < 1%
- ハンズオン Step 4 卒業 API レイテンシ p95 < 500ms
- ハンズオン経験者の 14 日以内バッジ獲得率 > 90% (現状 35%)

### 3.3 KPI 計測ツール
- Analytics events (§22-analytics.md): PostHog or Mixpanel 経由
- サーバー側集計 SQL (§22 KPI 集計クエリ例): audit_logs join meal_logs

### 3.4 KPI 監視 (§19, §20 連携)
- §19-rollout §6 KPI モニタリング: Looker Studio / Metabase ダッシュボード
- §20-observability §8 アラート: 完了率 < 60% で Slack #app-alerts 通知

---

## 4. 非目標 (v1 でやらないこと)

明示的にスコープアウト:

| 非目標 | 理由 | 後続検討 |
|---|---|---|
| 中断後の途中再開 | ロジック複雑化の割に効果薄、v2 で計測後判定 | v2 |
| A/B テスト枠 (Step 順序やキャッチコピー比較) | 計測整備優先、まずは固定 UX で改善幅を確認 | v2 |
| 英語版 (i18n 完全対応) | キー設計は最初から含むが、ja のみ実装 | v2 |
| ペアレント別チュートリアル (家族プランで親子内容変更) | 家族機能の usage 確認後判断 | v3 |
| ハンズオン中の sandbox 行を削除する API | sandbox 行は内部 admin 削除運用、ユーザー操作不要 | 永久 不要 |
| 既存ユーザー (= meal_logs 既保有) への遡及表示 | 安全弁で auto-skip、後日変更したくなったら手動再表示で対応 | v2 |

---

## 5. ペルソナ別 体験差分

### 5.1 標準ペルソナ A (一般家庭主婦、25-45 歳)
- onboarding 30 問完走
- ハンズオン 1.5 分でクリア
- バッジ 3 個獲得、ホームに welcome toast → 翌日も起動

### 5.2 ペルソナ B (時短重視、忙しい平日)
- onboarding 序盤でスキップ (allergies / dislikes 全て allowSkip 選択)
- ハンズオン Step 0 で【あとで】タップ
- 後日 /settings から再開 → 90 秒で完了

### 5.3 ペルソナ C (高齢ユーザー、60+ 歳)
- onboarding 完走に 30 分以上 (Dynamic Type 大、操作慣れ)
- ハンズオン: VoiceOver / Dynamic Type +200% でも崩れない
- 完了に 4-5 分かかるが、最後まで達成 (アクセシビリティ対応必須)

### 5.4 ペルソナ D (admin / org_admin / industrial_doctor 等)
- ロール ベースで auto-skip
- /home 直接表示、ハンズオン UI に出会わない

### 5.5 ペルソナ E (既存ユーザーの再ログイン)
- meal_logs に過去の non-sandbox 行あり
- condition C で auto-skip
- /handson-tour に直リンクしても /home へリダイレクト

ペルソナごとの動線を §11-testing.md で全て E2E でカバーする。

---

## 6. 関連設計書 (canonical 経由参照)

本機能の実装には以下の設計書への追記が必要:

- `docs/design/operator/01-data-model.md`: user_profiles 拡張、badges seed 追加、meal_logs/weekly_menus に is_sandbox 追加
- `docs/design/family/02-api-spec.md`: 新規 API 4 本仕様
- `docs/design/family/03-ui-spec.md`: ハンズオン画面群の追加
- `docs/design/cross/03-design-system.md`: Coachmark コンポーネント仕様
- `docs/design/cross/05-i18n-a11y.md`: tour 章追加
- `docs/design/cross/09-testing.md`: 概念のみ、具体は本ディレクトリ §11
- `docs/design/operator/07-audit-monitoring.md`: analytics events 追加
- `docs/design/mobile/01-architecture.md`: ハンズオン routing

これらへの追記は **Phase 1 開始前に Opus が canonical 整合性として一括で行う** (memory: feedback-design-doc-direct)。

---

## 7. 用語集

| 用語 | 定義 |
|---|---|
| **ハンズオン** | 画面の指示に従って実際に操作する形式のチュートリアル |
| **サンドボックス** | 実 API を呼ばず固定 mock で完結する隔離モード (※ 本設計では一部実 API も呼ぶハイブリッド) |
| **ハイブリッドサンドボックス** | mock 中心だが、バッジ実獲得のために実 API を選択的に呼ぶ方式 (案 B 採用) |
| **コーチマーク (Coachmark)** | 既存 UI 要素を Spotlight + 吹き出しで案内する UI パターン |
| **Spotlight** | 画面全体を dim させ、特定要素の周辺だけ明るくする視覚効果 |
| **case A** (旧案、却下) | サンドボックス完全 mock、バッジは Step 4 でまとめて付与 |
| **case B** (採用) | Step 1/2 で実 API を sandbox=true で呼んで実際にバッジ付与、Step 4 で tutorial_complete も実付与 |
| **canonical 単一ソース原則** | DDL や enum など同じ情報を 2 箇所に書かない、1 ファイルに集約する原則 (memory: feedback-design-canonical-source) |
| **modular monolith** | モノレポ内で機能領域ごとにモジュールを分け、並列開発・並列デプロイを可能にする構造 (memory: feedback-modular-monolith-parallel) |

# family/09 — 初回ハンズオンチュートリアル 詳細設計 (分割版)

> 範囲: 初回オンボーディング完了直後に表示する **使い方ハンズオンガイド** の詳細設計。
>
> 対象機能: ① 写真からの食事追加 / ② AI による献立追加 / ③ バッジ獲得確認 → 卒業バッジ。
>
> 設計方針: ダミーデータでぽちぽち体験させる "サンドボックス" 形式。ただしユーザー固有の個人情報 (ニックネーム / 体重 / 栄養目標) は実プロフィールから読んで吹き出しに反映する。
>
> Web/Mobile 両方 v1 同時リリース。workspace package で型・mock・i18n キー・analytics 定義を共通化。Overlay UI は技術スタック差から別実装。

## ナビゲーション (並列開発単位)

設計書はファイル単位で並列開発できるよう **意図的に分割** されている。各ファイルは独立した PR として実装可能 (`§12-phases.md` の Phase 計画を参照)。

### コア (機能要件)
| ファイル | 内容 | 主担当 PR |
|---|---|---|
| [`00-overview.md`](./00-overview.md) | 目的・背景・KPI 目標 | (設計書のみ、コード変更なし) |
| [`01-trigger-flow.md`](./01-trigger-flow.md) | 表示トリガー条件 + 全体フロー (mermaid) + ロール除外 | API: `/api/handson-tour/status` / 既存 onboarding 完了 hook |
| [`02-step0-welcome.md`](./02-step0-welcome.md) | Step 0 ウェルカム画面詳細 | UI: `<TourStep0Welcome>` (web/mobile) |
| [`03-step1-photo.md`](./03-step1-photo.md) | Step 1 写真追加 サンドボックス詳細 | UI: meals/new mode='sandbox' / API: `?source=handson_tour&sandbox=true` |
| [`04-step2-menu.md`](./04-step2-menu.md) | Step 2 AI 献立追加 サンドボックス詳細 | UI: V4GenerateModal mode='sandbox' / API: 同上 |
| [`05-step3-badges.md`](./05-step3-badges.md) | Step 3 バッジ確認 サンドボックス詳細 | UI: badges?tutorial-mode=1 |
| [`06-step4-graduation.md`](./06-step4-graduation.md) | Step 4 卒業画面 + tutorial_complete 付与 | UI: `<TourStep4Graduation>` / API: `/api/handson-tour/complete` |

### 横断 (実装規約)
| ファイル | 内容 | 主担当 PR |
|---|---|---|
| [`07-components.md`](./07-components.md) | UI コンポーネント Props 完全 schema (TypeScript) + ライフサイクル | UI: `<TourOverlay>` / `<TourBubble>` / `<TourProgress>` / `<TourSandboxWrapper>` |
| [`08-state-db.md`](./08-state-db.md) | DB スキーマ拡張 + 状態遷移図 + 競合解決 + リカバリ | DB: migration 1 ファイル / RLS 影響 |
| [`09-api-spec.md`](./09-api-spec.md) | API 4 本の Zod schema + サーバー擬似コード + Rate Limit | API 実装 |
| [`10-a11y.md`](./10-a11y.md) | ARIA / AccessibilityInfo / VoiceOver アナウンス文 / コントラスト | a11y 層実装 |
| [`11-testing.md`](./11-testing.md) | E2E (Maestro YAML / Playwright spec) + Unit + Integration | tester 主担当 |
| [`12-phases.md`](./12-phases.md) | Phase 1-5 実装計画 (タスク表 / 担当 / 並列度) | プロジェクト管理 |
| [`13-integration.md`](./13-integration.md) | 既存実装との接続点 (画面別) | 各実装 PR で参照 |

### データ・仕様
| ファイル | 内容 | 主担当 PR |
|---|---|---|
| [`14-mocks-i18n.md`](./14-mocks-i18n.md) | mock データ完全定義 + i18n キー全リスト + 文言マスタ (ja v1) | shared package |
| [`15-design-tokens.md`](./15-design-tokens.md) | 色 / typography / 寸法 / アニメ仕様 (cross/03 連携) | デザインシステム連携 |
| [`16-files-structure.md`](./16-files-structure.md) | 新規ファイル一覧 + 既存変更箇所 + 想定行数 + PR 分割戦略 | プロジェクト管理 |

### 運用・品質
| ファイル | 内容 | 主担当 PR |
|---|---|---|
| [`17-security.md`](./17-security.md) | sandbox 偽装防止 / 中断時整合性 / CSRF / RLS 影響 | API 層実装 |
| [`18-performance.md`](./18-performance.md) | レイテンシ目標 / 画像 preload / bundle 影響 | UI 実装 |
| [`19-rollout.md`](./19-rollout.md) | Feature flag / Canary / 段階公開 / ロールバック | DevOps |
| [`20-observability.md`](./20-observability.md) | ロギング / クラッシュレポート / Slack alert | observability |

### 完全成果物
| ファイル | 内容 | 主担当 PR |
|---|---|---|
| [`21-migration-sql.md`](./21-migration-sql.md) | Migration SQL 完全形 (commit-ready) + ロールバック SQL + RLS 検証 | DB PR |
| [`22-analytics.md`](./22-analytics.md) | Analytics events 完全 Zod schema + KPI 集計 SQL + 配信先 | analytics PR |

### 質問事項
| ファイル | 内容 |
|---|---|
| [`99-open-questions.md`](./99-open-questions.md) | 残不確実性チェックリスト + ロックステップ予想 |

---

## 並列開発の前提

### 共通参照 (canonical)
- DDL: `docs/design/operator/01-data-model.md` 単一ソース。本ディレクトリの DDL は **proposal** であり、実装時は operator/01 に追記してから commit。
- API 仕様 (canonical 詳細): `docs/design/family/02-api-spec.md` に追記、本ディレクトリの 09-api-spec.md は family/09 領域の **詳細補助**。
- UI 仕様 (canonical 一覧): `docs/design/family/03-ui-spec.md` に画面群追加、本ディレクトリの Step 詳細はその実装ガイド。
- デザインシステム: `docs/design/cross/03-design-system.md` に Coachmark 追加、本ディレクトリの 15-design-tokens.md は具体値。
- a11y: `docs/design/cross/05-i18n-a11y.md` に tour 章追加。
- analytics: `docs/design/operator/07-audit-monitoring.md` に events 追加。

### 並列実装で衝突しないための原則

1. **DDL は 1 PR に集約** (Phase 1 で 1 名が operator/01 + migration を担当)
2. **共通 package は 1 PR で構築** (Phase 1 後半、UI 実装の前提)
3. **UI 実装は web / mobile を別 PR**、共通 package import 経由でのみ繋がる
4. **既存画面 (meals/new, V4GenerateModal, /badges) の sandbox 対応は web/mobile 別 PR**
5. **テストは Phase 5 で 1 PR にまとめる** (Maestro + Playwright)

### 各ファイル単位での実装責任

各設計書ファイルが **1 つ以上の PR** に対応する設計。implementer は対応ファイルを読めば該当 PR を完成させられる。Opus は整合性を維持し、ファイル間の参照リンクが切れていないかを定期検証する。

---

## 改訂履歴

- 2026-05-07 v0: 概要 draft
- 2026-05-07 v1: 5 確定事項反映 (唐揚げ写真 / 案 B / 両 OS / 最初から / 計測あり) + Web/Mobile 技術差章
- 2026-05-07 v2: 詳細設計に格上げ (~1500 行)
- 2026-05-07 v3 (本版): **ファイル分割 + 詳細化**。25 ファイル構成、各ファイル単位で並列開発可。総量 v2 の ~10 倍規模に拡張予定。

---

## v3 完成定義 (DOD)

以下すべてが揃って v3 確定とする:

- [ ] 25 ファイル全部記述
- [ ] §99 残不確実性が 5 件以下に収束 (堀さん確認後)
- [ ] canonical ファイル (operator/01, family/02-03, cross/03/05/09, mobile/01, operator/07) への追記完了
- [ ] 引き継ぎ書 (`/Users/horidaisuke/handover-pr798.md`) に「ハンズオン開発」項目追加、新スレッドで AI エージェントが自動着手可能な状態

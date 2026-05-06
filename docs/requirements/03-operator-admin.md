# ほめゴハン運営者管理 要件定義書

**ドキュメントバージョン**: 1.0
**最終更新**: 2026-05-06
**作成者**: Opus (Claude)
**ステータス**: ドラフト (レビュー待ち)
**関連ドキュメント**: `01-family-management.md`, `02-organization-management.md`

---

## 1. エグゼクティブサマリー

### 1.1 背景と目的

ほめゴハンの運営事業者 (= 開発・運営会社) が、サービス全体を管理・モニタリング・最適化するための **内部向け管理コンソール**。本書のスコープは「運営者向け」であり、エンドユーザーや法人契約管理者は対象外 (それぞれ別ドキュメント)。

具体的には:
- ユーザー管理 (検索・BAN・サポート)
- 組織契約管理 (営業フロー・契約管理)
- コンテンツモデレーション (不適切食事・レシピ・AI出力)
- システム運用 (LLM 使用量・機能フラグ・DB 統計)
- 売上・MRR 分析
- 監査・コンプライアンス
- カスタマーサポート (問い合わせ対応・チケット管理)
- インフラ運用 (Edge Function 状況・Vercel 監視)

### 1.2 想定する利用者

| ロール | 役職例 | 主な業務 |
|--------|--------|---------|
| **super_admin** | CTO / プロダクトオーナー | 全権限、システム設定、ロール付与 |
| **admin** | 運営マネージャー | 日常運営、モデレーション、組織管理 |
| **support** | カスタマーサポート | 問い合わせ対応、ユーザー BAN 提案 |
| **sales** | 営業担当 (新ロール) | 法人契約フロー、見込み客管理 |
| **finance** | 経理 (新ロール) | 請求・支払・売上管理 |
| **content_moderator** | モデレーター (新ロール) | 不適切コンテンツの審査 |

### 1.3 ビジネス価値

- **運営効率化**: 1 人で 10,000 ユーザーを管理可能にする
- **品質維持**: モデレーション体制でコンテンツ品質確保
- **コスト最適化**: LLM 使用量・インフラコストの可視化と削減
- **コンプライアンス**: 監査ログでガバナンス対応
- **スケーラビリティ**: 100 万ユーザー規模でも運用可能な設計

### 1.4 現状実装サマリ

| 領域 | 状態 |
|------|------|
| `/admin` 基本画面 (ユーザー管理 / モデレーション / 監査) | ✅ |
| `/super-admin` 画面 (LLM 統計 / 機能フラグ / DB 統計) | ✅ |
| `/support` 画面 (問い合わせ管理 / ユーザー詳細) | ✅ |
| ロール体系 (user / support / org_admin / admin / super_admin) | ✅ |
| 監査ログ (`admin_audit_logs`) | ✅ (一部のみ) |
| 売上 / MRR ダッシュボード | **未実装** |
| サポートチケット (返信スレッド) | **未実装** |
| Push / Email 通知送信 | **未実装** |
| A/B テスト・セグメント | **未実装** |
| インフラ監視ダッシュボード | **未実装** |
| 不正検知 (BOT / 不正利用) | **未実装** |
| データエクスポート (BigQuery 連携 等) | **未実装** |
| sales / finance / content_moderator ロール | **未実装** |

### 1.5 スコープ

#### 含む
- 既存 `/admin` `/super-admin` `/support` の機能完成
- 売上・MRR ダッシュボード
- サポートチケット (返信スレッド)
- 通知配信 (Push / Email)
- 不正検知・BAN 自動化
- インフラ監視 (Vercel / Supabase / LLM API 統合)
- 営業向け CRM 軽量機能 (見込み客 / 契約進捗)
- 経理向け売上管理
- A/B テスト基盤
- 監査ログ完全網羅

#### 含まない
- 高度な BI ツール (Looker / Tableau 連携、別途検討)
- 自動運用 (Auto-scaling 設定、Vercel が担当)
- 法務管理 (契約書管理、別 SaaS 利用前提)
- 給与計算 (運営側従業員管理は別 HR システム)

---

## 2. 用語定義

| 用語 | 定義 |
|------|------|
| **運営者 (Operator)** | ほめゴハンの開発・運営会社のスタッフ。super_admin / admin / support / sales / finance / content_moderator のロールを持つ |
| **管理コンソール** | `/admin`, `/super-admin`, `/support` を含む運営者向け Web UI 全体 |
| **アクション (Action)** | 運営者が行う操作 (ユーザー BAN / プラン変更 / 機能フラグ更新 等) |
| **監査ログ** | 全アクションを永続記録する不可逆ログ |
| **モデレーション** | 不適切コンテンツ (食事写真・レシピ・AI 出力) の審査と対処 |
| **チケット** | ユーザーからの問い合わせをスレッド形式で管理する単位 |
| **MRR (Monthly Recurring Revenue)** | 月次経常収益。法人プラン契約から算出 |
| **コホート** | 特定期間に登録したユーザー群 (例: 2026-04 登録者) |
| **機能フラグ** | コードで if 分岐する条件で機能を ON/OFF (`feature_flags`) |
| **LLM コスト** | OpenAI / xAI / Gemini への支払い API 料金 |
| **不正利用 (Abuse)** | スパム投稿・大量登録・規約違反等 |
| **クォータ** | 各ユーザーの API 利用上限 (LLM 呼び出し回数等) |

---

## 3. ペルソナ

### 3.1 ペルソナ A: 田中 大輔 (38 歳、CTO、super_admin)

**プロフィール**
- 役職: CTO 兼開発責任者
- 業務: プロダクト全体の開発・運営・経営判断
- IT リテラシー: 最高
- 課題: 1 日中の運営オペレーションでコードを書く時間が無い

**主要ニーズ**
- LLM コストが急増した日に即座に原因特定 (どのユーザー / どの機能)
- 機能フラグで A/B テストを迅速に展開・撤回
- 売上 / MRR / 解約率を毎日ダッシュボードでチェック
- セキュリティインシデント発生時に admin 全員に即通知
- DB スキーマ変更前のデータ確認・バックアップ確認

**主要ジャーニー**
1. 朝、`/super-admin` ダッシュボードを開く → 昨日の KPI チェック
2. 「LLM コスト 前日比 +30%」アラート → 原因調査画面 → 異常ユーザー特定
3. 該当ユーザーをクォータ制限へ
4. 機能フラグ「new_meal_ai_v2」を 5% から 25% へ拡大
5. 監査ログを確認 → 全 admin の昨日の操作を一覧

### 3.2 ペルソナ B: 山田 由香 (32 歳、運営マネージャー、admin)

**プロフィール**
- 役職: カスタマーオペレーション・マネージャー
- 業務: 日常運営、ユーザーサポート統括、モデレーション統括
- IT リテラシー: 中-高

**主要ニーズ**
- 毎日 30 件のモデレーション (不適切食事・レシピ) を効率的に処理
- ユーザー BAN を判断 (規約違反度合いに応じて)
- カスタマーサポートのチケット進捗管理
- 月末に支援組織の請求書発行確認

**主要ジャーニー**
1. 朝、`/admin/moderation` でフラグ一覧
2. 1 件ずつ確認 (画像 + 投稿者履歴) → OK / 削除 / BAN を判断
3. `/admin/inquiries` で未対応チケット 5 件 → support チームに割当
4. 月次組織レポートを役員に共有

### 3.3 ペルソナ C: 佐藤 健 (28 歳、カスタマーサポート、support)

**プロフィール**
- 役職: カスタマーサポート担当
- 業務: ユーザー問い合わせ対応 (1 日 50 件)
- IT リテラシー: 中

**主要ニーズ**
- ユーザー検索で即座にユーザー詳細表示
- 過去問い合わせ履歴を確認しつつ返信
- 食事記録の不具合 (画像認識失敗) の原因確認
- BAN は提案するが実行は admin 待ち

**主要ジャーニー**
1. 朝、新規問い合わせ 20 件をチェック
2. 「画像認識が動かない」ユーザーの詳細画面 → 食事記録一覧
3. 該当画像を確認 → 解析ログを参照 → 「Gemini API timeout」を確認
4. ユーザーに「再撮影をお試しください」回答
5. 解決後にチケット close

### 3.4 ペルソナ D: 鈴木 雄一 (40 歳、営業マネージャー、sales)

**プロフィール**
- 役職: 法人営業
- 業務: B2B 営業 (健保・大企業)
- IT リテラシー: 中

**主要ニーズ**
- 見込み客リスト管理 (Salesforce 風)
- 商談進捗 (アプローチ → デモ → 提案 → 契約)
- パイロット運用の効果データを営業資料として出力
- 契約後はカスタマーサクセスに引き継ぎ

**主要ジャーニー**
1. `/admin/sales/leads` で見込み客一覧
2. 商談予定の企業に訪問前準備 (過去メール + パイロットデータ)
3. 契約締結 → ステージを「契約済」に変更 → 自動で経理に通知
4. パイロット組織の効果データを PDF 出力 → 提案資料に活用

### 3.5 ペルソナ E: 田中 美穂 (35 歳、経理担当、finance)

**プロフィール**
- 役職: 経理・財務
- 業務: 売上計上、請求書発行、未払い管理
- IT リテラシー: 中

**主要ニーズ**
- 月末に全組織の請求書を一括生成
- 未払い組織の自動アラート
- 売上推移を MRR / ARR / 解約率で把握
- Stripe 売上データと内部 DB を照合

**主要ジャーニー**
1. 月末日に `/admin/finance/invoices` → 「全組織分一括生成」
2. PDF 確認 → 1 件問題あり (プラン変更途中) → 個別調整
3. Stripe 連携 → 自動送信
4. 翌月初に未払い 3 件 → 督促メール送信

---

## 4. ユースケース

### 4.1 UC-OP-01: ユーザー検索と詳細表示

**フロー**:
1. `/admin/users` を開く
2. 検索 (Email / 名前 / ユーザー ID / 電話番号)
3. 検索結果から 1 件選択 → 詳細画面
4. 表示内容:
   - 基本情報 (Email、登録日、最終ログイン、プラン)
   - ロール一覧
   - 食事記録統計 (件数、最終記録日、画像認識成功率)
   - AI セッション数
   - 問い合わせ履歴
   - 管理ノート
   - BAN 履歴
   - 監査ログ (このユーザーに対するアクション)

### 4.2 UC-OP-02: ユーザー BAN

**フロー**:
1. ユーザー詳細画面 → 「BAN」ボタン
2. 確認モーダル:
   - 理由 (規約違反 / スパム / 不正利用 / その他)
   - BAN 種別 (一時 / 永久)
   - 期間 (一時 BAN の場合: 1 日 / 7 日 / 30 日)
   - 通知メッセージ (ユーザーに送る理由説明、編集可)
3. 確定 → API `POST /api/admin/users/{id}/ban`
4. 監査ログ記録 + ユーザーに Email 通知
5. ユーザーログイン時に「アカウントが BAN されています」表示

### 4.3 UC-OP-03: モデレーション処理 (食事画像)

**フロー**:
1. `/admin/moderation` の「食事フラグ」タブ
2. フラグ一覧 (フラグタイプ / 投稿者 / 画像 / 報告者 / 報告日)
3. 1 件選択 → 詳細表示 (画像 + 投稿コメント + 投稿者過去履歴)
4. 判断:
   - **承認 (false positive)**: フラグ解除、投稿継続
   - **削除のみ**: 画像削除、投稿者には警告通知
   - **削除 + 一時 BAN**: 規約違反度に応じて BAN
   - **削除 + 永久 BAN**: 重大違反時
5. 解決理由を入力 → 確定
6. 監査ログ記録 + 報告者に「処理完了」通知

### 4.4 UC-OP-04: AI コンテンツモデレーション

**フロー**:
1. `/admin/moderation/ai-content` を開く
2. AI が生成した不適切コンテンツのフラグ一覧
3. 例: AI Advisor が誤った医療アドバイスをした、AI 献立に毒性のある食材が混入
4. レビュー → プロンプト修正、ブロックリスト追加、 system prompt 更新
5. 修正後に該当ユーザーに「お詫びと正しい情報」通知

### 4.5 UC-OP-05: 機能フラグ管理

**フロー**:
1. `/super-admin/feature-flags` を開く
2. 機能フラグ一覧 (`new_meal_ai_v2`, `family_groups_enabled`, `experimental_chat_streaming` 等)
3. 各フラグ:
   - 説明
   - 有効化対象 (全ユーザー / 割合 / 特定ユーザー / 特定組織)
   - 現在の有効率
4. 編集 → 「5% から 25% へ拡大」
5. 確定 → API `PUT /api/super-admin/feature-flags`
6. 監査ログ記録、即座に反映
7. メトリクス監視 (有効化後のエラー率上昇等を自動検知)

### 4.6 UC-OP-06: LLM 使用量分析

**フロー**:
1. `/super-admin/llm-usage` を開く
2. 期間選択 (今日 / 7 日 / 30 日 / カスタム)
3. ダッシュボード:
   - 総コスト (USD / JPY)
   - モデル別内訳 (Gemini Flash Lite / Gemini Image / xAI Grok / OpenAI / Claude)
   - 機能別内訳 (analyze-meal / classify-photo / ai-consultation / generate-week-menu 等)
   - ユーザー別 Top 50 (異常検知用)
   - 時系列推移 (時間別)
4. 異常検知:
   - 1 ユーザーが 1 日 1,000 リクエスト超 → アラート
   - モデル別コストが前日比 +50% → アラート
5. クォータ設定:
   - フリープランは 1 日 50 回まで
   - プレミアムは 1 日 500 回
   - 法人は組織単位で設定

### 4.7 UC-OP-07: 売上ダッシュボード

**フロー**:
1. `/admin/finance/dashboard` を開く
2. KPI カード:
   - 今月の売上 (リアルタイム集計)
   - MRR (Monthly Recurring Revenue)
   - ARR (Annual Recurring Revenue)
   - 解約率 (Churn Rate)
   - LTV (Customer Lifetime Value)
   - CAC (Customer Acquisition Cost)
3. グラフ:
   - 月次売上推移
   - プラン別内訳 (個人 vs 法人)
   - コホート分析 (登録月別の継続率)
4. 法人契約一覧:
   - 契約中 / 契約準備中 / 解約済
   - 各組織の契約金額 + 次回更新日

### 4.8 UC-OP-08: サポートチケット

**フロー**:
1. `/support/tickets` でチケット一覧
2. ステータス: Open / In Progress / Resolved / Closed
3. 1 件選択 → スレッド表示
4. メッセージ送信 (テンプレート選択可)
5. 内部メモ (ユーザーには見えない、support 同士)
6. ユーザー詳細画面と連動 (チケット内で「ユーザーの食事記録を見る」リンク)
7. 解決後 → 「Resolved」 → ユーザーに Email 自動送信
8. 担当者割り当て (チケットを「自分」「○○さん」に)

### 4.9 UC-OP-09: 通知配信

**フロー**:
1. `/admin/notifications/campaigns` で通知キャンペーン管理
2. 「新規キャンペーン」 → ターゲット指定:
   - 全ユーザー
   - フィルタ (プラン / 登録月 / 最終ログイン日 / 食事記録なし期間 等)
   - CSV アップロードで個別指定
3. メッセージ作成:
   - Push 通知 (タイトル + 本文 + ディープリンク)
   - Email (件名 + HTML 本文)
   - アプリ内通知
4. プレビュー → A/B テスト設定 (任意)
5. 配信予約 (即時 / スケジュール)
6. 配信後: 開封率、クリック率、コンバージョン率を計測

### 4.10 UC-OP-10: 不正検知・自動 BAN

**フロー**:
1. ルール作成: `/super-admin/abuse-rules`
2. 例:
   - 「24 時間で 1,000 食事記録 → 一時 BAN (BOT 疑い)」
   - 「同じ画像を 100 回投稿 → 削除 + 警告」
   - 「1 IP から 10 アカウント登録 → 全 BAN」
3. 自動実行: バッチジョブ (5 分毎)
4. 検知時:
   - admin に通知
   - 自動 BAN (設定によりレベル分け)
5. 手動レビュー UI: `/admin/abuse/queue`

### 4.11 UC-OP-11: インフラ監視

**フロー**:
1. `/super-admin/infra` で統合ダッシュボード
2. 表示内容:
   - Vercel 関数の実行時間 (p50 / p95 / p99)
   - Vercel エラー率
   - Supabase Edge Function ステータス
   - Supabase DB 接続数 / クエリ時間
   - LLM API レスポンス時間
   - キャッシュヒット率
3. アラート: しきい値超過で Slack / Email
4. インシデント記録: 過去のインシデントと対応履歴

### 4.12 UC-OP-12: 監査ログ閲覧

**フロー**:
1. `/admin/audit-logs` で全ログ
2. フィルタ:
   - アクション種別 (BAN / role_change / setting_change 等)
   - 担当者 (admin)
   - 対象 (ユーザー / 組織)
   - 期間
3. 詳細展開: JSON で詳細表示
4. CSV エクスポート (法務対応)

### 4.13 UC-OP-13: ロール付与・剥奪

**フロー**:
1. `/super-admin/admins` で全管理者一覧
2. 「ロール変更」ボタン → モーダル
3. 付与可能ロール:
   - super_admin (super_admin のみ付与可)
   - admin (admin / super_admin)
   - support, sales, finance, content_moderator (admin / super_admin)
4. パスワード再認証必須
5. 監査ログ + 対象者に Email 通知

### 4.14 UC-OP-14: 営業 / CRM 機能

**フロー** (sales):
1. `/admin/sales/leads` で見込み客リスト
2. 「新規」 → 企業情報入力 (会社名、業種、従業員数、担当者、電話、メール)
3. ステージ管理: アプローチ → 商談 → 提案 → 契約
4. 商談メモ (時系列)
5. 提案書 PDF 自動生成 (パイロット効果データを反映)
6. 契約締結 → 組織レコード作成 (運営作業)

### 4.15 UC-OP-15: A/B テスト

**フロー**:
1. `/super-admin/experiments` で実験管理
2. 「新規実験」:
   - 名前: `new_chat_ui_2026_05`
   - 仮説: 新 UI でメッセージ送信率 +20%
   - バリアント: A (現行) / B (新)
   - 配分: 50/50
   - 期間: 14 日
   - 主要メトリクス: メッセージ送信数 / 滞在時間
3. 実行中: 統計的有意性をリアルタイム計算
4. 結果分析: 
   - p 値、信頼区間
   - サブグループ別 (年代 / プラン)
5. 採用 / 却下を決定

### 4.16 UC-OP-16: プラン定義・販売プラン管理 (新規)

**アクター**: super_admin
**目的**: ほめゴハンの全プラン (個人 / 家族 / 組織) を運営側で定義し、機能パッケージ・価格・有効期限・条件を一元管理する。

**フロー**:
1. `/super-admin/plans` を開く
2. 既存プラン一覧 (個人プラン / 家族プラン / 組織プラン)
3. 「新規プラン」を作成:
   - プラン key (例: `org_pro_2026`)
   - プラン名 (表示用、例: 「組織プロ 2026 春版」)
   - 種別 (個人 / 家族 / 組織)
   - 機能パッケージ (含まれる feature flag のセット)
   - 価格: 月額 / 年額
   - 期間: 最低契約期間、自動更新有無
   - 上限: メンバー数、家族メンバー数等
   - 条件: 業種限定、地域限定 (将来)
   - 公開ステータス (draft / public / private / deprecated)
4. プレビュー: 顧客に見える形で表示確認
5. 公開 → 個人ユーザー / 組織が選択可能に
6. 監査ログ + 価格変更履歴

### 4.17 UC-OP-17: 機能パッケージ管理

**フロー**:
1. `/super-admin/feature-packages` を開く
2. 機能パッケージ一覧:
   - 「基本機能」 (全プラン共通)
   - 「AI 解析」 (Pro 以上)
   - 「家族機能」 (家族プラン以上)
   - 「組織管理」 (組織プラン以上)
   - 「産業医連携」 (組織 Pro 以上)
   - 「カスタムカラー」 (組織 Pro 以上)
3. 各パッケージに含まれる feature flag を編集:
   - `family_groups_enabled`
   - `meal_photo_recognition`
   - `ai_consultation_streaming`
   - `org_dashboard_advanced`
   - 等
4. プランとパッケージの対応マトリクス:
```
              | Free | Pro | Family | Org Std | Org Pro | Org Ent |
基本機能      |  ✓   |  ✓  |   ✓    |    ✓    |    ✓    |    ✓    |
AI 解析       |      |  ✓  |   ✓    |    ✓    |    ✓    |    ✓    |
家族機能      |      |     |   ✓    |         |    ✓    |    ✓    |
組織管理      |      |     |        |    ✓    |    ✓    |    ✓    |
産業医連携    |      |     |        |         |    ✓    |    ✓    |
SSO           |      |     |        |         |         |    ✓    |
```
5. 一括変更 → 全プラン即反映

### 4.18 UC-OP-18: ライセンス販売管理 (運営側ビュー)

**フロー**:
1. `/admin/finance/licenses` で全組織のライセンス契約状況
2. 表示:
   - 組織別: プラン / 数量 / 有効期限 / 売上
   - 月別: 売上推移、解約数
   - 期限切れ予告: 30 / 14 / 7 日前のリスト
3. アクション:
   - 個別組織のライセンス詳細を確認
   - 期限延長・追加販売 (営業経由)
   - 強制終了 (未払い等)
4. レポート出力 (経理連携)

### 4.19 UC-OP-19: クーポン・割引管理 (新規)

**アクター**: super_admin / sales
**用途**: 法人営業時の割引、キャンペーン、紹介プログラム

**フロー**:
1. `/admin/coupons` で クーポン一覧
2. 「新規クーポン」:
   - コード (例: `ENTERPRISE2026`)
   - 種別: 固定額 / パーセント
   - 値: 10000 円 OFF / 20%
   - 適用対象: 個人 / 組織 / プラン指定
   - 利用上限: 1 回 / N 回 / 無制限
   - 有効期限
3. 営業先に共有 → 顧客が決済時に入力 → 自動適用
4. 利用統計レポート

**重複適用・遡及ルール**:
- **重複適用不可**: 1 つの契約 (`personal_subscriptions` または `org_license_pools`) に対し有効なクーポンは常に 1 つまで。新クーポン適用時は前のクーポンの効果を即座に終了 (`coupon_redemptions.ended_at` をセット)
- **既存契約への遡及適用は不可** (新規申込・更新タイミングのみ適用)。例外として super_admin が手動承認した場合のみ可 (`coupon_redemptions.applied_retroactively = TRUE` を記録、監査ログ必須)
- **試用期間との併用**: 試用期間中の契約には適用不可 (本契約開始時に自動適用)
- **同一ユーザーの上限**: `per_user_limit` で制御 (デフォルト 1 = 同じユーザーは 1 回のみ利用可能)

### 4.20 UC-OP-20: アップグレード分析

**フロー**:
1. `/admin/finance/upgrade-funnel` でファネル分析
2. Free → Pro 転換率
3. 個人 Pro → 家族プラン アップグレード率
4. 組織 Standard → Pro / Enterprise アップグレード率
5. 各ステップの離脱要因分析 (キャンセル理由集計)

### 4.21 UC-OP-21: 家族プラン同梱組織の管理

**フロー**:
1. `/admin/finance/family-addon-orgs` で組織別利用状況
2. 各組織の家族メンバー消費数
3. 「家族プラン同梱は ROI 高い」分析データ
4. 営業向け資料作成

---

## 5. 機能要件

### 5.1 F-OP-001: ユーザー管理

#### 5.1.1 検索
- 検索対象: Email / 名前 / ユーザー ID / 社員番号 / 電話番号
- 全文検索 (Postgres tsvector)
- フィルタ: プラン / ロール / 登録月 / 最終ログイン日 / 在籍状況 / BAN 状態
- ソート: 登録日 / 最終ログイン日 / 食事記録数 / プラン

#### 5.1.2 ユーザー詳細
- 基本情報セクション
- 食事記録統計
- AI 利用統計
- 健康スコアトレンド
- 問い合わせ履歴
- 管理ノート
- 監査ログ
- 関連組織 / 家族グループ
- BAN 履歴

#### 5.1.3 BAN 機能
- 一時 BAN (期間指定) / 永久 BAN
- 理由カテゴリ + 自由記述
- 自動 unBAN (期間切れ)
- BAN 中はログイン拒否、Push 通知配信停止
- BAN 解除も可

### 5.2 F-OP-002: モデレーション

#### 5.2.1 種類
- **食事フラグ** (`moderation_flags`): 不適切な食事画像
- **レシピフラグ** (`recipe_flags`): 不適切なレシピ
- **AI コンテンツフラグ** (`ai_content_logs`): AI が生成した問題コンテンツ
- **コメントフラグ** (将来): 食事コメント

#### 5.2.2 処理アクション
- 承認 (false positive)
- コンテンツ削除のみ
- 削除 + 警告
- 削除 + 一時 BAN
- 削除 + 永久 BAN
- エスカレーション (super_admin へ)

#### 5.2.3 統計
- フラグ件数推移
- 解決時間 (中央値)
- フラグ種別の比率
- 担当者別処理件数

#### 5.2.4 自動モデレーション
- 画像 NSFW 検出 (Gemini モデレーション API)
- テキスト hate speech 検出
- 自動フラグ → 人間レビューへ

### 5.3 F-OP-003: 監査ログ

#### 5.3.1 記録対象
**全ての admin 操作を記録**:
- ユーザー BAN / unBAN
- ロール変更
- 組織作成 / 削除 / プラン変更
- 機能フラグ更新
- システム設定変更
- お知らせ作成 / 削除
- モデレーション解決
- データエクスポート
- 通知キャンペーン送信
- 不正検知ルール変更

#### 5.3.2 記録項目
- `id`, `actor_id`, `action_type`, `target_id`, `target_type`
- `details` JSON (前後の値)
- `ip_address`, `user_agent`, `created_at`
- `severity`: info / warn / critical

#### 5.3.3 不可逆性
- 監査ログは UPDATE / DELETE 不可 (RLS で禁止)
- super_admin でも変更不可
- データ保持期間: 7 年 (法務要件)
- アーカイブ: 1 年経過後はコールドストレージへ

### 5.4 F-OP-004: 機能フラグ

#### 5.4.1 構造
```json
{
  "key": "new_meal_ai_v2",
  "description": "新しい食事 AI V2",
  "enabled": true,
  "rollout_strategy": {
    "type": "percentage",  // 'all', 'percentage', 'user_ids', 'organization_ids', 'roles'
    "value": 25
  },
  "constraints": {
    "min_user_age_days": 7,  // 登録 7 日以上
    "exclude_plans": ["free"]
  },
  "created_at": "...",
  "updated_at": "..."
}
```

#### 5.4.2 評価ロジック
- API リクエスト時に `is_enabled(flag_key, user)` を呼ぶ
- ハッシュベースで安定的にユーザーを A/B 分け
- メトリクス自動記録 (有効ユーザー数 / 効果)

#### 5.4.3 緊急停止
- 1 クリックで全ロールバック
- インシデント発生時に即座に無効化

### 5.5 F-OP-005: LLM コスト管理

#### 5.5.1 計測単位
- リクエスト毎: ユーザー / 機能 / モデル / トークン数 / コスト USD
- 集計: 日次 / 週次 / 月次

#### 5.5.2 ダッシュボード
- 総コスト (USD / JPY)
- モデル別内訳: Gemini Flash Lite / Gemini Image / xAI Grok / OpenAI / Claude
- 機能別内訳:
  - `analyze-meal-photo`
  - `classify-photo`
  - `analyze-fridge`
  - `analyze-health-checkup`
  - `analyze-weight-scale`
  - `ai-consultation` (ストリーミング、トークン多)
  - `generate-week-menu`
  - `generate-day-menu`
  - `generate-single-meal`
  - `image/generate` (献立画像生成)
- ユーザー別 Top 50: 異常使用検知
- 時系列推移: 時間 / 日別

#### 5.5.3 クォータ
| プラン | 1 日上限 | 1 ヶ月上限 |
|--------|---------|----------|
| Free | 50 リクエスト | 1,000 リクエスト |
| Pro | 500 リクエスト | 10,000 リクエスト |
| Premium | 2,000 リクエスト | 50,000 リクエスト |
| 法人 | 組織単位で設定 | 組織単位で設定 |

#### 5.5.4 異常検知
- 1 ユーザーが 1 日 5,000 リクエスト超 → アラート + 一時クォータ削減
- モデル別前日比 +50% → アラート
- 特定機能のコスト急増 → アラート

### 5.6 F-OP-006: 売上・MRR ダッシュボード

#### 5.6.1 KPI
- 今月の売上 (リアルタイム)
- 確定済売上 / 予測売上
- MRR / ARR
- 新規 MRR / 拡張 MRR / 縮小 MRR / 解約 MRR (Net New MRR)
- 解約率 (logo churn / revenue churn)
- LTV / CAC / LTV/CAC ratio
- 平均契約金額 (ACV)

#### 5.6.2 プラン別内訳
- 個人プラン (Free / Pro / Premium)
- 法人プラン (Org Starter / Standard / Pro / Enterprise)
- 各プランのアクティブユーザー / 売上

#### 5.6.3 コホート分析
- 登録月別の継続率 (1 / 3 / 6 / 12 ヶ月)
- 課金転換率 (Free → Paid)
- 月次売上のコホート分解

#### 5.6.4 法人契約管理
- 契約中組織一覧 (契約金額 / 次回更新日 / 担当営業)
- 解約予兆検知 (アクティブ率低下、ログイン頻度低下)
- 契約更新リマインダー (30 / 14 / 7 日前)

### 5.7 F-OP-007: サポートチケット

#### 5.7.1 チケット属性
- ID, ステータス (Open / In Progress / Pending / Resolved / Closed)
- 優先度 (Low / Medium / High / Urgent)
- カテゴリ (アカウント / 課金 / 機能 / 不具合 / その他)
- 担当者
- ユーザー (関連)
- 作成日時 / 解決日時

#### 5.7.2 スレッド
- ユーザー → サポート、サポート → ユーザーのメッセージ交換
- 添付ファイル (画像、PDF)
- 内部メモ (サポート同士、ユーザー非公開)
- ステータス変更履歴
- テンプレート (よくある回答を保存)

#### 5.7.3 SLA
- 初動応答: 営業日 24 時間以内
- 解決目標: 優先度別 (High: 48 時間 / Medium: 7 日 / Low: 30 日)
- アラート: SLA 超過時に担当者・マネージャーに通知

#### 5.7.4 統計
- 未対応件数
- 平均解決時間
- カテゴリ別件数
- 担当者別 KPI (件数 / 解決時間)

### 5.8 F-OP-008: 通知配信

#### 5.8.1 種類
- **キャンペーン通知**: マーケティング・お知らせ (`/admin/notifications/campaigns`)
- **トランザクション通知**: 自動配信 (登録完了 / 課金完了 / BAN / 招待 等)
- **緊急通知**: インシデント発生時 (admin 全員に Slack + Email)

#### 5.8.2 配信チャネル
- Push 通知 (APNs / FCM)
- Email (Resend)
- アプリ内通知
- SMS (将来、コスト次第)

#### 5.8.3 ターゲット指定
- 全ユーザー
- フィルタ:
  - プラン
  - 登録月
  - 最終ログイン日
  - 食事記録なし期間
  - 健康スコア
  - 居住地 (将来)
- CSV アップロード
- セグメント保存・再利用

#### 5.8.4 A/B テスト
- メッセージ A / B / C を分割配信
- 開封率 / クリック率 / コンバージョン率
- 統計的有意性

#### 5.8.5 配信スケジュール
- 即時
- 予約 (日時指定)
- ユーザータイムゾーン考慮 (将来)

### 5.9 F-OP-009: 不正検知

#### 5.9.1 検知ルール
- 大量登録 (同 IP から 10 分で 10 アカウント)
- BOT 疑い (24 時間で 1,000 食事記録)
- 同一画像連投 (1 ユーザーが同じ画像を 50 回)
- API スパム (1 分間に 1,000 リクエスト)
- スクリーンスクレイピング検知

#### 5.9.2 自動アクション
- 警告 (1 段階目): ユーザーに警告通知
- レート制限 (2 段階目): API 呼び出し制限
- 一時 BAN (3 段階目): 24 時間 BAN
- 永久 BAN (4 段階目): admin レビュー後

#### 5.9.3 手動レビューキュー
- 自動検知の偽陽性確認
- BAN 解除リクエスト処理
- 異議申立フロー

### 5.10 F-OP-010: インフラ監視

#### 5.10.1 監視対象
- Vercel: 関数実行時間、エラー率、デプロイ状況
- Supabase: DB クエリ時間、Edge Function ステータス、ストレージ使用量、Auth ステータス
- LLM API: レスポンス時間 (p50/p95/p99)、エラー率、コスト
- Vercel-Analytics: ページビュー、Core Web Vitals
- カスタム metrics: 食事認識成功率、献立生成成功率

#### 5.10.2 アラート
- しきい値超過で Slack #incident チャンネル + Email
- PagerDuty 連携 (将来)
- 自動エスカレーション (5 分未対応で次の担当者)

#### 5.10.3 インシデント管理
- インシデント記録 (発生時刻、影響範囲、対応者、復旧時刻)
- ポストモーテム作成
- 再発防止策追跡

### 5.11 F-OP-011: 営業 (CRM)

#### 5.11.1 リード管理
- 見込み客リスト
- スコアリング (確度高/中/低)
- ステージ: アプローチ / 商談 / 提案 / 交渉 / 契約 / 失注

#### 5.11.2 商談記録
- 時系列メモ
- 添付資料 (提案書 / 議事録)
- 次のアクション (リマインダー)

#### 5.11.3 提案書生成
- パイロット効果データ自動取得
- テンプレート差し込み
- PDF / PowerPoint 出力

### 5.12 F-OP-012: 経理 (Finance)

#### 5.12.1 請求書発行
- 月末一括生成
- 個別調整 (プラン変更途中、日割り)
- PDF + Stripe 連携

#### 5.12.2 未払い管理
- アラート (期限切れ 7/14/30 日)
- 督促メール (テンプレート)
- 一時停止フラグ

#### 5.12.3 売上計上
- 月次売上計上 (Stripe データと内部 DB 照合)
- 会計ソフト連携 (freee / マネーフォワード)

### 5.15 F-OP-015: プラン定義・販売管理ツール

#### 5.15.1 プラン定義
プラン (`subscription_plans` テーブル) は運営側で完全管理。
- プラン key (英数字、unique)
- 表示名 (ユーザー表示用)
- 種別 (`personal` / `family` / `org`)
- 価格 (月額 / 年額、JPY / USD)
- 機能パッケージ (1 つ以上の `feature_packages` を紐付け)
- 上限値 (家族メンバー数、組織メンバー数等)
- 公開ステータス (`draft` / `public` / `private` / `deprecated`)
- 表示順
- 説明文 (Markdown)
- バナー画像

#### 5.15.2 機能パッケージ
- パッケージ key (例: `ai_analysis`, `family_management`, `org_dashboard`)
- 含まれる feature flag のリスト
- 説明文
- バージョン管理 (改訂履歴)

#### 5.15.3 プラン × パッケージ マトリクス
- Web UI で視覚的に編集
- 例: 「Org Pro に AI 解析パッケージを追加」 → ワンクリック反映
- 反映後はリアルタイムで全ユーザーに適用

#### 5.15.4 価格変更
- 既存契約への影響をシミュレーション
- 新規契約のみ新価格 / 既存契約も次回更新時に変更 / 全契約即時変更 (要再認証)
- 価格変更履歴 (`plan_price_history`) で全変更を追跡

#### 5.15.5 プランのライフサイクル
```
draft (作成中)
  ↓ 公開
public (新規申込受付中)
  ↓ 非公開化
private (既存契約のみ継続、自動更新は可)
  ↓ 廃止
deprecated (新規申込・自動更新ともに不可、移行強制)
```

**各ステータスの既存契約への振る舞い**:

| ステータス | 新規申込 | 既存 `org_license_pools` の継続 | `org_license_pools.auto_renew` | 既存 `family_groups.plan_key` |
|------------|----------|-------------------------------|------------------------------|-------------------------------|
| `draft`    | ✗        | -                             | -                            | -                             |
| `public`   | ✓        | 継続                          | 継続                         | 継続                          |
| `private`  | ✗        | 継続                          | 継続                         | 継続                          |
| `deprecated` | ✗      | `ends_at` まで継続、以降は更新不可 | 強制 FALSE      | `ends_at` 経過後 `frozen` へ自動遷移 |

**deprecated 適用時の運営側オペレーション**:
1. プランを deprecated に変更すると、すべての関連 `org_license_pools.auto_renew = FALSE` に強制更新
2. 移行先プラン (`superseded_by_plan_id`) を必須指定
3. 影響を受ける組織管理者・個人ユーザーへ移行案内通知 (Email + アプリ内バナー):
   - deprecate 確定の 90 日前 / 30 日前 / 7 日前
   - `ends_at` 当日: ダウングレード or 移行先プランへの自動切替案内
4. `ends_at` 経過後:
   - 該当 `org_license_assignments.status = 'expired'`
   - 該当 `family_groups` (同梱配布分) は §4.17 の凍結フローに従う
   - 個人加入の `family_groups` は移行先プランへ自動切替 (オーナー要承認)

#### 5.15.6 顧客への影響シミュレーション
- 価格変更 → 影響を受ける契約数、影響金額、影響ユーザーリスト
- プラン廃止 → 影響顧客リスト、移行先プラン推奨、見込み解約数

#### 5.15.6.5 試用期間 (`trial_days`) フロー

`subscription_plans.trial_days > 0` のプランは試用期間が利用可能。試用は **個人プランのみ** (組織プランは契約交渉前提のため trial_days = 0 を強制)。

**試用開始**:
1. ユーザーが「7 日間無料で試す」ボタンを押下 (Stripe Setup Intent でカード登録は必須、課金は試用期間後)
2. `personal_subscriptions` に `trial_ends_at = NOW() + INTERVAL 'trial_days days'`、`status = 'trialing'` でレコード作成
3. 試用期間中は対象プランの全機能が解放される

**試用期間中**:
- 機能制限なし (本契約と同じ)
- 試用期間中に解約 → 即座に Free へダウングレード、課金なし
- 試用期間中に他プランへ切替 → 試用は消化扱いで終了、新プランは即時課金

**試用終了**:
- 終了 3 日前 / 1 日前 / 当日に Push + Email リマインダー
- カード登録済み: `trial_ends_at` 到達で自動課金開始 (`status = 'active'`)
- カード未登録: 自動的に Free へダウングレード (`status = 'expired'`)

**試用の制限**:
- 同じユーザーが同じプランを 2 回以上試用することは不可 (`personal_subscriptions` で過去 trial 履歴を検索)
- 紹介プログラム経由の試用は別途トラッキング (`trial_source` 列)

#### 5.15.7 プランダウングレード時の機能消失事前通知 (重要)

組織が上位プラン → 下位プラン (例: Org Pro → Org Standard) へダウングレードする際、消失する機能の影響をユーザーに事前通知する。

**運営側の責任**:
- `feature_packages` の差分計算 (旧プラン − 新プラン) を運営ツールが提供
- 影響メンバー一覧の自動抽出 API (`GET /api/super-admin/plans/{id}/downgrade-impact?to_plan_id=...`)
- 通知テンプレートの提供

**フロー**:
1. 組織管理者が `/org/licenses` でダウングレードを選択
2. システムが消失機能リストと影響メンバー一覧を表示 (確認画面)
   - 例: 「産業医連携機能」「AI 個別アドバイス」が消失、影響者 87 名
3. 組織管理者が確定すると、翌請求サイクル開始の N 日前 (デフォルト 7 日前) に該当メンバーへ通知:
   - Push: 「◯月◯日より◯◯機能が利用できなくなります」
   - Email: 機能一覧 + 個人プラン (Family Pro 等) への移行案内
4. 切替日に該当機能を物理的に無効化 (feature flag 評価ロジックが新プランの `feature_packages` を返す)

### 5.16 F-OP-016: 販売・収益管理

#### 5.16.1 ライセンス販売管理
組織向けライセンスの全体ビュー:
- 組織別販売状況 (プラン / 数量 / 期限 / 売上)
- 月別販売推移
- 期限切れ予告
- 強制終了管理 (未払い等)

#### 5.16.2 クーポン・割引管理
- クーポンコード生成
- 適用条件 (プラン / 期間 / 組織別 / 紹介プログラム)
- 利用統計
- 営業向けクーポン配布管理

#### 5.16.3 アップグレード分析
- ファネル: Free → Pro → Family → 法人
- 各ステップの転換率
- 離脱理由分析

#### 5.16.4 収益予測
- MRR 予測 (3 / 6 / 12 ヶ月)
- 解約予測 (機械学習、Phase 4)
- シナリオ分析 (価格変更時の予測)

### 5.17 F-OP-017: 個人課金管理

#### 5.17.1 個人プラン
- Free / Pro / Premium / Family Personal
- Stripe Subscription
- カード変更 / キャンセル / 一時停止

#### 5.17.2 個人ユーザー課金状況
- `/admin/finance/personal` で個人課金者リスト
- 検索・フィルタ
- 個別キャンセル対応 (顧客対応用)

### 5.13 F-OP-013: A/B テスト基盤

#### 5.13.1 実験設計
- 仮説、メトリクス、期間、配分
- バリアント (A / B / C…)
- ターゲット (全ユーザー / セグメント)

#### 5.13.2 実行
- ハッシュベース安定割当
- メトリクス自動記録

#### 5.13.3 統計分析
- 平均値の差、p 値、信頼区間
- ベイズ推定 (将来)
- サブグループ別 (年代 / プラン)

### 5.14 F-OP-014: データエクスポート

#### 5.14.1 用途
- 法務開示請求対応 (個人データ)
- BI ツール連携 (BigQuery / Snowflake / Looker)
- 機械学習データセット作成

#### 5.14.2 形式
- CSV / Parquet / JSON
- 個人特定情報の自動マスキング

---

## 6. 非機能要件

### 6.1 パフォーマンス
- ユーザー検索 (100 万件) < 1s
- ダッシュボード < 2s
- 監査ログ閲覧 < 1.5s
- レポート生成 < 30s

### 6.2 セキュリティ
- 全 admin に 2FA 必須 (Phase 2)
- IP allowlist (Enterprise admin)
- 全操作監査ログ
- セッション 1 時間タイムアウト
- ロール変更は再認証必須

### 6.3 スケーラビリティ
- 1,000 万ユーザー対応
- 同時 admin: 50 名
- 監査ログ: 1 億行 / 年

### 6.4 可用性
- 管理コンソール 99.9%
- インシデント時に自動フェイルオーバー (将来)

### 6.5 法務・コンプライアンス
- 個人情報保護法
- GDPR (EU 拠点企業利用時)
- SOC 2 Type II (将来取得)
- 監査ログ 7 年保持

---

## 7. データモデル

### 7.1 既存テーブル拡張

#### 7.1.1 `user_profiles.roles`
```sql
-- 新規ロール追加
-- ロール: user / support / sales / finance / content_moderator / org_member / org_manager / org_admin / org_industrial_doctor / admin / super_admin
```

#### 7.1.2 `admin_audit_logs`
```sql
ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS target_type VARCHAR(30);
ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS severity VARCHAR(20) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'critical'));

-- 不可逆性: UPDATE/DELETE 禁止
CREATE POLICY "audit_logs_immutable" ON admin_audit_logs FOR UPDATE USING (false);
CREATE POLICY "audit_logs_immutable_delete" ON admin_audit_logs FOR DELETE USING (false);
```

### 7.2 新規テーブル

#### 7.2.1 `support_tickets`
```sql
CREATE TABLE support_tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  subject         VARCHAR(200) NOT NULL,
  category        VARCHAR(50) NOT NULL,
  priority        VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status          VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'pending', 'resolved', 'closed')),
  assignee_id     UUID REFERENCES auth.users(id),
  resolved_at     TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE support_ticket_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES auth.users(id),
  is_internal     BOOLEAN NOT NULL DEFAULT FALSE,
  body            TEXT NOT NULL,
  attachments     JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 7.2.2 `notification_campaigns`
```sql
CREATE TABLE notification_campaigns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(200) NOT NULL,
  channel           VARCHAR(20) NOT NULL CHECK (channel IN ('push', 'email', 'in_app')),
  target_filter     JSONB NOT NULL,  -- { plan: ['free'], min_age_days: 7, ... }
  variants          JSONB NOT NULL,  -- [{ key: 'A', subject: '...', body: '...' }, ...]
  scheduled_at      TIMESTAMPTZ,
  status            VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  total_recipients  INT,
  sent_count        INT NOT NULL DEFAULT 0,
  open_count        INT NOT NULL DEFAULT 0,
  click_count       INT NOT NULL DEFAULT 0,
  conversion_count  INT NOT NULL DEFAULT 0,
  created_by        UUID NOT NULL REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 7.2.3 `abuse_rules`
```sql
CREATE TABLE abuse_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  rule_type       VARCHAR(50) NOT NULL,  -- 'request_rate', 'content_repetition', 'multi_account', etc.
  threshold       JSONB NOT NULL,
  action_type     VARCHAR(30) NOT NULL,  -- 'warning', 'rate_limit', 'temp_ban', 'perm_ban', 'manual_review'
  action_config   JSONB DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID NOT NULL REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE abuse_detections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         UUID NOT NULL REFERENCES abuse_rules(id),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details         JSONB NOT NULL,
  action_taken    VARCHAR(30),
  reviewed_by     UUID REFERENCES auth.users(id),
  review_status   VARCHAR(20),  -- 'auto', 'confirmed', 'false_positive', 'escalated'
  reviewed_at     TIMESTAMPTZ
);
```

#### 7.2.4 `experiments` (A/B テスト)
```sql
CREATE TABLE experiments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             VARCHAR(100) NOT NULL UNIQUE,
  hypothesis      TEXT,
  variants        JSONB NOT NULL,  -- [{ key: 'control', weight: 50 }, { key: 'variant_a', weight: 50 }]
  primary_metric  VARCHAR(100),
  start_date      DATE,
  end_date        DATE,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'completed', 'cancelled')),
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE experiment_assignments (
  experiment_id   UUID NOT NULL REFERENCES experiments(id),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  variant_key     VARCHAR(50) NOT NULL,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (experiment_id, user_id)
);
```

#### 7.2.5 `sales_leads`
```sql
CREATE TABLE sales_leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name    VARCHAR(200) NOT NULL,
  industry        VARCHAR(100),
  employee_count  INT,
  contact_name    VARCHAR(100),
  contact_email   VARCHAR(255),
  contact_phone   VARCHAR(50),
  source          VARCHAR(50),  -- 'website', 'referral', 'event', 'cold_call'
  stage           VARCHAR(30) NOT NULL DEFAULT 'approach',  -- 'approach', 'meeting', 'proposal', 'negotiation', 'won', 'lost'
  assigned_to     UUID REFERENCES auth.users(id),
  estimated_acv   INT,  -- Annual Contract Value
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sales_lead_activities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
  actor_id        UUID NOT NULL REFERENCES auth.users(id),
  activity_type   VARCHAR(30) NOT NULL,  -- 'call', 'email', 'meeting', 'note', 'stage_change'
  details         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 7.2.7 `subscription_plans` (プラン定義、運営側マスター)
```sql
CREATE TABLE subscription_plans (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key                VARCHAR(100) NOT NULL UNIQUE,  -- 'free', 'pro', 'family_basic', 'org_pro', etc.
  display_name            VARCHAR(200) NOT NULL,
  plan_type               VARCHAR(20) NOT NULL CHECK (plan_type IN ('personal', 'family', 'org')),
  description             TEXT,
  -- 価格
  monthly_price_jpy       INT,  -- NULL = 無料 or カスタム
  yearly_price_jpy        INT,
  currency                VARCHAR(3) NOT NULL DEFAULT 'JPY',
  -- 上限値
  max_members             INT,  -- 家族: 4/8、組織: メンバー上限
  max_family_seats        INT,  -- 組織プランで家族同梱時の家族メンバー数
  -- 機能
  feature_packages        UUID[] NOT NULL DEFAULT '{}',  -- feature_packages の id 配列
  -- 公開ステータス
  status                  VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'public', 'private', 'deprecated')),
  display_order           INT NOT NULL DEFAULT 0,
  -- メタ
  banner_url              TEXT,
  trial_days              INT NOT NULL DEFAULT 0,
  min_contract_months     INT NOT NULL DEFAULT 1,
  auto_renew_default      BOOLEAN NOT NULL DEFAULT TRUE,
  -- バージョン管理
  version                 INT NOT NULL DEFAULT 1,
  superseded_by_plan_id   UUID REFERENCES subscription_plans(id),  -- 後継プラン
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subscription_plans_status ON subscription_plans(status, display_order);
CREATE INDEX idx_subscription_plans_type ON subscription_plans(plan_type, status);
```

#### 7.2.8 `feature_packages` (機能パッケージ)
```sql
CREATE TABLE feature_packages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_key         VARCHAR(100) NOT NULL UNIQUE,  -- 'ai_analysis', 'family_management', etc.
  display_name        VARCHAR(200) NOT NULL,
  description         TEXT,
  feature_flags       VARCHAR(100)[] NOT NULL DEFAULT '{}',  -- 含まれる feature flag のキー
  display_order       INT NOT NULL DEFAULT 0,
  status              VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 7.2.9 `plan_price_history` (価格変更履歴)
```sql
CREATE TABLE plan_price_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id               UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  old_monthly_price_jpy INT,
  new_monthly_price_jpy INT,
  old_yearly_price_jpy  INT,
  new_yearly_price_jpy  INT,
  changed_by            UUID NOT NULL REFERENCES auth.users(id),
  reason                TEXT,
  effective_at          TIMESTAMPTZ NOT NULL,
  applies_to            VARCHAR(30) NOT NULL CHECK (applies_to IN ('new_only', 'on_renewal', 'immediately')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 7.2.10 `coupons` (クーポン・割引コード)
```sql
CREATE TABLE coupons (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                VARCHAR(50) NOT NULL UNIQUE,
  display_name        VARCHAR(200),
  discount_type       VARCHAR(20) NOT NULL CHECK (discount_type IN ('fixed', 'percentage')),
  discount_value      NUMERIC NOT NULL,  -- fixed: JPY、percentage: 0-100
  applicable_plans    UUID[] NOT NULL DEFAULT '{}',  -- 適用可能なプラン id (空 = 全プラン)
  applicable_to       VARCHAR(20) NOT NULL DEFAULT 'all' CHECK (applicable_to IN ('all', 'personal', 'family', 'org')),
  valid_from          TIMESTAMPTZ NOT NULL,
  valid_until         TIMESTAMPTZ NOT NULL,
  max_uses            INT,  -- NULL = 無制限
  uses_count          INT NOT NULL DEFAULT 0,
  per_user_limit      INT NOT NULL DEFAULT 1,
  duration_months     INT,  -- 何ヶ月間割引適用 (NULL = ずっと)
  status              VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'expired')),
  created_by          UUID NOT NULL REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE coupon_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id       UUID NOT NULL REFERENCES coupons(id),
  user_id         UUID REFERENCES auth.users(id),
  organization_id UUID REFERENCES organizations(id),
  applied_to_subscription_id UUID,  -- 個人 / 組織契約 のどちらか
  discount_amount_jpy INT NOT NULL,
  redeemed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 7.2.11 `revenue_snapshots` (収益スナップショット、日次)
```sql
CREATE TABLE revenue_snapshots (
  date                    DATE PRIMARY KEY,
  -- 個人プラン
  personal_active_users   INT NOT NULL DEFAULT 0,
  personal_mrr_jpy        INT NOT NULL DEFAULT 0,
  -- 家族プラン
  family_active_groups    INT NOT NULL DEFAULT 0,
  family_mrr_jpy          INT NOT NULL DEFAULT 0,
  -- 組織プラン
  org_active_orgs         INT NOT NULL DEFAULT 0,
  org_active_seats        INT NOT NULL DEFAULT 0,
  org_mrr_jpy             INT NOT NULL DEFAULT 0,
  -- 集計
  total_mrr_jpy           INT NOT NULL DEFAULT 0,
  total_arr_jpy           INT NOT NULL DEFAULT 0,
  -- 解約・新規
  new_signups             INT NOT NULL DEFAULT 0,
  cancellations           INT NOT NULL DEFAULT 0,
  upgrade_count           INT NOT NULL DEFAULT 0,
  downgrade_count         INT NOT NULL DEFAULT 0,
  -- メタ
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 7.2.6 `infra_metrics`
```sql
CREATE TABLE infra_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_name     VARCHAR(100) NOT NULL,
  source          VARCHAR(50) NOT NULL,  -- 'vercel', 'supabase', 'gemini', 'xai', 'openai', 'custom'
  value           NUMERIC NOT NULL,
  unit            VARCHAR(20),
  tags            JSONB DEFAULT '{}',
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_infra_metrics_recent ON infra_metrics(metric_name, recorded_at DESC);

CREATE TABLE infra_alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_name     VARCHAR(100) NOT NULL,
  threshold       NUMERIC NOT NULL,
  comparison      VARCHAR(10) NOT NULL CHECK (comparison IN ('>', '>=', '<', '<=', '=')),
  triggered_at    TIMESTAMPTZ NOT NULL,
  resolved_at     TIMESTAMPTZ,
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 8. API 仕様

### 8.1 ユーザー管理
- `GET /api/admin/users` (検索・フィルタ・ソート)
- `GET /api/admin/users/{id}` (詳細)
- `PATCH /api/admin/users/{id}` (基本情報更新)
- `POST /api/admin/users/{id}/ban`
- `POST /api/admin/users/{id}/unban`
- `PUT /api/admin/users/{id}/roles`
- `GET /api/admin/users/{id}/audit-logs`
- `POST /api/admin/users/{id}/notes`

### 8.2 モデレーション
- `GET /api/admin/moderation/{type}` (food / recipe / ai_content)
- `PUT /api/admin/moderation/{type}/{id}` (解決)
- `POST /api/admin/moderation/auto-rules`

### 8.3 監査ログ
- `GET /api/admin/audit-logs`
- `POST /api/admin/audit-logs/export`

### 8.4 機能フラグ
- `GET /api/super-admin/feature-flags`
- `PUT /api/super-admin/feature-flags/{key}`
- `POST /api/super-admin/feature-flags`
- `DELETE /api/super-admin/feature-flags/{key}`

### 8.5 LLM 使用量
- `GET /api/super-admin/llm-usage` (フィルタ・期間指定)
- `GET /api/super-admin/llm-usage/users/{id}`
- `POST /api/super-admin/llm-usage/quota-update`

### 8.6 売上 / 経理
- `GET /api/admin/finance/dashboard`
- `GET /api/admin/finance/mrr`
- `GET /api/admin/finance/cohorts`
- `POST /api/admin/finance/invoices/generate`
- `GET /api/admin/finance/invoices`
- `POST /api/admin/finance/invoices/{id}/resend`

### 8.7 サポート
- `GET /api/support/tickets`
- `POST /api/support/tickets`
- `GET /api/support/tickets/{id}`
- `POST /api/support/tickets/{id}/messages`
- `PATCH /api/support/tickets/{id}` (ステータス・担当者)

### 8.8 通知配信
- `GET /api/admin/notifications/campaigns`
- `POST /api/admin/notifications/campaigns`
- `POST /api/admin/notifications/campaigns/{id}/send`
- `GET /api/admin/notifications/campaigns/{id}/stats`

### 8.9 不正検知
- `GET /api/super-admin/abuse/rules`
- `POST /api/super-admin/abuse/rules`
- `PATCH /api/super-admin/abuse/rules/{id}`
- `GET /api/super-admin/abuse/detections`
- `POST /api/super-admin/abuse/detections/{id}/review`

### 8.10 インフラ監視
- `GET /api/super-admin/infra/dashboard`
- `GET /api/super-admin/infra/metrics`
- `GET /api/super-admin/infra/alerts`
- `POST /api/super-admin/infra/alerts/{id}/acknowledge`

### 8.11 営業
- `GET /api/admin/sales/leads`
- `POST /api/admin/sales/leads`
- `PATCH /api/admin/sales/leads/{id}`
- `POST /api/admin/sales/leads/{id}/activities`
- `POST /api/admin/sales/leads/{id}/proposal-pdf`

### 8.12 A/B テスト
- `GET /api/super-admin/experiments`
- `POST /api/super-admin/experiments`
- `PATCH /api/super-admin/experiments/{id}`
- `GET /api/super-admin/experiments/{id}/results`

### 8.13 データエクスポート
- `POST /api/super-admin/exports`
- `GET /api/super-admin/exports/{id}` (ステータス確認)
- `GET /api/super-admin/exports/{id}/download`

### 8.14 プラン定義 (super_admin)
- `GET /api/super-admin/plans` — プラン一覧
- `POST /api/super-admin/plans` — プラン新規作成 (draft)
- `GET /api/super-admin/plans/{id}` — プラン詳細
- `PATCH /api/super-admin/plans/{id}` — プラン編集
- `POST /api/super-admin/plans/{id}/publish` — draft → public
- `POST /api/super-admin/plans/{id}/unpublish` — public → private
- `POST /api/super-admin/plans/{id}/deprecate` — 廃止
- `POST /api/super-admin/plans/{id}/price-change` — 価格変更 (適用範囲指定)
- `GET /api/super-admin/plans/{id}/impact` — 価格変更影響シミュレーション
- `GET /api/super-admin/plans/{id}/price-history` — 価格変更履歴

### 8.15 機能パッケージ
- `GET /api/super-admin/feature-packages`
- `POST /api/super-admin/feature-packages`
- `PATCH /api/super-admin/feature-packages/{id}`
- `DELETE /api/super-admin/feature-packages/{id}`

### 8.16 クーポン管理
- `GET /api/admin/coupons` — クーポン一覧
- `POST /api/admin/coupons` — クーポン作成
- `PATCH /api/admin/coupons/{id}` — 編集
- `POST /api/admin/coupons/{id}/pause` — 一時停止
- `GET /api/admin/coupons/{id}/redemptions` — 利用統計

### 8.17 収益管理
- `GET /api/admin/finance/revenue/snapshot` — 最新スナップショット
- `GET /api/admin/finance/revenue/timeseries` — 期間指定で MRR / ARR 推移
- `GET /api/admin/finance/revenue/forecast` — 予測 (3/6/12 ヶ月)
- `GET /api/admin/finance/licenses` — 組織ライセンス販売一覧
- `GET /api/admin/finance/personal` — 個人課金者リスト

---

## 9. UI 画面仕様

### 9.1 `/admin` 既存拡張

#### 9.1.1 `/admin` (ダッシュボード)
- KPI カード: 全ユーザー / アクティブユーザー / 食事記録 / AI セッション / 未対応チケット数
- グラフ: 月次推移
- 直近のアクティビティ (監査ログ最新 10 件)

#### 9.1.2 `/admin/users` 拡張
- 高度な検索 (全文検索・複数条件)
- BAN ボタン強化 (理由・期間)
- 一括操作 (CSV ダウンロード、一括 BAN)

#### 9.1.3 `/admin/moderation` 拡張
- 自動モデレーションルール管理
- 統計ダッシュボード
- エスカレーション機能

#### 9.1.4 `/admin/audit-logs` 拡張
- 高度フィルタ
- CSV エクスポート

### 9.2 新規画面

#### 9.2.1 `/admin/finance/dashboard` (新規)
- MRR / ARR / 解約率
- コホート分析
- 法人契約一覧

#### 9.2.2 `/admin/finance/invoices` (新規)
- 請求書一覧
- 一括生成
- 個別 PDF 表示

#### 9.2.3 `/admin/sales/leads` (新規)
- 見込み客リスト
- ステージ管理
- 商談記録

#### 9.2.4 `/admin/sales/leads/{id}` (新規)
- リード詳細
- 活動履歴
- 提案書生成ボタン

#### 9.2.5 `/admin/notifications/campaigns` (新規)
- キャンペーン一覧
- 新規作成ウィザード
- 送信統計

#### 9.2.6 `/support/tickets` (拡張)
- チケット一覧 (フィルタ豊富化)
- 担当者割当・SLA 表示

#### 9.2.7 `/support/tickets/{id}` (新規)
- スレッドビュー
- 内部メモ
- ユーザー詳細リンク

### 9.3 `/super-admin` 既存拡張

#### 9.3.1 `/super-admin` (ダッシュボード) 強化
- システム健全性ステータス
- LLM コストアラート
- 過去 24 時間の重要イベント

#### 9.3.2 `/super-admin/llm-usage` 強化
- ユーザー別 Top N
- 異常検知アラート
- クォータ設定

#### 9.3.3 `/super-admin/feature-flags` 強化
- ロールアウト戦略 UI
- メトリクス連携

### 9.4 新規画面 (super-admin)

#### 9.4.1 `/super-admin/infra` (新規)
- 統合監視ダッシュボード
- アラート履歴

#### 9.4.2 `/super-admin/abuse` (新規)
- ルール管理
- 検知キュー

#### 9.4.3 `/super-admin/experiments` (新規)
- 実験管理
- 統計分析

#### 9.4.4 `/super-admin/exports` (新規)
- データエクスポート要求
- ダウンロード

#### 9.4.5 `/super-admin/plans` (新規) ⭐
プラン定義・販売管理ツール:
- プラン一覧 (テーブル)
  - カラム: key / 表示名 / 種別 / 月額 / 年額 / 含まれるパッケージ数 / ステータス / 表示順
  - 行クリックで詳細編集
  - Status badge (draft / public / private / deprecated)
- フィルタ: 種別 (personal / family / org)、ステータス
- アクション: 「+ 新規プラン作成」ボタン

#### 9.4.6 `/super-admin/plans/{id}` (プラン編集)
- 基本情報 (key、表示名、説明、銘柄画像)
- 種別 / 上限値
- 価格設定 (月額・年額)
- 機能パッケージ選択 (チェックボックスマトリクス)
- Stripe Price ID (連携時のみ)
- ステータス変更ボタン (Publish / Unpublish / Deprecate)
- 「価格変更」ボタン → モーダル (新価格 + 適用範囲: 新規のみ / 更新時 / 即時)
  - 影響シミュレーションを表示 (影響契約数、影響金額)
- 価格変更履歴タブ

#### 9.4.7 `/super-admin/feature-packages` (新規) ⭐
機能パッケージ管理:
- パッケージ一覧 (key / 表示名 / 含まれる feature flag 数 / 利用プラン数)
- 編集モーダル: パッケージに含める feature flag をチェックボックスで選択
- マトリクスビュー: プラン × パッケージの俯瞰

#### 9.4.8 `/admin/coupons` (新規) ⭐
クーポン管理:
- クーポン一覧 (code / 割引 / 有効期限 / 利用数 / ステータス)
- 「+ 新規クーポン」モーダル (固定額 / %、対象プラン、期限、回数制限)
- 個別クーポン詳細: 利用統計グラフ、利用者リスト
- 一時停止ボタン

#### 9.4.9 `/admin/finance/licenses` (新規) ⭐
組織ライセンス販売管理:
- 組織別販売状況テーブル (組織 / プラン / 数量 / 期限 / 売上 / 状態)
- 期限切れ予告アラート (30 日以内)
- 月別販売推移グラフ
- 詳細クリックで組織別ライセンスプール詳細へ

#### 9.4.10 `/admin/finance/personal` (新規)
個人課金者管理:
- 個人課金者リスト (ユーザー / プラン / 開始日 / 次回更新日 / MRR)
- 検索・フィルタ
- 個別キャンセル対応 (顧客対応用)

#### 9.4.11 `/admin/finance/dashboard` 拡張
- 日次・月次 MRR / ARR
- セグメント別: personal / family / org
- 解約予測カード
- アップグレードファネル
- 価格変更影響レポート

---

## 10. エラーハンドリング・バリデーション

### 10.1 共通エラーパターン
- 401: 未認証
- 403: 権限不足 (ロール / 範囲)
- 404: リソース未存在
- 409: 競合 (同時編集等)
- 422: バリデーション失敗
- 429: レート制限
- 500: サーバーエラー
- 503: サービス停止 (メンテナンス)

### 10.2 主要エラーコード
| コード | 意味 |
|--------|------|
| `OP_PERMISSION_DENIED` | ロール不足 |
| `OP_TARGET_PROTECTED` | super_admin 等 保護ユーザーへの操作不可 |
| `OP_AUDIT_LOG_IMMUTABLE` | 監査ログ書き換え不可 |
| `OP_FEATURE_FLAG_IN_USE` | 削除しようとしたフラグが利用中 |
| `OP_QUOTA_EXCEEDED` | LLM クォータ超過 |
| `OP_RE_AUTH_REQUIRED` | 再認証必須 |

---

## 11. 段階的実装計画

### Phase 1: 既存機能の完成 (3 週間)
- 監査ログ網羅 (現在記録されてない操作も記録)
- ユーザー BAN 強化
- モデレーション統計強化

### Phase 2: サポートチケット (2 週間)
- `support_tickets` + `support_ticket_messages`
- スレッド UI
- SLA / アラート

### Phase 3: 通知配信 (3 週間)
- Push 基盤 (APNs/FCM 統合)
- Email 基盤 (Resend)
- キャンペーン UI

### Phase 4: 売上・MRR (3 週間)
- Stripe 連携完了
- ダッシュボード
- コホート分析

### Phase 4.5: プラン管理ツール (3 週間) ⭐
- `subscription_plans` / `feature_packages` / `plan_price_history` / `coupons` / `revenue_snapshots` テーブル
- super_admin プラン管理 UI (`/super-admin/plans`、`/super-admin/feature-packages`)
- ライセンス販売ダッシュボード (`/admin/finance/licenses`)
- クーポン管理 UI
- プラン × 機能パッケージ マトリクス UI
- 価格変更影響シミュレーション
- 02-organization-management `org_license_pools` との連携 (プラン参照)
- 01-family-management の `family_groups.plan_key` との整合性

### Phase 5: 不正検知 (2 週間)
- ルールエンジン
- 自動 BAN
- 手動レビュー UI

### Phase 6: 営業・経理ロール (2 週間)
- 新ロール追加
- 営業 CRM 機能
- 経理請求書管理

### Phase 7: A/B テスト基盤 (2 週間)
- 実験エンジン
- 統計分析

### Phase 8: インフラ監視 (3 週間)
- メトリクス収集
- 統合ダッシュボード
- アラート

### Phase 9: 拡張機能 (継続)
- データエクスポート
- BigQuery 連携
- 高度な BI

---

## 12. テスト計画

### 12.1 単体・統合
- 各 API の権限テスト
- 監査ログ記録の網羅性テスト
- 機能フラグ評価ロジック

### 12.2 E2E (Playwright)
- `op/01-user-search.spec.ts`
- `op/02-user-ban.spec.ts`
- `op/03-moderation-resolve.spec.ts`
- `op/04-feature-flag-toggle.spec.ts`
- `op/05-llm-usage-dashboard.spec.ts`
- `op/06-support-ticket-thread.spec.ts`
- `op/07-mrr-dashboard.spec.ts`
- `op/08-notification-campaign.spec.ts`

### 12.3 セキュリティ
- 権限境界テスト (各ロール × 各操作)
- SQL injection 攻撃耐性
- 監査ログ改ざん試行

### 12.4 負荷テスト
- 監査ログ 1 億行で検索時間
- 通知 100 万件配信
- ダッシュボード同時アクセス 100 admin

---

## 13. リリース基準

- [ ] Phase 1 完了 + 監査ログ網羅性 100%
- [ ] 全主要 API のレート制限実装
- [ ] super_admin の 2FA 必須化
- [ ] サポートマニュアル完備
- [ ] インシデント対応プレイブック
- [ ] バックアップ・リストア手順

---

## 14. 付録

### 14.1 ロール体系図 (詳細)

```
super_admin
  ├ admin
  │   ├ support
  │   ├ sales (新)
  │   ├ finance (新)
  │   └ content_moderator (新)
  ├ org_admin
  │   ├ org_manager
  │   ├ org_industrial_doctor (新)
  │   ├ org_member
  │   └ org_viewer
  └ user
```

### 14.2 通知テンプレート例

```
件名: 【ほめゴハン】ご利用上の重要なお知らせ

{user_name} 様

ご利用中のアカウントについて、以下のお知らせがあります。

{notification_body}

ご質問・ご不明な点がございましたら、サポートまでお気軽にどうぞ。
support@homegohan.com

---
ほめゴハン運営チーム
```

### 14.3 関連ドキュメント

- `01-family-management.md`
- `02-organization-management.md`
- `docs/security/rbac.md` (ロールベースアクセス制御詳細)
- `docs/operations/incident-response.md`
- `docs/finance/billing.md`
- `docs/marketing/notification-strategy.md`

### 14.4 オープン課題

1. **2FA 実装**: TOTP / Email OTP / SMS のうちどれか (Phase 2)
2. **Stripe vs 自社請求**: 法人プランは銀行振込多め、Stripe との併用検討
3. **GDPR 対応**: EU 拠点企業向け、Phase 3 で本格対応
4. **データ保持期間**: 退会後の食事記録は何ヶ月保持? (現在 6 ヶ月、要法務確認)
5. **AI モデレーション精度**: Gemini モデレーション API の偽陽性率
6. **インシデント対応 SLA**: 内部目標 (P0: 30 分以内、P1: 2 時間)
7. **オンコール体制**: 24/7 vs 営業時間のみ (人員次第)

### 14.5 用語の使い分け

- 「運営者 / Operator」: ほめゴハン会社の従業員
- 「管理者 / admin」: 管理コンソール ロール名
- 「管理コンソール」: `/admin` `/super-admin` `/support` を含む UI 全体
- 「管理画面」: 個別の画面 (例: ユーザー管理画面)

---

**END OF OPERATOR ADMIN REQUIREMENTS DOCUMENT**

3 本完成。次は実装計画 PR の起案。

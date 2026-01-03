以下に、**企画書 → 要件定義書 → 基本設計書 → 詳細設計書**の順で、ここまでの内容を統合してまとめます。
（Vercel/Next.js Web版を主軸にしつつ、React Native アプリ展開も前提にした設計にしてあります）

---

## 用語メモ（v1/v2 と `/functions/v1` の違い）

本ドキュメント内で「v1/v2」という表現が **2種類** 登場するため、混同防止のために定義します。

- **`/functions/v1/...`**: Supabase Edge Functions の **HTTPパスのバージョン**（プラットフォーム側の仕様）。  
  これは **献立生成アルゴリズムの v1/v2 とは無関係**です。
- **献立生成ロジックの v1 / v2**:
  - **v1（legacy/旧方式）**: 既存の献立生成（RAG/LLM中心。`knowledge-gpt` 経由など）
  - **v2（dataset/データセット駆動）**: pgvector＋データセットDBを根拠に **ID選定→DB確定値を `planned_meals` に反映**する方式

**互換方針（重要）**
- `generate-weekly-menu` は互換入口として残し、内部で v2 を実行して旧呼び出しも壊さない（詳細は実装コメント参照）

---

# 第一部　企画書

## 1. サービス概要

### 1-1. サービス名（仮）

**ほめごはん**

### 1-2. タグライン案

> 撮るだけで分かる。食べ方から、パフォーマンスを底上げ。

### 1-3. 一文コンセプト

スポーツ・仕事・勉強などで
**自分のパフォーマンスを上げたい人**が、
日々の食事を「写真で撮るだけ」で、

* AIが写真から**栄養バランスを推定して記録**し、
* その人の目的に合わせた**ほめコメント＋一歩だけ改善アドバイス**と、
* 一汁三菜ベースの**1週間献立（朝昼晩）**

を自動生成してくれる、食習慣・パフォーマンス支援サービス。

---

## 2. 背景・課題認識

### 2-1. 現状の課題（共通）

1. 「何をどう食べればパフォーマンスが上がるか」が直感で分からない
2. 忙しくて、食事内容を**毎回手入力する余裕がない**
3. 情報は多いが、

   * カロリー・PFCなど数字が難しい
   * それを自分の生活にどう落とすかが分からない
4. ダイエット／美容系アプリは

   * 「減らす」「我慢する」方向のメッセージが多く、
   * メンタル負荷・リバウンドリスクも高い

→ 「パフォーマンスを上げるために**どう食べるか**」を、
　**できるだけ楽に・ポジティブに**支援する仕組みが不足している。

### 2-2. なぜ「写真 × AI栄養解析」が解決になりえるか

1. 写真なら、**ほぼゼロコスト**で入力できる
2. AIで大まかな栄養バランスを推定すれば、

   * 「細かい数値」ではなく「傾向」を掴める
     （例：脂質が多めの日が続いている、野菜が少ない など）
3. その傾向とユーザーの目的（パフォーマンス）を掛け合わせて、

   * 具体的な**行動レベルのアドバイス**に変換できる
4. さらに、1週間献立をAIに任せれば、

   * 「毎日ゼロから考える負担」が減り、
   * 食事全体が**中長期的に改善されるループ**を作れる

---

## 3. ターゲットセグメント

### 3-1. 上位カテゴリ（3本柱）

1. **フィジカルパフォーマンス向上系**
2. **知的・クリエイティブパフォーマンス向上系**
3. **コンディション安定・回復系**

### 3-2. セグメント詳細

* A1 アスリート・スポーツ愛好家
* A2 身体を使う仕事の人（建設・看護・介護・物流など）
* B1 ナレッジワーカー（エンジニア・企画・営業・コンサル等）
* B2 受験生・資格学習者
* B3 クリエイター・フリーランス
* C1 子育て中・家族を支える人
* C2 夜勤・シフトワーカー
* C3 ミドル〜シニアのパフォーマンス維持層

それぞれ、

* 何を高めたいか（持久力／集中力／回復力）
* 生活リズム（昼型・夜型／シフトあり）

が異なるため、**プロファイル情報＋写真ログ**から、
パフォーマンスモードごとに最適なコメント・献立を出し分ける。

---

## 4. 提供価値（Value Proposition）

1. **写真を撮るだけで栄養ログが溜まる**

   * 食品名・量を手で入力しなくても、AIがざっくり推定
   * 「完璧な数値」ではなく、**パターンを見るための目安**を提供

2. **パフォーマンス視点の“ほめコメント＋一歩だけ改善”**

   * まず「良いところ」を具体的にほめる
   * その上で、目的に応じた1ステップだけの改善案
   * 「我慢しろ」ではなく「こうするともっと良くなるよ」のトーン

3. **一汁三菜ベースの1週間献立**

   * 朝昼晩 × 7日分の献立をAIが提案
   * 週ごとの予定（試合・会議・夜勤）と、
     直近の栄養傾向を踏まえて調整
   * 「とりあえずこのベース通りに食材を買えばOK」という安心感

4. **中長期のパフォーマンス向上に効く「食べ方の型」が身につく**

   * 日々のほめコメント
   * 週単位の献立提案
     → これらを繰り返すことで、「自分にとって合う食べ方」が自然と学習される。

---

## 5. サービス機能概要

### 5-1. コア機能

1. **食事記録（写真ベース）**

   * カメラ撮影／アルバムから選択
   * 食事種別（朝・昼・夜・間食）
   * 食べた時間
   * 任意メモ（「試合前」「夜勤明け」など）

2. **AI栄養解析**

   * 画像から料理種別と量を推定
   * エネルギー / PFCバランス / 野菜量などをざっくり推定
   * 栄養スコア（例：★ 1〜5）やレーダーチャート的指標で表現

3. **AIほめコメント**

   * 栄養傾向 × パフォーマンスモード × 生活リズムを元に生成
   * 必ず「良い点」 → 「一歩改善」の順で表示

4. **一汁三菜 × 1週間献立生成**

   * 週の開始日＋今週の状況（試合・締切・夜勤など）を入力
   * 一汁三菜（主食/汁物/主菜/副菜×2）の構成で、朝昼晩×7日を提案
   * 直近の栄養傾向を参照し、不足しがちな要素を補う

5. **バッジ・実績管理**

   * 記録の継続
   * 重要な日の前後での意識的な食事
   * 週献立の実行回数
     などをバッジ化

### 5-2. 補助機能

* プロファイル管理（年齢帯・性別・パフォーマンス目的・生活リズム・制限食・アレルギー）
* シンプルな栄養・パフォーマンスサマリ（週・月単位）
* 設定（通知ON/OFF、ログアウト、データエクスポート準備など）
* 管理者向けモデレーション画面（不適切コンテンツ対応）

---

## 6. UXストーリー

### 6-1. 初回利用ストーリー

1. Webでアクセスまたはアプリをインストール
2. サービス概要を見てアカウント作成
3. プロファイル入力：

   * ニックネーム
   * 年齢帯
   * 最も上げたいパフォーマンス（例：スポーツ、集中力、夜勤耐性）
   * 生活リズム
   * 食の制限
   * 目標（例：「試合で最後まで足が止まらないようにしたい」）
4. チュートリアル：

   * 「食事を撮る」
   * 「AIが栄養とコメントを返す」
   * 「週の献立を作る」
5. ホーム画面に遷移 → 最初の1食を記録するよう促される

### 6-2. 1日の利用ストーリー

* 朝・昼・夜・間食のタイミングで：

  1. 食べる前（または後）に写真を撮る
  2. 種類と時間帯だけ軽く設定して保存
  3. 数秒〜十数秒後、AI栄養解析とほめコメントが届く
* 夜に1日を振り返ると：

  * 「今日はたんぱく質しっかり」「野菜はもう少し」などの傾向が分かる
  * 明日のどこで改善するかのヒントが得られる

### 6-3. 1週間の利用ストーリー

* 日曜の夜などに：

  1. 「今週の1週間献立を作る」ボタンを押す
  2. 「今週は出張多め」「試合が週末にある」などの状況を入力
  3. AIが一汁三菜ベースの献立案を生成
* ユーザーは：

  * その献立案を見ながら買い物リストを作る
  * 必要に応じて家族や予定で微調整
  * 「大枠が整っている」安心感を持てる

---

## 7. ビジネスモデル・マネタイズ案

### 7-1. B2Cサブスクリプション（個人向け）

* 無料プラン

  * 食事記録（写真）
  * AIほめコメント：1日数回まで
  * 栄養サマリ：簡易版
* 有料プラン（月額）

  * AIほめコメント：回数制限なし
  * 栄養サマリ：詳細（週・月の傾向、パフォーマンスとの関係）
  * 1週間献立生成：月○回
  * PDFエクスポート等（家族共有使途）

### 7-2. B2B/B2B2C

* 学校・部活・クラブチーム・企業（健康経営）向け

  * 管理用ダッシュボード
  * 個人データは匿名・集計ベースで提供
  * チーム全体のパフォーマンス・コンディション傾向の把握

---

## 8. ロードマップ（案）

* フェーズ1：MVP

  * Web版（Vercel / Next.js）
  * 食事記録（写真アップロード）
  * AI栄養解析（目安レベル）
  * AIほめコメント
  * 簡易プロフィール
* フェーズ2：1週間献立・バッジ

  * 一汁三菜 × 1週間献立
  * バッジ・モチベーション機能
  * 栄養サマリ（週・月）
* フェーズ3：React Nativeアプリ

  * ExpoでiOS/Androidアプリ化
  * カメラ連携・PWAとの連携
  * Push通知・リマインド
* フェーズ4：B2B/B2G展開

  * 集計ダッシュボード
  * 学校・自治体・企業との連携

---

# 第二部　要件定義書

## 1. システム概要

### 1-1. システム名

「ほめごはん」栄養・パフォーマンス支援システム

### 1-2. 目的

* ユーザーの食事を写真ベースで記録し、AIが栄養情報とフィードバックを提供することで、

  * 日々の食習慣を改善し、
  * 身体的・知的パフォーマンスの向上を支援する。

---

## 2. 利用者・アクター

1. **一般ユーザー**

   * 自身の食事・パフォーマンス向上のために利用
2. **管理者（運営）**

   * 不適切コンテンツ対応
   * サービス運用・監視
3. **将来：組織管理者**

   * 学校・企業などでの利用状況集計を見る（v1では非対象）

---

## 3. 用語定義（主要）

* **Meal（食事記録）**：1回分の食事（写真＋メモ）
* **MealType**：朝／昼／夜／間食
* **PerformanceMode**：ユーザーが主に上げたいパフォーマンスカテゴリ
* **AI Nutrition Estimation**：AIによる画像ベースの栄養推定
* **WeeklyMenu**：1週間 × 朝昼晩 × 一汁三菜 の献立案
* **Badge**：ユーザーの行動・習慣に紐づく実績

---

## 4. 機能要件（FR）

IDごとに簡潔にまとめます。

### FR-01 認証・アカウント管理

* メールアドレス＋パスワードによるサインアップ／ログイン／ログアウト
* メール認証による本人確認
* パスワードリセット

### FR-02 プロファイル登録・編集

* 基本情報（ニックネーム・年齢帯・性別）
* パフォーマンスモード選択（複数選択可）
* 生活リズム（勤務形態・運動頻度）
* 食の制限・アレルギー
* 目標テキスト・目標期間

### FR-03 食事記録（Meal）

* 食事の登録：写真＋メモ＋時間＋種別
* 食事の編集・削除
* 日別・週別・一覧表示

### FR-04 AIによる栄養解析

* 写真アップロード後に、裏でAIが栄養情報を推定
* 推定内容：

  * 主な料理カテゴリ
  * 概算エネルギー
  * PFCバランス
  * 野菜・果物などの充足度の目安
* 解析結果をMealに紐づけて保存

#### FR-04-v2 エビデンスベース栄養解析（v2）

* **目的**: 栄養推定の根拠を明確化し、精度を向上
* **処理方式**:
  1. Gemini 3 Proで料理・材料・分量を認識
  2. `dataset_ingredients`（2,483件）からベクトル検索で材料マッチング
  3. 材料の栄養値（100gあたり）× 使用量で栄養計算
  4. `dataset_recipes`（11,707件）の類似レシピで検証
* **追加出力**:
  * 拡張栄養素（ビタミン、ミネラル、食物繊維等 約25種類）
  * エビデンス情報（マッチした材料、参照レシピ、信頼度スコア）
* **フォールバック**: マッチ失敗時はv1方式（LLM直接推定）を使用

### FR-05 AIほめコメント

* Meal＋栄養推定＋プロファイルを入力として、

  * 「ほめコメント本文」
  * 「一歩だけ改善アドバイス」
* 1食ごとに最新コメントを紐づけて表示

### FR-06 一汁三菜 × 1週間献立生成

* 週の開始日・補足情報を入力して、WeeklyMenuを生成
* 朝・昼・夜ごとに：

  * 主食（rice）
  * 汁物（soup）
  * 主菜（main）
  * 副菜（side）×2程度
* ユーザーのプロファイルと直近の栄養傾向を反映

### FR-07 栄養・パフォーマンスサマリ表示

* 期間（1週間／1ヶ月）ごとの：

  * PFCバランスの傾向
  * 野菜・果物の頻度
  * 朝食欠食状況等
* シンプルなグラフ・指標で表示

### FR-08 バッジ・実績

* 条件に応じたバッジ付与
* バッジ一覧画面での表示
* 新規取得時の通知

### FR-09 設定

* 通知ON/OFF（v1ではアプリ内のみの想定）
* プライバシーポリシー・利用規約表示
* アカウント削除（将来検討）

### FR-10 管理者向け機能

* 通報・フラグが立ったMeal一覧
* Meal非表示の切り替え
* ユーザーサマリの閲覧（軽度）

---

## 5. 非機能要件（NFR）

### NFR-01 性能

* Webページ表示：主要画面のTTFB 1〜2秒以内
* AI栄養解析：数秒〜数十秒許容（非同期）
* 週献立生成：数十秒〜数分許容（非同期）

### NFR-02 可用性

* 月間稼働率：99％目標
* 障害時：ステータスページ or SNS での告知（運用設計は別途）

### NFR-03 セキュリティ

* 通信はすべてHTTPS
* Supabase Row Level Security を利用したマルチテナントセキュリティ
* パスワードはSupabase Authに委譲（自前保存しない）
* OpenAI APIキーはサーバ側のみで保持

### NFR-04 プライバシー

* 実名・住所・電話番号は必須としない
* 食事・健康に関する情報は機微情報として取り扱う
* 未成年利用時には保護者向け注意事項を提示（表現は別途検討）

### NFR-05 拡張性

* React Native アプリからも同じバックエンドを利用可能なAPI設計
* モノレポ構成を前提とした共通ライブラリ化（TypeScript）

---

## 6. 外部インタフェース要件

* Supabase：

  * Postgres / Auth / Storage / Edge Functions
* OpenAI：

  * GPTによるテキスト生成（ほめコメント／献立）
  * Visionによる画像解析＆栄養推定
* 通知系（将来）：

  * Push通知サービス（Expo Push / Firebase Cloud Messaging 等）

---

## 7. 運用・保守要件（概要）

* ログ収集：

  * Supabaseログ
  * アプリ側のエラーログ
* モニタリング：

  * APIレスポンス時間
  * OpenAI利用量（コスト監視）
* バックアップ：

  * DBの定期バックアップ（Supabase標準機能利用）

---

## 8. 制約・前提

* バックエンドは Supabase + Next.js の BFF で構成
* 画像処理・AI処理はクラウド上で実施（端末内では行わない）
* 初期リリースはWeb（スマホブラウザメイン）、ネイティブアプリは第2フェーズ

---

# 第三部　基本設計書

## 1. 全体アーキテクチャ

### 1-1. 構成要素

1. **フロントエンド（Web）**

   * Next.js（App Router）
   * Vercelでホスティング

2. **フロントエンド（ネイティブ）※将来**

   * React Native / Expo
   * 同一APIを利用するクライアント

3. **BFF / API層**

   * Next.js の `/api/**` ルート
   * Supabase / OpenAI と通信

4. **バックエンド（データストア）**

   * Supabase（Postgres）
   * Auth / Storage（写真保存）

5. **AIサービス**

   * OpenAI GPT (Text / Vision)

6. **非同期ワーカー**

   * Node.js or Supabase Edge Functions
   * `recipe_requests` / `weekly_menu_requests` テーブルを監視し、
     GPT呼び出しを行う

### 1-2. 通信フロー（概要）

* クライアント → Next.js API → Supabase / OpenAI
* 一部処理（週献立生成など）は：

  * APIで「リクエスト登録」→ DBの `pending` レコード
  * ワーカーがそれをピックアップしてAI処理 → `completed` に更新
  * クライアントはポーリング or サーバ通知で結果を取得

---

## 2. モジュール構成（論理）

* `front-web` モジュール：

  * ページコンポーネント
  * UIコンポーネント
  * 認証ガード

* `front-mobile` モジュール（将来）：

  * RN画面コンポーネント
  * React Navigation構成

* `core` モジュール：

  * TypeScriptドメイン型（Meal, WeeklyMenu等）
  * Supabaseクライアントラッパ
  * APIクライアント（`/api` 呼び出し）
  * ビジネスロジック（バッジ条件判定など）

* `worker` モジュール：

  * 単品レシピ生成ワーカー
  * 週献立生成ワーカー
  * 将来：栄養解析をバッチで再計算する処理など

---

## 3. データ設計（概念レベル）

### 3-1. 主なエンティティ

* User
* UserProfile
* Meal
* MealNutritionEstimate
* MealAiFeedback
* RecipeRequest（単品レシピ）
* WeeklyMenuRequest（週献立）
* Badge
* UserBadge
* ModerationFlag

### 3-2. 関係

* User 1 - 1 UserProfile
* User 1 - N Meal
* Meal 1 - 0..1 MealNutritionEstimate
* Meal 1 - N MealAiFeedback
* Meal 1 - N RecipeRequest
* User 1 - N WeeklyMenuRequest
* WeeklyMenuRequest 1 - 0..1 WeeklyMenu（結果JSON）
* Badge 1 - N UserBadge（Userとの中間）

---

## 4. 画面設計（一覧＋遷移）

### 4-1. 初回オンボーディング画面群

* S0 スプラッシュ
* S1 ウェルカム・サービス紹介
* S2 アカウント作成/ログイン選択
* S3 メール登録・パスワード設定
* S4 メール認証待ち
* S5 プロファイル Step1: 基本情報
* S6 プロファイル Step2: パフォーマンスモード
* S7 プロファイル Step3: 生活リズム
* S8 プロファイル Step4: 食の制限
* S9 プロファイル Step5: 目標設定
* S10 オンボーディング完了
* S11 ホーム（初回表示）

（すでに流れは会話で整理済みの通り）

### 4-2. 日常利用の主要画面

* ホーム画面

  * 今日の食事カード
  * 「＋ 食事を記録」ボタン
* 食事撮影・記録画面
* 食事詳細画面（AI栄養・ほめコメント表示）
* 栄養サマリ画面
* 1週間献立一覧画面
* 1週間献立生成画面
* 1週間献立詳細画面
* バッジ一覧画面
* プロファイル設定画面
* 設定画面

---

## 5. API一覧（概要）

* `/api/auth/*`（Supabase Auth利用なので、直接利用が多い）
* `/api/profile`

  * GET / PUT
* `/api/meals`

  * GET（一覧） / POST（新規）
* `/api/meals/[id]`

  * GET / PATCH / DELETE
* `/api/ai/nutrition`（画像アップロード時に叩く or ワーカー向け）
* `/api/ai/feedback`

  * POST（ほめコメント生成）
* `/api/ai/recipe/request`

  * POST（単品レシピ生成リクエスト）
* `/api/ai/recipe/[id]`

  * GET（単品レシピ結果）
* `/api/ai/menu/weekly/request`

  * POST（週献立生成リクエスト）
* `/api/ai/menu/weekly/[id]`

  * GET（週献立結果）
* `/api/badges`

  * GET（ユーザーのバッジ一覧）
* `/api/menus/weekly` / `/api/recipes` などの一覧API

---

## 6. 非同期処理・バッチ概要

* 非同期対象：

  * 画像栄養解析（必要なら）
  * 単品レシピ生成
  * 週献立生成
* 基本方式：

  * `*_requests` テーブルに `pending` レコードを作成
  * ワーカーがポーリングして処理
  * 結果を `completed` として保存

---

## 7. セキュリティ概要（基本設計レベル）

* 認証：

  * Supabase Auth
* 認可：

  * Postgres Row Level Security
* API：

  * Next.js APIでは、`supabase.auth.getUser()` でユーザー確認
* 秘密情報：

  * OpenAI APIキーはサーバ環境変数で管理
  * .env を通じてデプロイ時に設定

---

# 第四部　詳細設計書

ここから、より技術的な詳細に踏み込みます。

---

## 1. データベース詳細設計（テーブル）

### 1-1. user_profiles

| カラム        | 型           | 制約                      | 説明            |
| ---------- | ----------- | ----------------------- | ------------- |
| id         | uuid        | PK, FK → auth.users(id) | ユーザーID        |
| nickname   | text        | NOT NULL                | ニックネーム        |
| age_group  | text        | NOT NULL                | 年齢帯（enum的に利用） |
| gender     | text        | NOT NULL                | 性別            |
| goal_text  | text        |                         | 目標            |
| perf_modes | text[]      |                         | パフォーマンスモード配列  |
| lifestyle  | jsonb       |                         | 生活リズム情報       |
| diet_flags | jsonb       |                         | 食の制限情報        |
| created_at | timestamptz | default now()           | 作成日時          |
| updated_at | timestamptz | default now()           | 更新日時          |

### 1-2. meals

| カラム        | 型           | 制約                  | 説明       |
| ---------- | ----------- | ------------------- | -------- |
| id         | uuid        | PK                  | 食事ID     |
| user_id    | uuid        | FK → auth.users(id) | ユーザーID   |
| eaten_at   | timestamptz | NOT NULL            | 食べた日時    |
| meal_type  | text        | NOT NULL            | 朝/昼/夜/間食 |
| photo_url  | text        |                     | ストレージURL |
| memo       | text        |                     | メモ       |
| created_at | timestamptz | default now()       | 作成日時     |
| updated_at | timestamptz | default now()       | 更新日時     |

### 1-3. meal_nutrition_estimates

| カラム          | 型           | 制約             | 説明           |
| ------------ | ----------- | -------------- | ------------ |
| id           | uuid        | PK             | 推定ID         |
| meal_id      | uuid        | FK → meals(id) | 対象Meal       |
| energy_kcal  | numeric     |                | 概算エネルギー      |
| protein_g    | numeric     |                | たんぱく質        |
| fat_g        | numeric     |                | 脂質           |
| carbs_g      | numeric     |                | 炭水化物         |
| veg_score    | integer     |                | 野菜スコア（0〜5程度） |
| quality_tags | text[]      |                | 「高タンパク」などのタグ |
| raw_json     | jsonb       |                | AIレスポンス生データ  |
| created_at   | timestamptz | default now()  |              |

### 1-4. meal_ai_feedbacks

| カラム           | 型           | 説明       |
| ------------- | ----------- | -------- |
| id            | uuid PK     |          |
| meal_id       | uuid FK     |          |
| feedback_text | text        | ほめコメント本文 |
| advice_text   | text        | 一歩改善     |
| model_name    | text        | 使用モデル    |
| created_at    | timestamptz |          |

### 1-5. recipe_requests / weekly_menu_requests / badges / user_badges / moderation_flags

（前のメッセージでほぼ定義した通りなので、ここでは省略せずに構造を踏襲）

※実際のSQLはすでに提示したものを使う想定。

---

## 2. ドメインモデル（TypeScript）

※コードは全量記載します。

```ts
// types/domain.ts

export type ISODateTimeString = string;
export type ISODateString = string;

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export type AgeGroup =
  | 'under_18'
  | 'age_19_29'
  | 'age_30_39'
  | 'age_40_49'
  | 'age_50_plus';

export type Gender = 'male' | 'female' | 'other' | 'unspecified';

export type PerformanceMode =
  | 'sports'
  | 'physical_work'
  | 'knowledge_work'
  | 'study'
  | 'creative'
  | 'shift_work'
  | 'family_support'
  | 'longevity';

export interface LifestyleInfo {
  workStyle: 'desk' | 'stand' | 'physical' | 'shift';
  exerciseLevel: 'none' | 'light_1_2' | 'regular_3plus';
  notes?: string | null;
}

export interface DietFlags {
  allergies?: string[];
  restrictions?: string[];
  dislikes?: string[];
}

export interface UserProfile {
  id: string;
  nickname: string;
  ageGroup: AgeGroup;
  gender: Gender;
  goalText: string | null;
  performanceModes: PerformanceMode[];
  lifestyle: LifestyleInfo | null;
  dietFlags: DietFlags | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

export interface Meal {
  id: string;
  userId: string;
  eatenAt: ISODateTimeString;
  mealType: MealType;
  photoUrl: string | null;
  memo: string | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

export interface MealNutritionEstimate {
  id: string;
  mealId: string;
  energyKcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  vegScore: number | null; // 0-5
  qualityTags: string[];
  rawJson: any;
  createdAt: ISODateTimeString;
}

export interface MealAiFeedback {
  id: string;
  mealId: string;
  feedbackText: string;
  adviceText: string | null;
  modelName: string;
  createdAt: ISODateTimeString;
}

export type RecipeRequestStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export interface RecipeRequest {
  id: string;
  userId: string;
  baseMealId: string;
  status: RecipeRequestStatus;
  prompt: string;
  resultText: string | null;
  errorMessage: string | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

export type DishRole = 'rice' | 'soup' | 'main' | 'side';

export interface Dish {
  role: DishRole;
  name: string;
  description: string;
}

export type DayMealType = 'breakfast' | 'lunch' | 'dinner';

export interface DailyMealSet {
  mealType: DayMealType;
  dishes: Dish[];
  note?: string | null;
}

export interface WeeklyMenuDay {
  date: ISODateString;
  meals: DailyMealSet[];
}

export interface WeeklyMenu {
  id: string;
  userId: string;
  startDate: ISODateString;
  goalSummary?: string | null;
  createdAt: ISODateTimeString;
  days: WeeklyMenuDay[];
}

export type WeeklyMenuRequestStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export interface WeeklyMenuRequest {
  id: string;
  userId: string;
  startDate: ISODateString;
  status: WeeklyMenuRequestStatus;
  prompt: string;
  resultJson: WeeklyMenu | null;
  errorMessage: string | null;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
}

export interface Badge {
  id: string;
  code: string;
  name: string;
  description: string;
  conditionJson: any;
}

export interface UserBadge {
  userId: string;
  badgeId: string;
  obtainedAt: ISODateTimeString;
}
```

---

## 3. API詳細設計（代表的なもの）

### 3-1. 食事一覧取得 `/api/meals` GET

* 認証：必須（JWT）
* クエリパラメータ：

  * `date`: `YYYY-MM-DD`（任意）
* レスポンス例：

```json
{
  "meals": [
    {
      "id": "uuid",
      "userId": "uuid",
      "eatenAt": "2025-01-01T08:00:00Z",
      "mealType": "breakfast",
      "photoUrl": "https://...",
      "memo": "トーストと卵",
      "createdAt": "2025-01-01T08:10:00Z",
      "updatedAt": "2025-01-01T08:10:00Z"
    }
  ]
}
```

### 3-2. 食事登録 `/api/meals` POST

* リクエストBody：

```json
{
  "eatenAt": "2025-01-01T12:30:00Z",
  "mealType": "lunch",
  "photoUrl": "https://...",
  "memo": "牛丼大盛り"
}
```

* レスポンス：作成されたMealオブジェクト

### 3-3. AI栄養解析 `/api/ai/nutrition` POST

* 入力：

  * Meal ID または 画像ファイル

* 方式案：

  1. 写真アップロード後に `mealId` を渡す
  2. API側でStorageから画像を取り出し、OpenAI Visionに投げる

* リクエスト例（JSON版）：

```json
{
  "mealId": "uuid"
}
```

* レスポンス：

```json
{
  "estimate": {
    "mealId": "uuid",
    "energyKcal": 650,
    "proteinG": 22,
    "fatG": 20,
    "carbsG": 90,
    "vegScore": 2,
    "qualityTags": ["high_carb", "low_veggie"]
  }
}
```

※ 実際にはVision APIのレスポンスをラップする実装が必要。

### 3-3-v2. 栄養解析（v2 / エビデンスベース） `/api/ai/analyze-meal-photo-v2` POST

* 入力：
  * 食事写真（Base64 × 1枚以上）
  * mealType（breakfast/lunch/dinner/snack/midnight_snack）
  * mealId（既存献立更新時のみ）

* リクエスト例：

```json
{
  "images": [{"base64": "...", "mimeType": "image/jpeg"}],
  "mealType": "lunch",
  "mealId": "uuid (optional)"
}
```

* レスポンス：

```json
{
  "dishes": [
    {
      "name": "鶏の照り焼き",
      "role": "main",
      "calories_kcal": 350,
      "protein_g": 25.5,
      "carbs_g": 12.0,
      "fat_g": 18.5,
      "ingredient": "鶏もも肉",
      "ingredients": [
        {
          "name": "鶏もも肉",
          "amount_g": 120,
          "matched": {
            "id": "uuid",
            "name": "鶏肉 もも 皮つき 生",
            "similarity": 0.92
          },
          "nutrition": {
            "calories_kcal": 253,
            "protein_g": 21.2
          }
        }
      ]
    }
  ],
  "totalCalories": 550,
  "totalProtein": 32.0,
  "totalCarbs": 65.0,
  "totalFat": 22.0,
  "nutrition": {
    "sodiumG": 2.1,
    "fiberG": 3.5,
    "calciumMg": 45,
    "ironMg": 1.8,
    "vitaminCMg": 12,
    "potassiumMg": 450,
    "magnesiumMg": 35
  },
  "evidence": {
    "calculationMethod": "ingredient_based",
    "matchedIngredients": [
      {
        "input": "鶏もも肉",
        "matchedName": "鶏肉 もも 皮つき 生",
        "matchedId": "uuid",
        "similarity": 0.92,
        "amount_g": 120
      }
    ],
    "referenceRecipes": [
      {
        "id": "uuid",
        "name": "鶏の照り焼き定食",
        "similarity": 0.85,
        "calories_kcal": 520,
        "protein_g": 28
      }
    ],
    "verification": {
      "isVerified": true,
      "calculatedCalories": 550,
      "referenceCalories": 520,
      "deviationPercent": 5.7
    },
    "confidenceScore": 0.88
  },
  "overallScore": 82,
  "vegScore": 45,
  "praiseComment": "タンパク質たっぷりで筋肉の味方ですね！",
  "nutritionTip": "鶏もも肉はビタミンB群が豊富で疲労回復に効果的"
}
```

* 処理フロー：
  1. Gemini 3 Pro で画像認識（料理・材料・分量推定）
  2. 材料名をEmbedding生成（text-embedding-3-large, 1536次元）
  3. `dataset_ingredients` をベクトル検索
  4. 栄養計算（材料の栄養/100g × 使用量g）
  5. `dataset_recipes` で類似レシピ検索・検証
  6. `planned_meals` に全栄養素を保存

* フォールバック：
  * 材料マッチング失敗 → v1方式（LLM直接推定）

### 3-4. AIほめコメント `/api/ai/feedback` POST

* リクエスト：

```json
{
  "mealId": "uuid"
}
```

* 処理：

  1. Meal, MealNutritionEstimate, UserProfile を取得
  2. プロンプトを生成
  3. OpenAI GPTに投げる
* レスポンス：

```json
{
  "mealId": "uuid",
  "feedbackText": "昼からしっかり炭水化物とたんぱく質が取れていて、とても良いバランスです！...",
  "adviceText": "次は具だくさんの汁物を加えると、野菜と水分も一緒にとれてさらに◎です。"
}
```

### 3-5. 週献立生成 `/api/ai/menu/weekly/request` POST

* リクエスト：

```json
{
  "startDate": "2025-01-06",
  "note": "週末にフルマラソンがあります。平日は残業多め。"
}
```

* レスポンス：

```json
{
  "requestId": "uuid",
  "status": "pending"
}
```

* その後 `/api/ai/menu/weekly/{id}` GET で結果を取得。

### 3-6. 汎用献立生成 `/api/ai/menu/v4/generate` POST

**概要:** 指定されたスロットに対して献立を生成する汎用API

**リクエスト:**

```json
{
  "targetSlots": [
    { "date": "2026-01-03", "mealType": "lunch" },
    { "date": "2026-01-03", "mealType": "dinner" },
    { "date": "2026-01-04", "mealType": "breakfast" }
  ],
  "existingMenus": [
    { "date": "2026-01-02", "mealType": "dinner", "dishName": "鶏の照り焼き", "status": "completed", "isPast": true },
    { "date": "2026-01-03", "mealType": "breakfast", "dishName": "白米ご飯", "status": "ai", "isPast": false }
  ],
  "fridgeItems": [
    { "name": "鶏むね肉", "expirationDate": "2026-01-05", "quantity": "300g" },
    { "name": "キャベツ", "expirationDate": "2026-01-07" }
  ],
  "note": "今週は仕事が忙しいので、時短料理でお願いします。金曜は飲み会があるのでスキップ。",
  "constraints": {
    "useFridgeFirst": true,
    "quickMeals": true,
    "japaneseStyle": false,
    "avoidDuplicates": true,
    "cookingTime": { "weekday": 20, "weekend": 40 }
  },
  "familySize": 2
}
```

**レスポンス:**

```json
{
  "status": "processing",
  "requestId": "uuid",
  "estimatedSlots": 3,
  "message": "3食分の献立を生成中..."
}
```

**パラメータ詳細:**

| パラメータ | 必須 | 型 | 説明 |
|-----------|-----|-----|------|
| targetSlots | ◯ | array | 生成対象スロット（最大93件=31日×3食） |
| existingMenus | △ | array | 既存献立（省略時は自動収集） |
| fridgeItems | △ | array | 冷蔵庫食材（省略時は自動収集） |
| note | × | string | ユーザーの自由記述要望 |
| constraints | × | object | 生成条件 |
| familySize | × | number | 家族人数（省略時はプロファイルから） |
| userProfile | × | object | ユーザー情報（省略時は自動収集） |
| seasonalContext | × | object | 季節情報（省略時は自動計算） |

**constraints詳細:**

| フィールド | 型 | デフォルト | 説明 |
|-----------|-----|-----------|------|
| useFridgeFirst | boolean | true | 冷蔵庫食材を優先使用 |
| quickMeals | boolean | false | 時短料理中心 |
| japaneseStyle | boolean | false | 和食中心 |
| healthy | boolean | false | ヘルシー志向 |
| themes | string[] | [] | テーマ（例: "中華", "イタリアン"） |
| ingredients | string[] | [] | 使いたい食材 |
| cookingTime | object | null | 調理時間制限（分） |
| cheatDay | string | null | チートデイ（日付） |
| avoidDuplicates | boolean | true | 重複を避ける |

### 3-7. ユーザー設定更新 `/api/user/preferences` PATCH

**概要:** ユーザーの買い物パターン・調理器具などの設定を更新

**リクエスト:**

```json
{
  "shopping_frequency": "weekly",
  "weekly_food_budget": 15000,
  "cooking_equipment": {
    "has_oven": true,
    "has_grill": true,
    "has_pressure_cooker": false,
    "stove_type": "gas"
  }
}
```

**レスポンス:**

```json
{
  "success": true,
  "message": "設定を更新しました"
}
```

---

## 4. AI処理詳細設計

### 4-1. 栄養推定（Vision）

1. 入力：

   * 食事写真のURL
2. 手順：

   1. 画像URL＋指示文をVisionモデルに渡す
   2. JSON形式での出力を強制（栄養推定スキーマを明示）
   3. 例として、以下のようなJSON出力を期待：

```json
{
  "dishes": [
    { "name": "白ごはん", "category": "grain", "approx_grams": 180 },
    { "name": "焼き鮭", "category": "protein", "approx_grams": 80 },
    { "name": "味噌汁（豆腐とわかめ）", "category": "soup", "approx_grams": 200 },
    { "name": "ほうれん草のおひたし", "category": "vegetable", "approx_grams": 60 }
  ],
  "nutrition": {
    "energy_kcal": 650,
    "protein_g": 30,
    "fat_g": 18,
    "carbs_g": 85
  },
  "veg_score": 4,
  "quality_tags": ["balanced", "good_protein", "good_veggies"]
}
```

3. 出力をDBの `meal_nutrition_estimates` に保存

4. 設計上のポイント（3ステップ根拠）：

   1. Visionモデル単体だと表現が自由すぎるため、**JSONスキーマを強制**する
   2. カテゴリ分類（grain/protein/vegetable等）を行うことで、
      後段のパフォーマンスロジックで扱いやすくする
   3. 数値はあくまで「目安」とし、コメント生成や献立生成用の**特徴量**として使う

### 4-1-v2. 栄養推定（エビデンスベース / v2）

v1の課題（LLM直接推定で根拠がない）を解決するため、材料ベースの栄養計算を行う。

**処理パイプライン:**

```
┌─────────────────────────────────────────────────────────────┐
│  Step 1: 画像認識（Gemini 3 Pro）                           │
│  ・料理名、役割（main/side/soup等）を認識                    │
│  ・各料理の材料と分量（g）を推定                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: 材料マッチング                                      │
│  ・材料名 → Embedding生成（text-embedding-3-large, 1536次元）│
│  ・dataset_ingredients（2,483件）をベクトル検索              │
│  ・上位5件からLLMが最適候補を選択                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3: 栄養計算                                            │
│  ・材料の栄養 = (栄養/100g) × 使用量(g) × (1-廃棄率)         │
│  ・食事全体の栄養 = Σ各材料の栄養                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4: エビデンス検証                                      │
│  ・dataset_recipes（11,707件）から類似レシピ検索             │
│  ・計算値と参照値を比較（偏差20%以内→OK）                    │
│  ・大幅な乖離→警告付きで採用 or 調整                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 5: 結果保存                                            │
│  ・planned_meals に全栄養素（約30カラム）を保存              │
│  ・generation_metadata にエビデンス情報を保存                │
└─────────────────────────────────────────────────────────────┘
```

**使用するDBテーブル:**

| テーブル | 件数 | 用途 |
|---------|------|------|
| `dataset_ingredients` | 2,483 | 食材ごとの栄養値（日本食品標準成分表ベース） |
| `dataset_recipes` | 11,707 | レシピごとの栄養値（検証用参照） |

**フォールバック戦略:**

| 状況 | 対応 |
|------|------|
| 材料マッチング失敗 | テキスト類似度検索（pg_trgm）にフォールバック |
| 全材料マッチ失敗 | v1方式（LLM直接推定）にフォールバック |
| 検証で大幅な乖離 | 計算値を採用、confidenceScore低下 |

**出力に追加されるフィールド:**

```typescript
evidence: {
  calculationMethod: "ingredient_based",
  matchedIngredients: [...],     // マッチした材料情報
  referenceRecipes: [...],       // 参照したレシピ
  verification: { ... },         // 検証結果
  confidenceScore: 0.88          // 信頼度スコア
}
```

### 4-2. AIほめコメント

* Systemプロンプト（要旨）：

  * 「あなたは栄養とパフォーマンスに詳しいコーチです」
  * 「必ず良い点から入り、最後に小さな改善案を出す」
  * 「減らす・我慢するトーンは避け、ポジティブな提案にする」
* Inputに含める情報：

  * ユーザープロファイル（年齢帯・パフォーマンスモード）
  * Meal情報（時間帯・種別）
  * 栄養推定結果（PFC, veg_score 等）
* 出力フォーマット：

  * 本文（200〜400文字）
  * 一歩改善の一文（50〜150文字）

### 4-3. 1週間献立生成

* System：

  * 「日本の家庭料理に詳しい栄養アドバイザー兼料理研究家」
  * 一汁三菜の定義を明示
  * JSONスキーマ（WeeklyMenu型）を提示
* User：

  * ユーザープロファイル
  * 週の開始日
  * 今週の状況（note）
  * 直近1週間の栄養傾向要約（サーバ側で集計して渡す）
* 出力：

  * WeeklyMenu JSON（型に完全準拠）

### 4-4. 汎用献立生成（V4）

**概要:** 指定されたスロットに対して、コンテキスト（既存献立、冷蔵庫、旬、イベント、器具、買い物パターン）を踏まえて献立を生成

**処理フロー:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: コンテキスト構築（約5秒）                              │
│  ├── 既存献立の取得（動的範囲）                                 │
│  ├── 冷蔵庫食材の取得                                           │
│  ├── ユーザープロファイルの取得                                 │
│  ├── 旬の食材リストの構築                                       │
│  └── イベント行事の抽出                                         │
├─────────────────────────────────────────────────────────────────┤
│  Step 2: LLMプロンプト構築                                      │
│  ├── システムプロンプト（栄養士ロール）                         │
│  ├── コンテキスト注入（既存献立、冷蔵庫、旬、イベント）         │
│  ├── 制約条件（アレルギー、器具、買い物パターン）               │
│  └── ユーザー要望（自然言語）                                   │
├─────────────────────────────────────────────────────────────────┤
│  Step 3: 献立生成（日単位並列）                                 │
│  └── 各日のbreakfast/lunch/dinnerを生成                         │
├─────────────────────────────────────────────────────────────────┤
│  Step 4: 栄養計算（dataset_ingredientsベクトル検索）            │
│  └── 材料名→栄養値マッチング→積算                              │
├─────────────────────────────────────────────────────────────────┤
│  Step 5: 対象スロットのみ保存                                   │
│  └── targetSlotsに含まれるスロットのみplanned_mealsを更新       │
└─────────────────────────────────────────────────────────────────┘
```

**LLMプロンプト構成:**

* System:
  * 「日本の家庭料理に詳しい栄養アドバイザー兼料理研究家」
  * 一汁三菜の定義を明示
  * JSONスキーマ（GeneratedMeal型）を提示

* Context（注入情報）:
  * **既存献立**（過去7日〜未来7日、ステータス区別付き）
  * **冷蔵庫食材**（賞味期限付き）
  * **旬の食材**（月ベース：野菜/魚/果物）
  * **イベント行事**（日付に該当する場合）
  * **調理器具**（使える/使えない）
  * **買い物パターン**（まとめ買い→使い回し重視 / 毎日→鮮度重視）

* User:
  * 生成対象スロット一覧
  * ユーザー要望（自然言語）
  * 制約条件（アレルギー、調理時間、ヘルシー志向など）

* 出力:
  * GeneratedMealV4 JSON（型に完全準拠）

**GeneratedMealV4型:**

```typescript
interface GeneratedMealV4 {
  date: string;
  mealType: MealType;
  dishName: string;
  dishes: Array<{
    name: string;
    role: 'rice' | 'soup' | 'main' | 'side';
    ingredients: Array<{
      name: string;
      amount_g: number;
      note?: string;
    }>;
    instructions?: string[];
  }>;
  reasoning?: string; // なぜこの献立にしたか
  seasonalNote?: string; // 旬の食材を使った理由
  fridgeNote?: string; // 冷蔵庫食材を使った理由
}
```

**旬の食材の注入例:**

```
【1月の旬の食材】
■ 野菜: 白菜, 大根, ほうれん草, 小松菜, ねぎ, ブロッコリー, かぶ, れんこん
■ 魚介: ぶり, たら, かに, ふぐ, あんこう, 金目鯛, 牡蠣
■ 果物: みかん, りんご, いちご, きんかん

これらの食材を積極的に取り入れて、季節感のある献立を提案してください。
```

**イベント行事の注入例:**

```
【対象期間のイベント】
■ 1月1日: お正月
  - おすすめ料理: おせち料理, お雑煮, お屠蘇
  - おすすめ食材: 餅, 数の子, 黒豆
  - 備考: 1/1〜1/3

ユーザーの希望に応じて、イベントに関連した料理を提案してください。
```

**買い物パターンの注入例:**

```
【ユーザーの買い物パターン】
■ 頻度: 週1回まとめ買い
■ 予算: 週15,000円

週の前半は鮮度が重要な食材（魚、葉物野菜）を使い、
後半は日持ちする食材（根菜、乾物、冷凍食品）を活用する献立にしてください。
```

---

## 5. 非同期ワーカー詳細（疑似コード）

```ts
// 擬似コードイメージ

while (true) {
  // 1. 単品レシピジョブを処理
  const recipeJobs = await fetchPendingRecipeRequests(3);
  for (const job of recipeJobs) {
    await markRecipeProcessing(job.id);
    try {
      const prompt = job.prompt; // 事前生成
      const resultText = await callOpenAiForRecipe(prompt);
      await markRecipeCompleted(job.id, resultText);
    } catch (e) {
      await markRecipeFailed(job.id, String(e));
    }
  }

  // 2. 週献立ジョブを処理
  const weeklyJobs = await fetchPendingWeeklyMenuRequests(1);
  for (const job of weeklyJobs) {
    await markWeeklyMenuProcessing(job.id);
    try {
      const prompt = job.prompt;
      const menuJson = await callOpenAiForWeeklyMenu(prompt);
      const menu = JSON.parse(menuJson);
      await markWeeklyMenuCompleted(job.id, menu);
    } catch (e) {
      await markWeeklyMenuFailed(job.id, String(e));
    }
  }

  // 3. スリープ
  await sleep(15000);
}
```

---

## 6. クライアント詳細設計（Web）

### 6-1. Next.js App Router 構成（再掲＋整理）

```txt
app/
  layout.tsx
  (auth)/
    layout.tsx
    login/page.tsx
  (main)/
    layout.tsx
    page.tsx              // ホーム
    meals/
      new/page.tsx        // 食事登録
      [id]/page.tsx       // 食事詳細
    menus/
      weekly/
        page.tsx          // 週献立一覧＋生成
        [id]/page.tsx     // 週献立詳細
    profile/page.tsx
    badges/page.tsx
    settings/page.tsx
  api/
    meals/route.ts
    meals/[id]/route.ts
    profile/route.ts
    ai/
      nutrition/route.ts
      feedback/route.ts
      recipe/request/route.ts
      recipe/[id]/route.ts
      menu/weekly/request/route.ts
      menu/weekly/[id]/route.ts
```

### 6-2. React Native側展開（将来）

* `apps/mobile`（Expo）
* 画面：

  * HomeScreen
  * CaptureMealScreen
  * MealDetailScreen
  * WeeklyMenuListScreen
  * WeeklyMenuDetailScreen
  * ProfileScreen
* APIクライアント／型は `packages/core` を import

---

## 7. 認証・認可詳細

1. クライアント（Web/Native）はSupabase Authを利用
2. 認証後のリクエストでは、Supabaseのセッション or JWTを添付
3. API側では `supabase.auth.getUser()` でユーザー識別
4. DBのRLSで `user_id = auth.uid()` 以外のデータへアクセス不可
5. 管理者向け機能はサービスロールキー or カスタムクレームで制御

---

## 8. ロギング・モニタリング・エラー処理

* エラー時の基本方針：

  * ユーザーに見せるのは簡潔なメッセージ（「生成に失敗しました」など）
  * 詳細はサーバログに残す（OpenAIレスポンス含め）
* モニタリング指標：

  * APIのエラーレート／レスポンスタイム
  * OpenAI呼び出し成功率
  * ワーカーのジョブ滞留数（pendingの数）

---

## 9. 環境変数一覧

* `NEXT_PUBLIC_SUPABASE_URL`
* `NEXT_PUBLIC_SUPABASE_ANON_KEY`
* `SUPABASE_URL`
* `SUPABASE_SERVICE_ROLE_KEY`
* `OPENAI_API_KEY`
* `NEXT_PUBLIC_APP_NAME`

---

ここまでで、

* 企画書（コンセプト〜ターゲット〜価値）
* 要件定義（機能／非機能／制約）
* 基本設計（アーキ・画面・データ・API一覧）
* 詳細設計（DB／ドメインモデル／API I/F／AI処理／ワーカー／クライアント構成）

まで一通りつながった形になっています。

---

# 追記（2025-12-24）モバイルアプリ（React Native / Expo）設計

## 1. 方針（Store公開前提）
- iOS/Android を **Expo + EAS** で配布（App Store / Google Play）
- **モノレポ**で Web と Mobile を同一リポジトリで管理
- 秘密情報（`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `GOOGLE_*_API_KEY`）は **端末に置かない**

## 2. モノレポ構成（段階移行）
当面は既存Webをルートのまま維持しつつ、`apps/mobile` と `packages/core` を追加して動かします。
最終的には `apps/web` に移動して完全な `apps/*` 構成へ。

```txt
homegohan-app/
├── apps/
│   └── mobile/                 # Expo（iOS/Android）
├── packages/
│   └── core/                   # 共有: 型/バリデーション/APIクライアント/共通ロジック
├── src/                        # 既存Web（最終的に apps/web へ移動）
└── supabase/                   # Edge Functions / migrations
```

## 3. 共有方針（`packages/core`）
- 型（ドメイン/DB）、Zodスキーマ、APIクライアント、共通ユーティリティを段階的に移管
- 「まずモバイルで必要になった箇所から」移行し、Web側も随時 `packages/core` に寄せる

## 4. 認証/データアクセス
- モバイルは **Supabase Auth** を使用し、端末にセッションを永続化
- 通常CRUDは **Supabase（RLS）を直接利用**（端末は anon key + user JWT）
- AI処理は **Edge Functions / Next.js API（BFF）** を利用（秘密鍵はサーバ側のみ）

> 注意: 現状の Next.js API は `@supabase/ssr` により Cookie セッション前提が多いため、モバイルから同APIを叩く場合は Bearer(JWT) 対応が必要。移行期間は「モバイルは Supabase直 + Edge Functions（JWT必須）」を基本とする。

## 5. 配布（EAS）
- `development / preview / production` のビルドプロファイルで運用
- Secrets は EAS Secrets と `EXPO_PUBLIC_*` を使い分け、リポジトリに秘密情報を残さない

---

# 追記（2025-12-30）データセット駆動の献立生成（v2：全ユーザーにデフォルト適用）

## 1. 目的・背景

現状の献立生成は「LLMに“巨大JSON＋ミクロ栄養まで”を生成させる」比重が大きく、以下が課題になる：

- **数値の欠損/取り違え**：週次（7日×3食×複数品×多栄養項目）で出力が破綻しやすい
- **根拠の曖昧さ**：ミクロ栄養の数値が“推定/発明”になりやすい

そこで、スクレイプ済みの **献立セット（1行=1食）** と **レシピ（1行=1品）** を **DBに取り込み**、栄養値は“データが真実”として扱う。
LLM（GPT）は **管理栄養士としての味付け（ID選定/差し替え/文章）**に専念させる。

また、OpenAIの File Search（Vector Store / `file_search`）は便利だが、公式ドキュメント上 **構造化データ（CSV/JSONL等）の厳密なretrieval** や **カスタムmetadataによる決定的フィルタ** が既知の制約として挙げられている。
このため v2 のクリティカルパス（IDで1行を確実に引く、栄養カラムで厳密フィルタ等）を RAG に依存しない。
（参照：[`Assistants File Search` ドキュメント](https://platform.openai.com/docs/assistants/tools/file-search)）

## 2. 用語・前提

- **献立セット（Menu Set）**：1行=1食。最大5品（主菜/副菜/主食/汁物等）と、**合計栄養（ミクロ栄養含む）**を持つ
- **レシピ（Recipe）**：1行=1品。材料・作り方・**料理単位の栄養（ミクロ栄養含む）**を持つ
- **データセット**：外部ソース（例：oishi-kenko）由来の献立セット/レシピの集合。DBへ取り込み、バージョニングする
- **食材栄養（Ingredient / Food composition）**：1行=1食材（原則100gあたりの栄養）。`dataset_ingredients` に保持し、表記揺れに強い検索（`pg_trgm`/`pgvector`）を提供する
- **派生レシピ（Derived Recipe）**：既存レシピ（DB原型）をベースに「材料/手順」を編集して作るレシピ。`derived_recipes` に永続化し、栄養は `dataset_ingredients` を参照して合算する（根拠DB）
- **v2の原則**：
  - 栄養値（ミクロ栄養含む）は **AIに生成させない**。DBの確定値を `planned_meals` に写す
  - **相性（組み合わせの自然さ）はRDBで決め打ちしない**。献立例（RAG）を参照し、LLMが文脈判断する
  - **料理名はDBに存在しなくてもよい**（レパートリー拡張）。ただし“未登録”は必ず **DB根拠**を持たせる
    - **proxy**：近傍の既存レシピへ紐づけ（`base_recipe_id`）し、材料/作り方/栄養を確定（最短で確実）
    - **derived（推奨）**：DB原型（`base_dataset_recipe_id`）をベースに材料/手順を生成し、栄養は `dataset_ingredients` を参照して合算し `derived_recipes` に永続化
  - Vector Store（RAG）は **献立例の取得（相性判断の根拠）** と **近い料理/近い献立の探索** に積極利用する
  - 構造化データ（栄養表・材料・手順）は **DBが真実**。RAGから“数値”を確定しない

## 3. 追加/変更要件（要件定義の追記）

### FR-06-v2 一汁三菜 × 1週間献立生成（データセット駆動）
- 7日×3食 = **21枠**に対して、各枠の **料理リスト（複数品）**を生成する
- ユーザー制約（アレルギー/嗜好/健康状態/調理条件/家族人数）を満たす
- **相性の自然さ**は、献立例（RAG）を根拠にLLMが判断する
- 週生成時点で、各枠の **料理詳細（材料/作り方/料理単位ミクロ栄養）**を `planned_meals.dishes` にキャッシュする
- 料理名が未登録でも許容するが、各料理は **proxy（base_recipe_id）** に必ず紐づけて数値を確定する

### FR-06-v2a 単発生成/再生成（差し替え）
- **単発生成**：指定日×食事タイプ1枠に対して料理リストを生成し、詳細までキャッシュ
- **再生成（差し替え）**：既存枠の料理リストを差し替え（「最小差分で自然に」「栄養課題を改善」など）

### FR-06-v2b 派生レシピ生成（DB原型＋食材栄養DB）
- ユーザー要望や献立の味付けのために、**データセットに存在しない料理名**（例：麻婆豆腐→麻婆茄子）を提案できる
- ただし派生レシピは必ず **DB原型** を持つ（`derived_recipes.base_dataset_recipe_id`）
- LLM出力は **材料をg単位**で返す（`ingredients[].amount_g`）。`ingredients[].name` は「食材名のみ」にし、切り方/用途/補足は `ingredients[].note` に入れる
- 食材名は `dataset_ingredients` に対して **(1)正規化一致 → (2)pg_trgm → (3)pgvector** の順に解決し、**100gあたり栄養 × amount_g/100** で合算する
- 派生レシピは `derived_recipes` に保存し、後日 **再利用/品質評価/帳票**に利用できる
- 食材の名前解決率（`mapping_rate`）が閾値未満の場合は `warnings` を付与し、（プロダクト方針に応じて）ハード制約判定から除外/ユーザー承認/代理レシピ（proxy）へフォールバックできる

### NFR-06-v2 性能/信頼性
- 週生成は **数十秒〜数分**を許容（非同期）
- ジョブは `weekly_menu_requests` により **状態管理（pending/processing/completed/failed）**し、**再試行**できる
- 生成が途中で失敗しても、**プレースホルダー（is_generating=true）**の整合性を壊さない（部分更新/ロールバック方針を定義）

### FR-06-v4 汎用献立生成エンジン

**概要:**
V4は「週間献立生成」ではなく「汎用献立生成エンジン」として設計。1食〜最大31日分（93スロット）まで柔軟に対応し、UIが用途に応じてパラメータを組み立てて呼び出す。

**コア原則:**
1. **「週」の概念を持たない**: 1食でも31日分でも同じAPIで対応
2. **V4は何も判断しない**: 渡されたスロットをそのまま生成
3. **スロット判断はUI/API側**: 「空欄を探す」「範囲を展開する」はUI/APIの責務
4. **コンテキストは明示的に渡す**: 前後の献立、冷蔵庫食材などを明示的に渡す
5. **既存データはデフォルトで保護**: 明示的に指定されたスロットのみ生成/更新

**生成モード（UIで選択）:**
- **空欄を埋める**: 空いているスロットのみ生成（デフォルト）
- **選択したところだけ**: ユーザーが明示的に選んだスロットのみ
- **期間を指定**: 開始日時〜終了日時の範囲を指定（最大31日）
- **全部作り直す**: 今日以降の全スロットを再生成（確認必須）

**コンテキスト（LLMに渡す情報）:**
1. **既存献立**（動的範囲、過去・未来を区別、重複回避）
2. **冷蔵庫食材**（賞味期限、優先使用）
3. **旬の食材**（月ごとの野菜・魚・果物）
4. **イベント・行事**（正月、クリスマス等）
5. **調理器具**（使える/使えない）
6. **買い物パターン**（食材使い回し計画）
7. **ユーザー要望**（自然言語）

**コンテキスト範囲（動的）:**
| 生成対象日数 | 前後の参照範囲 |
|-------------|---------------|
| 1〜3日 | 前後3日 |
| 4〜7日 | 前後7日 |
| 8〜14日 | 前後10日 |
| 15〜31日 | 前後14日 |

### FR-06-v4a オンボーディング追加項目

以下をオンボーディングフローに追加（`family_size`の後に挿入）:

1. **買い物頻度**
   - 毎日買い物に行く
   - 週2〜3回
   - 週1回まとめ買い
   - 2週間に1回程度

2. **週の食費予算**（任意）
   - 〜5,000円 / 5,000〜10,000円 / 10,000〜15,000円 / 15,000〜20,000円 / 20,000円以上

3. **調理器具**（複数選択可）
   - オーブン/オーブンレンジ
   - 魚焼きグリル
   - 圧力鍋
   - ホットクック/電気圧力鍋
   - エアフライヤー
   - フードプロセッサー/ミキサー

4. **コンロの種類**
   - ガスコンロ
   - IHコンロ

### FR-06-v4b 旬の食材・イベント行事

- **旬の食材**: 月ごとの野菜・魚・果物をLLMに提供し、季節感のある献立を生成
- **イベント行事**: 正月、節分、ひな祭り、こどもの日、七夕、お盆、十五夜、ハロウィン、クリスマス、大晦日等の定番料理を提案

### NFR-06-v4 性能/信頼性

- 最大31日分（93スロット）の生成に対応
- 7日分以下は3ステップ分割、8日分以上は日単位並列+バッチ分割
- 既存データの保護を保証（明示的に指定されたスロットのみ変更）
- トークン数制約: 最大参照範囲（28日分×3食×50トークン）≒4,200トークン

## 4. 基本設計（インフラ・全体アーキテクチャ）

### 4-1. 構成（v2）
- **Supabase Postgres**：データセット（献立セット/レシピ）を保持（真実）
- **Supabase Storage**：データセットCSV/TSVの置き場（非公開）
- **データセットインポーター**：CSV→DBのETL（管理者実行、またはCI/定期）
- **食材栄養インポーター**：`食材栄養.csv` → `dataset_ingredients`（表記揺れ対策のため `name_embedding vector(1536)` を保持）
- **派生レシピ永続化**：`derived_recipes`（DB原型 + 差分（材料/手順）+ 食材DB合算栄養）
- **類似検索（ベクトル/RAG）**：
  - 献立例（1食の例文書）検索：OpenAI Vector Store（`file_search`）を利用（相性判断の根拠）
  - 料理（レシピ）近傍検索：`pgvector`（またはRAG）で近い既存レシピを取得し、proxyの `base_recipe_id` を確定
- 食材（Ingredient）近傍検索：`pg_trgm` + `pgvector` で `dataset_ingredients` を検索し、派生レシピの栄養計算の根拠にする
- **献立生成ワーカー（Edge Function）**：
  - `generate-weekly-menu`：21枠の料理リスト生成→proxy解決→検証/修復→保存
  - `generate-single-meal`：1枠の料理リスト生成→proxy解決→検証/修復→保存
  - `regenerate-meal-direct`：既存1枠を（最小差分で）差し替え
  - `create-derived-recipe`：派生レシピ（材料/手順）生成 → 食材名解決 → 栄養合算 → `derived_recipes` 永続化
  - `backfill-ingredient-embeddings`：`dataset_ingredients.name_embedding` のバックフィル（管理者/運用）
- **LLM（OpenAI）**：献立例を参照した相性判断、提案、差し替え、説明文

> 補足：OpenAI Vector Store（RAG）は「補助」（文章・発想・説明）として残してもよいが、v2の数値/レコード確定はDBが担う。
> 更新（2025-12-30）：v2ではRAGを「補助」に限定せず、**献立例の取得（相性判断の根拠）**として積極利用する。ただし **数値の確定はDB** を維持する。

### 4-2. データフロー（週次）
1. クライアント → `/api/ai/menu/weekly/request`：リクエスト作成、プレースホルダー作成
2. `weekly_menu_requests` にジョブ登録（status）
3. Edge Function（ワーカー）がジョブを処理
4. `meal_plans` / `meal_plan_days` / `planned_meals` を更新し、詳細をキャッシュ
5. クライアントは `weekly_menu_requests` をポーリングし、完了を表示

> 補足：v2では「非同期＝待ち時間の解決」に加え、**データセット参照＝数値の完全性/再現性**を担保する。

### 4-3. 構成（v4）

**V4アーキテクチャの追加点:**
- **`generate-menu-v4`**: 汎用献立生成エンジン（1食〜31日分対応）
- **スロットビルダー（フロントエンド）**: 用途に応じてtargetSlotsを構築するヘルパー関数群
- **旬の食材/イベントデータ**: 静的マスタデータとして保持（将来的にDBテーブル化可）
- **調理器具/買い物パターン**: `user_profiles`に新カラムとして追加

```
┌─────────────────────────────────────────────────────────────────┐
│  フロントエンド (UI)                                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ スロットビルダー                                          │  │
│  │ - buildEmptySlots()     ← 「空欄を埋める」ボタン          │  │
│  │ - buildRangeSlots()     ← 「期間を指定」UI                │  │
│  │ - buildSingleSlot()     ← 「この1食だけ」                │  │
│  │ - buildSelectedSlots()  ← 「選択したところだけ」         │  │
│  │ - buildAllFutureSlots() ← 「全部作り直す」               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           ↓ targetSlots + context               │
├─────────────────────────────────────────────────────────────────┤
│  API Route: /api/ai/menu/v4/generate                           │
│  - 認証、バリデーション                                         │
│  - 自動収集（existingMenus, fridgeItems, userProfile, seasonal）│
│  - meal_plan取得/作成                                           │
│  - Edge Function呼び出し（waitUntil）                           │
├─────────────────────────────────────────────────────────────────┤
│  Edge Function: generate-menu-v4                                │
│  - コンテキスト構築（既存献立、旬、イベント、器具、買い物）     │
│  - 日単位並列生成（LLM）                                        │
│  - 栄養計算（dataset_ingredients）                              │
│  - 対象スロットのみ保存（既存は保護）                           │
└─────────────────────────────────────────────────────────────────┘
```

### 4-4. データフロー（v4）

1. クライアント → スロットビルダーで`targetSlots`を構築
2. クライアント → `/api/ai/menu/v4/generate`：リクエスト作成
3. API Route：自動収集（既存献立、冷蔵庫、ユーザー情報、季節）
4. API Route → Edge Function `generate-menu-v4` を呼び出し
5. Edge Function：
   - コンテキスト構築（LLMプロンプト用）
   - 日単位で並列生成
   - 栄養計算
   - 対象スロットのみ保存
6. クライアント：Supabase Realtimeで進捗監視

### 4-5. UI設計（v4）

#### 4-5-1. AIアシスタントモーダル

```
┌─────────────────────────────────────────────────────────────┐
│  ✨ AIアシスタント                                    [×]  │
├─────────────────────────────────────────────────────────────┤
│  何を生成しますか？                                         │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ ✨ 空欄を埋める（6件）                                │ │
│  │    既存の献立はそのまま、空いているところだけ         │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ 🎯 選択したところだけ                                 │ │
│  │    変更したい食事を選んで                             │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ 📅 期間を指定                                         │ │
│  │    開始〜終了を選んで生成（最大31日）                 │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ 🔄 全部作り直す                                       │ │
│  │    これからの献立をすべてリセットして再生成           │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  条件を指定                                                 │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│  │冷蔵庫優先  │ │時短中心    │ │和食多め    │            │
│  └────────────┘ └────────────┘ └────────────┘            │
│                                                             │
│  ┌─────────────────────────────────────────────┐ [生成]  │
│  │ 自由にリクエスト（例: 木金は簡単に）        │          │
│  └─────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

#### 4-5-2. 期間指定モーダル

```
┌─────────────────────────────────────────────────────────────┐
│  📅 生成期間を選択                                    [×]  │
├─────────────────────────────────────────────────────────────┤
│  開始: [1月3日(金) ▼]  [朝食 ▼]                           │
│  終了: [1月17日(金)▼]  [夕食 ▼]                           │
│                                                             │
│  → 15日間・45食分を生成                                    │
│                                                             │
│  ☑ 空欄のみ生成（既存の献立は保持）                        │
│  ☐ 既存も含めて全部生成し直す                              │
│                                                             │
│                         [キャンセル]  [この期間で生成]      │
└─────────────────────────────────────────────────────────────┘
```

#### 4-5-3. スロット選択モード

各食事カードにチェックボックスを表示:

```
┌─────────────────────────────────────────────────────────────┐
│ 1/3（金）                        選択中: 3件  [生成] [×]   │
├─────────────────────────────────────────────────────────────┤
│ ☐ 朝  🍳 白米ご飯、味噌汁...                   済         │
│ ☑ 昼  🍜 鶏むね肉の塩レモン焼き...             AI         │
│ ☑ 夕  （空欄）                                             │
└─────────────────────────────────────────────────────────────┘
```

## 5. 詳細設計（インフラ/DB/処理）

### 5-1. DBスキーマ（追加）

#### 5-1-1. `dataset_menu_sets`（献立セット：1行=1食）
- **用途**：週21枠の選定母集団
- **主な列（例）**
  - `id`（text, PK）：`web-scraper-order`（例：`1748237765-1`）
  - `dataset_key`（text）：例 `oishi-kenko`
  - `source_url`（text）
  - `target_tags`（text[]）：例 `脂質異常症` 等（フィルタ/重み付けに利用）
  - `dish_summary`（jsonb）：最大5品の `{name, category, kcal, sodium_g}` 等
  - `calories_kcal`, `protein_g`, `fat_g`, `carbs_g`, `sodium_g`, `sugar_g`, `fiber_g`, ...（`planned_meals` と同等の栄養列）
  - `raw_row`（jsonb）：取り込み元の生データ（監査/再取り込み用）
  - `dataset_version`（text）
  - `created_at`, `updated_at`

#### 5-1-2. `dataset_recipes`（レシピ：1行=1品）
- **用途**：料理詳細（材料/作り方/料理単位ミクロ栄養）の参照元
- **主な列（例）**
  - `id`（uuid, PK）
  - `dataset_key`（text）
  - `source_url`（text, UNIQUE）
  - `name`（text）
  - `name_norm`（text）：検索用の正規化名（空白/記号/表記ゆれの簡易正規化）
  - `tags`（text[]）：例 `塩分カット` 等
  - `nutrition`（jsonb）：料理単位の栄養（ミクロ含む、正規化済みキー）
  - `ingredients`（jsonb）：`[{name, amount, unit?, grams?}, ...]`（可能な範囲で構造化）
  - `steps`（text[]）
  - `raw_ingredients_text`（text）, `raw_steps_text`（text）：抽出前テキスト（再解析用）
  - `name_embedding`（vector(1536), NULL可）：類似検索用（`text-embedding-3-small` 想定。必要なら次元を別途定義）
  - `dataset_version`（text）
  - `created_at`, `updated_at`

#### 5-1-3. `dataset_menu_set_items`（献立セット内の料理明細）
- **用途**：献立セット（最大5品）→レシピへの安定参照（名前衝突対策/正規化）
- **主な列（例）**
  - `menu_set_id`（text, FK → dataset_menu_sets.id）
  - `dish_index`（int：1〜5）
  - `dish_name`（text）
  - `dish_name_norm`（text）：検索用の正規化名
  - `dish_category`（text：主菜/副菜/主食/汁物 等）
  - `dish_kcal`（int）, `dish_sodium_g`（numeric）
  - `recipe_id`（uuid, FK → dataset_recipes.id, NULL許容）
  - `recipe_match_method`（text, NULL可）：`url|exact|trgm|vector|llm_pick|manual` 等
  - `recipe_match_confidence`（numeric, NULL可）：0〜1 の目安（運用/監視用）
  - `role`（text：`main/side/soup/rice` 等）
  - `created_at`, `updated_at`

#### 5-1-4. `dataset_import_runs`（取り込み実行ログ）
- **用途**：運用（いつ・どの版を・何件取り込んだか、エラーは何か）
- **主な列（例）**
  - `id`（uuid, PK）
  - `dataset_key`（text）, `dataset_version`（text）
  - `status`（text：running/succeeded/failed）
  - `stats`（jsonb：件数/マッピング率/重複/スキップ数）
  - `error_message`（text）
  - `started_at`, `finished_at`

#### 5-1-5. `dataset_ingredients`（食材栄養：1行=1食材）
- **用途**：派生レシピの栄養を「DB根拠」で算出するための食材組成（原則100gあたり）
- **主な列（例）**
  - `id`（uuid, PK）
  - `name`（text）, `name_norm`（text）
  - `calories_kcal`, `protein_g`, `fat_g`, `carbs_g`, `fiber_g`, `salt_eq_g`, `potassium_mg`, ...（多数）
  - `name_embedding`（vector(1536)）：食材名の近傍検索（表記揺れ対策）
  - `created_at`, `updated_at`
- **索引**
  - `name_norm` btree
  - `name_norm` gin(trgm)
  - `name_embedding` hnsw(cosine)
- **アクセス**
  - RLS有効。原則 **service role のみ**が参照/更新（クライアント直参照は不可）
- **検索補助RPC**
  - `search_similar_dataset_ingredients`（pg_trgm）
  - `search_dataset_ingredients_by_embedding`（pgvector）
  - `search_ingredients_full_by_embedding`（v2用：全栄養素を返すベクトル検索）

#### 5-1-5-v2. 食事写真分析v2用DB関数

**`search_ingredients_full_by_embedding`**（材料マッチング用）

```sql
CREATE OR REPLACE FUNCTION search_ingredients_full_by_embedding(
  query_embedding vector(1536),
  match_count integer DEFAULT 5
) RETURNS TABLE (
  id uuid,
  name text,
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  fiber_g numeric,
  sodium_mg numeric,
  potassium_mg numeric,
  calcium_mg numeric,
  magnesium_mg numeric,
  phosphorus_mg numeric,
  iron_mg numeric,
  zinc_mg numeric,
  iodine_ug numeric,
  cholesterol_mg numeric,
  vitamin_a_ug numeric,
  vitamin_d_ug numeric,
  vitamin_e_alpha_mg numeric,
  vitamin_k_ug numeric,
  vitamin_b1_mg numeric,
  vitamin_b2_mg numeric,
  vitamin_b6_mg numeric,
  vitamin_b12_ug numeric,
  folic_acid_ug numeric,
  vitamin_c_mg numeric,
  salt_eq_g numeric,
  discard_rate_percent numeric,
  similarity double precision
) LANGUAGE sql STABLE AS $$
  SELECT
    i.id, i.name,
    i.calories_kcal, i.protein_g, i.fat_g, i.carbs_g, i.fiber_g,
    i.sodium_mg, i.potassium_mg, i.calcium_mg, i.magnesium_mg, i.phosphorus_mg,
    i.iron_mg, i.zinc_mg, i.iodine_ug, i.cholesterol_mg,
    i.vitamin_a_ug, i.vitamin_d_ug, i.vitamin_e_alpha_mg, i.vitamin_k_ug,
    i.vitamin_b1_mg, i.vitamin_b2_mg, i.vitamin_b6_mg, i.vitamin_b12_ug,
    i.folic_acid_ug, i.vitamin_c_mg, i.salt_eq_g, i.discard_rate_percent,
    1 - (i.name_embedding <=> query_embedding) as similarity
  FROM dataset_ingredients i
  WHERE i.name_embedding IS NOT NULL
  ORDER BY i.name_embedding <=> query_embedding ASC
  LIMIT match_count;
$$;
```

**`search_recipes_with_nutrition`**（エビデンス検証用）

```sql
CREATE OR REPLACE FUNCTION search_recipes_with_nutrition(
  query_name text,
  similarity_threshold numeric DEFAULT 0.3,
  result_limit integer DEFAULT 5
) RETURNS TABLE (
  id uuid,
  name text,
  calories_kcal integer,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  sodium_g numeric,
  fiber_g numeric,
  ingredients_text text,
  similarity numeric
) LANGUAGE sql STABLE AS $$
  SELECT
    r.id, r.name, r.calories_kcal, r.protein_g, r.fat_g, r.carbs_g,
    r.sodium_g, r.fiber_g, r.ingredients_text,
    similarity(r.name_norm, public.normalize_dish_name(query_name)) as similarity
  FROM dataset_recipes r
  WHERE similarity(r.name_norm, public.normalize_dish_name(query_name)) >= similarity_threshold
  ORDER BY similarity DESC
  LIMIT result_limit;
$$;
```

#### 5-1-6. `derived_recipes`（派生レシピ永続化）
- **用途**：AIが生成した派生レシピを保存し、後で再利用/評価/改善できるようにする
- **主な列（例）**
  - `id`（uuid, PK）
  - `name`, `name_norm`
  - `base_dataset_recipe_id`（uuid, FK → `dataset_recipes.id`）：必須（DB原型）
  - `created_by_user_id`（uuid, NULL可）
  - `ingredients`（jsonb）：`[{name, amount_g, note, matched_ingredient_id, similarity, method, skip?}, ...]`
  - `instructions`（text[]）
  - 推定/計算栄養（`calories_kcal`, `protein_g`, `fat_g`, `carbs_g`, `sodium_g`, `vitamin_*` など。食材DBに存在しない項目は NULL になり得る）
  - `generation_metadata`（jsonb）：`mapping_rate`, `warnings`, `elapsed_ms` など
  - `name_embedding`（vector(1536)）
- **アクセス**
  - RLS有効。v2初期は **service role のみ**（ユーザーへの表示は `planned_meals` 側のキャッシュで行う）

> 注：`planned_meals` はすでにミクロ栄養列（`iodine_ug` 等）を保持できる。v2ではこの列群へ **データセットの確定値をコピー**する。

### 5-2. 既存テーブルの拡張（推奨）

#### `planned_meals`（トレーサビリティ）
差し替え・監査・再生成の安定化のため、以下を追加する（v2推奨）：
- `source_dataset_key`（text）
- `source_menu_set_id`（text）
- `source_menu_set_url`（text）
- `source_recipe_urls`（text[]）または `dishes` 内に `sourceUrl` を付与
- `source_dataset_version`（text）

※ 追加が難しい場合の暫定：`weekly_menu_requests.prediction_result` に選定IDを保持し、必要に応じて逆引きする。

#### `user_profiles`（v4対応）

買い物パターンと調理器具を追加する：

```sql
-- Migration: 20260103_add_v4_profile_columns.sql

-- 買い物パターン
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS shopping_frequency TEXT;
-- "daily" | "twice_weekly" | "weekly" | "biweekly"

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS weekly_food_budget INTEGER;
-- 週の食費予算（円）

-- 調理器具
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS cooking_equipment JSONB DEFAULT '{}';
-- {
--   "has_oven": true,
--   "has_pressure_cooker": false,
--   "has_air_fryer": false,
--   "has_grill": true,
--   "stove_type": "gas" | "ih"
-- }

-- インデックス
CREATE INDEX IF NOT EXISTS idx_user_profiles_shopping_frequency 
  ON user_profiles(shopping_frequency);
```

**cooking_equipment構造:**
| フィールド | 型 | 説明 |
|-----------|-----|------|
| has_oven | boolean | オーブン/オーブンレンジ |
| has_grill | boolean | 魚焼きグリル |
| has_pressure_cooker | boolean | 圧力鍋 |
| has_slow_cooker | boolean | ホットクック/電気圧力鍋 |
| has_air_fryer | boolean | エアフライヤー |
| has_food_processor | boolean | フードプロセッサー/ミキサー |
| stove_type | string | "gas" \| "ih" |

### 5-3. データ取り込み（ETL）

#### 入力
- 献立セットCSV/TSV（1行=1食、合計栄養＋料理名/分類/カロリー/塩分）
- レシピCSV/TSV（1行=1品、材料/作り方＋料理栄養＋タグ）
- 食材栄養CSV（`食材栄養.csv`：1行=1食材、原則100gあたりの栄養）

#### 取り込み手順（推奨）
0. **初回取り込み（数十MB規模）はCLI/psqlでの一括投入を推奨**
   - 理由：Edge Function単体での“巨大CSVを一気に”はタイムアウト/メモリのリスクがあるため
   - 例：管理者PCから `COPY`（またはバッチUPSERT）で投入 → 取り込み後に正規化/索引/マッピングを回す
1. Storage（非公開）へ `datasets/{dataset_key}/{version}/...` として配置（運用/再取り込みのソース）
2. インポーターを実行し、以下を実施
   - 単位正規化（例：`µg`/`ug`/`μg`、`全カルシウム` 等の表記揺れ）
   - 列名正規化（DBの栄養キーへマッピング）
   - `dataset_menu_set_items` の生成（最大5品の分解）
   - レシピの重複排除（`source_url` を主キー）
   - **献立セットの料理名→レシピのマッピング（品質がv2成否を決める）**
     - 可能なら `source_url` 等の **決定的キー**で紐づけ（最優先）
     - 次に **完全一致**（`dish_name_norm = name_norm`）
     - 次に **類似一致（DB内）**：
       - `pg_trgm`（文字列類似）で上位候補抽出
       - `pgvector`（埋め込み）で上位候補抽出（任意）
     - 同名衝突/曖昧な場合は **上位候補リストをLLMに提示して選ばせる（llm_pick）**
     - それでも解決できない場合は未解決として残し、手動辞書（manual）で補完
   - 食材栄養の取り込み（`dataset_ingredients`）
     - `name_norm` を正規化して保存（表記揺れ対策）
     - `name_embedding` を生成（CLIで一括生成 or `backfill-ingredient-embeddings` で後追いバックフィル）
3. `dataset_import_runs` に統計（マッピング率、未解決数）を保存
4. `system_settings` に「有効データセット版」を設定（例：`menu_dataset_active_version`）

### 5-4. 生成アルゴリズム（週次/単発/再生成）

#### 共通方針
- **候補抽出はDBで行う**（数値・タグ）
- GPTは **候補の中から選ぶ/差し替える**（理由づけ・バリエーション調整）。候補外IDを出したら失敗として再試行
- 生成後に **検証**し、違反があれば **部分的に差し替え**（全文作り直しは最終手段）

#### ユーザー要望（自然文）を「DB検索ができる形」に落とす
ユーザーの要望（例：「今週は和食多めで、夜は時短。高血圧なので塩分控えめ。鶏むね肉を使いたい」）は、DBに“完全一致で存在する”とは限らない。
v2では「ドンピシャ検索」ではなく、**要望をクエリ/制約に変換して“近い候補を十分数集める”**設計とする。

- **Step A: 要望の構造化（Query Planner）**
  - LLM（またはルール）で以下へ変換：
    - ハード制約：アレルギー/宗教/禁忌食材、絶対NG
    - 数値制約：カロリー/PFC/塩分上限（`nutrition_targets` 由来）
    - ソフト制約：和食/辛め/さっぱり、時短、作り置き、季節、冷蔵庫食材優先 等
    - クエリ語：料理名/食材/調理法のキーワード、同義語（例：鶏むね=胸肉/チキン）
- **Step B: DBで候補抽出（Hybrid retrieval）**
  - `dataset_menu_sets` を対象に、以下を組み合わせてスコアリング：
    - **栄養スコア**：目標への近さ、上限超過の強いペナルティ
    - **テキスト類似**：献立名・料理名（`dish_summary` 等）と要望キーワードの一致/類似（`pg_trgm`）
    - （任意）**ベクトル類似**：献立セットの要約埋め込み（`pgvector`）
  - 上位K（例：50〜200）を候補として返す（「1件当てる」ではなく「選べるだけ集める」）
- **Step C: 段階的緩和（Progressive relaxation）**
  - 候補が少ない/ゼロの場合は、**ソフト制約の重みを落として再検索**する
  - ハード制約（アレルギー等）と法令/安全性は緩和しない
  - それでもゼロなら「データセット内に該当がない」ことを明示し、ユーザーに条件緩和を促す（無理に捏造しない）

#### 3層防御：組み合わせの「相性」を制御する

料理を自由に組み合わせると「おでん＋カレー＋チャーハン」のような不自然な献立が生成されるリスクがある。
v2では **3層の防御** で組み合わせの相性を制御する。

```
┌──────────────────────────────────────────────────┐
│  第1層：構造テンプレート選択                         │
│  → 既存の献立セットから「構造」を借りる               │
│     例：[メイン:カレー系] + [副菜:サラダ系] + [小鉢:漬物系] │
└──────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────┐
│  第2層：スロット内で料理を入れ替え                   │
│  → 同じ「役割×近傍（類似）」内で入れ替え               │
│     例：チキンカレー → 近い料理（埋め込み/文字列類似の上位N）│
│  ※ 栄養制約・在庫・好みでフィルタ                    │
└──────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────┐
│  第3層：LLM相性チェック                             │
│  → 「この組み合わせは日本の食卓として自然か？」        │
│  → 不自然なら却下し、代案を提示                      │
└──────────────────────────────────────────────────┘
```

##### 第1層：構造テンプレート（献立セットの構造を借りる）

既存の献立セットは **栄養士が作った「正しい組み合わせ」** である。
この「構造」（どの役割にどんな料理を配置するか）をテンプレートとして使う。

- 献立セットの構造例：
  - カレーセット = `[メイン:カレー系] + [副菜:サラダ系] + [小鉢:漬物系]`
  - 和定食 = `[メイン:焼き魚系] + [副菜:煮物系] + [汁物:味噌汁系] + [主食:ご飯]`
  - 中華セット = `[メイン:炒め物系] + [主食:チャーハン系] or [麺:ラーメン系]`

##### 第2層：スロット内入れ替え（柔軟性の確保）

レシピ単体に固定の「役割（slot_type）」を持たせると例外が多すぎて破綻するため、**役割はテンプレート（献立セット）が持つスロットで決める**。
具体的には、`dataset_menu_set_items.role` / `dish_category`（主菜/副菜/主食/汁物/小鉢 等）を「その献立内での役割」として扱い、**そのスロットに入れる料理候補を入れ替える**。
これにより **組み合わせの構造は保証しつつ、個別料理は自由に選べる**。

- 入れ替え例（カレーセットの場合）：
  - メインスロット（元料理：チキンカレー）→ **類似検索の近傍**：ビーフカレー / キーマカレー / スープカレー
  - 副菜スロット（元料理：サラダ）→ **類似検索の近傍**：グリーンサラダ / コールスロー / ポテトサラダ
  - 小鉢スロット（元料理：らっきょう）→ **類似検索の近傍**：福神漬け / ピクルス

##### 第3層：LLM相性チェック（常識フィルタ）

完全に自由な組み合わせを許可する場合、または第2層で判断が曖昧な場合に適用。
LLMに「この組み合わせは日本の食卓として自然か？」を判定させる。

- 判定基準（厳しめ）：
  - 「少しでも違和感があれば不自然と判定」
  - 「粉物＋粉物（たこ焼き＋お好み焼き）→ 炭水化物過多、不自然」
  - 「カレー＋おでん（大）→ メイン競合、不自然」
  - 「カレー＋おでん（小鉢）→ 許容」

##### レシピ側に持たせる属性（固定の役割ではなく「性質」）

「ラーメン＋チャーハンはOK」「ご飯＋たこ焼き＋お好み焼きはNG」など、**役割/ジャンルだけでは裁けない例外**が多い。
v2では「役割」をレシピに固定せず、レシピ側は **不変に近い“性質”**（料理タイプ/ボリューム/ジャンル/調理法など）を持たせ、相性は後述のスコアで判断する。

| 属性 | 例 | 用途 |
|---|---|---|
| `name_norm` | 正規化名（空白/記号/表記ゆれの簡易正規化） | 文字列類似（`pg_trgm`）による候補抽出 |
| `name_embedding` | 埋め込みベクトル（例：vector(1536)） | **類似検索**による候補抽出（「近傍」を取る） |
| `size` | large/medium/small | 量の制御（小鉢ならジャンル混在OK等） |
| `cuisine` | japanese/western/chinese/other | 参考情報 |
| `kind_tags`（推奨） | carb_heavy / protein_heavy / vegetable_heavy / spicy / fried / flour ... | 相性スコア・ソフト制約の特徴量（厳密ルールではなくスコア） |

> 注：`kind_tags` は「完全に正しい分類」を求めない。誤り/例外を前提に、後述の **献立例（RAG）** と **LLMチェック** で吸収する。

##### 相性をどう判定するか（献立例を参照してLLMが判断する）

相性（「AとCを一緒に出して自然か」）は例外が多く、少数のルールや固定カテゴリだけで網羅するのは難しい。
このため v2 では、**献立例（過去/データセットの献立）を検索して提示し、LLMに“常識判断”をさせる**方針とする。

- **献立例の取得（RAG）**
  - 献立セット（1食）を「料理名一覧＋役割＋簡単な説明」などのテキストに整形し、OpenAI Vector Store（`file_search`）に格納する
  - 生成時に「ユーザー要望」「候補の料理名」「現在の組み合わせ」をクエリとして、近い献立例を複数取得する
- **LLMの相性判定**
  - 取得した献立例を根拠として、現在の組み合わせを評価（自然/不自然/グレー）
  - 不自然なら **最小差分の差し替え案**（置換対象スロットと理由）を返す
  - 境界条件（例：おでんは“主菜”だとNGだが“小鉢”ならOK）のような文脈判断を許容する
- **実装上の安全策**
  - 「DBに存在しない料理名」を **許容するかどうか**はプロダクト方針で切り替え可能にする（創造性 vs 数値の確実性）
    - **確定モード（推奨デフォルト）**：栄養・制約（ミクロ栄養、塩分上限、アレルギー等）を確実に満たすため、各料理はDB検索（文字列類似/埋め込み）で候補を出し、**候補内から選ばせる**（未登録料理は採用しない）
    - **創作モード（任意）**：未登録料理名の提案を許容し、レパートリーを増やす。ただし「未登録」をそのまま採用するのではなく、可能な限り **“似た実例”をプロキシとして紐づける**（数値と詳細の一貫性を保つ）。以下を必須とする：
      - `planned_meals.dishes` に `source: "dataset" | "proxy" | "derived" | "generated"` を付与して区別する
      - **derived（推奨）**：
        - 未登録料理名（表示名）は許容するが、必ず **DB原型**（`base_dataset_recipe_id`）を確定する
        - `create-derived-recipe` で **材料/手順（g単位）**を生成し、`dataset_ingredients` で食材名を解決して **合算栄養**を算出する
        - 結果は `derived_recipes` に永続化し、`mapping_rate` / `warnings` を保存する
        - `mapping_rate` が閾値未満なら UI で明示し、再生成・食材名修正・proxyへのフォールバック等を選べる
      - **proxy（フォールバック）**：
        - ベクトル検索等で **近い既存レシピ（recipe_id）** を見つけ、`base_recipe_id` として保持する
        - 材料/作り方/栄養は **base_recipe_id の確定データ**を使う（最短で確実）
      - **generated（最終手段）**：
        - DB原型（`base_dataset_recipe_id`）すら確定できない場合のみ許容する
        - **栄養の扱い（推定/未計算）を明示**し、健康系のハード制約判定から除外 or ユーザー承認を必須にする
      - 後日、管理者/運用で「辞書登録/新規レシピ追加/食材名の正規化改善」を行う **育成フロー**に繋げる
  - 相性判定は“最後の味付け”とし、栄養制約（塩分等）やアレルギー等のハード制約はコード/DBで必ず検証する

##### 生成フローへの適用

1. ユーザー要望を解析（例：「カレーが食べたい」）
2. **第1層**：要望に合う構造テンプレートを選択（例：カレーセットの構造）
3. **第2層**：各スロット内で候補を抽出（栄養制約・在庫・好みでフィルタ）
4. 候補からLLMがID選定（被り回避・バランス調整）
5. **第3層**：献立例（RAG）を参照してLLMが常識チェック（不自然なら候補内で差し替え）
6. 栄養はDBから取得して `planned_meals` に保存

#### 制約最適化（"献立作り"の中核はコード側）
ユーザー要望は「前日と被らない」「昼と夜も被らない」「朝は軽め」「冷蔵庫優先」「嗜好も反映」など複雑になりやすい。
v2では、LLMが"いい感じの献立知識を内蔵している"ことを前提にせず、**データセット（DB）にある献立/レシピを材料に、コード側で制約最適化**を行う。

- **ハード制約（必ず守る）**
  - アレルギー/宗教/禁忌食材
  - 塩分など上限（健康状態/目標により）
  - 同一枠の成立要件（朝昼晩が揃う等）
- **ソフト制約（できるだけ守る＝スコア化）**
  - 主菜タンパクの多様性（前日・同日昼夜・週内の被りペナルティ）
  - 朝は軽め（カロリー帯/脂質量などでペナルティ）
  - 時短/作り置き/和食多め等の嗜好
  - 冷蔵庫・パントリー優先（使いたい食材の一致スコア）
- **手法（現実的で実装しやすい）**
  1. 各スロット（21枠）に対して候補K（例：50〜200）を用意（DB抽出）
  2. まずは栄養/制約を満たしやすい順で **greedy に割当**（直前/同日の被りを避ける）
  3. 週全体のスコア（栄養目標への近さ＋多様性＋嗜好＋在庫消費）を評価し、**局所探索（swap/replace）**で改善
  4. 収束 or 反復回数上限で確定
- **修復（作り直しではなく“部分差し替え”）**
  - 例：塩分が超過 → 上位の“塩分寄与が大きい枠”を特定 → その枠だけ低塩候補へ差し替え → 再評価
  - 例：タンパク被り → 被り枠だけ別タンパク候補へ差し替え → 再評価

この設計だと「RAG検索を何回も回して骨子を固める」必要はなく、**DB候補＋最適化＋部分修復**で安定して解ける。

#### 重要：RAG（File Search）に期待しないこと
- 「IDで1行を確実に引く」「CSVの特定列を厳密に読む」「栄養カラムでSQLのように絞り込む」等は **RAGの責務にしない**
- v2では、これらは **DB取り込み＋索引＋クエリ**で解決し、LLMは“選択・調整・説明”に集中させる

#### 週次（21枠）
1. スロットごとに目標（カロリー、塩分上限、タグ優先度）を決める
2. `dataset_menu_sets` から各スロットの候補集合（上位K）を抽出
3. GPTへ「候補一覧（ID固定）＋制約＋被り情報」を渡し、21枠のIDを選定（**候補外ID禁止**）
4. 選定IDを展開し、`dataset_menu_set_items`→`dataset_recipes` で詳細取得
5. `planned_meals.dishes` を構築（材料/手順/料理栄養）し、食事合計栄養を列にコピー
6. 検証（アレルギー/禁忌食材、塩分、栄養課題、被り）→問題枠だけ差し替え再実行

#### 単発
- 週次の1スロット版（同様にID選定→展開→検証→保存）

#### 再生成（差し替え）
- 現在の `source_menu_set_id` を除外し、栄養課題/ユーザー要望を反映して別IDを選定→更新

### 5-5. 監視・ログ・コスト
- `weekly_menu_requests.prediction_result`：
  - 選定ID一覧、差し替え履歴、検証結果、所要時間、データセット版
- `ai_content_logs`：
  - GPTの入力/出力（要約）、モデル名、概算コスト（運用監視）
- アラート基準：
  - `failed` 率、平均所要時間、データセット未マッピング率の上昇

### 5-6. セキュリティ（RLS/アクセス）
- `dataset_*` テーブルは **クライアントから直接参照させない**（service role のみ）
- 生成結果は `planned_meals` に完全にキャッシュするため、UIは既存のRLSで完結する

## 6. 移行手順（全ユーザーにデフォルト適用）
1. DBへデータセットを取り込み（ETL＋マッピング率確認）
2. `system_settings` に有効データセット版を設定
3. `generate-weekly-menu` / `generate-single-meal` / `regenerate-meal-direct` を v2ロジックへ切替
4. 監視（失敗率/所要時間/未マッピング率）を見ながら改善

## 7. リスク・未決定事項
- **料理名マッピングの衝突**：同名料理が複数ある場合の優先順位（URL優先/タグ一致/手動辞書）
- **マッピング品質が低い場合のUX**：材料/手順が欠ける（週生成時点で"全埋め"できない）
  - 対策：マッピング率の品質ゲート（例：>=95%）を設け、未達なら旧方式へフォールバック可能なスイッチを残す
- **ライセンス/出典表記**：外部データセットの利用条件に応じたUI表記（source_urlの保持）
- **データセット更新**：新版取り込み時の差分反映、過去の献立との整合

---

## 8. 詳細スキーマ定義（実装仕様）

### 8-1. `planned_meals.dishes` JSONスキーマ

`dishes` カラムはJSONB型で、1食に含まれる料理の配列を保持する。
各料理には **source（データ元）** と **base_recipe_id（proxy時の参照先）** を持たせ、トレーサビリティを確保する。

```typescript
// Zodスキーマ
import { z } from 'zod';

export const DishSchema = z.object({
  // 基本情報
  name: z.string(),                          // 表示名（LLMが出した名前、または既存レシピ名）
  role: z.enum(['main', 'side', 'soup', 'rice', 'small_dish', 'dessert', 'other']),
  
  // データ元（トレーサビリティ）
  source: z.enum(['dataset', 'proxy', 'generated']),
  // - dataset: DBの既存レシピに完全一致
  // - proxy: DBの近傍レシピをベースに採用（名前は異なる可能性あり）
  // - generated: DB内に近傍が見つからず、LLM生成データを使用（非推奨、最終手段）
  
  base_recipe_id: z.string().uuid().nullable(),  // dataset/proxy時に参照したレシピのID
  base_recipe_name: z.string().nullable(),       // 参照レシピの正式名（UI表示「ベース: ◯◯」用）
  source_url: z.string().url().nullable(),       // レシピのソースURL（出典表記用）
  
  // 栄養（DBから取得した確定値）
  calories_kcal: z.number().int().nullable(),
  protein_g: z.number().nullable(),
  fat_g: z.number().nullable(),
  carbs_g: z.number().nullable(),
  sodium_g: z.number().nullable(),
  fiber_g: z.number().nullable(),
  // ミクロ栄養（必要に応じて拡張）
  // calcium_mg, iron_mg, vitamin_a_ug, ...
  
  // 料理詳細（DBから取得）
  ingredients: z.array(z.object({
    name: z.string(),
    amount: z.string().nullable(),      // "100g", "1/2個" など
    category: z.string().nullable(),    // "肉類", "野菜" など
  })).nullable(),
  
  steps: z.array(z.string()).nullable(),  // 調理手順
  
  // メタ情報
  cooking_time_minutes: z.number().int().nullable(),
  servings: z.number().int().nullable(),
  
  // proxy解決時の類似度（監視/デバッグ用）
  similarity_score: z.number().min(0).max(1).nullable(),
});

export const PlannedMealDishesSchema = z.array(DishSchema);

// 型定義
export type Dish = z.infer<typeof DishSchema>;
export type PlannedMealDishes = z.infer<typeof PlannedMealDishesSchema>;
```

#### 例：通常の献立（source: dataset）
```json
{
  "dishes": [
    {
      "name": "チキンカレー",
      "role": "main",
      "source": "dataset",
      "base_recipe_id": "550e8400-e29b-41d4-a716-446655440000",
      "base_recipe_name": "チキンカレー",
      "source_url": "https://example.com/recipe/chicken-curry",
      "calories_kcal": 650,
      "protein_g": 25,
      "fat_g": 18,
      "carbs_g": 85,
      "sodium_g": 2.5,
      "fiber_g": 3,
      "ingredients": [
        {"name": "鶏もも肉", "amount": "300g", "category": "肉類"},
        {"name": "玉ねぎ", "amount": "1個", "category": "野菜"},
        {"name": "カレールー", "amount": "4皿分", "category": "調味料"}
      ],
      "steps": ["鶏肉を一口大に切る", "玉ねぎを炒める", "水を加えて煮込む", "ルーを入れる"],
      "cooking_time_minutes": 40,
      "servings": 4,
      "similarity_score": 1.0
    }
  ]
}
```

#### 例：未登録料理名（source: proxy）
```json
{
  "dishes": [
    {
      "name": "スパイシーチキンカレー",
      "role": "main",
      "source": "proxy",
      "base_recipe_id": "550e8400-e29b-41d4-a716-446655440000",
      "base_recipe_name": "チキンカレー",
      "source_url": "https://example.com/recipe/chicken-curry",
      "calories_kcal": 650,
      "protein_g": 25,
      "fat_g": 18,
      "carbs_g": 85,
      "sodium_g": 2.5,
      "fiber_g": 3,
      "ingredients": [...],
      "steps": [...],
      "cooking_time_minutes": 40,
      "servings": 4,
      "similarity_score": 0.92
    }
  ]
}
```

### 8-2. `planned_meals` テーブル拡張（マイグレーション）

```sql
-- v2トレーサビリティ用カラム追加
ALTER TABLE planned_meals ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'legacy';
-- 'legacy': v1で生成された献立
-- 'dataset': v2でデータセットから生成
-- 'mixed': 一部proxyを含む

ALTER TABLE planned_meals ADD COLUMN IF NOT EXISTS source_dataset_version TEXT;
-- 生成時点のデータセット版（例：'2025-01-01'）

ALTER TABLE planned_meals ADD COLUMN IF NOT EXISTS generation_metadata JSONB;
-- {
--   "model": "gpt-5-mini",
--   "generated_at": "2025-01-01T12:00:00Z",
--   "adjustments": [...],  -- LLMが行った調整の説明
--   "validation_passed": true,
--   "retry_count": 0
-- }

-- インデックス（任意）
CREATE INDEX IF NOT EXISTS idx_planned_meals_source_type ON planned_meals(source_type);
```

### 8-3. LLMレスポンス JSON出力スキーマ

#### 週次献立生成（generate-weekly-menu）

```typescript
// LLMに要求するJSON出力のZodスキーマ
export const WeeklyMenuResponseSchema = z.object({
  meals: z.array(z.object({
    day: z.number().int().min(1).max(7),        // 1=月曜, 7=日曜
    meal_type: z.enum(['breakfast', 'lunch', 'dinner']),
    dishes: z.array(z.object({
      name: z.string(),                          // 料理名（DB存在は問わない）
      role: z.enum(['main', 'side', 'soup', 'rice', 'small_dish', 'other']),
    })),
    theme: z.string().nullable(),                // 「和食」「時短」など（任意）
  })),
  
  adjustments: z.array(z.object({
    day: z.number().int().nullable(),
    meal_type: z.string().nullable(),
    original_request: z.string(),               // ユーザーの元要望
    changed_to: z.string(),                     // 実際の提案
    reason: z.string(),                         // 変更理由
  })).nullable(),
  
  weekly_advice: z.string().nullable(),         // 週全体へのアドバイス
});

export type WeeklyMenuResponse = z.infer<typeof WeeklyMenuResponseSchema>;
```

#### 単発生成（generate-single-meal）

```typescript
export const SingleMealResponseSchema = z.object({
  dishes: z.array(z.object({
    name: z.string(),
    role: z.enum(['main', 'side', 'soup', 'rice', 'small_dish', 'other']),
  })),
  
  adjustments: z.array(z.object({
    original_request: z.string(),
    changed_to: z.string(),
    reason: z.string(),
  })).nullable(),
  
  advice: z.string().nullable(),
});

export type SingleMealResponse = z.infer<typeof SingleMealResponseSchema>;
```

#### 差し替え（regenerate-meal-direct）

```typescript
export const RegenerateMealResponseSchema = z.object({
  dishes: z.array(z.object({
    name: z.string(),
    role: z.enum(['main', 'side', 'soup', 'rice', 'small_dish', 'other']),
    is_changed: z.boolean(),                    // 変更されたかどうか
  })),
  
  change_summary: z.string(),                   // 何を変えたかの要約
  reason: z.string(),                           // 変更理由
});

export type RegenerateMealResponse = z.infer<typeof RegenerateMealResponseSchema>;
```

### 8-4. エラー時のリトライ仕様

#### リトライ対象

| エラー種別 | リトライ | 最大回数 | 待機時間 |
|-----------|---------|---------|---------|
| LLM API タイムアウト | ✅ | 3回 | 指数バックオフ（1s, 2s, 4s） |
| LLM API レート制限 | ✅ | 5回 | 指数バックオフ（5s, 10s, 20s, 40s, 80s） |
| JSON パースエラー | ✅ | 2回 | 即時（プロンプト修正なし） |
| Zodバリデーションエラー | ✅ | 2回 | 即時（エラー内容をプロンプトに追加） |
| proxy解決失敗（近傍なし） | ❌ | - | source: generated にフォールバック |
| ハード制約違反（検証失敗） | ✅ | 3回 | 即時（違反箇所を指定して部分差し替え） |
| DB接続エラー | ✅ | 3回 | 指数バックオフ（1s, 2s, 4s） |

#### リトライフロー

```
LLM呼び出し
    │
    ├─ 成功 → JSON パース
    │              │
    │              ├─ 成功 → Zod バリデーション
    │              │              │
    │              │              ├─ 成功 → proxy解決 → 検証
    │              │              │                        │
    │              │              │                        ├─ 成功 → 保存 → 完了
    │              │              │                        │
    │              │              │                        └─ 失敗（ハード制約違反）
    │              │              │                                 │
    │              │              │                                 └─ 違反枠だけ差し替え依頼（最大3回）
    │              │              │
    │              │              └─ 失敗（バリデーションエラー）
    │              │                       │
    │              │                       └─ エラー内容をプロンプトに追加してリトライ（最大2回）
    │              │
    │              └─ 失敗（パースエラー）
    │                       │
    │                       └─ そのままリトライ（最大2回）
    │
    └─ 失敗（API エラー）
             │
             └─ 指数バックオフでリトライ（最大3〜5回）
```

#### 最終失敗時の処理

- `weekly_menu_requests.status` を `failed` に更新
- `weekly_menu_requests.error_message` にエラー詳細を保存
- UIには「献立生成に失敗しました。再度お試しください。」を表示
- 部分的に成功した枠がある場合は `is_generating = true` のままにし、ユーザーに再生成を促す

### 8-5. Vector Store（献立例RAG）登録形式

#### 1献立セット = 1ドキュメント

```
ファイル名: menu_set_{id}.txt

---
献立ID: 1748237765-1
カテゴリ: 夕食
対象: 脂質異常症
カロリー: 650kcal
塩分: 2.5g

【料理構成】
- 主菜: チキンカレー（鶏肉、玉ねぎ、じゃがいも）
- 副菜: コールスロー（キャベツ、にんじん）
- 小鉢: らっきょう

【特徴】
- タンパク質がしっかり取れる
- 野菜も摂取できるバランス献立
- 調理時間: 約40分
---
```

#### Vector Store構成

| 項目 | 設定 |
|------|------|
| ファイル形式 | テキスト（.txt） |
| 1ファイル | 1献立セット |
| チャンクサイズ | デフォルト（OpenAI管理） |
| 総ファイル数 | 献立セット数に依存（例：数千〜数万件） |
| 更新頻度 | データセット更新時（手動/CI） |

#### 検索クエリ例

```
「夕食 カレー 塩分控えめ 時短」
→ カレー系の夕食献立で、塩分が低めのものが上位に
```

### 8-6. 料理近傍検索（proxy解決）の閾値・フォールバック

#### 検索方式

1. **完全一致**（`name_norm` で照合）
2. **文字列類似**（`pg_trgm` で照合、`similarity >= 0.6`）
3. **ベクトル類似**（`pgvector` で照合、`cosine_similarity >= 0.85`）

#### 閾値と採用基準

| 検索結果 | similarity | 採用 | source |
|---------|------------|------|--------|
| 完全一致 | 1.0 | ✅ | `dataset` |
| 高類似度 | >= 0.85 | ✅ | `proxy` |
| 中類似度 | 0.70 - 0.84 | ⚠️ 警告付きで採用 | `proxy` |
| 低類似度 | 0.50 - 0.69 | ⚠️ ログに記録、LLMに確認 | `proxy` |
| 類似なし | < 0.50 | ❌ フォールバック | `generated` |

#### フォールバック（source: generated）

近傍が見つからない場合、以下の手順でフォールバック：

1. **LLMに栄養推定を依頼**（一般的な栄養値を返す）
2. **材料/作り方は空配列**（「詳細はありません」と表示）
3. **`generation_metadata.has_generated_dish = true`** をセット
4. **監視ダッシュボードでアラート**（generated率が高いと品質低下）

#### 許容 generated 率

| 週次献立（21食 × 平均3品 = 63品） | 基準 |
|-----------------------------------|------|
| 正常 | generated 0件 |
| 許容 | generated 1-3件（<5%） |
| 警告 | generated 4-6件（<10%） |
| 異常 | generated 7件以上（>=10%）→ 品質ゲート発動 |

### 8-7. マイグレーション手順（v1 → v2）

#### 前提

- v1の既存データ（`planned_meals`）は保持する
- v2は新規生成から適用し、既存データは触らない
- フラグで切り替え可能にする（ロールバック対応）

#### 手順

```
Phase 1: 準備（〜1日）
├─ 1. dataset_* テーブルをマイグレーションで作成
├─ 2. planned_meals に v2カラム追加（source_type, source_dataset_version, generation_metadata）
├─ 3. デフォルト値を設定（既存データは source_type = 'legacy'）
└─ 4. インデックス作成

Phase 2: データ取り込み（〜1日）
├─ 1. 献立セットCSV → dataset_menu_sets へ COPY/UPSERT
├─ 2. レシピCSV → dataset_recipes へ COPY/UPSERT
├─ 3. dataset_menu_set_items の生成（料理明細の分解）
├─ 4. レシピマッピング実行（URL優先 → 完全一致 → 類似 → LLM pick）
├─ 5. マッピング率確認（品質ゲート: >= 95%）
└─ 6. Vector Store に献立例をアップロード

Phase 3: 切り替え（〜1日）
├─ 1. system_settings に v2_enabled = true, dataset_version = 'YYYY-MM-DD' を設定
├─ 2. Edge Functions を v2ロジックにデプロイ
├─ 3. 新規生成は v2、既存データは触らない
└─ 4. 監視開始（失敗率、generated率、所要時間）

Phase 4: 安定化（〜1週間）
├─ 1. 監視データを確認し、閾値調整
├─ 2. 問題があれば v2_enabled = false でロールバック
├─ 3. 安定したら v1コードを削除（任意）
└─ 4. ドキュメント更新
```

#### ロールバック手順

```sql
-- v2を無効化
UPDATE system_settings SET value = 'false' WHERE key = 'v2_enabled';

-- Edge Functions は v1ロジックにフォールバック（コード内で分岐）
```

#### 既存データとの整合

- **v1で生成済みの献立**：`source_type = 'legacy'` のまま保持。v2のスキーマ（dishes内のsource等）は `null` 許容
- **v2で生成した献立**：`source_type = 'dataset' or 'mixed'`。完全なスキーマ
- **UIでの表示**：`source_type` によらず同じUIで表示（互換性維持）

---

## 9. アーキテクチャ図・フロー図

### 9-1. システム全体アーキテクチャ（v2）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               クライアント                                    │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐              │
│  │   Web App    │      │  Mobile App  │      │   Admin CLI  │              │
│  │  (Next.js)   │      │    (Expo)    │      │  (バッチ)     │              │
│  └──────┬───────┘      └──────┬───────┘      └──────┬───────┘              │
└─────────┼───────────────────────┼────────────────────┼─────────────────────┘
          │                       │                    │
          │ REST API / RPC        │                    │ COPY / UPSERT
          ▼                       ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Supabase                                          │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      Edge Functions                                    │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │ generate-weekly │  │ generate-single │  │   regenerate-   │       │  │
│  │  │     -menu       │  │     -meal       │  │   meal-direct   │       │  │
│  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘       │  │
│  │           │                    │                    │                 │  │
│  │           └────────────────────┴────────────────────┘                 │  │
│  │                               │                                        │  │
│  │           ┌───────────────────┴───────────────────┐                   │  │
│  │           │                                       │                   │  │
│  │           ▼                                       ▼                   │  │
│  │  ┌────────────────────────────────┐    ┌──────────────────┐          │  │
│  │  │     OpenAI Agents SDK          │    │   Supabase DB    │          │  │
│  │  │  ┌────────────────────────┐    │    │  ┌────────────┐  │          │  │
│  │  │  │ fileSearchTool (RAG)   │    │    │  │ proxy解決  │  │          │  │
│  │  │  │ + GPT-5-mini           │    │    │  │ (類似検索) │  │          │  │
│  │  │  │ ※一体化・分離不可     │    │    │  │ [栄養確定] │  │          │  │
│  │  │  └────────────────────────┘    │    │  └────────────┘  │          │  │
│  │  └────────────────────────────────┘    └──────────────────┘          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      PostgreSQL (RLS)                                  │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐ │  │
│  │  │ user_       │  │ meal_plans  │  │ planned_    │  │ health_      │ │  │
│  │  │ profiles    │  │             │  │ meals       │  │ records      │ │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └──────────────┘ │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐ │  │
│  │  │ dataset_    │  │ dataset_    │  │ dataset_    │  │ system_      │ │  │
│  │  │ menu_sets   │  │ recipes     │  │ menu_set_   │  │ settings     │ │  │
│  │  │ (献立セット)│  │ (レシピ)    │  │ items       │  │              │ │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └──────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      OpenAI Vector Store                               │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  献立例ドキュメント（.txt）                                       │  │  │
│  │  │  - 1献立セット = 1ファイル                                       │  │  │
│  │  │  - 献立ID / カテゴリ / 対象 / 栄養 / 料理構成 / 特徴             │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 9-2. 週次献立生成フロー（v2）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 1: 入力収集【Edge Function】                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  Supabase DB から取得:                                                       │
│  - user_profiles（アレルギー、嗜好、調理条件）                                │
│  - health_records（最近の健康データ）                                        │
│  - nutrition_targets（栄養目標）                                             │
│  - pantry_items（冷蔵庫の食材）                                              │
│                                                                              │
│  + ユーザー要望（自然文）                                                    │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 2: プロンプト構築【Edge Function】                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  ハード制約: アレルギー卵 → 卵除外                                           │
│             高血圧 → 塩分 <= 2.5g/食                                         │
│  ソフト制約: 時短希望 → 調理30分以内優先                                     │
│             和食多め → 和食タグ優先                                          │
│             昨日の主菜 → 被り回避                                            │
│                                                                              │
│  → これらをプロンプト文字列として構築                                        │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 3: OpenAI Agents SDK 呼び出し【OpenAI API】                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ const agent = new Agent({                                           │    │
│  │   model: "gpt-5-mini",                                              │    │
│  │   tools: [fileSearchTool(["vs_..."])],  // ← RAGはここで自動実行    │    │
│  │ });                                                                  │    │
│  │ const result = await runner.run(agent, prompt);                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  SDK内部で自動的に:                                                          │
│  1. fileSearchTool が Vector Store を検索（献立例を取得）                   │
│  2. 検索結果 + プロンプト を GPT-5-mini に渡す                              │
│  3. LLM が 21食分の献立JSONを生成                                           │
│                                                                              │
│  ※ RAG検索とLLM呼び出しは分離できない（SDK内部で一体化）                    │
│  ※ 所要時間: ~60-90秒                                                       │
│                                                                              │
│  出力: { meals: [...21食分...], adjustments: [...], weekly_advice: "..." }  │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 4: Zodバリデーション【Edge Function】                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  WeeklyMenuResponseSchema.safeParse(llmOutput)                               │
│  → 成功: 続行                                                                │
│  → 失敗: エラー内容をプロンプトに追加してStep 3を再実行（最大2回）           │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 5: 料理解決（proxy）【Edge Function → Supabase DB】                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  LLMが出した料理名（63品）を Supabase DB で検索:                            │
│                                                                              │
│  1. dataset_recipes から完全一致検索（name_norm）                            │
│  2. 一致なし → pg_trgm + pgvector でハイブリッド類似検索                     │
│  3. similarity >= 0.85 → source: proxy                                       │
│  4. similarity >= 0.50 → source: proxy（警告付き）                           │
│  5. similarity < 0.50 → source: generated（フォールバック）                  │
│                                                                              │
│  ※ バッチ化: 63品を1回のSQLで検索（~1秒）                                   │
│  結果: base_recipe_id, base_recipe_name, 栄養値, 材料, 作り方 を確定         │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 6: 検証（Validation）【Edge Function】                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  proxy解決で取得した材料・栄養をチェック:                                    │
│  □ アレルギー食材が含まれていないか（材料チェック）                          │
│  □ 禁忌食材が含まれていないか                                               │
│  □ 塩分/カロリーがハード制約内か                                            │
│  □ 主菜のタンパク源が連続で被っていないか                                   │
│                                                                              │
│  → 違反あり: 違反枠だけLLMに差し替え依頼（Step 3〜5をその枠だけ再実行）     │
│  → 違反なし: 続行                                                            │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 7: 保存【Edge Function → Supabase DB】                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  meal_plans → meal_plan_days → planned_meals                                │
│                                                                              │
│  planned_meals:                                                              │
│   - dishes: [{ name, role, source, base_recipe_id, 栄養, 材料, 作り方 }]    │
│   - calories_kcal, protein_g, ... : 合計栄養（DBから計算）                   │
│   - source_type: 'dataset' or 'mixed'                                       │
│   - source_dataset_version: '2025-01-01'                                    │
│   - generation_metadata: { model, adjustments, validation_passed, ... }     │
│                                                                              │
│  weekly_menu_requests.status = 'completed'                                  │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Step 8: 画像生成（オプション）【Edge Function → Gemini API】                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  Promise.allSettled で 21枚を全並列生成（~5-10秒）                          │
│  planned_meals.image_url を更新                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 9-3. 責務分担表

| 責務 | 担当 | 実行場所 | 説明 |
|------|------|---------|------|
| ユーザー情報取得 | **DB** | Edge Function | Supabase DBから取得 |
| プロンプト構築 | **Code** | Edge Function | 制約をプロンプト文字列に変換 |
| RAG検索 + LLM呼び出し | **OpenAI Agents SDK** | OpenAI API | 一体化（分離不可） |
| └─ 献立例の検索 | （SDK内部） | （Vector Store） | fileSearchToolが自動実行 |
| └─ 料理の選定・組み合わせ | （SDK内部） | （GPT-5-mini） | 献立例を参考に判断 |
| Zodバリデーション | **Code** | Edge Function | JSON構造の検証 |
| proxy解決 | **DB** | Edge Function | Supabase DBで類似検索 |
| 栄養値の確定 | **DB** | Edge Function | dataset_recipesの確定値 |
| 材料・作り方の確定 | **DB** | Edge Function | dataset_recipesの確定値 |
| ハード制約の検証 | **Code** | Edge Function | アレルギー/塩分等をチェック |
| 部分修復（差し替え） | **SDK + Code** | 両方 | 違反枠だけ再生成 |
| DB保存 | **DB** | Edge Function | planned_mealsに保存 |
| 画像生成 | **Gemini API** | Edge Function | 全並列で呼び出し |

### 9-4. 「たこ焼き+お好み焼き」問題の解決

**問題**: 「ご飯のおかずにたこ焼きとお好み焼き」は不自然だが、ルールで固定すると例外が多すぎる

**解決策（3層防御）**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Layer 1: 構造テンプレート                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  献立例（RAG）から「良い組み合わせ」の構造を参照                              │
│  例: 「主菜1 + 副菜1〜2 + 汁物1 + 主食1」という構成が多い                   │
│  → LLMがこのパターンを自然に踏襲                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Layer 2: LLM常識判断                                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  プロンプトに「献立として自然な組み合わせにしてください」を含める             │
│  RAGで取得した献立例を「良い組み合わせの参考」として提示                      │
│  → LLMが「たこ焼き+お好み焼きは粉もの被りで不自然」と判断                    │
│                                                                              │
│  ただし「たこ焼きパーティー」のような文脈なら許容される（柔軟性）            │
└─────────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Layer 3: 後検証（監視）                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  生成された献立を監視ダッシュボードで確認                                     │
│  不自然な組み合わせが多発 → プロンプト/RAGデータを改善                       │
│  （ルールで弾くのではなく、品質改善のフィードバックループ）                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**ポイント**:
- 固定ルール（`slot_type`, `category` 等）に頼らない
- LLMの「常識」と「献立例の参照」で柔軟に判断
- 例外（パーティー、特別な日）も自然に対応可能
- 問題が多発すれば監視で検知し、RAG/プロンプトを改善

### 9-5. コード配置（packages/core）

```
packages/core/src/
├── schemas/
│   ├── index.ts                    # エクスポート
│   ├── dish.ts                     # Dish スキーマ（planned_meals.dishes[]）
│   ├── menu-response.ts            # LLMレスポンススキーマ
│   └── generation-config.ts        # リトライ設定、閾値、メタデータスキーマ
├── types/
│   └── userProfile.ts              # 既存
├── converters/
│   └── userProfile.ts              # 既存
├── api/
│   └── httpClient.ts               # 既存
└── index.ts                        # 全エクスポート
```

### 9-6. タイムアウト対策

#### Supabase Edge Functions のタイムアウト制限

| プラン | 最大実行時間 |
|--------|------------|
| 無料 | 150秒 |
| 有料（Pro） | 400秒 |

#### v2の処理時間見積もり

| 処理 | 実行場所 | 時間 | 最適化後 |
|------|---------|------|---------|
| ユーザー情報取得 | **Edge Function** (Supabase DB) | ~0.5秒 | ~0.5秒 |
| **OpenAI Agents SDK** | **OpenAI API** | **~60-90秒** | ~60-90秒 |
| └─ RAG検索（fileSearchTool） | （SDK内部で自動実行） | 含む | 含む |
| └─ LLM呼び出し（GPT-5-mini） | （SDK内部で自動実行） | 含む | 含む |
| Zodバリデーション | **Edge Function** (コード) | ~0.1秒 | ~0.1秒 |
| proxy解決（63品） | **Edge Function** (Supabase DB) | ~3-5秒 | **~1秒** |
| 検証・部分修復 | **Edge Function** (コード + 再LLM) | ~0-30秒 | ~0-30秒 |
| DB保存 | **Edge Function** (Supabase DB) | ~1-2秒 | ~1-2秒 |
| 画像生成（21枚） | **Edge Function** (Gemini API) | ~60-120秒 | **~5-10秒** |
| **合計** | | **~130-250秒** | **~70-135秒** |

#### 最適化ポイント

##### 1. proxy解決のバッチ化

```typescript
// ❌ 悪い例: 1品ずつクエリ
for (const dish of dishes) {
  const recipe = await findSimilarRecipe(dish.name);
}

// ✅ 良い例: バッチでクエリ
const dishNames = dishes.map(d => d.name);
const recipes = await findSimilarRecipesBatch(dishNames);
```

```sql
-- 1回のクエリで複数料理を検索
SELECT DISTINCT ON (query_name) 
  query_name, r.*,
  similarity(r.name_norm, query_name) AS score
FROM unnest($1::text[]) AS query_name
CROSS JOIN LATERAL (
  SELECT * FROM dataset_recipes
  WHERE similarity(name_norm, query_name) > 0.3
  ORDER BY similarity(name_norm, query_name) DESC
  LIMIT 1
) r;
```

##### 2. 画像生成の全並列化

```typescript
// ❌ 現在: 順次処理（21枚 × 3-6秒 = 63-126秒）
for (const meal of meals) {
  await generateImage(meal);
}

// ✅ 改善: 全並列処理（21枚同時）
const imageResults = await Promise.allSettled(
  meals.map(meal => generateImageWithRetry(meal))
);
// → 21枚同時 × 1回の往復 = 約5-10秒

// レート制限対策付きの画像生成
async function generateImageWithRetry(meal: Meal, maxRetries = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await generateMealImage(meal.dishName, meal.userId, supabase);
    } catch (error: any) {
      if (error.message?.includes('429') || error.message?.includes('RATE_LIMIT')) {
        // レート制限の場合は指数バックオフで待機
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.warn(`Rate limited, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`Image generation failed for ${meal.dishName}:`, error);
        return null; // 他のエラーは諦める
      }
    }
  }
  return null;
}

// Promise.allSettled で部分失敗を許容
for (const [i, result] of imageResults.entries()) {
  if (result.status === 'fulfilled' && result.value) {
    await updateImageUrl(meals[i].id, result.value);
  }
  // 失敗した画像は null のまま（後で再生成可能）
}
```

**全並列のメリット:**
- 21枚 × 3-6秒 → **約5-10秒**（ネットワーク往復1回分）
- Gemini APIが429を返しても、リトライで対応

**注意点:**
- Gemini API無料枠は15 RPM程度の制限あり → 有料枠推奨
- `Promise.allSettled` で部分失敗を許容（失敗した画像は後から再生成可能）

##### 3. 画像生成の完全分離（オプション）

画像生成を別のEdge Functionに切り出し、非同期で実行：

```
generate-weekly-menu
  │
  ├─ 献立生成・保存（~30-60秒で完了）
  │
  └─ 完了後に generate-meal-images を invoke（fire-and-forget風）
       │
       └─ 21枚の画像を生成してDB更新（別途実行）
```

**注意**: Supabase Edge Functionsはfire-and-forgetが動作しないため、
画像生成は「献立完了後にクライアントから別途呼び出し」または
「pg_cron + pg_netで非同期トリガー」が必要。

##### 4. 段階的なレスポンス

ユーザー体験を優先する場合：

1. **Phase 1**: 献立生成完了 → UIに表示（画像なし）
2. **Phase 2**: 画像生成 → 逐次UIに画像を表示

```typescript
// 献立生成完了時点で即座にレスポンス
await saveMenuToDb(menu);
await updateRequestStatus('completed');

// 画像生成は別途（クライアントがポーリング or WebSocket）
// または planned_meals.image_url が null のものを
// クライアント側で遅延ロード時に生成
```

#### 結論

| 状況 | 対応 |
|------|------|
| **有料プラン（400秒）** | ✅ 余裕あり（最適化後 ~70-135秒） |
| 無料プラン（150秒） | ⚠️ ギリギリ or 超える可能性あり |

**有料プランなら問題なし** 👍

### 9-7. データベースER図（v2追加分）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           データセット系（service role のみ）                 │
│                                                                              │
│  ┌──────────────────┐     ┌──────────────────────┐     ┌─────────────────┐ │
│  │ dataset_menu_sets│     │ dataset_menu_set_items│     │ dataset_recipes │ │
│  ├──────────────────┤     ├──────────────────────┤     ├─────────────────┤ │
│  │ id (PK)          │────<│ menu_set_id (FK)     │     │ id (PK)         │ │
│  │ external_id (UQ) │     │ dish_name            │     │ external_id     │ │
│  │ meal_type        │     │ slot_index           │     │ name            │ │
│  │ target_condition │     │ role                 │     │ name_norm       │ │
│  │ calories_kcal    │     │ recipe_id (FK)       │>────│                 │ │
│  │ protein_g        │     │ mapping_status       │     │ calories_kcal   │ │
│  │ fat_g            │     │ similarity_score     │     │ protein_g       │ │
│  │ carbs_g          │     └──────────────────────┘     │ fat_g           │ │
│  │ sodium_g         │                                   │ carbs_g         │ │
│  │ fiber_g          │                                   │ sodium_g        │ │
│  │ source_url       │                                   │ ingredients     │ │
│  │ tags[]           │                                   │ steps[]         │ │
│  └──────────────────┘                                   │ source_url      │ │
│                                                          │ cuisine         │ │
│  ┌──────────────────┐                                   │ size            │ │
│  │dataset_import_runs│                                   │ kind_tags[]     │ │
│  ├──────────────────┤                                   └─────────────────┘ │
│  │ id (PK)          │                                                        │
│  │ version          │                                                        │
│  │ status           │     ┌──────────────────┐                              │
│  │ menu_sets_count  │     │ system_settings  │                              │
│  │ recipes_count    │     ├──────────────────┤                              │
│  │ mapping_rate     │     │ key (PK)         │                              │
│  └──────────────────┘     │ value            │                              │
│                            │ description      │                              │
│                            └──────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           既存テーブル（拡張）                                │
│                                                                              │
│  ┌──────────────────┐                                                        │
│  │ planned_meals    │                                                        │
│  ├──────────────────┤                                                        │
│  │ id (PK)          │                                                        │
│  │ meal_plan_day_id │                                                        │
│  │ meal_type        │                                                        │
│  │ dish_name        │                                                        │
│  │ dishes (JSONB)   │  ← v2: source, base_recipe_id, similarity_score 追加 │
│  │ ...              │                                                        │
│  │ source_type      │  ← v2: 'legacy' | 'dataset' | 'mixed'                 │
│  │ source_dataset_  │  ← v2: データセット版                                 │
│  │   version        │                                                        │
│  │ generation_      │  ← v2: { model, adjustments, validation_passed, ... } │
│  │   metadata (JSON)│                                                        │
│  └──────────────────┘                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# 10. 栄養素プロパティ命名規則（重要）

## ⚠️ この規則を変更してはいけません

栄養素プロパティは以下の統一された命名規則に従っています。
この規則はDBのJSONB、Edge Functions、UI、型定義すべてで共有されており、
**安易に変更するとデータの不整合やUIの表示崩れを引き起こします。**

## 10-1. 命名規則

```
{栄養素名}_{単位}
```

### 単位の種類

| 単位 | 意味 | 使用する栄養素 |
|------|------|----------------|
| `kcal` | キロカロリー | エネルギー |
| `g` | グラム | タンパク質、脂質、炭水化物、塩分、糖質、食物繊維、脂肪酸 |
| `mg` | ミリグラム | カリウム、カルシウム、リン、マグネシウム、鉄、亜鉛、コレステロール、ビタミンB1/B2/B6/C/E |
| `ug` | マイクログラム | ヨウ素、ビタミンA/B12/D/K、葉酸 |

## 10-2. 完全なプロパティ一覧

### 基本栄養素

| プロパティ名 | 日本語名 | 単位 |
|-------------|---------|------|
| `calories_kcal` | エネルギー | kcal |
| `protein_g` | タンパク質 | g |
| `fat_g` | 脂質 | g |
| `carbs_g` | 炭水化物 | g |

### 塩分・糖質・食物繊維

| プロパティ名 | 日本語名 | 単位 |
|-------------|---------|------|
| `sodium_g` | 塩分（ナトリウム相当量） | g |
| `sugar_g` | 糖質 | g |
| `fiber_g` | 食物繊維 | g |
| `fiber_soluble_g` | 水溶性食物繊維 | g |
| `fiber_insoluble_g` | 不溶性食物繊維 | g |

### ミネラル

| プロパティ名 | 日本語名 | 単位 |
|-------------|---------|------|
| `potassium_mg` | カリウム | mg |
| `calcium_mg` | カルシウム | mg |
| `phosphorus_mg` | リン | mg |
| `magnesium_mg` | マグネシウム | mg |
| `iron_mg` | 鉄 | mg |
| `zinc_mg` | 亜鉛 | mg |
| `iodine_ug` | ヨウ素 | µg |
| `cholesterol_mg` | コレステロール | mg |

### ビタミン

| プロパティ名 | 日本語名 | 単位 |
|-------------|---------|------|
| `vitamin_a_ug` | ビタミンA | µg |
| `vitamin_b1_mg` | ビタミンB1 | mg |
| `vitamin_b2_mg` | ビタミンB2 | mg |
| `vitamin_b6_mg` | ビタミンB6 | mg |
| `vitamin_b12_ug` | ビタミンB12 | µg |
| `vitamin_c_mg` | ビタミンC | mg |
| `vitamin_d_ug` | ビタミンD | µg |
| `vitamin_e_mg` | ビタミンE | mg |
| `vitamin_k_ug` | ビタミンK | µg |
| `folic_acid_ug` | 葉酸 | µg |

### 脂肪酸

| プロパティ名 | 日本語名 | 単位 |
|-------------|---------|------|
| `saturated_fat_g` | 飽和脂肪酸 | g |
| `monounsaturated_fat_g` | 一価不飽和脂肪酸 | g |
| `polyunsaturated_fat_g` | 多価不飽和脂肪酸 | g |

## 10-3. 使用箇所

この命名規則は以下の箇所で使用されています：

| 場所 | ファイル/テーブル | 説明 |
|------|------------------|------|
| **型定義** | `types/domain.ts` (`DishDetail`) | TypeScript型 |
| **DB (JSONB)** | `planned_meals.dishes[]` | 各料理の栄養情報 |
| **DB (カラム)** | `planned_meals.*_g`, `*_mg`, `*_ug` | 食事合計の栄養情報 |
| **Edge Functions** | `generate-weekly-menu-v3` 等 | LLM出力から変換 |
| **UI** | `src/app/(main)/menus/weekly/page.tsx` | 表示処理 |
| **コンバーター** | `lib/converter.ts` | DB→ドメイン変換 |

## 10-4. 変更時の手順（必須）

命名規則を変更する必要がある場合は、以下の手順を**必ず**実行してください：

1. **DBマイグレーション作成**
   - `planned_meals.dishes` JSONB内の全データを新形式に変換
   - 該当するカラム名の変更（必要な場合）

2. **型定義更新**
   - `types/domain.ts` の `DishDetail` インターフェース

3. **Edge Functions更新**
   - `generate-weekly-menu-v3/index.ts`
   - `generate-single-meal-v3/index.ts`
   - `regenerate-meal-direct-v3/index.ts`
   - `_shared/nutrition-calculator.ts`

4. **UI更新**
   - `src/app/(main)/menus/weekly/page.tsx`
   - その他、栄養表示を行うすべてのコンポーネント

5. **コンバーター更新**
   - `lib/converter.ts` の `toPlannedMeal` 等

6. **設計書更新**
   - 本セクション (DESIGN.md 10章) の一覧を更新

7. **テスト**
   - 既存データの表示確認
   - 新規生成データの表示確認

## 10-5. 過去の教訓（2026-01-01）

### 問題

`cal`, `protein`, `fat`, `carbs` といった旧形式と、`calories_kcal`, `protein_g`, `fat_g`, `carbs_g` といった新形式が混在し、UIで栄養が表示されない問題が発生しました。

### 原因

- 型定義を新形式に変更したが、DBの既存データは旧形式のままだった
- UIが新形式を参照するため、旧形式のデータが表示できなかった

### 解決策

- DBマイグレーションを実行し、すべての旧形式データを新形式に変換
- 型定義、Edge Functions、UIを新形式に統一

### 再発防止

- 本セクションを設計書に追加
- 型定義に警告コメントを追加（変更禁止の旨を明記）

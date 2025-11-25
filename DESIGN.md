以下に、**企画書 → 要件定義書 → 基本設計書 → 詳細設計書**の順で、ここまでの内容を統合してまとめます。
（Vercel/Next.js Web版を主軸にしつつ、React Native アプリ展開も前提にした設計にしてあります）

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
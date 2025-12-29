# ほめゴハン - アプリケーション仕様書

## 目次
1. [概要](#1-概要)
2. [技術スタック](#2-技術スタック)
3. [AIモデルと使用用途](#3-aiモデルと使用用途)
4. [データベーススキーマ](#4-データベーススキーマ)
5. [画面構成と遷移](#5-画面構成と遷移)
6. [API仕様](#6-api仕様)
7. [Supabase Edge Functions](#7-supabase-edge-functions)
8. [アルゴリズム詳細](#8-アルゴリズム詳細)
9. [認証・認可](#9-認証認可)
10. [環境変数](#10-環境変数)
11. [モバイルアプリ（React Native / Expo）](#11-モバイルアプリreact-native--expo)

---

## 1. 概要

**ほめゴハン**は、AIを活用した食事管理・献立提案アプリケーションです。

### 主要機能
- 📸 **食事写真分析**: 写真からAIが料理を認識し、栄養素を推定
- 🍽️ **AI献立提案**: ユーザープロファイルに基づくパーソナライズされた週間献立生成
- 📊 **栄養管理**: 目標カロリー・PFCバランスの計算と追跡
- 🏥 **健康記録**: 体重、体脂肪、血圧などの健康データ管理
- 🏆 **ゲーミフィケーション**: バッジ、ストリーク、チャレンジ機能
- 🛒 **買い物リスト**: 献立から自動生成される買い物リスト

---

## 2. 技術スタック

### フロントエンド
| 技術 | バージョン | 用途 |
|------|-----------|------|
| Next.js | 14.2.3 | Reactフレームワーク（App Router） |
| React | 18.3.1 | UIライブラリ |
| TypeScript | 5.9.3 | 型安全な開発 |
| Tailwind CSS | 4.1.17 | スタイリング |
| Framer Motion | 12.23.24 | アニメーション |
| Lucide React | 0.554.0 | アイコン |
| Zod | 4.1.13 | バリデーション |

### モバイル（React Native / Expo）
| 技術 | バージョン | 用途 |
|------|-----------|------|
| React Native | Expo SDKに準拠 | iOS/Android ネイティブアプリ |
| Expo | SDK（EAS前提） | ビルド/配布、カメラ、通知、Deep Link |
| Expo Router | Expo SDKに準拠 | ルーティング（WebのApp Routerに近い構造） |
| TypeScript | Webと同等 | 型安全な開発（`packages/core` で共有） |
| Supabase JS | 2.x | Auth / DB / Storage（クライアント側） |

### バックエンド
| 技術 | 用途 |
|------|------|
| Supabase | PostgreSQLデータベース、認証、ストレージ、Edge Functions |
| Next.js API Routes | RESTful APIエンドポイント |

### AI/ML
| モデル | プロバイダー | 用途 |
|--------|-------------|------|
| GPT-4o-mini | OpenAI | 献立生成、栄養アドバイス |
| Gemini 2.0 Flash | Google | 画像分析（食事・冷蔵庫・健康機器） |
| Gemini 2.5 Flash Preview | Google | 料理画像生成 |

---

## 3. AIモデルと使用用途

### 3.1 OpenAI GPT-5-mini

**使用箇所:**
- `generate-weekly-menu` Edge Function
- `generate-single-meal` Edge Function
- `/api/ai/hint` API

**プロンプト戦略:**
```
役割: 一流の管理栄養士AI
入力: ユーザープロファイル、健康状態、栄養目標、調理条件
出力: JSON形式の献立データ（料理名、カロリー、PFC、調理時間）
```

**パラメータ:**
- `model`: gpt-5-mini
- `temperature`: 0.7-0.8
- `response_format`: { type: "json_object" }

### 3.2 Google Gemini 2.0 Flash

**使用箇所:**
- `/api/ai/analyze-meal-photo` - 食事写真分析
- `/api/ai/analyze-fridge` - 冷蔵庫画像分析
- `analyze-health-photo` Edge Function - 健康機器写真分析

**プロンプト例（食事分析）:**
```
この食事の写真を分析してください。
以下のJSON形式で、写真に写っている全ての料理を特定し、
それぞれの栄養情報を推定してください：
{
  "dishes": [
    {"name": "料理名", "role": "main/side/soup", "cal": 推定カロリー}
  ],
  "totalCalories": 合計カロリー
}
```

**パラメータ:**
- `model`: gemini-2.0-flash-exp
- `temperature`: 0.4
- `maxOutputTokens`: 2048-4096

### 3.3 Google Gemini 3 Pro Image Preview (画像生成 / Nano Banana Pro)

**使用箇所:**
- `generate-weekly-menu` Edge Function
- `generate-single-meal` Edge Function

**プロンプト:**
```
A delicious, appetizing, professional food photography shot of {dishName}.
Natural lighting, high resolution, minimalist plating, Japanese cuisine style.
```

**パラメータ:**
- `model`: gemini-3-pro-image-preview
- `responseModalities`: ['IMAGE']
- `imageConfig`: { aspectRatio: '1:1' }

---

## 4. データベーススキーマ

### 4.1 コアテーブル

#### `user_profiles`
```sql
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  nickname TEXT NOT NULL,
  age INTEGER,
  gender TEXT,  -- 'male', 'female', 'other', 'unspecified'
  height NUMERIC,
  weight NUMERIC,
  target_weight NUMERIC,
  fitness_goals TEXT[],  -- ['lose_weight', 'build_muscle', ...]
  health_conditions TEXT[],  -- ['高血圧', '糖尿病', ...]
  diet_flags JSONB,  -- {allergies: [], dislikes: []}
  work_style TEXT,
  weekly_exercise_minutes INTEGER,
  cooking_experience TEXT,
  weekday_cooking_minutes INTEGER,
  weekend_cooking_minutes INTEGER,
  kitchen_appliances TEXT[],
  favorite_ingredients TEXT[],
  cuisine_preferences JSONB,
  family_size INTEGER DEFAULT 1,
  role TEXT DEFAULT 'user',  -- 'user', 'admin', 'org_admin'
  ...
);
```

#### `meal_plans`
```sql
CREATE TABLE meal_plans (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  title TEXT DEFAULT '週間献立',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT DEFAULT 'draft',  -- 'draft', 'active', 'completed', 'archived'
  is_active BOOLEAN DEFAULT false,
  ...
);
```

#### `meal_plan_days`
```sql
CREATE TABLE meal_plan_days (
  id UUID PRIMARY KEY,
  meal_plan_id UUID REFERENCES meal_plans(id),
  day_date DATE NOT NULL,
  day_of_week TEXT,
  theme TEXT,
  nutritional_focus TEXT,
  is_cheat_day BOOLEAN DEFAULT false,
  UNIQUE(meal_plan_id, day_date)
);
```

#### `planned_meals`
```sql
CREATE TABLE planned_meals (
  id UUID PRIMARY KEY,
  meal_plan_day_id UUID REFERENCES meal_plan_days(id),
  meal_type TEXT NOT NULL,  -- 'breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'
  mode TEXT DEFAULT 'cook',  -- 'cook', 'quick', 'buy', 'out', 'skip'
  dish_name TEXT NOT NULL,
  dishes JSONB,  -- [{name, cal, protein, role, ingredient}]
  image_url TEXT,
  calories_kcal INTEGER,
  protein_g NUMERIC,
  fat_g NUMERIC,
  carbs_g NUMERIC,
  is_completed BOOLEAN DEFAULT false,
  ...
);
```

### 4.2 健康記録テーブル

#### `health_records`
```sql
CREATE TABLE health_records (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  record_date DATE NOT NULL,
  weight NUMERIC,
  body_fat_percentage NUMERIC,
  systolic_bp INTEGER,
  diastolic_bp INTEGER,
  heart_rate INTEGER,
  sleep_hours NUMERIC,
  sleep_quality INTEGER,  -- 1-5
  mood_score INTEGER,  -- 1-5
  stress_level INTEGER,  -- 1-5
  overall_condition INTEGER,  -- 1-5
  water_intake INTEGER,  -- ml
  step_count INTEGER,
  notes TEXT,
  UNIQUE(user_id, record_date)
);
```

#### `health_goals`
```sql
CREATE TABLE health_goals (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  goal_type TEXT NOT NULL,  -- 'weight', 'body_fat', 'steps'
  target_value NUMERIC NOT NULL,
  target_unit TEXT NOT NULL,
  start_value NUMERIC,
  current_value NUMERIC,
  target_date DATE,
  status TEXT DEFAULT 'active',  -- 'active', 'achieved', 'cancelled'
  ...
);
```

#### `health_insights`
```sql
CREATE TABLE health_insights (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  analysis_date DATE NOT NULL,
  period_type TEXT,  -- 'daily', 'weekly', 'monthly'
  insight_type TEXT,  -- 'weight_trend', 'blood_pressure', 'sleep_analysis', ...
  title TEXT NOT NULL,
  summary TEXT,
  details JSONB,
  recommendations TEXT[],
  priority TEXT,  -- 'low', 'medium', 'high', 'critical'
  is_alert BOOLEAN DEFAULT false,
  is_read BOOLEAN DEFAULT false,
  ...
);
```

### 4.3 その他のテーブル

- `meals` - 実際に食べた食事記録
- `meal_nutrition_estimates` - 食事の栄養推定値
- `meal_ai_feedbacks` - AIからのフィードバック
- `shopping_list_items` - 買い物リスト
- `pantry_items` - 冷蔵庫/パントリーの在庫
- `recipes` - レシピ
- `badges` - バッジ定義
- `user_badges` - ユーザーが獲得したバッジ
- `health_challenges` - 健康チャレンジ
- `notification_preferences` - 通知設定

---

## 5. 画面構成と遷移

### 5.1 画面一覧

#### 認証系 (`/auth`)
| パス | 画面名 | 説明 |
|------|--------|------|
| `/` | ランディングページ | 未ログインユーザー向け |
| `/login` | ログイン | メール/パスワード、Google認証 |
| `/signup` | 新規登録 | アカウント作成 |
| `/auth/verify` | メール確認 | 認証メール送信後の案内 |
| `/auth/forgot-password` | パスワードリセット | リセットリンク送信 |
| `/auth/reset-password` | 新パスワード設定 | リセットリンクからアクセス |
| `/auth/callback` | OAuth コールバック | Google認証のリダイレクト先 |

#### メイン機能 (`/main`)
| パス | 画面名 | 説明 |
|------|--------|------|
| `/home` | ホーム | ダッシュボード、今日の献立、統計 |
| `/menus/weekly` | 週間献立 | 7日分の献立表示・編集 |
| `/menus/weekly/request` | 献立リクエスト | AI献立生成ウィザード |
| `/meals/new` | 食事記録 | 写真撮影・分析・記録 |
| `/meals/[id]` | 食事詳細 | 個別の食事詳細 |
| `/profile` | プロフィール | ユーザー情報編集 |
| `/badges` | バッジ | 獲得バッジ一覧 |
| `/settings` | 設定 | アプリ設定 |
| `/about` | アプリについて | 機能紹介 |
| `/contact` | お問い合わせ | 問い合わせフォーム |
| `/terms` | 利用規約 | 利用規約 |
| `/privacy` | プライバシー | プライバシーポリシー |

#### 健康記録 (`/health`)
| パス | 画面名 | 説明 |
|------|--------|------|
| `/health` | 健康ダッシュボード | 健康データ概要 |
| `/health/record` | 詳細記録 | 体重、血圧等の入力 |
| `/health/record/quick` | クイック記録 | 簡易入力（体重のみ等） |
| `/health/graphs` | グラフ | 健康データの推移 |
| `/health/goals` | 目標管理 | 健康目標の設定・進捗 |
| `/health/challenges` | チャレンジ | 健康チャレンジ |
| `/health/insights` | AI分析 | AIによる健康分析 |
| `/health/settings` | 通知設定 | 記録リマインダー設定 |

#### 管理者 (`/admin`)
| パス | 画面名 | 説明 |
|------|--------|------|
| `/admin` | 管理ダッシュボード | 管理者向け概要 |
| `/admin/users` | ユーザー管理 | ユーザー一覧・ロール変更 |
| `/admin/announcements` | お知らせ管理 | お知らせ作成・編集 |
| `/admin/moderation` | モデレーション | 報告された投稿の管理 |

#### 組織 (`/org`)
| パス | 画面名 | 説明 |
|------|--------|------|
| `/org/dashboard` | 組織ダッシュボード | 組織統計 |
| `/org/members` | メンバー管理 | 組織メンバー一覧 |

### 5.2 画面遷移図

```
[ランディング(/)]
    │
    ├─→ [ログイン(/login)] ←─┐
    │       │                │
    │       ├─→ [ホーム(/home)] ←─ [Google OAuth Callback]
    │       │       │
    │       │       ├─→ [週間献立(/menus/weekly)]
    │       │       │       │
    │       │       │       └─→ [献立リクエスト(/menus/weekly/request)]
    │       │       │
    │       │       ├─→ [食事記録(/meals/new)]
    │       │       │
    │       │       ├─→ [健康ダッシュボード(/health)]
    │       │       │       │
    │       │       │       ├─→ [詳細記録(/health/record)]
    │       │       │       ├─→ [目標管理(/health/goals)]
    │       │       │       └─→ [AI分析(/health/insights)]
    │       │       │
    │       │       ├─→ [プロフィール(/profile)]
    │       │       │
    │       │       └─→ [バッジ(/badges)]
    │       │
    │       └─→ [パスワードリセット(/auth/forgot-password)]
    │               │
    │               └─→ [新パスワード設定(/auth/reset-password)]
    │
    └─→ [新規登録(/signup)]
            │
            └─→ [メール確認(/auth/verify)]
                    │
                    └─→ [オンボーディング(/onboarding)]
                            │
                            └─→ [完了(/onboarding/complete)]
                                    │
                                    └─→ [ホーム(/home)]
```

---

## 6. API仕様

### 6.1 AI関連API

#### `POST /api/ai/analyze-meal-photo`
食事写真を分析し、料理と栄養情報を推定

**リクエスト:**
```json
{
  "images": [{"base64": "...", "mimeType": "image/jpeg"}],
  "mealType": "lunch",
  "mealId": "uuid (optional)"
}
```

**レスポンス:**
```json
{
  "dishes": [
    {"name": "鶏の照り焼き", "role": "main", "cal": 350, "ingredient": "鶏もも肉"}
  ],
  "totalCalories": 550,
  "nutritionalAdvice": "タンパク質が豊富な良いバランスです"
}
```

#### `POST /api/ai/analyze-fridge`
冷蔵庫の写真から食材を検出

**リクエスト:**
```json
{
  "imageUrl": "https://..." OR "imageBase64": "...",
  "mimeType": "image/jpeg"
}
```

**レスポンス:**
```json
{
  "ingredients": ["キャベツ", "にんじん", "豚肉"],
  "detailedIngredients": [
    {"name": "キャベツ", "category": "野菜", "quantity": "1/2玉", "freshness": "good", "daysRemaining": 5}
  ],
  "summary": "野菜が豊富です。豚肉と野菜炒めがおすすめ",
  "suggestions": ["野菜炒め", "ポトフ", "回鍋肉"]
}
```

#### `POST /api/ai/menu/weekly/request`
週間献立のAI生成をリクエスト

**リクエスト:**
```json
{
  "startDate": "2025-01-01",
  "constraints": {
    "ingredients": ["鶏肉", "キャベツ"],
    "cookingTime": {"weekday": 30, "weekend": 60},
    "themes": ["時短", "和食"]
  },
  "note": "今週は野菜多めで"
}
```

**レスポンス:**
```json
{
  "requestId": "uuid",
  "status": "processing"
}
```

#### `POST /api/ai/menu/meal/generate`
単一の食事をAI生成

**リクエスト:**
```json
{
  "dayDate": "2025-01-01",
  "mealType": "dinner",
  "preferences": {"quickMeals": true, "healthy": true},
  "note": "魚料理希望"
}
```

### 6.2 献立管理API

#### `GET /api/meal-plans`
ユーザーの献立計画一覧を取得

#### `GET /api/meal-plans/meals`
指定期間の献立を取得

**クエリパラメータ:**
- `startDate`: 開始日 (YYYY-MM-DD)
- `endDate`: 終了日 (YYYY-MM-DD)

#### `POST /api/meal-plans/meals`
新しい献立を追加

#### `PATCH /api/meal-plans/meals/[id]`
献立を更新（完了マーク等）

#### `DELETE /api/meal-plans/meals/[id]`
献立を削除

### 6.3 健康記録API

#### `GET /api/health/records`
健康記録一覧を取得

#### `POST /api/health/records`
新しい健康記録を作成

#### `GET /api/health/records/[date]`
指定日の健康記録を取得

#### `PUT /api/health/records/[date]`
指定日の健康記録を更新

#### `POST /api/health/records/quick`
クイック記録（体重のみ等）

#### `GET /api/health/goals`
健康目標一覧

#### `POST /api/health/goals`
新しい目標を作成

#### `GET /api/health/streaks`
連続記録日数を取得

#### `GET /api/health/insights`
AI分析結果一覧

### 6.4 その他のAPI

| エンドポイント | メソッド | 説明 |
|---------------|---------|------|
| `/api/profile` | GET/PUT | プロフィール取得・更新 |
| `/api/badges` | GET | バッジ一覧 |
| `/api/pantry` | GET/POST | パントリー管理 |
| `/api/recipes` | GET/POST | レシピ管理 |
| `/api/shopping-list` | GET/POST | 買い物リスト |
| `/api/upload` | POST | 画像アップロード |
| `/api/announcements` | GET | お知らせ一覧 |

---

## 7. Supabase Edge Functions

### 7.1 `generate-weekly-menu`

**トリガー:** `/api/ai/menu/weekly/request` からの呼び出し

**処理フロー:**
1. ユーザープロファイル取得
2. 健康記録取得（過去7日間）
3. 健康目標・AIインサイト取得
4. パーソナライズされたプロンプト構築
5. OpenAI GPT-4o-mini で7日分の献立生成
6. `meal_plans`, `meal_plan_days`, `planned_meals` にデータ保存
7. Gemini で各料理の画像生成（オプション）

**栄養目標計算アルゴリズム:**
```typescript
// 基礎代謝（Mifflin-St Jeor式）
BMR = 10 * weight + 6.25 * height - 5 * age + (gender === 'male' ? 5 : -161)

// 活動係数
activityMultiplier = 1.2 // 座位中心
  + (weeklyExercise > 300 ? 0.5 : weeklyExercise > 150 ? 0.3 : 0.1)
  + (avgSteps > 10000 ? 0.2 : 0)

// TDEE
TDEE = BMR * activityMultiplier

// 目標による調整
if (goals.includes('lose_weight')) TDEE -= 500
if (goals.includes('build_muscle')) TDEE += 300
```

### 7.2 `generate-single-meal`

**トリガー:** `/api/ai/menu/meal/generate` からの呼び出し

**処理フロー:**
1. ユーザープロファイル取得
2. 食事タイプごとのカロリー配分計算
3. OpenAI で単一食事生成
4. Gemini で画像生成
5. `planned_meals` に保存

**カロリー配分:**
```typescript
const mealCalorieRatio = {
  breakfast: 0.25,  // 25%
  lunch: 0.35,      // 35%
  dinner: 0.35,     // 35%
  snack: 0.05       // 5%
}
```

### 7.3 `analyze-meal-photo`

**トリガー:** `/api/ai/analyze-meal-photo` からの呼び出し（mealId指定時）

**処理フロー:**
1. Gemini Vision で画像分析
2. 料理名、カロリー、栄養素を推定
3. `planned_meals` の `dishes` フィールドを更新

### 7.4 `analyze-health-photo`

**トリガー:** 健康記録画面からの呼び出し

**処理フロー:**
1. 体重計等の健康機器写真を受信
2. Gemini Vision で数値を読み取り
3. `health_records` に自動入力

### 7.5 `analyze-health-photo`

**トリガー:** 健康記録画面からの写真アップロード

**処理フロー:**
1. JWT認証でユーザー確認
2. 画像データ受信（File or Base64）
3. Gemini 2.0 Flash で画像分析
4. 機器タイプ自動判定（体重計/血圧計/体温計）
5. 数値データ抽出・JSON形式で返却

**対応機器:**
| 機器タイプ | 抽出データ |
|-----------|-----------|
| `weight_scale` | 体重(kg)、体脂肪率(%)、筋肉量(kg) |
| `blood_pressure` | 収縮期血圧(mmHg)、拡張期血圧(mmHg)、脈拍(bpm) |
| `thermometer` | 体温(℃) |

**プロンプト:**
```
あなたは健康機器の画面を読み取る専門家です。
画像に表示されている数値を正確に読み取ってください。

以下のJSON形式で回答してください：
{
  "type": "weight_scale" | "blood_pressure" | "thermometer" | "unknown",
  "values": {
    "weight": 数値（kg単位、体重計の場合）,
    "body_fat_percentage": 数値（%、体脂肪率が表示されている場合）,
    "systolic_bp": 数値（mmHg、収縮期血圧）,
    "diastolic_bp": 数値（mmHg、拡張期血圧）,
    ...
  },
  "confidence": 0.0〜1.0の信頼度,
  "raw_text": "画面に表示されている全てのテキスト"
}
```

**レスポンス例:**
```json
{
  "success": true,
  "result": {
    "type": "weight_scale",
    "values": {
      "weight": 65.2,
      "body_fat_percentage": 18.5,
      "muscle_mass": null
    },
    "confidence": 0.95,
    "raw_text": "65.2 kg 18.5%"
  }
}
```

---

### 7.6 `generate-health-insights`

**トリガー:** 週次スケジュール or 手動トリガー（`/api/health/insights` 経由）

**処理フロー:**
1. JWT認証でユーザー確認
2. 期間設定（daily/weekly/monthly）
3. `health_records` から該当期間のデータ取得
4. ユーザープロファイル・健康目標取得
5. 6種類の分析を実行
6. `health_insights` テーブルに保存

**分析アルゴリズム:**

#### 1. 体重トレンド分析 (`analyzeWeightTrend`)
```typescript
// 変化量計算
const change = lastWeight - firstWeight;

// 目標との比較
if (weightGoal) {
  goalProgress = {
    target: weightGoal.target_value,
    remaining: lastWeight - weightGoal.target_value,
    onTrack: (目標が減量 && 減少中) || (目標が増量 && 増加中)
  };
}

// アラート判定
if (Math.abs(change) > 2) {
  priority = 'high';
  isAlert = true;
}
```

#### 2. 血圧分析 (`analyzeBloodPressure`)
```typescript
// 基準値判定
if (avgSystolic >= 140 || avgDiastolic >= 90) {
  status = '高血圧';
  priority = 'critical';
  isAlert = true;
} else if (avgSystolic >= 130 || avgDiastolic >= 85) {
  status = '高め';
  priority = 'high';
} else if (avgSystolic < 90 || avgDiastolic < 60) {
  status = '低め';
  priority = 'medium';
}
```

#### 3. 睡眠分析 (`analyzeSleep`)
```typescript
// 睡眠時間の評価
if (avgHours < 6) {
  priority = 'high';
  recommendations.push('睡眠時間が不足しています');
}

// 睡眠の質の評価
if (avgQuality < 3) {
  priority = 'high';
  recommendations.push('睡眠の質が低めです');
}
```

#### 4. 相関分析 (`analyzeCorrelations`)
```typescript
// 睡眠と体調の相関を分析
const sleepGoodDays = records.filter(r => 
  r.sleep_quality >= 4 || r.sleep_hours >= 7
);
const sleepGoodMoodAvg = average(sleepGoodDays.map(r => r.mood_score));

const sleepBadDays = records.filter(r => 
  r.sleep_quality <= 2 || r.sleep_hours < 6
);
const sleepBadMoodAvg = average(sleepBadDays.map(r => r.mood_score));

const correlation = sleepGoodMoodAvg - sleepBadMoodAvg;
```

#### 5. 活動量分析 (`analyzeActivity`)
```typescript
// 歩数評価
if (avgSteps < 5000) {
  priority = 'high';
  recommendations.push('活動量が少なめです。1日8000歩を目標に');
} else if (avgSteps >= 10000) {
  recommendations.push('素晴らしい活動量です！');
}
```

#### 6. AI総合分析 (`generateAIInsight`)
```typescript
// OpenAI GPT-4o-mini による総合分析
const prompt = `以下の健康記録データを分析し、
ユーザーへの個別アドバイスを生成してください。

期間: ${periodType}
データサマリー: ${JSON.stringify(summarizeRecords(records))}
ユーザー情報: 年齢、性別、目標...

JSON形式で回答:
{
  "title": "絵文字付きの短いタイトル",
  "summary": "2-3文の要約",
  "recommendations": ["アドバイス1", "アドバイス2"],
  "priority": "low" | "medium" | "high"
}`;
```

**生成されるインサイト例:**
```json
{
  "insight_type": "weight_trend",
  "title": "📉 体重が減少傾向",
  "summary": "この期間で1.5kg減少しました（平均65.2kg）",
  "details": {
    "start_weight": 66.7,
    "end_weight": 65.2,
    "change": -1.5,
    "goal_progress": { "target": 63, "remaining": 2.2, "onTrack": true }
  },
  "recommendations": ["目標に向かって順調です！このペースを維持しましょう"],
  "priority": "low",
  "is_alert": false
}
```

---

### 7.7 `generate-weekly-menu` (健康記録統合版)

**トリガー:** `/api/ai/menu/weekly/request` からの呼び出し

**健康記録の活用:**
```typescript
// 1. 最新の健康記録を取得（過去7日間）
const { data: healthRecords } = await supabase
  .from('health_records')
  .select('*')
  .eq('user_id', userId)
  .gte('record_date', weekAgo)
  .order('record_date', { ascending: false })
  .limit(7);

// 2. 最新のAIアラートを取得
const { data: healthInsights } = await supabase
  .from('health_insights')
  .select('*')
  .eq('user_id', userId)
  .eq('is_alert', true)
  .eq('is_dismissed', false);

// 3. 健康目標を取得
const { data: healthGoals } = await supabase
  .from('health_goals')
  .select('*')
  .eq('user_id', userId)
  .eq('status', 'active');
```

**栄養目標への反映:**
```typescript
function calculateNutritionTarget(profile, healthRecords, healthGoals) {
  // 最新の健康記録から体重を取得
  const latestWeight = healthRecords?.find(r => r.weight)?.weight || profile.weight;
  
  // 最近の平均歩数を計算
  const avgSteps = healthRecords?.filter(r => r.step_count)
    .reduce((sum, r, _, arr) => sum + r.step_count / arr.length, 0) || 0;
  
  // 歩数に応じて活動係数を調整
  if (avgSteps > 12000) activityMultiplier = 1.7;
  else if (avgSteps > 8000) activityMultiplier = 1.5;
  
  // 健康目標から体重目標を取得
  const weightGoal = healthGoals?.find(g => g.goal_type === 'weight');
  if (weightGoal && latestWeight) {
    const weightDiff = latestWeight - weightGoal.target_value;
    if (weightDiff > 0) tdee -= Math.min(500, weightDiff * 50);
  }
  
  // 血圧が高い場合は減塩
  const avgBP = healthRecords?.filter(r => r.systolic_bp)
    .reduce((sum, r, _, arr) => sum + r.systolic_bp / arr.length, 0) || 0;
  const needsLowSodium = avgBP > 130;
  
  return { dailyCalories, protein, fat, carbs, sodium: needsLowSodium ? 1500 : 2300 };
}
```

**健康制約の動的生成:**
```typescript
function buildHealthConstraints(profile, healthRecords, healthInsights) {
  const constraints = [];
  
  // 血圧が高めの場合
  const avgSystolic = healthRecords?.filter(r => r.systolic_bp)
    .reduce((sum, r, _, arr) => sum + r.systolic_bp / arr.length, 0);
  if (avgSystolic > 130) {
    constraints.push('【血圧注意】塩分控えめ、野菜多めの献立を');
  }
  
  // 睡眠の質が低い場合
  const avgSleepQuality = healthRecords?.filter(r => r.sleep_quality)
    .reduce((sum, r, _, arr) => sum + r.sleep_quality / arr.length, 0);
  if (avgSleepQuality < 3) {
    constraints.push('【睡眠サポート】トリプトファン含有食材（牛乳、バナナ）を夕食に');
  }
  
  // ストレスレベルが高い場合
  const avgStress = healthRecords?.filter(r => r.stress_level)
    .reduce((sum, r, _, arr) => sum + r.stress_level / arr.length, 0);
  if (avgStress > 3.5) {
    constraints.push('【ストレス緩和】ビタミンB群、マグネシウム豊富な食材を');
  }
  
  // AIアラートからの推奨事項
  for (const insight of healthInsights) {
    const foodRelated = insight.recommendations?.find(r => 
      r.includes('食') || r.includes('栄養')
    );
    if (foodRelated) constraints.push(`【AI推奨】${foodRelated}`);
  }
  
  return constraints;
}
```

---

## 8. アルゴリズム詳細

### 8.1 栄養目標計算

**ファイル:** `lib/nutrition-calculator.ts`

#### 基礎代謝計算（Mifflin-St Jeor式）
```typescript
export function calculateBMR(profile: UserProfile): number {
  const { weight, height, age, gender } = profile;
  
  if (!weight || !height || !age) return 1800;
  
  if (gender === 'male') {
    return Math.round(10 * weight + 6.25 * height - 5 * age + 5);
  } else {
    return Math.round(10 * weight + 6.25 * height - 5 * age - 161);
  }
}
```

#### 活動係数計算
```typescript
export function calculateActivityMultiplier(profile: UserProfile): number {
  let base = 1.2; // 座位中心
  
  // 仕事スタイルによる調整
  if (workStyle === 'physical') base = 1.6;
  else if (workStyle === 'stand') base = 1.4;
  
  // 運動習慣による調整
  if (weeklyExercise > 300) base += 0.3;
  else if (weeklyExercise > 150) base += 0.2;
  
  // 通勤による調整
  if (commute.method === 'walk' || commute.method === 'bike') {
    base += Math.min(commute.minutes / 60 * 0.1, 0.15);
  }
  
  return Math.min(base, 2.2);
}
```

#### PFCバランス計算
```typescript
export function calculateMacros(profile, dailyCalories): Macros {
  let proteinRatio = 0.20;
  let fatRatio = 0.25;
  let carbsRatio = 0.55;
  
  // 目標による調整
  if (goals.includes('build_muscle')) {
    proteinRatio = 0.30;
    carbsRatio = 0.45;
  }
  
  // 健康状態による調整
  if (conditions.includes('糖尿病')) {
    carbsRatio = 0.40;
    proteinRatio = 0.25;
    fatRatio = 0.35;
  }
  
  return {
    protein: Math.round((dailyCalories * proteinRatio) / 4),
    fat: Math.round((dailyCalories * fatRatio) / 9),
    carbs: Math.round((dailyCalories * carbsRatio) / 4),
  };
}
```

### 8.2 健康状態に基づく食事制約

```typescript
export function buildHealthFocus(profile: UserProfile): HealthFocusItem[] {
  const focuses = [];
  
  // 高血圧
  if (conditions.includes('高血圧')) {
    focuses.push({
      condition: 'high_blood_pressure',
      actions: ['reduce_salt_to_6g', 'increase_potassium', 'dash_diet'],
      excludeIngredients: ['漬物', 'ラーメン', 'カップ麺'],
      preferIngredients: ['バナナ', 'ほうれん草', 'アボカド']
    });
  }
  
  // 糖尿病
  if (conditions.includes('糖尿病')) {
    focuses.push({
      condition: 'diabetes',
      actions: ['low_gi', 'reduce_sugar', 'increase_fiber'],
      excludeIngredients: ['白米（大量）', '砂糖', 'ジュース'],
      preferIngredients: ['玄米', 'オートミール', '野菜']
    });
  }
  
  // ... その他の健康状態
  
  return focuses;
}
```

### 8.3 バッジ判定アルゴリズム

**ファイル:** `/api/badges/route.ts`

```typescript
const BADGE_CONDITIONS = {
  'first_bite': { type: 'meal_count', threshold: 1 },
  'streak_3': { type: 'streak', threshold: 3 },
  'streak_7': { type: 'streak', threshold: 7 },
  'photo_10': { type: 'photo_count', threshold: 10 },
  'veggie_5': { type: 'veg_score_streak', threshold: 5 },
  // ...
};

async function checkBadgeEligibility(userId, badgeCode) {
  const condition = BADGE_CONDITIONS[badgeCode];
  
  switch (condition.type) {
    case 'meal_count':
      const mealCount = await getMealCount(userId);
      return mealCount >= condition.threshold;
    
    case 'streak':
      const streak = await getConsecutiveDays(userId);
      return streak >= condition.threshold;
    
    // ...
  }
}
```

---

## 9. 認証・認可

### 9.1 認証方式

- **メール/パスワード認証**: Supabase Auth
- **Google OAuth**: Supabase Auth + Google Provider
- **セッション管理**: Supabase SSR + Next.js Middleware

### 9.2 ミドルウェア

**ファイル:** `middleware.ts`

```typescript
export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

### 9.3 Row Level Security (RLS)

全テーブルにRLSを適用し、ユーザーは自分のデータのみアクセス可能:

```sql
-- 例: meal_plans
CREATE POLICY "Users can manage own meal plans" ON meal_plans
  FOR ALL USING (auth.uid() = user_id);

-- 例: planned_meals（親テーブル経由でチェック）
CREATE POLICY "Users can manage own planned meals" ON planned_meals
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM meal_plan_days
      JOIN meal_plans ON meal_plans.id = meal_plan_days.meal_plan_id
      WHERE meal_plan_days.id = planned_meals.meal_plan_day_id
      AND meal_plans.user_id = auth.uid()
    )
  );
```

### 9.4 ロール

| ロール | 権限 |
|--------|------|
| `user` | 自分のデータのCRUD |
| `org_admin` | 組織メンバーのデータ閲覧 |
| `admin` | 全データのCRUD、ユーザー管理 |

---

## 10. 環境変数

### 必須
```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=xxx
SUPABASE_SERVICE_ROLE_KEY=xxx

# OpenAI
OPENAI_API_KEY=sk-xxx

# Google AI
GOOGLE_AI_STUDIO_API_KEY=xxx
# または
GOOGLE_GEN_AI_API_KEY=xxx
```

### オプション
```env
# 画像生成モデル（デフォルト: gemini-3-pro-image-preview）
GEMINI_IMAGE_MODEL=gemini-3-pro-image-preview

# 分析モデル（デフォルト: gemini-2.0-flash-exp）
GEMINI_ANALYSIS_MODEL=gemini-2.0-flash-exp
```

---

## 11. モバイルアプリ（React Native / Expo）

### 11.1 方針（Store公開前提）
- **iOS/Android を Expo + EAS で配布**する（App Store / Google Play）
- **モノレポ**で Web と Mobile を同一リポジトリで管理し、型や共通ロジックを段階的に共有する
- クライアント（モバイル）に **秘密鍵（`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `GOOGLE_*_API_KEY`）は絶対に置かない**

### 11.2 モノレポ構成（段階移行）
当面は既存Webをルートのまま維持しつつ、`apps/mobile` と `packages/core` を追加する。
最終的には `apps/web` へ移動する。

```txt
homegohan-app/
├── apps/
│   └── mobile/                 # Expo（iOS/Android）
├── packages/
│   └── core/                   # 共有: 型/バリデーション/APIクライアント/共通ロジック
├── src/                        # 既存Web（最終的に apps/web へ移動）
├── supabase/                   # Edge Functions / migrations
└── types/                      # 段階的に packages/core へ移行予定
```

### 11.3 共有パッケージ（`packages/core`）の責務
- **ドメイン型**（例: `UserProfile`, `MealPlan`, `PlannedMeal` など）
- **バリデーション**（Zod schemas）
- **APIクライアント**（Web/モバイル共通の呼び出し規約）
- **共通ロジック**（日付処理、栄養計算の一部、フォーマット等）

> 移行は「まずモバイル側で必要になったものから切り出す」方式で進める。

### 11.4 認証（Supabase Auth）
- モバイルは **Supabase Auth（email/password → Google/Appleは後追い）**
- セッションは端末に永続化し、API呼び出しでは **Supabase Access Token（JWT）** を利用する

### 11.5 データアクセス方針（Webとモバイルの共存）
#### 原則
- **通常CRUD**（献立/健康記録/買い物/冷蔵庫等）は、モバイルから **Supabase（RLS）を直接利用**してもよい
- **AI処理（OpenAI/Geminiの秘密鍵が必要）**は、以下のいずれかで実行する:
  - **Supabase Edge Functions**（推奨）
  - **Next.js API（BFF）**（移行期間の互換/集約用）

#### 重要：現状のWeb APIの認証方式との差
現行の Next.js API は `@supabase/ssr` により **Cookieセッション前提**の箇所が多い。
モバイルから同APIを叩く場合は **Bearer(JWT)対応**が必要になるため、移行期間は以下を採用する:
- **モバイル → Supabase（RLS）直アクセス + Edge Functions（JWT必須）**
- もしくは **モバイル → Next.js API（Bearer対応を追加）**（段階的に対応）

### 11.6 Push通知（Expo Notifications）
- Expo Push Token を取得し、サーバ側に保存して配信に利用する
- 保存先は以下いずれか（実装で決定）:
  - `user_push_tokens`（新設・推奨）
  - `notification_preferences` に token を追加（単一端末前提なら可）
- 将来的に、健康記録リマインドや献立通知へ拡張する

### 11.7 Deep Link / Universal Link
- `homegohan://` スキームを基本に、iOS/Android のユニバーサルリンクにも対応
- OAuth（Google/Apple）導入時はコールバックURLの設計が必須

### 11.8 EAS Build / EAS Submit（CI/CD）
- `apps/mobile` で EAS を使用し、以下のプロファイルを運用する:
  - **development**: 開発端末向け
  - **preview**: QA/社内配布
  - **production**: ストア公開用
- Secrets（API URL等）は `eas.json` と EAS Secrets を利用し、**リポジトリに秘密情報を残さない**

### 11.9 モバイル用の環境変数（例）
Expoでは `EXPO_PUBLIC_` を付けるとクライアントから参照可能になる。

```env
# Supabase（公開情報）
EXPO_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=xxx

# API（Next.js BFFを使う場合）
EXPO_PUBLIC_API_BASE_URL=https://your-web-domain.example

# ビルド環境
EXPO_PUBLIC_APP_ENV=development|preview|production
```

### 11.10 最終ゴール（機能完全移植）
Webにある **全機能**（メイン機能/組織/管理者/サポート/スーパー管理を含む）を、
段階的にモバイルへ実装する。移行の基準は以下:
- Phase A: **日常利用のメイン導線**（認証/オンボ/ホーム/献立/食事記録/AI相談）
- Phase B: **生活・健康の拡張**（健康/買い物/冷蔵庫/レシピ/バッジ/比較/家族）
- Phase C: **管理系の完全移植**（組織/管理者/サポート/スーパー管理）

### 11.11 機能・画面一覧（Web → Mobile）
#### Webページ一覧（`src/app/**/page.tsx`）
モバイルは以下のWebルートと同等の画面を提供する（ロール/権限により表示制御）。

- **公開ページ（未ログインでも閲覧可）**
  - `/`（LP）
  - `/about`, `/company`, `/contact`, `/faq`, `/guide`, `/legal`, `/news`, `/pricing`
- **認証**
  - `/login`, `/signup`
  - `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify`
- **オンボーディング**
  - `/onboarding`, `/onboarding/complete`
- **メイン（ログイン後）**
  - `/home`
  - `/meals/new`, `/meals/[id]`
  - `/menus/weekly`, `/menus/weekly/request`
  - `/health`
    - `/health/record`, `/health/record/quick`
    - `/health/graphs`, `/health/insights`, `/health/goals`, `/health/challenges`, `/health/settings`
  - `/badges`, `/comparison`
  - `/profile`, `/settings`
  - `/terms`, `/privacy`
- **組織（org）**
  - `/org/dashboard`, `/org/challenges`, `/org/departments`, `/org/invites`, `/org/members`, `/org/settings`
- **管理者（admin）**
  - `/admin`
  - `/admin/announcements`, `/admin/audit-logs`, `/admin/inquiries`, `/admin/moderation`, `/admin/organizations`, `/admin/users`
- **スーパー管理（super-admin）**
  - `/super-admin`
  - `/super-admin/admins`, `/super-admin/database`, `/super-admin/feature-flags`, `/super-admin/settings`
- **サポート（support）**
  - `/support`
  - `/support/inquiries`, `/support/users`

#### モバイルのルーティング方針（Expo Router）
- `apps/mobile/app/(public)`：公開ページ（必要に応じて簡略UI）
- `apps/mobile/app/(auth)`：ログイン/登録/パスワード再設定/メール確認
- `apps/mobile/app/(tabs)`：日常導線（ホーム/献立/食事/健康/設定）
- `apps/mobile/app/(org)` / `(admin)` / `(super-admin)` / `(support)`：ロールに応じた管理画面（設定画面から遷移）

#### バックエンドAPIの対応（モバイル）
- **基本CRUD**: Supabase（RLS）をモバイルから直接利用（anon key + user JWT）
- **AI/秘密鍵が必要**: Supabase Edge Functions（推奨）または Next.js API（BFF）
- **管理系**: 原則は Next.js API を経由（監査/権限/複雑な集計が多いため）

### 11.12 品質保証（仕様↔実装の10パス検証）
全機能実装が完了したら、以下を **最低10周（10パス）** 実施し、都度差分を修正してから次パスへ進む。

- **Pass 1: 画面網羅性**（上記のWebページ一覧がモバイルで全て到達可能か）
- **Pass 2: API網羅性**（各画面のデータ取得/更新が仕様通りか、未使用API/未実装APIの棚卸し）
- **Pass 3: 認証/セッション**（ログイン/ログアウト/復元/期限切れ/メール確認/パスリセット）
- **Pass 4: RLS/権限**（他ユーザー/他ロールのデータにアクセスできないこと、管理画面の表示制御）
- **Pass 5: AI機能**（Edge Functions呼び出し、ユーザーID検証、長時間処理、失敗時のリトライ/表示）
- **Pass 6: 画像/アップロード**（カメラ/フォトライブラリ/Storage/サイズ/失敗時の復帰）
- **Pass 7: データ整合性**（献立/食事/健康/買い物/冷蔵庫の参照整合・削除整合）
- **Pass 8: UX**（ローディング/エラー/空状態/戻る動作/多重送信防止/オフライン時）
- **Pass 9: パフォーマンス**（初回起動、一覧スクロール、画像表示、キャッシュ、メモリ）
- **Pass 10: ストア要件**（権限文言、プライバシー、退会/データ削除導線、審査NG項目）

---

## 付録

### A. ディレクトリ構造

```
homegohan/
├── src/
│   ├── app/
│   │   ├── (admin)/        # 管理者画面
│   │   ├── (auth)/         # 認証画面
│   │   ├── (main)/         # メイン機能画面
│   │   ├── (org)/          # 組織管理画面
│   │   ├── api/            # APIルート
│   │   ├── onboarding/     # オンボーディング
│   │   └── page.tsx        # ランディングページ
│   ├── components/         # 共通コンポーネント
│   ├── hooks/              # カスタムフック
│   └── lib/                # ユーティリティ
├── lib/
│   ├── nutrition-calculator.ts  # 栄養計算
│   ├── converter.ts             # データ変換
│   └── supabase/                # Supabaseクライアント
├── supabase/
│   ├── functions/          # Edge Functions
│   └── migrations/         # DBマイグレーション
├── types/
│   ├── domain.ts           # ドメイン型定義
│   └── database.ts         # DB型定義
└── docs/
    └── schema.sql          # DBスキーマ
```

### B. コーディング規約

- TypeScript strict mode
- ESLint + Prettier
- Tailwind CSS for styling
- Framer Motion for animations
- Server Components優先、必要時のみ"use client"

---

**更新日:** 2025年12月24日
**バージョン:** 0.1.0


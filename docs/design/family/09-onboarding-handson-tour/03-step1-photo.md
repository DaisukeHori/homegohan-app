# 03 — Step 1: 写真からの食事追加 詳細

> 関連: [02-step0-welcome](./02-step0-welcome.md) / [04-step2-menu](./04-step2-menu.md) / [07-components](./07-components.md) / [09-api-spec](./09-api-spec.md) / [14-mocks-i18n](./14-mocks-i18n.md) / [17-security](./17-security.md)

---

## 1. 役割

Step 1 は **「写真 1 枚で食事が記録できる」体験を提供する**。既存 `meals/new` 画面をハイブリッドサンドボックス (mock 中心 + 実 API による実バッジ付与) で再利用。

## 2. ハイブリッドサンドボックスの位置付け

「ぽちぽち体験 + 実バッジ獲得」を両立するため、以下の設計:

| 工程 | 動作 | 実装 |
|---|---|---|
| 写真選択 | 自動でサンプル画像を選択済み状態 | mock |
| AI 解析 | 固定 mock レスポンスを 1.5 秒ローディング後表示 | mock (実 Gemini API は呼ばない) |
| 結果表示 | mock データを既存 result 画面に流し込む | mock |
| 保存 | 実 API `POST /api/meal-plans/add-from-photo?source=handson_tour` を呼ぶ + body に `sandbox: true` | **実 API** |
| バッジ判定 | サーバー側で `first_bite` バッジを実際に付与 (条件: meal_logs INSERT したので発火) | **実 API** |

→ ユーザー体験は完全 mock (90 秒で完走可能) + バッジは実獲得 (既存システムと整合)。

---

## 3. サブステップ詳細

### 3.1 サブステップ表

| sub | 表示要素 | testID 起点 | 自動進行 | 手動進行 | 個人情報展開 |
|---|---|---|---|---|---|
| 1.1 | intro 吹き出し | `tour-step-1-intro` | 2.5s 後 | タップ可 | なし |
| 1.2 | カメラボタン Spotlight | `meal-camera-button` | 2.0s 後 | なし (自動) | なし |
| 1.3 | analyzing スピナー | `meal-analyzing-view` | 1.5s 後 | なし | なし |
| 1.4 | result 画面表示 | `meal-result-screen` | 0.5s 後 | なし | なし |
| 1.5 | 結果カード Spotlight | `meal-result-dish-name` + `meal-result-calories` | なし | 【次へ】タップ | nickname / target_kcal / percent |
| 1.6 | 保存ボタン Spotlight | `meal-save-button` | なし | 【保存】タップ | なし |
| 1.7 | 保存中 spinner | `tour-step-1-saving` | API 完了まで | なし | なし |
| 1.8 | 成功 → Step 2 へ | — | 即時 | なし | なし |

### 3.2 サブステップ 1.1: intro 吹き出し

#### 内容

```
┌────────────────────────────────────┐
│                                    │
│   📸 写真 1 枚で                     │
│      食事が記録できます               │
│                                    │
│   タップで進む                        │
│                                    │
└────────────────────────────────────┘
```

#### 仕様
- 画面中央に白いカード (max-width 280px)
- アイコン: 📸 (24sp)
- タイトル: 18sp / bold
- 「タップで進む」ヒント: 12sp / gray-500
- 自動進行: 2.5 秒後に 1.2 へ
- 手動進行: タップで 1.2 へ即時遷移

#### 文言 (i18n key: `tour.step1.intro_*`)

| key | 文言 |
|---|---|
| `intro_title` | "写真 1 枚で食事が記録できます" |
| `intro_hint` | "タップで進む" |

#### testID
- `tour-step-1-intro`: カード全体
- `tour-step-1-intro-tap`: タップ領域

---

### 3.3 サブステップ 1.2: カメラボタン Spotlight

#### 内容
既存 `meals/new` 画面で `[meal-camera-button]` (撮影ボタン) を Spotlight。吹き出しで案内。

#### 仕様
- Spotlight ターゲット: `meal-camera-button` testID
- spotlight padding: 12px
- 吹き出し位置: target の上 (auto = 画面下に target あれば top に表示)
- 吹き出し内容:
  - title なし
  - body: "写真を撮るかギャラリーから選びます"
  - 進捗ドット: ● ● ○ ○ ○
- 自動進行: 2.0 秒後に 1.3 へ (タップは無視、Spotlight overlay がブロック)

#### サンドボックス挙動
ユーザーが `meal-camera-button` をタップしようとしても overlay でブロックされる。代わりに自動で:
1. サンプル画像 (`assets/handson-tour/sample-meal.jpg` = 唐揚げ定食) を内部 state に注入
2. 1.5 秒間 analyzing 画面を表示 (mock)
3. result 画面へ遷移

#### 文言

| key | 文言 |
|---|---|
| `camera_bubble` | "写真を撮るかギャラリーから選びます" |

---

### 3.4 サブステップ 1.3: analyzing スピナー

#### 内容
既存 `meals/new` 画面の analyzing view (`[meal-analyzing-view]`) を 1.5 秒間表示。

#### 仕様
- 既存 UI 流用 (スピナー + "解析中..." テキスト)
- 1.5 秒後に強制的に 1.4 へ (mock 完了)
- 実 Gemini API は呼ばない

#### Web/Mobile 違い
- web: 既存 `meal-analyzing-view` がそのまま使える (CSS スピナー)
- mobile: 既存 `meal-analyzing-view` がそのまま使える (Reanimated スピナー)

---

### 3.5 サブステップ 1.4: result 画面表示

#### 内容
既存 `meals/new` の result 画面を `MOCK_PHOTO_RESPONSE` で表示。

#### 表示される要素 (既存)
- 写真サムネイル (唐揚げ定食、`sample-meal.jpg`)
- 料理名: "鶏の唐揚げ定食"
- カロリー: 780 kcal
- PFC: 38g / 32g / 88g
- AI 信頼度: 95%
- 日付選択
- 【保存】ボタン
- 【キャンセル】ボタン

#### 0.5 秒後に 1.5 へ自動進行 (Spotlight 表示)

---

### 3.6 サブステップ 1.5: 結果カード Spotlight

#### 内容
`meal-result-dish-name` + `meal-result-calories` を Spotlight。個人情報を反映した吹き出し。

#### 仕様
- Spotlight ターゲット: 2 要素を包含する矩形 (両者 testID の bounding box を merge)
- 吹き出し位置: target の下
- 吹き出し内容:
  - title: "AI が自動判定"
  - body (target_kcal 取得成功時): "{nickname} さんの目標 {target_kcal} kcal/日 の約 {percent}%"
  - body (target_kcal NULL 時): "AI が自動で料理名と栄養を判定しました"
  - 【次へ】ボタン
  - 進捗ドット: ● ● ● ○ ○

#### 個人情報展開ロジック

```ts
import { personalize } from '@homegohan/handson-tour-shared';

const nickname = profile?.nickname || 'あなた';
const targetKcal = profile?.target_kcal_per_day;  // 推測: nutrition_goal + 体重 + 身長 + 年齢 + 性別 から計算
const percent = targetKcal ? Math.round((780 / targetKcal) * 100) : null;

const bodyTemplate = targetKcal
  ? i18n('tour.step1.result_bubble_with_target')
  : i18n('tour.step1.result_bubble_no_target');

const body = personalize(bodyTemplate, { nickname, target_kcal: targetKcal, percent });
```

#### 文言

| key | 文言 |
|---|---|
| `result_title` | "AI が自動判定" |
| `result_bubble_with_target` | "{nickname} さんの目標 {target_kcal} kcal/日 の約 {percent}%" |
| `result_bubble_no_target` | "AI が自動で料理名と栄養を判定しました" |
| `next_button` | "次へ" |

#### target_kcal 取得失敗時のフォールバック
- profile API 失敗 → `result_bubble_no_target` 表示
- `target_kcal_per_day` が profile に存在しない → 同上 (operator/01 の column 確認次第、§99 残不確実性)
- 0 や負値 → 異常値、`result_bubble_no_target` 表示

---

### 3.7 サブステップ 1.6: 保存ボタン Spotlight

#### 内容
`meal-save-button` を Spotlight + 吹き出しで保存を促す。

#### 仕様
- Spotlight ターゲット: `meal-save-button`
- 吹き出し位置: target の上 (画面下にあるボタンなので)
- 吹き出し内容:
  - title なし
  - body: "保存するだけで毎日の記録が完成"
  - 進捗ドット: ● ● ● ● ○

#### 保存タップ動作

```ts
const handleSave = async () => {
  setIsSaving(true);  // 1.7 サブステップへ
  try {
    const response = await fetch('/api/meal-plans/add-from-photo?source=handson_tour', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sandbox: true,
        dishName: '鶏の唐揚げ定食',
        calories: 780,
        protein_g: 38,
        fat_g: 32,
        carbs_g: 88,
        photo_url: null,  // mock のため
        eaten_at: new Date().toISOString(),
        meal_type: 'dinner',
      }),
    });
    if (!response.ok) throw new Error(`status_${response.status}`);

    fireAnalytics('handson_tour_step_completed', { step: 1, dwell_ms: Date.now() - mountTime.current });
    router.push('/handson-tour/menu');
  } catch (err) {
    setIsSaving(false);
    setError(err);  // エラー画面表示 (§3.10)
    fireAnalytics('handson_tour_step_error', { step: 1, error_code: err.message });
  }
};
```

---

### 3.8 サブステップ 1.7: 保存中 spinner

#### 内容
- 既存 result 画面のボタン領域にスピナー
- 【保存】ボタン disabled
- 「保存中...」テキスト
- 想定時間: 100-500ms

#### 仕様
- 全体に薄いオーバーレイは出さない (既存 UX 流用)
- spinner だけ表示 (a11y: `aria-busy="true"` を【保存】ボタンに付与)

---

### 3.9 サブステップ 1.8: 成功 → Step 2 へ

#### 内容
- API 成功後、即時 `/handson-tour/menu` へ遷移
- 遷移は §02-step0 §5 と同じ exit アニメーション (200ms fade)

#### サーバー副作用 (実バッジ付与)
サーバー側で:

```sql
-- meal_logs INSERT
INSERT INTO meal_logs (
  user_id, dish_name, calories, protein_g, fat_g, carbs_g,
  eaten_at, meal_type, source, is_sandbox, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'photo', true, now())
RETURNING id;

-- first_bite バッジ付与 (既存ロジック流用、ただし sandbox 行もカウントする方針)
INSERT INTO user_badges (user_id, badge_id, obtained_at)
SELECT $1, b.id, now() FROM badges b
WHERE b.code = 'first_bite'
  AND NOT EXISTS (SELECT 1 FROM user_badges ub WHERE ub.user_id = $1 AND ub.badge_id = b.id);
```

→ 既に first_bite を持っているユーザー (= force=1 で再表示してる場合) は INSERT されない (NOT EXISTS で防御、§19-rollout)。

---

### 3.10 エラー画面 (1.6 失敗時)

#### 内容

```
┌────────────────────────────────────┐
│   ⚠ 保存できませんでした              │
│                                    │
│   電波の状態を確認して                  │
│   もう一度お試しください                │
│                                    │
│      [   もう一度   ]                  │
│                                    │
│      [   あとで   ]                  │
└────────────────────────────────────┘
```

#### 仕様
- フルスクリーンモーダル (Step 0 と同じパターン)
- 【もう一度】タップ → 1.7 から再実行 (再 API 呼び出し)
- 【あとで】タップ → /home へ遷移 + skip API
- 連続 3 回失敗で【あとで】を強調表示 (太字)

#### 文言

| key | 文言 |
|---|---|
| `error_title` | "保存できませんでした" |
| `error_subtitle` | "電波の状態を確認してもう一度お試しください" |
| `error_retry_button` | "もう一度" |
| `error_skip_button` | "あとで" |

---

## 4. ハイブリッドサンドボックスのプロップ仕様

### 4.1 `<MealNewScreen mode="sandbox">` プロップ

```ts
type MealNewScreenSandboxProps = {
  mode: 'sandbox';
  initialStep: 'mode-select' | 'capture' | 'analyzing' | 'result' | 'select-date';
  prefilled: {
    dishName: string;
    calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
    confidence: number;
    photo_local_uri?: string;  // mobile
    photo_public_url?: string;  // web
  };
  /** 自動進行のシーケンス (sub-step 1.1 → 1.4 を auto で進める) */
  autoSequence?: {
    enabled: true;
    timings: {
      cameraToAnalyzing: number;  // 2000
      analyzingToResult: number;  // 1500
      resultToSpotlight: number;  // 500
    };
  };
  /** 保存時の API オプション */
  apiOptions: {
    source: 'handson_tour';
    sandbox: true;
  };
  /** 保存成功時のコールバック */
  onSandboxComplete: (result: { meal_log_id: string; badge_awarded?: BadgeAward }) => void;
  /** 保存失敗時のコールバック */
  onSandboxError: (error: ErrorPayload) => void;
};

type MealNewScreenNormalProps = {
  mode?: 'normal';
  // 既存 props
};

type MealNewScreenProps = MealNewScreenNormalProps | MealNewScreenSandboxProps;
```

### 4.2 既存ロジックへの分岐

```tsx
function MealNewScreen(props: MealNewScreenProps) {
  if (props.mode === 'sandbox') {
    return <MealNewScreenSandbox {...props} />;
  }
  return <MealNewScreenNormal {...props} />;
}

function MealNewScreenSandbox(props: MealNewScreenSandboxProps) {
  // 自動シーケンスとカスタム保存ロジック
  // overlay は親 (`/handson-tour/photo` page) が管理
}
```

`MealNewScreenSandbox` は内部 state を `prefilled` で初期化、auto sequence で sub-step 1.1 → 1.4 を進める。

---

## 5. mock データ完全定義

### 5.1 `MOCK_PHOTO_RESPONSE`

**Canonical 定義**: `14-mocks-i18n.md` §1.2 を参照 (重複定義を避けるため本ファイルでは省略)。

主要フィールド (本 step で参照):
- `dishName`: '鶏の唐揚げ定食'
- `calories`: 780
- `protein_g` / `fat_g` / `carbs_g`: 38 / 32 / 88

完全な型定義 (`allergy_warnings`, `ai_comment`, `detected_items[]` 等を含む) は §14-mocks-i18n を canonical とする。

### 5.2 サンプル画像メタデータ

```ts
export const SAMPLE_MEAL_IMAGE = {
  // web
  webUrl: '/handson-tour/sample-meal.jpg',
  webUrlWebp: '/handson-tour/sample-meal.webp',  // optional
  // mobile (Expo asset require)
  mobileAssetModule: () => require('../../../apps/mobile/assets/handson-tour/sample-meal.jpg'),
  // metadata
  width: 1024,
  height: 768,
  fileSizeBytes: 200_000,  // 目標 (圧縮後)
  altText: '唐揚げ定食 (ご飯・味噌汁・キャベツ千切り付き)',
};
```

---

## 6. 個人情報の利用 (Step 1)

| フィールド | 取得元 | 利用箇所 |
|---|---|---|
| `nickname` | profile | 1.5 吹き出し |
| `target_kcal_per_day` | profile (推測 column 名、§99) | 1.5 吹き出しの目標値表示 |

target_kcal の正確な column 名 / 計算式は operator/01-data-model 確認後確定 (§99-open-questions §step1)。

---

## 7. アニメーション

### 7.1 サブステップ間のトランジション

| from → to | 動き | duration |
|---|---|---|
| 1.1 → 1.2 (intro fade out + Spotlight on camera) | cross-fade | 200ms |
| 1.2 → 1.3 (Spotlight off + analyzing show) | spotlight fade out 150ms + analyzing 既存 fade-in | 200ms |
| 1.3 → 1.4 (analyzing → result) | 既存遷移 (slide right) | 250ms |
| 1.4 → 1.5 (result マウント完了 → Spotlight) | spotlight fade in 200ms | 200ms |
| 1.5 → 1.6 (Spotlight target 切り替え) | spotlight crossfade + 移動 | 250ms |
| 1.6 → 1.7 (saving) | spotlight fade out + spinner fade in | 150ms |
| 1.7 → 1.8 (Step 2 遷移) | 全体 fade out | 200ms |

### 7.2 reduce-motion 時
- すべての fade を 0ms (jump cut)
- spotlight 移動も即時
- analyzing スピナーは継続表示 (待ち時間は変えない)

---

## 8. testID 一覧

| testID | プラットフォーム | 用途 |
|---|---|---|
| `tour-step-1-intro` | both | 新規 |
| `tour-step-1-intro-tap` | both | 新規、タップ領域 |
| `meal-mode-select-meal` | both | 既存 |
| `meal-camera-button` | both | 既存 |
| `meal-analyzing-view` | both | 既存 |
| `meal-result-screen` | both | 既存 |
| `meal-result-dish-name` | both | 既存 |
| `meal-result-calories` | both | 既存 |
| `meal-save-button` | both | 既存 |
| `tour-step-1-saving` | both | 新規 |
| `tour-step-1-error` | both | 新規 |
| `tour-step-1-error-retry` | both | 新規 |
| `tour-step-1-error-skip` | both | 新規 |

---

## 9. Analytics events (Step 1)

| event | timing | properties |
|---|---|---|
| `handson_tour_step_viewed` | 1.1 マウント | `{ step: 1, platform }` |
| `handson_tour_step_completed` | 1.6 保存成功 | `{ step: 1, dwell_ms }` |
| `handson_tour_step_error` | 1.6 保存失敗 | `{ step: 1, error_code, error_message }` |
| `handson_tour_skipped` | エラー画面【あとで】 | `{ step: 1, reason: 'user_action' }` |
| `handson_tour_skipped` | hard_back | `{ step: 1, reason: 'hard_back' }` |

---

## 10. 状態管理

### 10.1 ローカル state

```ts
type Step1State = {
  subStep: '1.1' | '1.2' | '1.3' | '1.4' | '1.5' | '1.6' | '1.7' | '1.8' | 'error';
  isAutoAdvancing: boolean;
  errorCount: number;
  errorPayload: ErrorPayload | null;
  mountTime: number;  // dwell 計測用
};
```

### 10.2 自動進行のタイマー

```ts
useEffect(() => {
  if (subStep === '1.1') {
    const timer = setTimeout(() => setSubStep('1.2'), 2500);
    return () => clearTimeout(timer);
  }
  if (subStep === '1.2') {
    const timer = setTimeout(() => setSubStep('1.3'), 2000);
    return () => clearTimeout(timer);
  }
  // ... 1.3, 1.4 同様
}, [subStep]);
```

### 10.3 サブステップごとの testID 連動

`<HandsonTourOverlay>` の `targetTestId` は subStep に応じて切り替え:

```ts
const targetTestId = useMemo(() => {
  switch (subStep) {
    case '1.2': return 'meal-camera-button';
    case '1.5': return 'meal-result-dish-name';  // (calories と merge は別途)
    case '1.6': return 'meal-save-button';
    default: return null;  // フルスクリーン or no spotlight
  }
}, [subStep]);
```

---

## 11. テストケース

### 11.1 Unit
- subStep 自動遷移タイマー (1.1 → 1.2 が 2.5 秒で発火)
- prefilled が正しく result 画面に流れる
- 保存 API が `?source=handson_tour&sandbox=true` で呼ばれる
- 失敗時にエラー画面が出る
- 失敗時に skip API が呼ばれない (= retry 可)
- 個人情報フォールバック (target_kcal NULL → no_target 文言)

### 11.2 E2E (Maestro)

```yaml
# 03-step1-photo-success.yaml
appId: com.homegohan.app
---
- runFlow: ../_shared/login-as-new-user.yaml
- assertVisible: { id: tour-step-0 }
- tapOn: { id: tour-step-0-start }
- assertVisible: { id: tour-step-1-intro }
- # 自動進行を待つ (1.1 → 1.2)
- waitForAnimationToEnd: { timeout: 3000 }
- assertVisible: { id: meal-camera-button }
- # 1.2 → 1.3 自動
- waitForAnimationToEnd: { timeout: 2500 }
- assertVisible: { id: meal-analyzing-view }
- # 1.3 → 1.4 自動
- waitForAnimationToEnd: { timeout: 2000 }
- assertVisible: { id: meal-result-screen }
- assertVisible:
    id: meal-result-dish-name
    text: "鶏の唐揚げ定食"
- assertVisible:
    id: meal-result-calories
    text: "780"
- # 1.5 spotlight 表示中
- waitForAnimationToEnd: { timeout: 1000 }
- tapOn:
    id: tour-next-button  # 1.5 → 1.6
- assertVisible:
    id: meal-save-button
- tapOn:
    id: meal-save-button  # 1.6 → 1.7 → 1.8
- waitForAnimationToEnd:
    timeout: 3000
- assertVisible:
    id: tour-step-2-intro  # Step 2 開始
```

```yaml
# 04-step1-error-retry.yaml
appId: com.homegohan.app
env:
  HANDSON_PHOTO_API_FAIL_ONCE: 'true'  # 1 回目 fail mock
---
- runFlow: ../_shared/login-as-new-user.yaml
- tapOn: { id: tour-step-0-start }
# ... 1.6 まで自動進行
- tapOn: { id: meal-save-button }
- assertVisible: { id: tour-step-1-error }
- tapOn: { id: tour-step-1-error-retry }
# 2 回目は成功
- assertVisible: { id: tour-step-2-intro }
```

### 11.3 Integration
- 保存後、`meal_logs` に `is_sandbox=true` の行が追加されている
- `user_badges` に `first_bite` が追加されている (新規ユーザーの場合)
- `force=1` で再表示時、すでに first_bite を持つユーザーには重複 INSERT されない

---

## 12. 残不確実性

[`99-open-questions.md`](./99-open-questions.md) §step1 セクション:

- [ ] `user_profiles.target_kcal_per_day` カラムの存在確認 (operator/01-data-model 確認)
  - 存在しない場合: profile から逐次計算する関数を新規実装するか、または target_kcal_per_day を新規カラム追加するか
- [ ] サンプル画像 webp 化を v1 から実施するか (画像最適化)
- [ ] 1.4 → 1.5 の自動遷移タイミング 0.5s で UX 違和感ないか
- [ ] エラー連続失敗時の【あとで】強調表示の閾値 (3 回で OK か)
- [ ] sandbox 行を /meals/list 等の通常 UI で **隠す** vs **表示** どちらが良いか
  - 案 A: 隠す (UI 汚さない) ← 推奨
  - 案 B: 表示する (体験継続感)

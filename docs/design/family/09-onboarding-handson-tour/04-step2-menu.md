# 04 — Step 2: AI による献立追加 詳細

> 関連: [03-step1-photo](./03-step1-photo.md) / [05-step3-badges](./05-step3-badges.md) / [07-components](./07-components.md) / [09-api-spec](./09-api-spec.md) / [14-mocks-i18n](./14-mocks-i18n.md)

---

## 1. 役割

Step 2 は **「ボタン 1 つで明日の献立が決まる」体験を提供する**。既存 `V4GenerateModal` をハイブリッドサンドボックスで再利用。Step 1 と同じく mock 中心 + 実バッジ付与の方針 (案 B)。

---

## 2. 既存 `V4GenerateModal` の概要 (researcher 結果より)

### 2.1 主要 props (既存)
- `targetSlots[]`: { date, mealType }
- `constraints`: { no_cook?, simple_only?, variety_emphasis? }
- `note?`: 自由記述

### 2.2 主要 testID (既存、web のみ付与)
| testID | 用途 |
|---|---|
| `meal-regenerate-button` | 再生成ボタン (既存) |
| `generation-failed-modal` | 失敗モーダル |
| `generation-retry-button` | リトライ |
| `success-message-title` | 成功メッセージ |
| `success-message-body` | 同上 |
| `ultimate-mode-toggle` | (Premium、disabled) |

### 2.3 既存 API
- `POST /api/ai/menu/v5/generate` (V4 で v5 という命名)
  - Request: `{ targetSlots, constraints, note }`
  - Response: 生成された MealPlan の配列

---

## 3. ハンズオン Step 2 のサブステップ

### 3.1 サブステップ表

| sub | 表示 | testID | 自動進行 | 手動進行 | 個人情報展開 |
|---|---|---|---|---|---|
| 2.1 | intro 吹き出し | `tour-step-2-intro` | 2.5s | タップ可 | なし |
| 2.2 | 条件フラグ Spotlight (no_cook ON 状態) | `v4-no-cook-toggle` | なし | 【次へ】 | なし |

進捗ドット: Step 2 表示中なので **● ● ● ○ ○** (3 番目 active、Step 単位固定)。サブステップ単位ではドット数は変化しない。
| 2.3 | 自由メモ Spotlight | `v4-note-textarea` | なし | 【次へ】 | なし |
| 2.4 | 生成ボタン Spotlight | `v4-generate-button` | なし | 【生成する】タップ | なし |
| 2.5 | ローディング | `v4-loading-spinner` | 2.0s | なし (mock) | なし |
| 2.6 | 結果カード Spotlight | `v4-result-card` | なし | 【次へ】 | allergies / dislikes / cooking_experience |
| 2.7 | 追加ボタン Spotlight | `v4-add-to-menu-button` | なし | 【追加】タップ | なし |
| 2.8 | 追加中 spinner | `tour-step-2-saving` | API 完了 | なし | なし |
| 2.9 | 成功 → Step 3 へ | — | 即時 | なし | なし |

### 3.2 サブステップ 2.1: intro 吹き出し

```
┌────────────────────────────────────┐
│   🤖 ボタン 1 つで                    │
│      明日の献立が決まります             │
│   タップで進む                          │
└────────────────────────────────────┘
```

**仕様**: §03 §3.2 と同形式。アイコンは 🤖。文言:

| key | 文言 |
|---|---|
| `intro_title` | "ボタン 1 つで明日の献立が決まります" |
| `intro_hint` | "タップで進む" |

### 3.3 サブステップ 2.2: 条件フラグ Spotlight

#### 内容
ハンズオンに入った時点で `no_cook: true` が **既にチェック済み**。Spotlight でハイライトしつつ「気分や条件を選びます」と説明。

#### 仕様
- `<V4GenerateModal>` の sandbox モードで `initialFlags={{ no_cook: true }}` を指定
- Spotlight ターゲット: `v4-no-cook-toggle` の checkbox 周辺
- 吹き出し: title なし、body "気分や条件を選びます (今は調理しなくていい がチェック済み)"
- 進捗ドット: **● ● ● ○ ○** (Step 2 = 3 番目 active、Step 単位固定。サブステップで変化しない) (3 番目 active)

#### 文言

| key | 文言 |
|---|---|
| `flags_bubble` | "気分や条件を選びます (今は「調理しなくていい」がチェック済み)" |
| `next_button` | "次へ" |

### 3.4 サブステップ 2.3: 自由メモ Spotlight

#### 内容
`v4-note-textarea` を Spotlight + "自由メモも書けます (任意)" 吹き出し。

#### 仕様
- 入力は不要 (任意)、【次へ】タップで 2.4 へ
- ユーザーが文字入力した場合、その文字列は API request に含めず破棄 (mock のため)
- ただし入力 UI 自体は通常通り反応する (= UX 違和感なし)

#### 文言

| key | 文言 |
|---|---|
| `note_bubble` | "自由メモも書けます (任意)" |

### 3.5 サブステップ 2.4: 生成ボタン Spotlight

#### 内容
`v4-generate-button` を Spotlight + "タップで AI が献立を作ります" 吹き出し。

#### 仕様
- 【生成する】タップで 2.5 (loading) へ
- 実 API は呼ばない (mock 完結)
- mock 遅延は 2.0 秒 (= 体感を実装通りに保つ)

#### 文言

| key | 文言 |
|---|---|
| `generate_bubble` | "タップで AI が献立を作ります" |

### 3.6 サブステップ 2.5: ローディング

#### 内容
既存 `<V4GenerateModal>` のローディング UI を表示。固定 2.0 秒で完了。

#### 仕様
- 既存 UI 流用 (スピナー + "AI が考え中..." テキスト)
- progress bar が出る場合は 0% → 100% で 2.0 秒 (linear)
- 2.0 秒後に強制 2.6 へ
- mock では実 API 呼ばない、`MOCK_MENU_RESPONSE` を直接 state に流し込む

### 3.7 サブステップ 2.6: 結果カード Spotlight

#### 内容
生成された献立カード (`v4-result-card`) を Spotlight + 個人情報を反映した吹き出し。

#### 仕様
- Spotlight ターゲット: `v4-result-card` 全体
- 吹き出し位置: target の下 (画面上部にカードあれば bottom)
- 吹き出し内容:
  - title: "{nickname} さんに合わせた献立"
  - body (allergies あり, cooking_exp あり): "{allergies} は除外、{cooking_experience_text} の手順"
  - body (allergies NULL, cooking_exp あり): "{cooking_experience_text} の手順"
  - body (allergies NULL, cooking_exp NULL/beginner): "初心者でも作れる手順"
  - 【次へ】ボタン

#### 個人情報展開

```ts
const allergies = profile?.allergies ?? [];
const dislikes = profile?.dislikes ?? [];
const excludeList = [...allergies, ...dislikes].slice(0, 3);  // 最大 3 件表示
const cookingExp = profile?.cooking_experience || 'beginner';

const cookingExpText = {
  beginner: '初心者でも作れる',
  intermediate: 'いつもの手順で作れる',
  advanced: 'シェフの腕前を活かせる',
}[cookingExp];

const bubbleBody = excludeList.length > 0
  ? `${excludeList.join('・')} は除外、${cookingExpText} の手順`
  : `${cookingExpText} の手順`;
```

#### 文言

| key | 文言 |
|---|---|
| `result_title` | "{nickname} さんに合わせた献立" |
| `result_bubble_full` | "{exclude_list} は除外、{cooking_experience_text} の手順" |
| `result_bubble_no_exclude` | "{cooking_experience_text} の手順" |
| `next_button` | "次へ" |

### 3.8 サブステップ 2.7: 追加ボタン Spotlight

#### 内容
`v4-add-to-menu-button` を Spotlight + "献立に追加" 吹き出し。

#### 仕様
- Spotlight ターゲット: `v4-add-to-menu-button`
- 【献立に追加】タップで 2.8 (saving) へ
- 進捗ドット: ● ● ● ○ ○ (Step 2 内、ボタン位置)

#### 文言

| key | 文言 |
|---|---|
| `add_bubble` | "献立に追加" |
| `add_button` | "献立に追加" |

### 3.9 サブステップ 2.8: 追加中 spinner

#### 内容
- `<V4GenerateModal>` の【追加】ボタンに spinner 内蔵
- 「追加中...」テキスト
- 想定 100-500ms

#### サーバー処理 (実 API 呼び出し)

```ts
const response = await fetch('/api/menu-plans/add?source=handson_tour', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({
    sandbox: true,
    date_offset_days: 1,  // 明日
    meal_type: 'dinner',
    dish_name: '豚肉と野菜の生姜焼き',
    calories: 620,
    protein_g: 35,
    fat_g: 22,
    carbs_g: 70,
    cooking_time_minutes: 20,
    ingredients: MOCK_MENU_RESPONSE.ingredients,
    instructions: MOCK_MENU_RESPONSE.instructions,
  }),
});
```

サーバー側:
- `weekly_menus` テーブルに `is_sandbox = true` で INSERT
- `planner` バッジ付与 (条件: weekly_menus に 1 件以上ある場合)

### 3.10 サブステップ 2.9: 成功 → Step 3 へ

- 即時 `/handson-tour/badges` へ遷移
- `handson_tour_step_completed { step: 2, dwell_ms }` event

### 3.11 エラー画面 (2.7 失敗時)

§03-step1 §3.10 と同じパターン。文言だけ変更:

| key | 文言 |
|---|---|
| `error_title` | "献立を追加できませんでした" |
| `error_subtitle` | "電波の状態を確認してもう一度お試しください" |

---

## 4. ハイブリッドサンドボックスのプロップ仕様

### 4.1 `<V4GenerateModal mode="sandbox">` プロップ

```ts
type V4GenerateModalSandboxProps = {
  mode: 'sandbox';
  initialFlags: {
    no_cook?: boolean;
    simple_only?: boolean;
    variety_emphasis?: boolean;
  };
  /** ローディング後に注入する mock レスポンス */
  prefilled: typeof MOCK_MENU_RESPONSE;
  /** ローディング時間 (ms) */
  loadingDurationMs: number;  // 2000
  /** API オプション */
  apiOptions: {
    source: 'handson_tour';
    sandbox: true;
  };
  onSandboxComplete: (result: { menu_id: string; badge_awarded?: BadgeAward }) => void;
  onSandboxError: (error: ErrorPayload) => void;
};

type V4GenerateModalProps = V4GenerateModalSandboxProps | V4GenerateModalNormalProps;
```

### 4.2 既存ロジックへの分岐

```tsx
function V4GenerateModal(props: V4GenerateModalProps) {
  if (props.mode === 'sandbox') return <V4GenerateModalSandbox {...props} />;
  return <V4GenerateModalNormal {...props} />;
}
```

`V4GenerateModalSandbox` 内部:
- `initialFlags` で state 初期化
- 【生成する】タップ時、実 API は呼ばず `setTimeout(() => setResult(prefilled), 2000)`
- 【追加】タップ時、実 API を呼ぶ (`apiOptions` 経由)

---

## 5. mock データ完全定義

### 5.1 `MOCK_MENU_RESPONSE` (canonical 参照)

**Canonical 定義**: `14-mocks-i18n.md` §1.3 を参照。重複定義を避けるため本ファイルでは省略。完全な型定義 (servings / difficulty / personalization 等を含む 8 件 ingredients) は §14 を参照。

主要フィールド (本 step で参照):
- `dish_name`: '豚肉と野菜の生姜焼き'
- `calories`: 620, `protein_g`: 35, `fat_g`: 22, `carbs_g`: 70
- `cooking_time_minutes`: 20, `servings`: 2
- `ingredients`: 8 件 / `instructions`: 6 ステップ

(旧コードブロックは削除完了。canonical は §14-mocks-i18n.md §1.3 のみ。)

---

## 6. 個人情報の利用 (Step 2)

| フィールド | 取得元 | 利用箇所 |
|---|---|---|
| `nickname` | profile | 2.6 吹き出し title |
| `allergies` (text[]) | profile (skipable) | 2.6 吹き出し body の "{allergies} は除外" |
| `dislikes` (text[]) | profile (skipable) | 2.6 同上 (allergies と join) |
| `cooking_experience` (enum: beginner/intermediate/advanced) | profile (skipable) | 2.6 吹き出し body の "{cooking_experience_text}" |

### NULL / 空配列フォールバック

| 状況 | 表示 |
|---|---|
| allergies = NULL or [] AND dislikes = NULL or [] | "{cooking_experience_text} の手順" (除外文言なし) |
| cooking_experience = NULL | beginner 扱い ("初心者でも作れる手順") |
| 両方 NULL | "初心者でも作れる手順" |

---

## 7. アニメーション

### 7.1 サブステップ間トランジション

| from → to | 動き | duration |
|---|---|---|
| 2.1 → 2.2 (intro fade out + Spotlight on toggle) | cross-fade | 200ms |
| 2.2 → 2.3 (Spotlight 移動 toggle → textarea) | spotlight 移動 | 250ms |
| 2.3 → 2.4 (Spotlight 移動 textarea → generate button) | spotlight 移動 | 250ms |
| 2.4 → 2.5 (Spotlight off + loading show) | crossfade | 200ms |
| 2.5 → 2.6 (loading off + Spotlight on result) | crossfade | 200ms |
| 2.6 → 2.7 (Spotlight 移動 result → add button) | spotlight 移動 | 250ms |
| 2.7 → 2.8 (Spotlight off + saving spinner) | crossfade | 150ms |
| 2.8 → 2.9 (Step 3 遷移) | 全体 fade out | 200ms |

### 7.2 reduce-motion
すべて 0ms (jump cut)。

---

## 8. testID 一覧

| testID | プラットフォーム | 用途 |
|---|---|---|
| `tour-step-2-intro` | both | 新規 |
| `tour-step-2-intro-tap` | both | 新規 |
| `v4-no-cook-toggle` | web 既存 / mobile 要追加 | フラグ |
| `v4-simple-only-toggle` | both 要追加 | フラグ |
| `v4-variety-emphasis-toggle` | both 要追加 | フラグ |
| `v4-note-textarea` | both 要追加 | 自由メモ |
| `v4-generate-button` | web 既存 / mobile 要追加 | 生成 |
| `v4-loading-spinner` | both 要追加 | ローディング |
| `v4-result-card` | both 要追加 | 結果カード |
| `v4-result-dish-name` | both 要追加 | 料理名 |
| `v4-result-calories` | both 要追加 | カロリー |
| `v4-add-to-menu-button` | both 要追加 | 追加 |
| `tour-step-2-saving` | both | 新規 |
| `tour-step-2-error` | both | 新規 |
| `tour-step-2-error-retry` | both | 新規 |
| `tour-step-2-error-skip` | both | 新規 |

V4GenerateModal 系の testID は web 側にも追加が必要 (現状 5 個のみ、§03 §11.1 で要件化)。

---

## 9. Analytics events (Step 2)

| event | timing | properties |
|---|---|---|
| `handson_tour_step_viewed` | 2.1 マウント | `{ step: 2, platform }` |
| `handson_tour_step_completed` | 2.7 追加成功 | `{ step: 2, dwell_ms }` |
| `handson_tour_step_error` | 2.7 失敗 | `{ step: 2, error_code, error_message }` |
| `handson_tour_skipped` | エラー画面【あとで】 / hard_back | `{ step: 2, reason }` |

---

## 10. 状態管理

### 10.1 ローカル state

```ts
type Step2State = {
  subStep: '2.1' | '2.2' | '2.3' | '2.4' | '2.5' | '2.6' | '2.7' | '2.8' | '2.9' | 'error';
  flags: { no_cook: boolean; simple_only: boolean; variety_emphasis: boolean };
  noteValue: string;  // 入力されても破棄
  loadingProgress: number;  // 0-100
  result: typeof MOCK_MENU_RESPONSE | null;
  errorCount: number;
  errorPayload: ErrorPayload | null;
  mountTime: number;
};
```

### 10.2 自動進行タイマー (loading)

```ts
useEffect(() => {
  if (subStep === '2.5') {
    let progress = 0;
    const interval = setInterval(() => {
      progress += 5;
      setLoadingProgress(progress);
      if (progress >= 100) {
        clearInterval(interval);
        setResult(MOCK_MENU_RESPONSE);
        setSubStep('2.6');
      }
    }, 100);
    return () => clearInterval(interval);
  }
}, [subStep]);
```

### 10.3 Spotlight 連動

```ts
const targetTestId = useMemo(() => {
  switch (subStep) {
    case '2.2': return 'v4-no-cook-toggle';
    case '2.3': return 'v4-note-textarea';
    case '2.4': return 'v4-generate-button';
    case '2.6': return 'v4-result-card';
    case '2.7': return 'v4-add-to-menu-button';
    default: return null;
  }
}, [subStep]);
```

---

## 11. テストケース

### 11.1 Unit
- subStep 自動遷移 (2.5 → 2.6 が 2.0 秒で発火)
- initialFlags が正しくチェック状態に反映される
- prefilled が結果カードに正しく流れる
- 追加 API が `?source=handson_tour&sandbox=true` で呼ばれる
- allergies / dislikes / cooking_experience の各 NULL パターンで吹き出し文言が変わる
- noteValue が API request に **含まれない** こと (mock 完結)

### 11.2 E2E (Maestro)

```yaml
# 05-step2-menu-success.yaml
appId: com.homegohan.app
---
- runFlow: ../03-step1-photo-success.yaml  # Step 1 まで完走
- assertVisible: { id: tour-step-2-intro }
- waitForAnimationToEnd: { timeout: 3000 }
- assertVisible: { id: v4-no-cook-toggle }
- # checked であることを確認 (Maestro: assertVisible で aria-checked=true 等)
- tapOn: { id: tour-next-button }
- assertVisible: { id: v4-note-textarea }
- tapOn: { id: tour-next-button }
- assertVisible: { id: v4-generate-button }
- tapOn: { id: v4-generate-button }
- assertVisible: { id: v4-loading-spinner }
- waitForAnimationToEnd: { timeout: 3000 }
- assertVisible: { id: v4-result-card }
- assertVisible:
    id: v4-result-dish-name
    text: "豚肉と野菜の生姜焼き"
- tapOn: { id: tour-next-button }
- assertVisible: { id: v4-add-to-menu-button }
- tapOn: { id: v4-add-to-menu-button }
- waitForAnimationToEnd: { timeout: 3000 }
- assertVisible: { id: tour-step-3-intro }
```

```yaml
# 06-step2-menu-error-retry.yaml
appId: com.homegohan.app
env:
  HANDSON_MENU_API_FAIL_ONCE: 'true'
---
# ... Step 2.7 まで自動進行
- tapOn: { id: v4-add-to-menu-button }
- assertVisible: { id: tour-step-2-error }
- tapOn: { id: tour-step-2-error-retry }
- assertVisible: { id: tour-step-3-intro }
```

### 11.3 Integration
- 追加 API 成功後、`weekly_menus` に `is_sandbox=true` の行が追加されている
- `user_badges` に `planner` が追加されている
- force=1 で再表示時、すでに planner を持つユーザーには重複 INSERT されない

---

## 12. 残不確実性 (§99 連携)

- [ ] V4GenerateModal の sandbox prop 名称 (`mode='sandbox'` か `sandbox={...}` か、既存命名規則確認)
- [ ] `weekly_menus` テーブルの列名 (date 系、meal_type 系、dish_name 系の正確な名称、operator/01 確認)
- [ ] `planner` バッジの発火条件 (weekly_menus 1 件以上で良いか、別条件か、operator/01 + 既存実装確認)
- [ ] 自由メモ入力を破棄して良いか (実 API 呼ばないので OK だが UX 違和感ないか)
- [ ] ローディング 2.0 秒の妥当性 (実 API レイテンシは ~5-15 秒の場合あり、mock の方が速い → "速くて当然" の体験 OK)

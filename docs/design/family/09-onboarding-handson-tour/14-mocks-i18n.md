# 14 — Mock データ + i18n キー + 文言マスタ

> 関連: [03-step1-photo](./03-step1-photo.md) / [04-step2-menu](./04-step2-menu.md) / [07-components](./07-components.md) / cross/05-i18n-a11y.md

---

## 1. Mock データ完全定義

### 1.1 配置場所

すべての mock データは `packages/handson-tour-shared/src/mocks.ts` に集約。Web/Mobile 両方が同じ source を import するため、片方だけ変更されることがない。

### 1.2 `MOCK_PHOTO_RESPONSE`

```ts
// packages/handson-tour-shared/src/mocks.ts
export const MOCK_PHOTO_RESPONSE = {
  dishName: '鶏の唐揚げ定食',
  calories: 780,
  protein_g: 38,
  fat_g: 32,
  carbs_g: 88,
  confidence: 0.95,
  detected_items: [
    { name: '鶏の唐揚げ', portion_g: 200 },
    { name: '白米', portion_g: 200 },
    { name: '味噌汁', portion_g: 150 },
    { name: 'キャベツ千切り', portion_g: 50 },
  ],
  ai_provider: 'gemini-2.0-flash',
  detected_at: null,
  /** 食材アレルギー警告 (mock では空) */
  allergy_warnings: [],
  /** AI コメント (mock では固定) */
  ai_comment: 'バランスのよい和食定食です。たんぱく質が豊富!',
} as const;

export type MockPhotoResponse = typeof MOCK_PHOTO_RESPONSE;
```

### 1.3 `MOCK_MENU_RESPONSE`

```ts
export const MOCK_MENU_RESPONSE = {
  date_offset_days: 1,
  meal_type: 'dinner' as const,
  dish_name: '豚肉と野菜の生姜焼き',
  calories: 620,
  protein_g: 35,
  fat_g: 22,
  carbs_g: 70,
  cooking_time_minutes: 20,
  servings: 2,  // 2 人前
  difficulty: 'easy' as const,
  ingredients: [
    { name: '豚ロース薄切り', quantity_g: 200, unit: 'g' as const },
    { name: '玉ねぎ', quantity_g: 80, unit: 'g' as const },
    { name: 'ピーマン', quantity_g: 60, unit: 'g' as const },
    { name: 'しょうが', quantity_g: 10, unit: 'g' as const },
    { name: '醤油', quantity_g: 15, unit: 'ml' as const },
    { name: 'みりん', quantity_g: 15, unit: 'ml' as const },
    { name: '砂糖', quantity_g: 5, unit: 'g' as const },
    { name: 'サラダ油', quantity_g: 10, unit: 'ml' as const },
  ],
  instructions: [
    '豚肉に塩こしょうし、軽く片栗粉をまぶす',
    '野菜を一口大に切る (玉ねぎは 1 cm、ピーマンは細切り)',
    'しょうがをすりおろす',
    'フライパンに油を熱し、豚肉を中火で焼く',
    '野菜を加えて炒める',
    '醤油・みりん・砂糖・しょうがを混ぜたタレを加える',
    '全体に火が通ったら盛り付けて完成',
  ],
  ai_provider: 'gemini-2.0-flash',
  generated_at: null,
  /** 個人化情報 (mock では空) */
  personalization: {
    excluded_ingredients: [],
    cooking_difficulty_adjusted: 'easy',
  },
} as const;

export type MockMenuResponse = typeof MOCK_MENU_RESPONSE;
```

### 1.4 サンプル画像メタデータ

```ts
export const SAMPLE_MEAL_IMAGE = {
  webPath: '/handson-tour/sample-meal.jpg',
  webPathWebp: '/handson-tour/sample-meal.webp',
  mobileAssetModule: () => require('../../../apps/mobile/assets/handson-tour/sample-meal.jpg'),
  width: 1024,
  height: 768,
  fileSizeBytes: 200_000,
  mimeType: 'image/jpeg',
  altText: '唐揚げ定食 (ご飯・味噌汁・キャベツ千切り付き)',
  altTextEn: 'Karaage (Japanese fried chicken) set meal with rice, miso soup, and shredded cabbage',
} as const;
```

### 1.5 mock データの更新ポリシー

- mock データの値変更 (例: dishName を変える) は v1 確定後 **freeze**
- 変更する場合は v2 で実施
- 理由: i18n キーの一部に値が埋め込まれている (例: "鶏の唐揚げ定食、780 kcal の約 X%"の文言)

---

## 2. i18n キー全リスト (ja v1)

### 2.1 配置場所

`packages/handson-tour-shared/src/i18n.ts` で ja のみ提供。将来英語化時は en を追加。

### 2.2 キー命名規則

- 階層: `tour.{section}.{element}`
- セクション: `step0`, `step1`, `step2`, `step3`, `step4`, `step5`, `cooking_experience`, `a11y`
- ケース: snake_case

### 2.3 完全リスト

```ts
// packages/handson-tour-shared/src/i18n.ts (ja v1)
export const HANDSON_TOUR_I18N_JA = {
  tour: {
    // ====== Step 0 ウェルカム ======
    step0: {
      title: '{nickname} さん、ようこそ!',
      subtitle: '3 つの便利機能を一緒に試してみましょう (約 90 秒)',
      start_button: 'はじめる',
      later_button: 'あとで',
      a11y_title: 'ステップ 1 / 5、{nickname} さんへのウェルカム画面',
      a11y_start_hint: 'タップするとハンズオンが始まります',
      a11y_later_hint: 'タップするとチュートリアルを終了します',
    },

    // ====== Step 1 写真追加 ======
    step1: {
      // intro
      intro_title: '写真 1 枚で食事が記録できます',
      intro_hint: 'タップで進む',

      // sub-steps
      camera_bubble: '写真を撮るかギャラリーから選びます',
      result_title: 'AI が自動判定',
      result_bubble_with_target: '{nickname} さんの目標 {target_kcal} kcal/日 の約 {percent}%',
      result_bubble_no_target: 'AI が自動で料理名と栄養を判定しました',
      save_bubble: '保存するだけで毎日の記録が完成',

      // buttons
      next_button: '次へ',
      save_button: '保存',

      // error
      error_title: '保存できませんでした',
      error_subtitle: '電波の状態を確認してもう一度お試しください',
      error_retry_button: 'もう一度',
      error_skip_button: 'あとで',

      // a11y
      a11y_title: 'ステップ 2 / 5、写真から食事を追加します',
      a11y_result_announce: '鶏の唐揚げ定食、780 キロカロリー。{nickname} さんの目標 {target_kcal} キロカロリー の {percent} パーセントです。',
    },

    // ====== Step 2 AI 献立 ======
    step2: {
      intro_title: 'ボタン 1 つで明日の献立が決まります',
      intro_hint: 'タップで進む',

      flags_bubble: '気分や条件を選びます (今は「調理しなくていい」がチェック済み)',
      note_bubble: '自由メモも書けます (任意)',
      generate_bubble: 'タップで AI が献立を作ります',

      result_title: '{nickname} さんに合わせた献立',
      result_bubble_full: '{exclude_list} は除外、{cooking_experience_text} の手順',
      result_bubble_no_exclude: '{cooking_experience_text} の手順',

      add_bubble: '献立に追加',

      next_button: '次へ',
      generate_button: '生成する',
      add_button: '献立に追加',

      // error
      error_title: '献立を追加できませんでした',
      error_subtitle: '電波の状態を確認してもう一度お試しください',
      error_retry_button: 'もう一度',
      error_skip_button: 'あとで',

      // a11y
      a11y_title: 'ステップ 3 / 5、AI で献立を作ります',
      a11y_result_announce: '豚肉と野菜の生姜焼き、620 キロカロリー、調理時間 20 分。',
    },

    // ====== Step 3 バッジ確認 ======
    step3: {
      // loading
      loading_text: 'バッジを確認中...',

      // intro
      intro_title: '{nickname} さん、もう 2 つ獲得しています!',
      intro_hint: 'タップで進む',

      // バッジ別吹き出し
      first_bite_title: 'はじめての一歩',
      first_bite_bubble: '写真から記録を 1 度しました',
      planner_title: 'プランナー',
      planner_bubble: '献立を 1 度作りました',
      tutorial_complete_title: '使い方マスター',
      tutorial_complete_bubble: '次の画面で受け取れます',

      next_button: '次へ',

      // error
      error_title: 'バッジ情報を取得できませんでした',
      error_retry_button: 'もう一度',
      error_skip_button: 'あとで',

      // a11y
      a11y_title: 'ステップ 4 / 5、{nickname} さん、もう 2 つバッジを獲得しています',
    },

    // ====== Step 4 卒業 ======
    step4: {
      // saving
      saving_text: '完了処理中...',

      // graduate
      title: '卒業おめでとう! 🎉',
      subtitle: '{nickname} さん、これで homegohan を使いこなせます',
      badge_label: '獲得バッジ: 使い方マスター',
      home_button: 'ホームへ',

      // error
      error_title: '電波が悪いみたい',
      error_subtitle: '少し待ってからもう一度',
      retry_button: 'もう一度',
      error_later_button: 'あとで',

      // a11y
      a11y_title: 'ステップ 5 / 5、卒業画面',
      a11y_announce: '卒業おめでとう。使い方マスターのバッジを獲得しました。',
    },

    // ====== Step 5 通常ホーム + welcome toast ======
    step5: {
      welcome_toast: 'これからは自分のペースで使ってね、{nickname} さん',
      a11y_toast_announce: 'これからは自分のペースで使ってね、{nickname} さん。',
    },

    // ====== cooking_experience テキスト ======
    cooking_experience: {
      beginner: '初心者でも作れる',
      intermediate: 'いつもの手順で作れる',
      advanced: 'シェフの腕前を活かせる',
    },

    // ====== 共通 a11y ======
    a11y: {
      overlay_label: '使い方ガイド',
      progress_label: 'ステップ {current} / {total}',
      next_label: '次のステップへ進む',
      skip_label: 'チュートリアルを終了する',
      save_label: '食事を保存する',
      add_to_menu_label: '献立に追加する',
      home_label: 'ホーム画面へ進む',
      retry_label: 'もう一度実行する',
      spotlight_target_hint: 'ハイライトされた要素の説明',
    },

    // ====== 共通文言 ======
    common: {
      next: '次へ',
      back: '戻る',
      cancel: 'キャンセル',
      ok: 'OK',
      retry: 'もう一度',
      skip: 'あとで',
    },
  },
} as const;

// 型生成
export type HandsonTourI18nJa = typeof HANDSON_TOUR_I18N_JA;
```

### 2.4 i18n キー総数

カテゴリ別:

| セクション | キー数 |
|---|---|
| step0 | 8 |
| step1 | 14 |
| step2 | 14 |
| step3 | 13 |
| step4 | 12 |
| step5 | 2 |
| cooking_experience | 3 |
| a11y | 9 |
| common | 6 |
| **合計** | **81** |

### 2.5 placeholder 一覧

文言中で使う placeholder:

| placeholder | 例 | 使われる箇所 |
|---|---|---|
| `{nickname}` | "太郎" | Step 0/1/2/3/4/5 各所 |
| `{target_kcal}` | "1900" | Step 1 |
| `{percent}` | "41" | Step 1 |
| `{exclude_list}` | "卵・乳" | Step 2 |
| `{cooking_experience_text}` | "初心者でも作れる" | Step 2 |
| `{current}` | "2" | a11y progress |
| `{total}` | "5" | a11y progress |
| `{step}` | (将来) | (なし、step は番号で扱う) |

---

## 3. 文言マスタ (一覧表)

### 3.1 表示文言一覧 (画面別)

#### Step 0
| 表示文言 | i18n key |
|---|---|
| "{nickname} さん、ようこそ!" | `tour.step0.title` |
| "3 つの便利機能を一緒に試してみましょう (約 90 秒)" | `tour.step0.subtitle` |
| "はじめる" | `tour.step0.start_button` |
| "あとで" | `tour.step0.later_button` |

#### Step 1
| 表示文言 | i18n key |
|---|---|
| "写真 1 枚で食事が記録できます" | `tour.step1.intro_title` |
| "タップで進む" | `tour.step1.intro_hint` |
| "写真を撮るかギャラリーから選びます" | `tour.step1.camera_bubble` |
| "AI が自動判定" | `tour.step1.result_title` |
| "{nickname} さんの目標 {target_kcal} kcal/日 の約 {percent}%" | `tour.step1.result_bubble_with_target` |
| "AI が自動で料理名と栄養を判定しました" | `tour.step1.result_bubble_no_target` |
| "保存するだけで毎日の記録が完成" | `tour.step1.save_bubble` |
| "次へ" | `tour.step1.next_button` |
| "保存" | `tour.step1.save_button` |
| "保存できませんでした" | `tour.step1.error_title` |
| "電波の状態を確認してもう一度お試しください" | `tour.step1.error_subtitle` |
| "もう一度" | `tour.step1.error_retry_button` |
| "あとで" | `tour.step1.error_skip_button` |

(以下同様、§2.3 に完全リスト)

---

## 4. 文言レビュー観点

### 4.1 トーン・マナー
- 親しみやすい敬体 (「~ます」)
- 命令形は避ける (例: × 「タップせよ」 → ○ 「タップで進む」)
- 専門用語を最小化 (例: × 「コーチマーク」 → ○ 「使い方ガイド」)

### 4.2 文字数制限
- 吹き出し本文: 30 文字以内 (1 画面で見える程度)
- title: 20 文字以内
- ボタン: 6 文字以内

### 4.3 個人情報埋め込みのバリエーション

長い nickname (30 字超) に対するフォールバックは §2 §3.2 で truncate + …。

---

## 5. 数値定数の統一

### 5.1 ハンズオン中で使う固定値

```ts
// packages/handson-tour-shared/src/constants.ts
export const HANDSON_TOUR_CONSTANTS = {
  // 各ステップの自動進行タイマー (ms)
  STEP1_INTRO_AUTO_MS: 2500,
  STEP1_CAMERA_AUTO_MS: 2000,
  STEP1_ANALYZING_DURATION_MS: 1500,
  STEP1_RESULT_TO_SPOTLIGHT_MS: 500,

  STEP2_INTRO_AUTO_MS: 2500,
  STEP2_LOADING_DURATION_MS: 2000,

  STEP3_INTRO_AUTO_MS: 2000,

  STEP4_SAVING_DELAY_MS: 100,
  STEP4_BUTTON_ACTIVATION_MS: 5000,

  STEP5_TOAST_DURATION_MS: 4000,

  // エラー連続失敗閾値
  ERROR_CONSECUTIVE_THRESHOLD: 3,

  // タイムアウト
  STATUS_API_TIMEOUT_MS: 5000,
  COMPLETE_API_TIMEOUT_MS: 10000,

  // アニメーション
  OVERLAY_FADE_IN_MS: 200,
  OVERLAY_FADE_OUT_MS: 200,
  SPOTLIGHT_MOVE_MS: 250,
  BUBBLE_FADE_IN_MS: 150,
  BUBBLE_FADE_DELAY_MS: 100,

  // 紙吹雪
  CONFETTI_PARTICLE_COUNT: 300,
  CONFETTI_DURATION_MS: 3000,

  // バッジ
  BADGE_GLOW_DURATION_MS: 1000,
} as const;
```

これらの定数を変更すれば全コンポーネントで反映。マジックナンバーは禁止。

---

## 6. 国際化 (英語版) の準備

### 6.1 v2 で追加するファイル

```
packages/handson-tour-shared/src/i18n.en.ts
```

ja のキーを完全 mirror。例:

```ts
export const HANDSON_TOUR_I18N_EN = {
  tour: {
    step0: {
      title: 'Welcome, {nickname}!',
      subtitle: "Let's try 3 useful features together (about 90 seconds)",
      start_button: 'Start',
      later_button: 'Later',
      // ...
    },
    // ...
  },
};
```

### 6.2 ロケール切替

```ts
// packages/handson-tour-shared/src/i18n.ts
import { HANDSON_TOUR_I18N_JA } from './i18n.ja';
import { HANDSON_TOUR_I18N_EN } from './i18n.en';  // v2

export function getHandsonTourI18n(locale: 'ja' | 'en') {
  return locale === 'en' ? HANDSON_TOUR_I18N_EN : HANDSON_TOUR_I18N_JA;
}
```

v1 では ja のみ提供。

### 6.3 翻訳 ガイドライン
- placeholder は **そのまま残す** (例: `{nickname}`)
- 文化依存表現 (例: 🎓 卒業) は en でも使える絵文字を選ぶ
- 文字数制限 (吹き出し 30 字) は en では 60 字程度に緩和

---

## 7. テスト

### 7.1 i18n キー網羅テスト

```ts
// __tests__/i18n.test.ts
import { HANDSON_TOUR_I18N_JA } from '@homegohan/handson-tour-shared';

describe('i18n keys completeness', () => {
  it('should have all required step0 keys', () => {
    expect(HANDSON_TOUR_I18N_JA.tour.step0.title).toBeDefined();
    expect(HANDSON_TOUR_I18N_JA.tour.step0.subtitle).toBeDefined();
    expect(HANDSON_TOUR_I18N_JA.tour.step0.start_button).toBeDefined();
    expect(HANDSON_TOUR_I18N_JA.tour.step0.later_button).toBeDefined();
  });
  // ... 全 81 キー
});
```

### 7.2 placeholder 検出テスト

```ts
import { personalize, HANDSON_TOUR_I18N_JA } from '@homegohan/handson-tour-shared';

describe('placeholder usage in i18n', () => {
  it('all placeholders are replaced', () => {
    const text = HANDSON_TOUR_I18N_JA.tour.step1.result_bubble_with_target;
    const result = personalize(text, {
      nickname: '太郎',
      target_kcal: 1900,
      percent: 41,
    });
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
  });
});
```

### 7.3 mock データ schema テスト

```ts
import { z } from 'zod';
import { MOCK_PHOTO_RESPONSE, MOCK_MENU_RESPONSE } from '@homegohan/handson-tour-shared';

const PhotoResponseSchema = z.object({
  dishName: z.string(),
  calories: z.number().positive(),
  protein_g: z.number().nonnegative(),
  // ...
});

describe('mock data schema validation', () => {
  it('MOCK_PHOTO_RESPONSE matches schema', () => {
    expect(() => PhotoResponseSchema.parse(MOCK_PHOTO_RESPONSE)).not.toThrow();
  });
});
```

---

## 8. 残不確実性 (§99 連携)

- [ ] `MOCK_MENU_RESPONSE` の構造が実 `/api/ai/menu/v5/generate` レスポンスと一致するか (researcher 結果より構造推測、要確認)
- [ ] 個人情報フォールバック時の挙動 (target_kcal 取得失敗) で `result_bubble_no_target` 表示することのユーザビリティ (実体験 vs 個人化が薄まる影響)
- [ ] 文言レビュー (kindergarten 程度の言葉遣いで OK か、もう少し洗練するか)
- [ ] ja のみで v1 リリース、en は v2 で問題ないか
- [ ] サンプル写真 webp 化を Phase 2 で実施するか (sharp/cwebp での変換、CI でビルド時に自動)

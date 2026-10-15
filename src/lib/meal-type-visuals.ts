/**
 * 食事の区分ごとの見た目の表 (Web) (#1665)
 *
 * 区分 (MealType の 5 値) ごとの色・背景色・アイコンの部品を、Web ではここ 1 か所に置く。
 * 各画面は区分との比較の連鎖 (三項・if・switch) や手書きの表を持たず、ここから引く。
 * - 表示名は @homegohan/shared の MEAL_LABELS、絵文字は MEAL_EMOJIS (Web とモバイルで同じ値) から引く。
 * - モバイルの見た目の表 (apps/mobile/src/lib/meal-type-visuals.ts) は、使っていたネイティブの画面と一緒に消した (#1598)。
 * - 表は Record<MealType, …> なので、MealType に値が増えると tsc が漏れを止める。
 *
 * 画面ごとに今の色が違うので、値を揃えずに表を分けている (#1665 では画面の見た目を変えない):
 * - MEAL_TYPE_RECORD_THEME: 食事を記録する画面 (食事の追加・食事の詳細) と、献立の『食事を追加』モーダル。落ち着いた色。
 * - MEAL_TYPE_HOME_THEME: ホームの今日の食事。鮮やかな色 (以前のモバイルの区分の色と同じ値。モバイルの表は #1598 で消した)。
 * 色の値はそれぞれの画面の colors にあった値と同じ (warning / success の系統は STATUS_COLOR_TOKENS と同じ値なのでそこから引く)。
 */
import { Coffee, Moon, Sun, Utensils, type LucideIcon } from 'lucide-react';
import { STATUS_COLOR_TOKENS, type MealType } from '@homegohan/shared';

/** 区分の見た目のうち、アイコンの部品と文字・線の色 */
export type MealTypeIconTheme = { icon: LucideIcon; color: string };
/** アイコンの部品と文字・線の色に、淡い下地の色を加えたもの */
export type MealTypeIconThemeWithBg = MealTypeIconTheme & { bg: string };

/** 食事を記録する画面の配色 (それぞれの画面の colors の accent / purple / blue と同じ値) */
const RECORD_PALETTE = {
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
} as const;

/**
 * 食事を記録する画面 (食事の追加 /meals/new・食事の詳細 /meals/[id]) と、献立の『食事を追加』モーダルの区分の見た目。
 * 食事の詳細は color を、『食事を追加』モーダルは bg を使う。
 */
export const MEAL_TYPE_RECORD_THEME: Record<MealType, MealTypeIconThemeWithBg> = {
  breakfast: { icon: Coffee, color: STATUS_COLOR_TOKENS.warning, bg: STATUS_COLOR_TOKENS.warningLight },
  lunch: { icon: Sun, color: RECORD_PALETTE.accent, bg: RECORD_PALETTE.accentLight },
  dinner: { icon: Moon, color: RECORD_PALETTE.purple, bg: RECORD_PALETTE.purpleLight },
  snack: { icon: Utensils, color: STATUS_COLOR_TOKENS.success, bg: STATUS_COLOR_TOKENS.successLight },
  midnight_snack: { icon: Moon, color: RECORD_PALETTE.blue, bg: RECORD_PALETTE.blueLight },
};

/** ホームの今日の食事の区分の見た目 (鮮やかな色。以前のモバイルの区分の色 MEAL_TYPE_COLORS と同じ値。その表は #1598 で消した) */
export const MEAL_TYPE_HOME_THEME: Record<MealType, MealTypeIconTheme> = {
  breakfast: { icon: Coffee, color: '#FF9800' },
  lunch: { icon: Sun, color: '#4CAF50' },
  dinner: { icon: Moon, color: '#7C4DFF' },
  snack: { icon: Coffee, color: '#E91E63' },
  midnight_snack: { icon: Moon, color: '#3F51B5' },
};

/** 人数の設定 (曜日 × 食事) が持つ区分。おやつ・夜食の人数は設定しない (types/domain の ServingsConfig と同じ 3 食) */
export type ServingsMealType = Extract<MealType, 'breakfast' | 'lunch' | 'dinner'>;

/**
 * 人数の設定の表 (献立の人数の設定・買い物の範囲の人数の表) の、区分の短い名前。
 * Web の人数の表は夕食を「夜」と書く (以前のモバイルの献立のカードの短い名前は「夕」で、値が違った。そのカードは #1598 で消した)。
 */
export const SERVINGS_MEAL_SHORT_LABELS: Record<ServingsMealType, string> = {
  breakfast: '朝',
  lunch: '昼',
  dinner: '夜',
};

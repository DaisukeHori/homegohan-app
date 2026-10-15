/**
 * 食事の区分ごとの見た目の表 (モバイル) (#1665)
 *
 * 区分 (MealType の 5 値) ごとの色・アイコンの部品・短い名前を、モバイルではここ 1 か所に置く。
 * 各画面は区分との比較の連鎖 (三項・if・switch) や手書きの表を持たず、ここから引く。
 * - 表示名は @homegohan/shared の MEAL_LABELS、絵文字は MEAL_EMOJIS (Web とモバイルで同じ値) から引く。
 * - Web の見た目の表は src/lib/meal-type-visuals.ts。
 * - 表は Record<MealType, …> なので、MealType に値が増えると tsc が漏れを止める。
 *
 * - MEAL_TYPE_COLORS: 食事の詳細・週間献立のカード・『食事タイプを選択』モーダルの区分の色 (鮮やかな色。Web のホームと同じ値)。
 * (以前は食事の新規作成の画面 (apps/mobile/app/meals/new.tsx) の区分のボタンの色と下地の色の表も持っていたが、
 *  その画面を消したので表も消した。#1598。食事の記録は WebView の中の Web の画面 (/meals/new) が受け持つ)
 */
import type { Ionicons } from "@expo/vector-icons";
import { CloudMoon, Coffee, Moon, Sun, SunMedium } from "lucide-react-native";
import type { MealType } from "@homegohan/shared";

/** lucide-react-native のアイコンの部品 (どのアイコンも同じ型) */
export type MealTypeLucideIcon = typeof Sun;

/** Ionicons のアイコンの名前 (食事の詳細・『食事タイプを選択』モーダル) */
export const MEAL_TYPE_IONICONS: Record<MealType, keyof typeof Ionicons.glyphMap> = {
  breakfast: "sunny",
  lunch: "partly-sunny",
  dinner: "moon",
  snack: "cafe",
  midnight_snack: "cloudy-night",
};

/** lucide のアイコンの部品 (週間献立のカード) */
export const MEAL_TYPE_LUCIDE_ICONS: Record<MealType, MealTypeLucideIcon> = {
  breakfast: Sun,
  lunch: SunMedium,
  dinner: Moon,
  snack: Coffee,
  midnight_snack: CloudMoon,
};

/** 区分の色 (食事の詳細・週間献立のカード・『食事タイプを選択』モーダル) */
export const MEAL_TYPE_COLORS: Record<MealType, string> = {
  breakfast: "#FF9800",
  lunch: "#4CAF50",
  dinner: "#7C4DFF",
  snack: "#E91E63",
  midnight_snack: "#3F51B5",
};

/**
 * 週間献立のカードの番号付きの名前に使う、区分の短い名前 (1 件目は「朝」「昼」「夕」)。
 * おやつ・夜食は短くせず表示名と同じ。Web の人数の表の短い名前 (夕食を「夜」) とは値が違う。
 */
export const MEAL_TYPE_SHORT_LABELS: Record<MealType, string> = {
  breakfast: "朝",
  lunch: "昼",
  dinner: "夕",
  snack: "おやつ",
  midnight_snack: "夜食",
};

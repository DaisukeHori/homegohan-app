/**
 * 撮影の台本 (shoot.pw.ts) が /api/ai/analyze-meal-photo の応答の代わりに返す、食事の写真の解析の見本の値 (#1867 段 0)。
 *
 * 値は「アプリの写真の解析が作れる文と値」だけにする。記録コメント・栄養メモ・スコアは、supabase/functions/_shared/nutrition-pipeline.ts の
 * buildTemplatePraiseAndTip (定型の文と式) が作るものと同じ。紹介ページ (/) と使い方ガイド (/guide) は同じ画像 (public/guide/comment.png・analyze.png) を
 * 読むので、アプリにできないこと (料理の中身を褒める文・式で出ないスコア) を写してはいけない。
 * tests/landing-page-1867.test.ts の U-25 が、この値がアプリの式と定型の文に合っていることと、画像を撮り直してあることを確かめる。
 * 根拠: docs/design/marketing/01-landing-site.md §7.1 の表。
 */

/** 食事の写真の解析の結果 (応答の形は /api/ai/analyze-meal-photo と同じ。nutrition は食物繊維 fiberG だけを持つ) */
export const GUIDE_MEAL_ANALYSIS = {
  dishes: [
    { name: "鶏の唐揚げ", role: "main", cal: 420, calories_kcal: 420 },
    { name: "ごはん", role: "rice", cal: 250, calories_kcal: 250 },
    { name: "キャベツの千切り", role: "side", cal: 20, calories_kcal: 20 },
    { name: "味噌汁", role: "soup", cal: 50, calories_kcal: 50 },
  ],
  /** 料理の合計 (420 + 250 + 20 + 50) */
  totalCalories: 740,
  /** 写っている量の 1 人前としてありうる値。25 未満なので、栄養メモは食品の働きに触れない定型の 1 つ目の文になる */
  totalProtein: 24,
  totalCarbs: 92,
  /** 24 × 4 + 92 × 4 + 27 × 9 = 707 kcal で、740 kcal と 5 % 以内 */
  totalFat: 27,
  /** 食物繊維 (g)。6 未満 (栄養メモの分かれ目) */
  nutrition: { fiberG: 4 },
  /** アプリの式: 70 + min(10, 24 / 3 = 8) + min(8, 4 * 1.6 = 6.4) + 5 (740 は 250〜900) = 89.4 → 89 */
  overallScore: 89,
  /** 野菜の点 (野菜の材料の重さ / 120 g * 100 を 0〜100 に収めた値。キャベツの千切りと味噌汁の具で 54 g ほど) */
  vegScore: 45,
  /** アプリの定型の文: 料理の名前の先頭 2 つと、食事の区分 (昼食) */
  praiseComment: "鶏の唐揚げ、ごはんの記録がしっかりできていて素晴らしいです。昼食を丁寧に残せていて、とても良い流れです✨",
  /** アプリの定型の 3 つの文の 1 つ目 (タンパク質 25 g 未満・食物繊維 6 g 未満のとき) */
  nutritionTip: "食事を記録して振り返ること自体が、バランス改善の近道です。",
  nutritionalAdvice: "",
  catalogMatches: [] as never[],
};

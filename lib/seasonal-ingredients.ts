// lib/seasonal-ingredients.ts
// 月ごとの旬の食材データ（V4献立生成エンジン用）

export interface SeasonalIngredients {
  vegetables: string[];
  fish: string[];
  fruits: string[];
}

/**
 * 月ごとの旬の食材マスタデータ
 * キー: 月（1-12）
 */
export const SEASONAL_INGREDIENTS: Record<number, SeasonalIngredients> = {
  1: { // 1月
    vegetables: ["白菜", "大根", "ほうれん草", "小松菜", "ねぎ", "ブロッコリー", "かぶ", "れんこん", "春菊", "ごぼう"],
    fish: ["ぶり", "たら", "かに", "ふぐ", "あんこう", "金目鯛", "牡蠣", "わかさぎ", "ひらめ"],
    fruits: ["みかん", "りんご", "いちご", "きんかん", "デコポン"],
  },
  2: { // 2月
    vegetables: ["白菜", "キャベツ", "ほうれん草", "菜の花", "ブロッコリー", "かぶ", "セロリ", "春菊"],
    fish: ["ぶり", "さわら", "たら", "かき", "あさり", "しじみ", "はまぐり"],
    fruits: ["いちご", "デコポン", "いよかん", "ぽんかん", "はっさく"],
  },
  3: { // 3月
    vegetables: ["菜の花", "キャベツ", "新たまねぎ", "アスパラガス", "たけのこ", "ふき", "うど", "せり"],
    fish: ["さわら", "たい", "めばる", "さより", "しらす", "はまぐり", "あさり"],
    fruits: ["いちご", "デコポン", "清見オレンジ", "キウイ"],
  },
  4: { // 4月
    vegetables: ["たけのこ", "新たまねぎ", "春キャベツ", "アスパラガス", "そら豆", "さやえんどう", "ふき", "みつば"],
    fish: ["たい", "かつお", "さわら", "あじ", "しらす", "さざえ"],
    fruits: ["いちご", "キウイ", "グレープフルーツ", "甘夏"],
  },
  5: { // 5月
    vegetables: ["そら豆", "グリーンピース", "アスパラガス", "新じゃがいも", "らっきょう", "新ごぼう", "きぬさや"],
    fish: ["かつお", "あじ", "いわし", "きす", "ほたるいか", "あゆ"],
    fruits: ["いちご", "メロン", "すいか", "さくらんぼ", "びわ"],
  },
  6: { // 6月
    vegetables: ["きゅうり", "なす", "トマト", "ピーマン", "ズッキーニ", "みょうが", "オクラ", "しそ", "新しょうが"],
    fish: ["あじ", "いわし", "すずき", "かます", "あなご", "うなぎ"],
    fruits: ["さくらんぼ", "びわ", "メロン", "すいか", "あんず", "プラム"],
  },
  7: { // 7月
    vegetables: ["トマト", "なす", "きゅうり", "ゴーヤ", "とうもろこし", "えだまめ", "オクラ", "みょうが", "しそ"],
    fish: ["あじ", "うなぎ", "はも", "すずき", "いわし", "あなご", "たこ"],
    fruits: ["すいか", "メロン", "もも", "マンゴー", "ブルーベリー"],
  },
  8: { // 8月
    vegetables: ["トマト", "なす", "きゅうり", "ゴーヤ", "とうもろこし", "えだまめ", "オクラ", "かぼちゃ", "冬瓜"],
    fish: ["さんま", "いわし", "かつお", "うなぎ", "あじ", "たこ"],
    fruits: ["すいか", "もも", "ぶどう", "なし", "マンゴー", "いちじく"],
  },
  9: { // 9月
    vegetables: ["さつまいも", "里芋", "かぼちゃ", "なす", "れんこん", "きのこ類", "しめじ", "まいたけ", "しいたけ"],
    fish: ["さんま", "さば", "いわし", "かつお", "さけ", "いくら", "戻りがつお"],
    fruits: ["ぶどう", "なし", "いちじく", "柿", "栗"],
  },
  10: { // 10月
    vegetables: ["さつまいも", "里芋", "かぼちゃ", "まつたけ", "きのこ類", "春菊", "チンゲン菜", "ながいも"],
    fish: ["さんま", "さば", "さけ", "いくら", "かき", "ししゃも"],
    fruits: ["柿", "りんご", "栗", "ぶどう", "ざくろ", "みかん"],
  },
  11: { // 11月
    vegetables: ["白菜", "大根", "ほうれん草", "春菊", "ねぎ", "里芋", "れんこん", "ごぼう", "ゆりね"],
    fish: ["さば", "たら", "ぶり", "かき", "ずわいがに", "ひらめ", "ふぐ"],
    fruits: ["柿", "りんご", "みかん", "キウイ", "ゆず"],
  },
  12: { // 12月
    vegetables: ["白菜", "大根", "ほうれん草", "小松菜", "ねぎ", "春菊", "かぶ", "れんこん", "ごぼう", "ゆりね"],
    fish: ["ぶり", "たら", "かに", "ふぐ", "あんこう", "かき", "たらば蟹"],
    fruits: ["みかん", "りんご", "ゆず", "キウイ", "いちご"],
  },
};

/**
 * 指定された月の旬の食材を取得
 * @param month 月（1-12）
 * @returns その月の旬の食材
 */
export function getSeasonalIngredients(month: number): SeasonalIngredients {
  const normalizedMonth = ((month - 1) % 12) + 1;
  return SEASONAL_INGREDIENTS[normalizedMonth] || SEASONAL_INGREDIENTS[1];
}

/**
 * 指定された日付の旬の食材を取得
 * @param date 日付オブジェクトまたは日付文字列
 * @returns その月の旬の食材
 */
export function getSeasonalIngredientsForDate(date: Date | string): SeasonalIngredients {
  const d = typeof date === 'string' ? new Date(date) : date;
  const month = d.getMonth() + 1; // JavaScript月は0-indexed
  return getSeasonalIngredients(month);
}

/**
 * 複数の日付範囲で共通する旬の食材を取得
 * @param startDate 開始日
 * @param endDate 終了日
 * @returns 期間中に旬となる食材（重複排除済み）
 */
export function getSeasonalIngredientsForRange(startDate: Date | string, endDate: Date | string): SeasonalIngredients {
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
  const end = typeof endDate === 'string' ? new Date(endDate) : endDate;
  
  const months = new Set<number>();
  const current = new Date(start);
  
  while (current <= end) {
    months.add(current.getMonth() + 1);
    current.setMonth(current.getMonth() + 1);
  }
  // 終了日の月も含める
  months.add(end.getMonth() + 1);
  
  const result: SeasonalIngredients = {
    vegetables: [],
    fish: [],
    fruits: [],
  };
  
  for (const month of months) {
    const ingredients = getSeasonalIngredients(month);
    result.vegetables.push(...ingredients.vegetables);
    result.fish.push(...ingredients.fish);
    result.fruits.push(...ingredients.fruits);
  }
  
  // 重複排除
  return {
    vegetables: [...new Set(result.vegetables)],
    fish: [...new Set(result.fish)],
    fruits: [...new Set(result.fruits)],
  };
}

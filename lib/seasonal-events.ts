// lib/seasonal-events.ts
// 年間行事・イベントデータ（V4献立生成エンジン用）

export interface SeasonalEvent {
  name: string;
  date: string; // "MM-DD" format or "variable" for movable feasts
  dishes: string[];
  ingredients: string[];
  note?: string;
  dateRange?: { start: string; end: string }; // For multi-day events
}

/**
 * 日本の年間行事・イベントマスタデータ
 * 献立提案時に参照される伝統的な行事食情報
 */
export const SEASONAL_EVENTS: SeasonalEvent[] = [
  // 1月
  {
    name: "お正月",
    date: "01-01",
    dishes: ["おせち料理", "お雑煮", "お屠蘇"],
    ingredients: ["餅", "数の子", "黒豆", "栗きんとん", "伊達巻き", "紅白かまぼこ", "えび", "昆布巻き"],
    note: "1/1〜1/3",
    dateRange: { start: "01-01", end: "01-03" },
  },
  {
    name: "七草がゆ",
    date: "01-07",
    dishes: ["七草がゆ"],
    ingredients: ["せり", "なずな", "ごぎょう", "はこべら", "ほとけのざ", "すずな", "すずしろ"],
  },
  {
    name: "鏡開き",
    date: "01-11",
    dishes: ["お汁粉", "雑煮"],
    ingredients: ["餅", "小豆"],
  },
  
  // 2月
  {
    name: "節分",
    date: "02-03",
    dishes: ["恵方巻き", "福豆", "いわしの塩焼き"],
    ingredients: ["海苔", "大豆", "いわし", "酢飯", "きゅうり", "卵焼き"],
  },
  {
    name: "バレンタインデー",
    date: "02-14",
    dishes: ["チョコレートスイーツ", "ガトーショコラ"],
    ingredients: ["チョコレート", "生クリーム", "カカオ"],
  },
  
  // 3月
  {
    name: "ひな祭り",
    date: "03-03",
    dishes: ["ちらし寿司", "はまぐりのお吸い物", "ひなあられ", "桜餅"],
    ingredients: ["はまぐり", "菜の花", "いくら", "錦糸卵", "酢飯"],
  },
  {
    name: "春分の日",
    date: "03-20",
    dishes: ["ぼた餅", "おはぎ"],
    ingredients: ["もち米", "あんこ", "きなこ"],
    note: "日付は変動あり（3/20〜21）",
  },
  {
    name: "ホワイトデー",
    date: "03-14",
    dishes: ["ホワイトチョコスイーツ", "マシュマロ"],
    ingredients: ["ホワイトチョコレート", "マシュマロ"],
  },
  
  // 4月
  {
    name: "お花見",
    date: "variable",
    dishes: ["お花見弁当", "桜餅", "だんご"],
    ingredients: ["桜の葉", "道明寺粉", "海苔巻き"],
    note: "3月下旬〜4月中旬（地域差あり）",
  },
  {
    name: "イースター",
    date: "variable",
    dishes: ["エッグ料理", "ラム肉料理"],
    ingredients: ["卵", "ラム肉", "パン"],
    note: "春分の日以降の最初の満月の次の日曜日",
  },
  
  // 5月
  {
    name: "こどもの日",
    date: "05-05",
    dishes: ["ちまき", "柏餅", "鯉のぼりケーキ"],
    ingredients: ["柏の葉", "笹の葉", "餅米", "あんこ"],
  },
  {
    name: "母の日",
    date: "variable",
    dishes: ["カーネーションケーキ", "特別ディナー"],
    ingredients: [],
    note: "5月第2日曜日",
  },
  
  // 6月
  {
    name: "父の日",
    date: "variable",
    dishes: ["うなぎ", "ステーキ", "ビールに合う料理"],
    ingredients: ["うなぎ", "牛肉"],
    note: "6月第3日曜日",
  },
  {
    name: "夏越の祓",
    date: "06-30",
    dishes: ["水無月", "冷やし中華"],
    ingredients: ["小豆", "ういろう"],
  },
  
  // 7月
  {
    name: "七夕",
    date: "07-07",
    dishes: ["そうめん", "ちらし寿司", "星型料理"],
    ingredients: ["そうめん", "オクラ", "星型野菜"],
  },
  {
    name: "土用の丑の日",
    date: "variable",
    dishes: ["うなぎ", "う巻き", "うざく"],
    ingredients: ["うなぎ", "きゅうり"],
    note: "7月下旬〜8月上旬（立秋前18日間）",
  },
  
  // 8月
  {
    name: "お盆",
    date: "08-13",
    dishes: ["精進料理", "そうめん", "おはぎ"],
    ingredients: ["なす", "きゅうり", "そうめん", "もち米"],
    note: "8/13〜8/16（地域により7月の場合あり）",
    dateRange: { start: "08-13", end: "08-16" },
  },
  
  // 9月
  {
    name: "十五夜（中秋の名月）",
    date: "variable",
    dishes: ["月見団子", "月見そば", "月見うどん"],
    ingredients: ["団子", "里芋", "栗", "枝豆"],
    note: "旧暦8月15日（9月中旬〜10月上旬）",
  },
  {
    name: "敬老の日",
    date: "variable",
    dishes: ["長寿祝い膳", "赤飯"],
    ingredients: ["赤飯", "小豆"],
    note: "9月第3月曜日",
  },
  {
    name: "秋分の日",
    date: "09-23",
    dishes: ["おはぎ", "ぼた餅"],
    ingredients: ["もち米", "あんこ", "きなこ"],
    note: "日付は変動あり（9/22〜24）",
  },
  
  // 10月
  {
    name: "ハロウィン",
    date: "10-31",
    dishes: ["かぼちゃ料理", "パンプキンスープ", "ハロウィンスイーツ"],
    ingredients: ["かぼちゃ", "紫芋", "オレンジ"],
  },
  {
    name: "体育の日/スポーツの日",
    date: "variable",
    dishes: ["運動会弁当", "おにぎり"],
    ingredients: [],
    note: "10月第2月曜日",
  },
  
  // 11月
  {
    name: "七五三",
    date: "11-15",
    dishes: ["お赤飯", "千歳飴", "祝い膳"],
    ingredients: ["赤飯", "小豆"],
  },
  {
    name: "勤労感謝の日",
    date: "11-23",
    dishes: ["新米料理", "収穫祭料理"],
    ingredients: ["新米", "野菜"],
  },
  {
    name: "ボジョレーヌーヴォー解禁",
    date: "variable",
    dishes: ["ワインに合う料理", "チーズ", "フレンチ"],
    ingredients: ["チーズ", "生ハム", "パン"],
    note: "11月第3木曜日",
  },
  
  // 12月
  {
    name: "冬至",
    date: "12-22",
    dishes: ["かぼちゃ煮", "ゆず湯"],
    ingredients: ["かぼちゃ", "小豆", "ゆず"],
    note: "日付は変動あり（12/21〜22）",
  },
  {
    name: "クリスマス・イヴ",
    date: "12-24",
    dishes: ["ローストチキン", "クリスマスケーキ", "シチュー"],
    ingredients: ["鶏肉", "生クリーム", "イチゴ", "スポンジケーキ"],
  },
  {
    name: "クリスマス",
    date: "12-25",
    dishes: ["ローストチキン", "ローストビーフ", "クリスマスケーキ", "シチュー"],
    ingredients: ["鶏肉", "牛肉", "生クリーム", "野菜"],
    dateRange: { start: "12-24", end: "12-25" },
  },
  {
    name: "大晦日",
    date: "12-31",
    dishes: ["年越しそば", "おせち準備"],
    ingredients: ["そば", "ねぎ", "えび天ぷら"],
  },
];

/**
 * 指定された日付に該当するイベントを取得
 * @param date 日付オブジェクトまたは日付文字列（YYYY-MM-DD）
 * @returns その日に該当するイベント配列
 */
export function getEventsForDate(date: Date | string): SeasonalEvent[] {
  const d = typeof date === 'string' ? new Date(date) : date;
  const monthDay = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  
  return SEASONAL_EVENTS.filter(event => {
    // 固定日のイベント
    if (event.date === monthDay) {
      return true;
    }
    
    // 期間イベントのチェック
    if (event.dateRange) {
      const [startMonth, startDay] = event.dateRange.start.split('-').map(Number);
      const [endMonth, endDay] = event.dateRange.end.split('-').map(Number);
      const currentMonth = d.getMonth() + 1;
      const currentDay = d.getDate();
      
      // 同月内の範囲チェック
      if (startMonth === endMonth && currentMonth === startMonth) {
        return currentDay >= startDay && currentDay <= endDay;
      }
      // 年をまたがない範囲チェック
      if (currentMonth === startMonth && currentDay >= startDay) {
        return true;
      }
      if (currentMonth === endMonth && currentDay <= endDay) {
        return true;
      }
      if (currentMonth > startMonth && currentMonth < endMonth) {
        return true;
      }
    }
    
    return false;
  });
}

/**
 * 指定された日付範囲内のイベントを取得
 * @param startDate 開始日
 * @param endDate 終了日
 * @returns 期間内のイベント配列（重複排除済み）
 */
export function getEventsForRange(startDate: Date | string, endDate: Date | string): SeasonalEvent[] {
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
  const end = typeof endDate === 'string' ? new Date(endDate) : endDate;
  
  const eventSet = new Map<string, SeasonalEvent>();
  const current = new Date(start);
  
  while (current <= end) {
    const events = getEventsForDate(current);
    for (const event of events) {
      if (!eventSet.has(event.name)) {
        eventSet.set(event.name, event);
      }
    }
    current.setDate(current.getDate() + 1);
  }
  
  return Array.from(eventSet.values());
}

/**
 * 指定された月のイベントを取得
 * @param month 月（1-12）
 * @returns その月のイベント配列
 */
export function getEventsForMonth(month: number): SeasonalEvent[] {
  const monthStr = String(month).padStart(2, '0');
  
  return SEASONAL_EVENTS.filter(event => {
    if (event.date === 'variable') {
      return false; // 変動日は個別に処理が必要
    }
    return event.date.startsWith(monthStr);
  });
}

/**
 * 土用の丑の日を計算（簡易版）
 * 実際には複雑な計算が必要なので、代表的な日付を返す
 * @param year 年
 * @returns 土用の丑の日の日付配列
 */
export function getDoyoUshiDays(year: number): Date[] {
  // 簡易的に7月下旬の丑の日を返す
  // 実際の計算にはより複雑なロジックが必要
  const dates: Date[] = [];
  const startDate = new Date(year, 6, 19); // 7月19日から
  const endDate = new Date(year, 7, 7); // 8月7日まで（立秋前後）
  
  const current = new Date(startDate);
  while (current <= endDate) {
    // 丑の日は12日周期で繰り返す
    // ここでは簡易的に最初の丑の日を7月20日前後と仮定
    if (current.getDate() >= 20 && current.getDate() <= 30 && current.getMonth() === 6) {
      dates.push(new Date(current));
      break;
    }
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

/**
 * 十五夜の日付を計算（簡易版）
 * @param year 年
 * @returns 十五夜の日付
 */
export function getJugoya(year: number): Date | null {
  // 十五夜は旧暦8月15日で、通常9月中旬〜10月上旬
  // 簡易的に9月中旬を返す（実際にはlunar calendar計算が必要）
  // 2024年: 9/17, 2025年: 10/6, 2026年: 9/25
  const approximateDates: Record<number, Date> = {
    2024: new Date(2024, 8, 17),
    2025: new Date(2025, 9, 6),
    2026: new Date(2026, 8, 25),
    2027: new Date(2027, 8, 15),
  };
  
  return approximateDates[year] || null;
}

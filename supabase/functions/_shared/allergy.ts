function normalizeForMatch(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .trim();
}

const EXPANSIONS: Record<string, string[]> = {
  卵: ["卵", "たまご", "タマゴ", "卵黄", "卵白"],
  エビ: ["エビ", "えび", "海老"],
  カニ: ["カニ", "かに", "蟹"],
  小麦: ["小麦", "小麦粉", "薄力粉", "強力粉", "パン粉", "パン", "パスタ", "うどん", "ラーメン", "そうめん", "中華麺"],
  乳製品: ["牛乳", "乳", "チーズ", "バター", "ヨーグルト", "生クリーム", "クリーム", "脱脂粉乳", "ホエイ"],
  そば: ["そば", "蕎麦"],
  落花生: ["落花生", "ピーナッツ", "peanut"],
  ナッツ類: ["ナッツ", "アーモンド", "カシューナッツ", "くるみ", "胡桃", "ピスタチオ", "マカダミア", "ヘーゼルナッツ"],
  貝類: ["貝", "あさり", "アサリ", "しじみ", "シジミ", "牡蠣", "かき", "ホタテ", "帆立", "はまぐり", "ハマグリ", "サザエ", "つぶ貝"],
  魚卵: ["魚卵", "いくら", "イクラ", "たらこ", "タラコ", "明太子", "めんたいこ", "数の子", "キャビア"],
  大豆: ["大豆", "豆", "豆腐", "納豆", "味噌", "みそ", "醤油", "しょうゆ", "豆乳", "きなこ", "おから", "油揚げ", "soy"],
};

export type AllergenHit = {
  allergen: string; // 元のアレルゲン表記
  needle: string; // 実際にマッチした語
};

function getNeedles(allergen: string): string[] {
  const key = String(allergen ?? "").trim();
  if (!key) return [];
  if (key === "none" || key === "なし" || key === "特になし") return [];
  const expanded = EXPANSIONS[key];
  if (Array.isArray(expanded) && expanded.length) return expanded;
  return [key];
}

export function detectAllergenHits(allergens: string[], texts: Array<string | null | undefined>): AllergenHit[] {
  const normalizedText = texts
    .map((t) => normalizeForMatch(String(t ?? "")))
    .filter(Boolean)
    .join("\n");

  if (!normalizedText) return [];

  const hits: AllergenHit[] = [];
  const seen = new Set<string>();
  for (const a of allergens ?? []) {
    const allergen = String(a ?? "").trim();
    if (!allergen) continue;
    const needles = getNeedles(allergen);
    for (const needle of needles) {
      const n = normalizeForMatch(needle);
      if (!n) continue;
      if (normalizedText.includes(n)) {
        const key = `${allergen}::${needle}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ allergen, needle });
      }
    }
  }
  return hits;
}

export function summarizeAllergenHits(hits: AllergenHit[]): string {
  if (!hits.length) return "";
  const map = new Map<string, Set<string>>();
  for (const h of hits) {
    const set = map.get(h.allergen) ?? new Set<string>();
    set.add(h.needle);
    map.set(h.allergen, set);
  }
  const parts = Array.from(map.entries()).map(([allergen, needles]) => `${allergen}(${Array.from(needles).join(",")})`);
  return parts.join(" / ");
}


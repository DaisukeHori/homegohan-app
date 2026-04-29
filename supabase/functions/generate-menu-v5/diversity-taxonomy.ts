export const MAIN_DISH_FAMILIES = [
  "teriyaki_chicken",
  "simmered_chicken",
  "stir_fry_chicken",
  "ginger_pork",
  "stir_fry_pork",
  "grilled_salmon",
  "foil_salmon",
  "grilled_mackerel",
  "miso_fish",
  "simmered_fish",
  "tofu_main",
  "egg_main",
  "curry_main",
  "gratin_main",
  "rice_bowl",
  "noodle_soup",
  "other_main",
] as const;

export const PROTEIN_FAMILIES = [
  "chicken",
  "pork",
  "salmon",
  "mackerel",
  "other_fish",
  "egg",
  "tofu",
  "mixed",
  "other",
] as const;

export const BREAKFAST_TEMPLATES = [
  "rice_miso_egg",
  "rice_miso_grilled_fish",
  "rice_soup_tofu",
  "bread_egg",
  "bread_yogurt",
  "noodle_soup",
  "other_breakfast",
] as const;

export const SOUP_KINDS = [
  "miso",
  "clear",
  "western",
  "none",
  "other",
] as const;

export const SODIUM_MODES = [
  "low",
  "normal",
] as const;

export type MainDishFamily = (typeof MAIN_DISH_FAMILIES)[number];
export type ProteinFamily = (typeof PROTEIN_FAMILIES)[number];
export type BreakfastTemplate = (typeof BREAKFAST_TEMPLATES)[number];
export type SoupKind = (typeof SOUP_KINDS)[number];
export type SodiumMode = (typeof SODIUM_MODES)[number];

const CHICKEN_KEYWORDS = ["鶏", "とり", "チキン"];
const PORK_KEYWORDS = ["豚", "ぶた", "ポーク"];
const SALMON_KEYWORDS = ["鮭", "さけ", "サーモン"];
const MACKEREL_KEYWORDS = ["さば", "サバ", "鯖"];
const FISH_KEYWORDS = [
  "魚",
  "ぶり",
  "鯛",
  "たい",
  "たら",
  "かれい",
  "いわし",
  "あじ",
  "ほっけ",
  "まぐろ",
  "かつお",
  "めばる",
  "さわら",
  "鰆",
  "めかじき",
  "メカジキ",
  "かじき",
  "赤魚",
  "さんま",
  "秋刀魚",
  "ししゃも",
];
const EGG_KEYWORDS = ["卵", "たまご", "玉子", "親子", "キッシュ", "エッグ", "オムレツ", "スクランブル"];
const TOFU_KEYWORDS = ["豆腐", "厚揚げ", "高野豆腐", "がんも"];
const NOODLE_KEYWORDS = ["うどん", "そば", "ラーメン", "麺", "焼きそば", "そうめん", "パスタ", "スパゲティ", "スパゲッティ", "ペンネ", "マカロニ"];
const CURRY_KEYWORDS = ["カレー", "きーま", "キーマ", "ハヤシ"];
const RICE_BOWL_KEYWORDS = ["丼", "どん", "混ぜ御飯", "混ぜご飯", "炊き込み", "チャーハン", "ピラフ"];
const PORK_STIR_FRY_KEYWORDS = ["回鍋肉", "ホイコーロー", "青椒肉絲", "チンジャオロース"];
const GRATIN_KEYWORDS = ["グラタン", "ドリア", "ラザニア"];
const BREAD_KEYWORDS = ["パン", "トースト", "サンド", "ホットドッグ", "ロールパン"];
const YOGURT_KEYWORDS = ["ヨーグルト", "グラノーラ", "シリアル"];
const MISO_KEYWORDS = ["味噌", "みそ"];
const CLEAR_SOUP_KEYWORDS = ["すまし", "お吸い物", "吸い物"];
const WESTERN_SOUP_KEYWORDS = ["ポタージュ", "コンソメ", "スープ"];

export function normalizeMenuText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[()（）［］【】「」『』・/\\,，、。.\-_\s　]+/g, " ")
    .trim();
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(normalizeMenuText(keyword)));
}

export function classifyProteinFamily(name: string | null | undefined): ProteinFamily {
  const text = normalizeMenuText(name);
  if (!text) return "other";
  const matched = [
    includesAny(text, CHICKEN_KEYWORDS),
    includesAny(text, PORK_KEYWORDS),
    includesAny(text, SALMON_KEYWORDS),
    includesAny(text, MACKEREL_KEYWORDS),
    includesAny(text, FISH_KEYWORDS),
    includesAny(text, EGG_KEYWORDS),
    includesAny(text, TOFU_KEYWORDS),
  ].filter(Boolean).length;
  if (matched >= 2) return "mixed";
  if (includesAny(text, CHICKEN_KEYWORDS)) return "chicken";
  if (includesAny(text, PORK_KEYWORDS)) return "pork";
  if (includesAny(text, SALMON_KEYWORDS)) return "salmon";
  if (includesAny(text, MACKEREL_KEYWORDS)) return "mackerel";
  if (includesAny(text, FISH_KEYWORDS)) return "other_fish";
  if (includesAny(text, EGG_KEYWORDS)) return "egg";
  if (includesAny(text, TOFU_KEYWORDS)) return "tofu";
  return "other";
}

export function classifyMainDishFamily(name: string | null | undefined): MainDishFamily {
  const text = normalizeMenuText(name);
  if (!text) return "other_main";
  const proteinFamily = classifyProteinFamily(text);

  if (includesAny(text, NOODLE_KEYWORDS)) return "noodle_soup";
  if (includesAny(text, RICE_BOWL_KEYWORDS)) return "rice_bowl";
  if (includesAny(text, CURRY_KEYWORDS)) return "curry_main";
  if (includesAny(text, GRATIN_KEYWORDS)) return "gratin_main";
  if (includesAny(text, PORK_STIR_FRY_KEYWORDS)) return "stir_fry_pork";

  if (proteinFamily === "chicken") {
    if (text.includes("照り焼")) return "teriyaki_chicken";
    if (text.includes("煮") || text.includes("炊")) return "simmered_chicken";
    if (text.includes("炒") || text.includes("ソテ") || text.includes("グリル") || text.includes("焼")) return "stir_fry_chicken";
    return "stir_fry_chicken";
  }

  if (proteinFamily === "pork") {
    if (text.includes("生姜焼") || text.includes("しょうが焼") || text.includes("生姜") || text.includes("しょうが")) return "ginger_pork";
    if (text.includes("炒") || text.includes("ソテ") || text.includes("キムチ")) return "stir_fry_pork";
    return "stir_fry_pork";
  }

  if (proteinFamily === "salmon") {
    if (text.includes("ホイル") || text.includes("包み焼")) return "foil_salmon";
    return "grilled_salmon";
  }

  if (proteinFamily === "mackerel") {
    return "grilled_mackerel";
  }

  if (proteinFamily === "other_fish") {
    if (includesAny(text, MISO_KEYWORDS) || text.includes("西京")) return "miso_fish";
    if (text.includes("煮") || text.includes("炊")) return "simmered_fish";
    return "simmered_fish";
  }

  if (proteinFamily === "tofu") return "tofu_main";
  if (proteinFamily === "egg") return "egg_main";
  return "other_main";
}

export function inferSoupKind(names: string[]): SoupKind {
  const joined = normalizeMenuText(names.join(" "));
  if (!joined) return "none";
  if (includesAny(joined, MISO_KEYWORDS)) return "miso";
  if (includesAny(joined, CLEAR_SOUP_KEYWORDS)) return "clear";
  if (includesAny(joined, WESTERN_SOUP_KEYWORDS)) return "western";
  if (joined.includes("汁") || joined.includes("スープ")) return "other";
  return "none";
}

export function inferBreakfastTemplate(names: string[]): BreakfastTemplate {
  const joined = normalizeMenuText(names.join(" "));
  if (!joined) return "other_breakfast";
  if (includesAny(joined, NOODLE_KEYWORDS)) return "noodle_soup";
  if (includesAny(joined, BREAD_KEYWORDS) && includesAny(joined, EGG_KEYWORDS)) return "bread_egg";
  if (includesAny(joined, BREAD_KEYWORDS) && includesAny(joined, YOGURT_KEYWORDS)) return "bread_yogurt";

  const hasRice = joined.includes("ご飯") || joined.includes("ごはん");
  const hasMisoSoup = includesAny(joined, MISO_KEYWORDS);
  const hasEgg = includesAny(joined, EGG_KEYWORDS);
  const hasFish = classifyProteinFamily(joined) === "salmon" || classifyProteinFamily(joined) === "mackerel" || classifyProteinFamily(joined) === "other_fish";
  const hasTofu = includesAny(joined, TOFU_KEYWORDS);

  if (hasRice && hasMisoSoup && hasEgg) return "rice_miso_egg";
  if (hasRice && hasMisoSoup && hasFish) return "rice_miso_grilled_fish";
  if (hasRice && hasTofu) return "rice_soup_tofu";
  return "other_breakfast";
}

export function inferSodiumMode(params: {
  preferLowSodium?: boolean;
  targetDailySodiumG?: number | null;
}): SodiumMode {
  if (params.preferLowSodium) return "low";
  if (typeof params.targetDailySodiumG === "number" && Number.isFinite(params.targetDailySodiumG) && params.targetDailySodiumG <= 2.5) {
    return "low";
  }
  return "normal";
}

export function isHighSodiumFamily(family: MainDishFamily): boolean {
  return family === "teriyaki_chicken"
    || family === "miso_fish"
    || family === "noodle_soup";
}

// ===== Protein Super-Category (PR: 魚偏重バグ修正) =====
// salmon / mackerel / other_fish を「魚」、chicken / pork を「肉」に集約し、
// validator が「魚全体」「肉全体」レベルで偏りを検出できるようにする。

export const PROTEIN_SUPER_CATEGORIES = [
  "fish",
  "meat",
  "egg",
  "tofu",
  "mixed",
  "other",
] as const;

export type ProteinSuperCategory = (typeof PROTEIN_SUPER_CATEGORIES)[number];

export function toProteinSuperCategory(family: ProteinFamily): ProteinSuperCategory {
  switch (family) {
    case "salmon":
    case "mackerel":
    case "other_fish":
      return "fish";
    case "chicken":
    case "pork":
      return "meat";
    case "egg":
      return "egg";
    case "tofu":
      return "tofu";
    case "mixed":
      return "mixed";
    case "other":
    default:
      return "other";
  }
}

export function getProteinSuperCategoryLabel(superCategory: ProteinSuperCategory): string {
  switch (superCategory) {
    case "fish":
      return "魚";
    case "meat":
      return "肉";
    case "egg":
      return "卵";
    case "tofu":
      return "豆腐";
    case "mixed":
      return "ミックス";
    default:
      return "その他";
  }
}

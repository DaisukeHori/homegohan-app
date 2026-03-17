import { normalizeUrl } from "../catalog-utils.ts";
import { getCatalogSourceConfig } from "./source-registry.ts";
import type { CatalogPageType, CatalogSourceConfig } from "./types.ts";

export type CatalogSourceAdapter = {
  config: CatalogSourceConfig;
  maxDiscoveryDepth: number;
  buildDiscoveryPrompt: (input: {
    categoryCode: string;
    pageType: Extract<CatalogPageType, "root" | "category" | "subcategory">;
  }) => string;
  buildDetailPrompt: (input: {
    categoryCode: string;
    brandName: string;
  }) => string;
  filterItemUrls: (urls: string[]) => string[];
  filterCategoryUrls: (urls: string[]) => string[];
};

type PromptBuilder = {
  discoveryIntro: string[];
  detailIntro: string[];
  maxDiscoveryDepth: number;
};

const PROMPT_BUILDERS: Record<string, PromptBuilder> = {
  seven_eleven_jp: {
    maxDiscoveryDepth: 3,
    discoveryIntro: [
      "セブン-イレブンの商品一覧ページです。",
      "商品詳細URLは `/products/a/item/<id>/` です。",
      "カテゴリ、地域一覧、ラインナップ一覧は `categoryUrls` に入れてください。",
    ],
    detailIntro: [
      "セブン-イレブンの商品詳細ページです。",
      "栄養成分表、アレルギー情報、価格、販売地域を優先して抽出してください。",
    ],
  },
  familymart_jp: {
    maxDiscoveryDepth: 2,
    discoveryIntro: [
      "ファミリーマートの商品一覧ページです。",
      "カテゴリURLは `/goods/<category>.html`、商品詳細URLは `/goods/<category>/<id>.html` です。",
    ],
    detailIntro: [
      "ファミリーマートの商品詳細ページです。",
      "`.item_nutritional_info` と `.item_allergen` を優先して抽出してください。",
    ],
  },
  lawson_jp: {
    maxDiscoveryDepth: 2,
    discoveryIntro: [
      "ローソンの商品一覧ページです。",
      "カテゴリURLは `/recommend/original/<category>/`、商品詳細URLは `/recommend/original/detail/<id>_<code>.html` です。",
    ],
    detailIntro: [
      "ローソンの商品詳細ページです。",
      "`.nutritionFacts_table`、アレルギー情報、地域注記を優先して抽出してください。",
    ],
  },
  natural_lawson_jp: {
    maxDiscoveryDepth: 2,
    discoveryIntro: [
      "ナチュラルローソンの商品一覧ページです。",
      "商品詳細URLは `/recommend/commodity/detail/<id>_<code>.html` または `/sp/recommend/commodity/detail/<id>_<code>.html` です。",
      "カテゴリURLは `/recommend/commodity/00001/1254679_4518.html` または `/sp/recommend/commodity/00001/1254679_5464.html` の形式です。",
      "Lawson 系 detail 構造を共有する前提で、商品詳細と commodity 一覧 URL を抽出してください。",
    ],
    detailIntro: [
      "ナチュラルローソンの商品詳細ページです。",
      "Lawson 系の栄養表とアレルギー情報を優先して抽出してください。",
    ],
  },
  ministop_jp: {
    maxDiscoveryDepth: 2,
    discoveryIntro: [
      "ミニストップの商品一覧ページです。",
      "カテゴリURLは `/syohin/<category>/`、商品詳細URLは `/syohin/products/detail<id>.html` です。",
      "有効な商品詳細URLは `detail050627.html` のような 6 桁以上の numeric id のみです。",
      "`detail1.html` や `detail2.html` のようなダミーURLを生成しないでください。",
    ],
    detailIntro: [
      "ミニストップの商品詳細ページです。",
      "`栄養成分情報` と `アレルゲン情報` の definition list を優先して抽出してください。",
    ],
  },
};

const DEFAULT_PROMPT_BUILDER: PromptBuilder = {
  maxDiscoveryDepth: 2,
  discoveryIntro: [
    "日本のコンビニ商品の一覧ページです。",
    "商品詳細URLだけを itemUrls に、カテゴリやサブカテゴリの一覧URLだけを categoryUrls に入れてください。",
  ],
  detailIntro: [
    "日本のコンビニ商品の詳細ページです。",
    "商品名、画像URL、価格、カテゴリ、販売地域、アレルゲン、主要栄養を抽出してください。",
  ],
};

export function getCatalogSourceAdapter(sourceCode: string): CatalogSourceAdapter | null {
  const config = getCatalogSourceConfig(sourceCode);
  if (!config) return null;

  const promptBuilder = PROMPT_BUILDERS[sourceCode] ?? DEFAULT_PROMPT_BUILDER;

  return {
    config,
    maxDiscoveryDepth: promptBuilder.maxDiscoveryDepth,
    buildDiscoveryPrompt(input) {
      const categorySpecificNotes = buildCategorySpecificDiscoveryNotes(config.code, input.categoryCode);
      return [
        ...promptBuilder.discoveryIntro,
        ...categorySpecificNotes,
        "重複を除き、絶対URLで返してください。",
        "商品ではない一般サイトリンクは含めないでください。",
        `categoryCode=${input.categoryCode}`,
        `pageType=${input.pageType}`,
      ].join("\n");
    },
    buildDetailPrompt(input) {
      return [
        ...promptBuilder.detailIntro,
        "name, imageUrl, category, subcategory, description, priceYen, salesRegion, availabilityStatus, allergens, nutrition を JSON で返してください。",
        "nutrition は caloriesKcal, proteinG, fatG, carbsG, fiberG, sodiumG, sugarG に入れてください。",
        "曖昧な値は null にしてください。",
        `brand=${input.brandName}`,
        `categoryCode=${input.categoryCode}`,
      ].join("\n");
    },
    filterItemUrls(urls) {
      return filterUrlsByPatterns(urls, config.detailUrlPatterns);
    },
    filterCategoryUrls(urls) {
      return filterUrlsByPatterns(urls, config.categoryUrlPatterns);
    },
  };
}

function buildCategorySpecificDiscoveryNotes(sourceCode: string, categoryCode: string) {
  if (sourceCode === "ministop_jp" && categoryCode === "sweets") {
    return [
      "コールドスイーツでは `/syohin/nutrition/results.html?search_category[]=コールドスイーツ` の栄養検索結果 table を優先してください。",
      "itemUrls には table 行の `/syohin/products/detailNNNNNN.html` だけを入れてください。",
      "`/syohin/sweets/...` の紹介ページ、キャンペーン、今週のおすすめ、他カテゴリ商品は itemUrls に入れないでください。",
    ];
  }
  return [];
}

function filterUrlsByPatterns(urls: string[], patterns?: RegExp[]) {
  const seen = new Set<string>();
  const filtered: string[] = [];

  for (const rawUrl of urls) {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized || seen.has(normalized)) continue;
    if (patterns?.length && !patterns.some((pattern) => pattern.test(normalized))) continue;
    seen.add(normalized);
    filtered.push(normalized);
  }

  return filtered;
}

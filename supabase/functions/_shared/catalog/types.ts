export type CatalogSourceStrategy =
  | "catalog_tree"
  | "catalog_tree_shared_parent"
  | "partial_nutrition_catalog"
  | "news_feed_catalog"
  | "weak_catalog"
  | "unsupported";

export type CatalogPageType =
  | "root"
  | "category"
  | "subcategory"
  | "detail"
  | "article";

export type CatalogSourceConfig = {
  code: string;
  brandName: string;
  baseUrl: string;
  rootUrl: string;
  strategy: CatalogSourceStrategy;
  parentSourceCode?: string | null;
  isEnabled: boolean;
  supportsFullNutrition: boolean;
  categoryHints?: string[];
  detailUrlPatterns?: RegExp[];
  categoryUrlPatterns?: RegExp[];
  nutritionMarkers?: string[];
  notes?: string[];
};

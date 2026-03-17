export interface CatalogProductSummary {
  id: string;
  sourceId: string;
  sourceCode: string;
  brandName: string;
  name: string;
  categoryCode: string | null;
  description: string | null;
  imageUrl: string | null;
  canonicalUrl: string;
  priceYen: number | null;
  caloriesKcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  sodiumG: number | null;
  fiberG: number | null;
  sugarG: number | null;
  availabilityStatus: string;
  matchScore?: number;
}

export interface CatalogDishMatch {
  dishName: string;
  candidates: CatalogProductSummary[];
}

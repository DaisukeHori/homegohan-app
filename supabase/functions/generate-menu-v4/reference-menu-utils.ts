export type MenuReference = {
  title: string;
  dishes: Array<{
    name: string;
    role: string;
  }>;
};

export type RawMenuReferenceCandidate = {
  title?: string | null;
  theme_tags?: string[] | null;
  dishes?: Array<{ name?: string | null; role?: string | null; class_raw?: string | null }> | null;
  similarity?: number | null;
};

export function shouldSkipReferenceMenuSearch(referenceMenuCount: number | null | undefined): boolean {
  return typeof referenceMenuCount === "number" && referenceMenuCount <= 0;
}

function isPlaceholderTitle(value: string): boolean {
  const normalized = normalizeReferenceText(value);
  return normalized === "" || normalized === "（無題）" || normalized === "無題" || normalized === "(untitled)";
}

function hasNamedDish(candidate: RawMenuReferenceCandidate): boolean {
  return Array.isArray(candidate.dishes)
    && candidate.dishes.some((dish) => normalizeReferenceText(dish?.name ?? "") !== "");
}

export function isValidMenuReferenceCandidate(candidate: RawMenuReferenceCandidate): boolean {
  return !isPlaceholderTitle(candidate.title ?? "") && hasNamedDish(candidate);
}

function normalizeReferenceText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s　]+/g, " ")
    .trim();
}

export function extractReferenceSearchKeywords(queryText: string): string[] {
  const normalized = normalizeReferenceText(queryText);
  if (!normalized) return [];

  const keywords = new Set<string>([normalized]);
  for (const token of normalized.split(/[,\s/、。・]+/)) {
    const trimmed = token.trim();
    if (trimmed.length >= 2) keywords.add(trimmed);
  }
  return [...keywords];
}

function buildCandidateSearchText(candidate: RawMenuReferenceCandidate): string {
  const title = normalizeReferenceText(candidate.title ?? "");
  const themes = Array.isArray(candidate.theme_tags) ? candidate.theme_tags.map(normalizeReferenceText).join(" ") : "";
  const dishes = Array.isArray(candidate.dishes)
    ? candidate.dishes.map((dish) => normalizeReferenceText(dish?.name ?? "")).filter(Boolean).join(" ")
    : "";
  return [title, themes, dishes].filter(Boolean).join(" ");
}

function computeKeywordScore(queryText: string, candidate: RawMenuReferenceCandidate): number {
  const searchText = buildCandidateSearchText(candidate);
  if (!searchText) return 0;

  return extractReferenceSearchKeywords(queryText).reduce((score, keyword) => {
    if (!keyword) return score;
    if (searchText === keyword) return score + 1.5;
    if (searchText.includes(keyword)) return score + (keyword.length >= 4 ? 1 : 0.5);
    return score;
  }, 0);
}

export function rerankMenuReferenceCandidates(
  queryText: string,
  candidates: RawMenuReferenceCandidate[],
  limit: number,
): RawMenuReferenceCandidate[] {
  return [...candidates]
    .filter(isValidMenuReferenceCandidate)
    .map((candidate, index) => ({
      candidate,
      keywordScore: computeKeywordScore(queryText, candidate),
      similarity: Number(candidate?.similarity ?? 0),
      index,
    }))
    .sort((a, b) => {
      if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return a.index - b.index;
    })
    .slice(0, limit)
    .map((item) => item.candidate);
}

export function mapMenuReferenceCandidates(candidates: unknown[]): MenuReference[] {
  return candidates
    .filter((candidate: any) => isValidMenuReferenceCandidate(candidate ?? {}))
    .map((candidate: any) => ({
      title: String(candidate?.title ?? ""),
      dishes: Array.isArray(candidate?.dishes)
        ? candidate.dishes
            .filter((dish: any) => normalizeReferenceText(dish?.name ?? "") !== "")
            .map((dish: any) => ({
              name: String(dish?.name ?? ""),
              role: String(dish?.role ?? dish?.class_raw ?? "other"),
            }))
        : [],
    }));
}

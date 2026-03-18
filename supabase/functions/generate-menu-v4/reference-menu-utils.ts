export type MenuReference = {
  title: string;
  dishes: Array<{
    name: string;
    role?: string;
  }>;
};

const DEFAULT_REFERENCE_SEARCH_MIN = 24;
const DEFAULT_REFERENCE_SEARCH_PER_SLOT = 8;
const DEFAULT_REFERENCE_SEARCH_MAX = 150;

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

export function computeReferenceSearchMatchCount(targetSlotCount: number): number {
  const normalizedTargetSlotCount = Math.max(1, Math.trunc(targetSlotCount || 0));
  return Math.min(
    DEFAULT_REFERENCE_SEARCH_MAX,
    Math.max(DEFAULT_REFERENCE_SEARCH_MIN, normalizedTargetSlotCount * DEFAULT_REFERENCE_SEARCH_PER_SLOT),
  );
}

export function buildReferenceMenuSummary(
  references: MenuReference[],
  options?: {
    maxPerRole?: number;
    maxMenus?: number;
  },
): string {
  const maxPerRole = Math.max(1, Math.trunc(options?.maxPerRole ?? 8));
  const maxMenus = Math.max(1, Math.trunc(options?.maxMenus ?? Math.max(references.length, 1)));
  const limitedReferences = references.slice(0, maxMenus);
  const roleBuckets = new Map<string, string[]>();

  for (const reference of limitedReferences) {
    for (const dish of reference.dishes ?? []) {
      const role = String(dish.role ?? "other");
      const name = String(dish.name ?? "").trim();
      if (!name) continue;
      if (!roleBuckets.has(role)) roleBuckets.set(role, []);
      const bucket = roleBuckets.get(role)!;
      if (!bucket.includes(name)) bucket.push(name);
    }
  }

  const roleOrder = ["main", "side", "soup", "rice", "other"];
  const roleLabels: Record<string, string> = {
    main: "主菜",
    side: "副菜",
    soup: "汁物",
    rice: "主食",
    other: "その他",
  };

  const lines = [
    `参考献立は ${references.length} 件取得済みです。以下の傾向を踏まえて献立を組み立ててください。`,
  ];

  for (const role of roleOrder) {
    const names = (roleBuckets.get(role) ?? []).slice(0, maxPerRole);
    if (names.length === 0) continue;
    lines.push(`- ${roleLabels[role]}候補: ${names.join("、")}`);
  }

  return lines.join("\n");
}

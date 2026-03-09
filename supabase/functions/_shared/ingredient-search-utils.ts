export type IngredientSearchCandidate = {
  id: string;
  name: string;
  name_norm: string;
  calories_kcal?: number | null;
  similarity?: number | null;
  textSimilarity?: number | null;
  vectorSimilarity?: number | null;
};

type RankedIngredientCandidate = IngredientSearchCandidate & {
  combinedScore: number;
  textSignal: number;
};

export function normalizeIngredientSearchText(value: string): string {
  return String(value ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（）()]/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

function getCandidateKey(candidate: IngredientSearchCandidate): string {
  return candidate.id || candidate.name_norm || candidate.name;
}

function computeTextSignal(queryNorm: string, candidate: IngredientSearchCandidate): number {
  const candidateNorm = normalizeIngredientSearchText(candidate.name_norm || candidate.name);
  if (!candidateNorm || !queryNorm) return candidate.textSimilarity ?? 0;

  if (candidateNorm === queryNorm) return 1;
  if (candidateNorm.includes(queryNorm)) return Math.max(candidate.textSimilarity ?? 0, 0.95);
  if (queryNorm.includes(candidateNorm)) return Math.max(candidate.textSimilarity ?? 0, 0.8);

  return candidate.textSimilarity ?? 0;
}

export function mergeIngredientCandidates(
  inputName: string,
  textCandidates: IngredientSearchCandidate[],
  vectorCandidates: IngredientSearchCandidate[],
): RankedIngredientCandidate[] {
  const queryNorm = normalizeIngredientSearchText(inputName);
  const merged = new Map<string, RankedIngredientCandidate>();

  for (const candidate of textCandidates) {
    const key = getCandidateKey(candidate);
    const textSignal = computeTextSignal(queryNorm, {
      ...candidate,
      textSimilarity: candidate.textSimilarity ?? candidate.similarity ?? 0,
    });

    merged.set(key, {
      ...candidate,
      textSimilarity: candidate.textSimilarity ?? candidate.similarity ?? 0,
      combinedScore: textSignal,
      textSignal,
    });
  }

  for (const candidate of vectorCandidates) {
    const key = getCandidateKey(candidate);
    const existing = merged.get(key);
    const vectorSimilarity = candidate.vectorSimilarity ?? candidate.similarity ?? 0;
    const next: RankedIngredientCandidate = existing
      ? {
          ...existing,
          ...candidate,
          textSimilarity: existing.textSimilarity ?? candidate.textSimilarity ?? null,
          vectorSimilarity,
          textSignal: existing.textSignal,
          combinedScore: existing.combinedScore,
        }
      : {
          ...candidate,
          vectorSimilarity,
          textSimilarity: candidate.textSimilarity ?? null,
          textSignal: computeTextSignal(queryNorm, candidate),
          combinedScore: 0,
        };

    const textWeight = next.textSignal > 0 ? 0.8 : 0.2;
    const vectorWeight = next.textSignal > 0 ? 0.2 : 0.8;
    next.combinedScore = next.textSignal * textWeight + vectorSimilarity * vectorWeight;
    merged.set(key, next);
  }

  return [...merged.values()].sort((a, b) => {
    if (b.textSignal !== a.textSignal) return b.textSignal - a.textSignal;
    if ((b.combinedScore ?? 0) !== (a.combinedScore ?? 0)) return (b.combinedScore ?? 0) - (a.combinedScore ?? 0);
    return (b.vectorSimilarity ?? 0) - (a.vectorSimilarity ?? 0);
  });
}

export function shouldSelectIngredientWithoutLLM(
  inputName: string,
  candidate: IngredientSearchCandidate & { textSignal?: number },
): boolean {
  const queryNorm = normalizeIngredientSearchText(inputName);
  const candidateNorm = normalizeIngredientSearchText(candidate.name_norm || candidate.name);
  const textSignal = candidate.textSignal ?? computeTextSignal(queryNorm, candidate);

  if (!candidateNorm || !queryNorm) return false;
  if (candidateNorm === queryNorm) return true;
  if (textSignal >= 0.95) return true;
  return textSignal >= 0.28;
}

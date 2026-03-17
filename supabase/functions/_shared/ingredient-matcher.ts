/**
 * 材料マッチャー（ingredient-matcher.ts）
 * 
 * 材料名からdataset_ingredientsをベクトル検索し、
 * LLMが最適な材料を選択する
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { EXACT_NAME_NORM_MAP, INGREDIENT_ALIASES, normalizeIngredientNameJs, isWaterishIngredient } from './nutrition-calculator.ts'
import { callV4FastLLM } from './v4-fast-llm.ts'
import {
  DATASET_EMBEDDING_API_KEY_ENV,
  fetchDatasetEmbeddings,
  fetchSingleDatasetEmbedding,
} from '../../../shared/dataset-embedding.mjs'
import {
  mergeIngredientCandidates,
  shouldSelectIngredientWithoutLLM,
} from './ingredient-search-utils.ts'
import { isRetryableError, withRetry, withTimeout } from './network-retry.ts'

// ============================================
// 型定義
// ============================================

export interface EstimatedIngredient {
  name: string
  amount_g: number
}

export interface MatchedIngredientData {
  id: string
  name: string
  name_norm: string
  calories_kcal: number | null
  protein_g: number | null
  fat_g: number | null
  carbs_g: number | null
  fiber_g: number | null
  sodium_mg: number | null
  potassium_mg: number | null
  calcium_mg: number | null
  magnesium_mg: number | null
  phosphorus_mg: number | null
  iron_mg: number | null
  zinc_mg: number | null
  iodine_ug: number | null
  cholesterol_mg: number | null
  vitamin_a_ug: number | null
  vitamin_d_ug: number | null
  vitamin_e_alpha_mg: number | null
  vitamin_k_ug: number | null
  vitamin_b1_mg: number | null
  vitamin_b2_mg: number | null
  niacin_mg: number | null
  vitamin_b6_mg: number | null
  vitamin_b12_ug: number | null
  folic_acid_ug: number | null
  pantothenic_acid_mg: number | null
  biotin_ug: number | null
  vitamin_c_mg: number | null
  salt_eq_g: number | null
  discard_rate_percent: number | null
  similarity: number
}

export interface IngredientMatchResult {
  input: EstimatedIngredient
  matched: MatchedIngredientData | null
  confidence: 'high' | 'medium' | 'low' | 'none'
  matchMethod: 'exact_map' | 'alias_map' | 'exact_name_norm' | 'alias_name_norm' | 'embedding_llm' | 'embedding' | 'text_similarity' | 'none'
}

type PartialMatchedIngredientCandidate =
  Partial<Omit<MatchedIngredientData, 'id' | 'name' | 'name_norm' | 'similarity'>> &
  Pick<MatchedIngredientData, 'id' | 'name' | 'name_norm'> & {
    similarity?: number | null
  }

interface IngredientMatchMemo {
  matched: MatchedIngredientData | null
  confidence: IngredientMatchResult['confidence']
  matchMethod: IngredientMatchResult['matchMethod']
}

const MAX_INGREDIENT_MATCH_CONCURRENCY = 4

function toMatchedIngredientData(
  candidate: PartialMatchedIngredientCandidate,
  similarity: number,
): MatchedIngredientData {
  return {
    id: candidate.id,
    name: candidate.name,
    name_norm: candidate.name_norm,
    calories_kcal: candidate.calories_kcal ?? null,
    protein_g: candidate.protein_g ?? null,
    fat_g: candidate.fat_g ?? null,
    carbs_g: candidate.carbs_g ?? null,
    fiber_g: candidate.fiber_g ?? null,
    sodium_mg: candidate.sodium_mg ?? null,
    potassium_mg: candidate.potassium_mg ?? null,
    calcium_mg: candidate.calcium_mg ?? null,
    magnesium_mg: candidate.magnesium_mg ?? null,
    phosphorus_mg: candidate.phosphorus_mg ?? null,
    iron_mg: candidate.iron_mg ?? null,
    zinc_mg: candidate.zinc_mg ?? null,
    iodine_ug: candidate.iodine_ug ?? null,
    cholesterol_mg: candidate.cholesterol_mg ?? null,
    vitamin_a_ug: candidate.vitamin_a_ug ?? null,
    vitamin_d_ug: candidate.vitamin_d_ug ?? null,
    vitamin_e_alpha_mg: candidate.vitamin_e_alpha_mg ?? null,
    vitamin_k_ug: candidate.vitamin_k_ug ?? null,
    vitamin_b1_mg: candidate.vitamin_b1_mg ?? null,
    vitamin_b2_mg: candidate.vitamin_b2_mg ?? null,
    niacin_mg: candidate.niacin_mg ?? null,
    vitamin_b6_mg: candidate.vitamin_b6_mg ?? null,
    vitamin_b12_ug: candidate.vitamin_b12_ug ?? null,
    folic_acid_ug: candidate.folic_acid_ug ?? null,
    pantothenic_acid_mg: candidate.pantothenic_acid_mg ?? null,
    biotin_ug: candidate.biotin_ug ?? null,
    vitamin_c_mg: candidate.vitamin_c_mg ?? null,
    salt_eq_g: candidate.salt_eq_g ?? null,
    discard_rate_percent: candidate.discard_rate_percent ?? null,
    similarity,
  }
}

function isGenericSoupOrDishWord(inputName: string): boolean {
  const normalized = normalizeIngredientNameJs(inputName)
  return /^(味噌汁|みそ汁|汁物|汁|スープ|お吸い物|吸い物|みそスープ)$/.test(normalized)
}

function createSupabaseQueryError(label: string, error: any): Error & { status?: number } {
  const err = new Error(`${label}: ${error?.message ?? 'unknown error'}`) as Error & { status?: number }
  err.status =
    isRetryableError(error) || /timeout|temporar|unavailable|connection|fetch failed/i.test(String(error?.message ?? ''))
      ? 503
      : 400
  return err
}

async function runSupabaseQuery<T>(
  queryFactory: () => Promise<{ data: T | null; error: any }>,
  label: string,
  defaultValue: T,
  timeoutMs = 15000,
  retries = 2,
): Promise<T> {
  return await withRetry(async () => {
    const result = await withTimeout(queryFactory(), { label, timeoutMs })
    if (result.error) {
      throw createSupabaseQueryError(label, result.error)
    }
    return (result.data ?? defaultValue) as T
  }, { label, retries })
}

// ============================================
// Dataset embedding 生成
// ============================================

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = Deno.env.get(DATASET_EMBEDDING_API_KEY_ENV)
  if (!apiKey) {
    throw new Error(`${DATASET_EMBEDDING_API_KEY_ENV} is not set`)
  }
  return await withRetry(
    async () => await fetchSingleDatasetEmbedding(text, { apiKey, inputType: 'query' }) as number[],
    { label: `ingredientMatcher.generateEmbedding:${text.slice(0, 40)}`, retries: 2 },
  )
}

async function generateEmbeddingsBatch(texts: string[]): Promise<Map<string, number[]>> {
  const uniqueTexts = [...new Set(texts.map((text) => text.trim()).filter(Boolean))]
  if (uniqueTexts.length === 0) {
    return new Map()
  }

  const apiKey = Deno.env.get(DATASET_EMBEDDING_API_KEY_ENV)
  if (!apiKey) {
    throw new Error(`${DATASET_EMBEDDING_API_KEY_ENV} is not set`)
  }

  const embeddings = await withRetry(
    async () => await fetchDatasetEmbeddings(uniqueTexts, { apiKey, inputType: 'query' }) as number[][],
    { label: 'ingredientMatcher.generateEmbeddingsBatch', retries: 2 },
  )
  const map = new Map<string, number[]>()

  uniqueTexts.forEach((text, index) => {
    const embedding = embeddings[index]
    if (Array.isArray(embedding)) {
      map.set(text, embedding)
    }
  })

  return map
}

// ============================================
// ベクトル検索による材料マッチング
// ============================================

async function searchByEmbedding(
  supabase: SupabaseClient,
  ingredientName: string,
  matchCount: number = 5,
  precomputedEmbedding?: number[]
): Promise<MatchedIngredientData[]> {
  try {
    const embedding = precomputedEmbedding ?? await generateEmbedding(ingredientName)

    return await runSupabaseQuery<MatchedIngredientData[]>(
      () => supabase.rpc('search_ingredients_full_by_embedding', {
        query_embedding: embedding,
        match_count: matchCount,
      }),
      `search_ingredients_full_by_embedding:${ingredientName}`,
      [],
    )
  } catch (error) {
    console.error('Embedding generation error:', error)
    return []
  }
}

// ============================================
// テキスト類似度検索（フォールバック）
// ============================================

async function searchByTextSimilarity(
  supabase: SupabaseClient,
  ingredientName: string,
  threshold: number = 0.3,
  limit: number = 5
): Promise<MatchedIngredientData[]> {
  try {
    return await runSupabaseQuery<MatchedIngredientData[]>(
      () => supabase.rpc('search_ingredients_by_text_similarity', {
        query_name: ingredientName,
        similarity_threshold: threshold,
        result_limit: limit,
      }),
      `search_ingredients_by_text_similarity:${ingredientName}`,
      [],
    )
  } catch (error) {
    console.error('Text similarity search error:', error)
    return []
  }
}

// ============================================
// LLMで最適な材料を選択
// ============================================

export async function selectBestMatchWithLLM(
  inputName: string,
  candidates: Array<{ id: string; name: string; name_norm: string; similarity: number; calories_kcal?: number | null }>
): Promise<number> {
  if (candidates.length === 0) return -1
  if (candidates.length === 1) return 0

  const systemPrompt = `あなたは日本の食品データベースの専門家です。`

  const userPrompt = `料理で使われる食材「${inputName}」に最も適切な食品データベースエントリを選んでください。

【候補】
${candidates.map((c, i) => `${i + 1}. ${c.name} (類似度: ${(c.similarity * 100).toFixed(0)}%, ${c.calories_kcal ?? '?'}kcal/100g)`).join('\n')}

【重要なルール】
- 料理に使う「${inputName}」として最も自然なものを選ぶ
- **調理状態を考慮**: ご飯・麦ご飯など「炊いた状態」で使う食材は「めし」「ゆで」を選ぶ。「乾」は乾燥状態でカロリーが3倍近く高いので避ける
- 明らかに全く異なる食材しかない場合は「0」と答える
- 数字だけで答える（例: 「2」）

回答:`

  try {
    const { text: content } = await callV4FastLLM({
      section: "ingredientMatcher.selectBestMatchWithLLM",
      systemPrompt,
      userPrompt,
      maxCompletionTokens: 10,
    })
    const num = parseInt(content, 10)

    if (num === 0) {
      console.log(`[ingredient-matcher] LLM: 「${inputName}」→ 全候補却下`)
      return -1
    }

    if (num >= 1 && num <= candidates.length) {
      console.log(`[ingredient-matcher] LLM: 「${inputName}」→ ${num}番「${candidates[num - 1].name}」を選択`)
      return num - 1
    }
  } catch (e: any) {
    console.warn(`[ingredient-matcher] LLM selection failed for "${inputName}":`, e?.message)
  }

  // フォールバック: 最初の候補を使用
  console.log(`[ingredient-matcher] LLM selection fallback: using first candidate for "${inputName}"`)
  return 0
}

function selectBestCandidateWithoutLLM(
  inputName: string,
  candidates: Array<{
    id: string
    name: string
    name_norm: string
    similarity?: number | null
    vectorSimilarity?: number | null
    textSignal?: number
    combinedScore?: number
    calories_kcal?: number | null
  }>,
): { candidate: typeof candidates[number]; confidence: 'high' | 'medium' | 'low'; matchMethod: IngredientMatchResult['matchMethod'] } | null {
  const bestCandidate = candidates[0]
  if (!bestCandidate) return null

  if (shouldSelectIngredientWithoutLLM(inputName, bestCandidate)) {
    const textSignal = bestCandidate.textSignal ?? 0
    return {
      candidate: bestCandidate,
      confidence: textSignal >= 0.95 ? 'high' : 'medium',
      matchMethod: textSignal > 0 ? 'text_similarity' : 'embedding',
    }
  }

  const secondCandidate = candidates[1]
  const bestScore = bestCandidate.combinedScore ?? bestCandidate.vectorSimilarity ?? bestCandidate.textSignal ?? bestCandidate.similarity ?? 0
  const secondScore = secondCandidate?.combinedScore ?? secondCandidate?.vectorSimilarity ?? secondCandidate?.textSignal ?? secondCandidate?.similarity ?? 0
  const scoreGap = bestScore - secondScore
  const textSignal = bestCandidate.textSignal ?? 0

  if (
    (bestScore >= 0.82 && scoreGap >= 0.08) ||
    (bestScore >= 0.72 && textSignal >= 0.55 && scoreGap >= 0.05)
  ) {
    return {
      candidate: bestCandidate,
      confidence: bestScore >= 0.9 ? 'high' : 'medium',
      matchMethod: textSignal > 0.4 ? 'text_similarity' : 'embedding',
    }
  }

  return null
}

// ============================================
// name_normでの完全一致検索
// ============================================

async function searchByExactNameNorm(
  supabase: SupabaseClient,
  nameNorm: string
): Promise<MatchedIngredientData | null> {
  try {
    const data = await runSupabaseQuery<MatchedIngredientData | null>(
      () => supabase
        .from('dataset_ingredients')
        .select('*')
        .eq('name_norm', nameNorm)
        .maybeSingle(),
      `dataset_ingredients.exact_name_norm:${nameNorm}`,
      null,
    )
    if (!data) {
      return null
    }
    return { ...data, similarity: 1.0 }
  } catch (error) {
    console.warn(`[ingredient-matcher] exact name_norm lookup failed for "${nameNorm}":`, error)
    return null
  }
}

// ============================================
// 単一材料のマッチング
// ============================================

export async function matchSingleIngredient(
  supabase: SupabaseClient,
  ingredient: EstimatedIngredient,
  options: {
    precomputedEmbedding?: number[]
  } = {},
): Promise<IngredientMatchResult> {
  const inputName = ingredient.name
  
  // 水系食材はスキップ
  if (isWaterishIngredient(inputName)) {
    console.log(`[ingredient-matcher] Skip water-ish: "${inputName}"`)
    return {
      input: ingredient,
      matched: null,
      confidence: 'none',
      matchMethod: 'none',
    }
  }

  // ============================================
  // 1. EXACT_NAME_NORM_MAP で完全マッチ（最速・最高精度）
  // ============================================
  const exactNameNorm = EXACT_NAME_NORM_MAP[inputName]
  if (exactNameNorm) {
    const exactMatch = await searchByExactNameNorm(supabase, exactNameNorm)
    if (exactMatch) {
      console.log(`[ingredient-matcher] ✅ exact_map: "${inputName}" → "${exactMatch.name}" (${exactMatch.calories_kcal}kcal/100g)`)
      return {
        input: ingredient,
        matched: exactMatch,
        confidence: 'high',
        matchMethod: 'exact_map',
      }
    } else {
      console.warn(`[ingredient-matcher] ⚠️ exact_map key found but DB miss: "${exactNameNorm}"`)
    }
  }

  // ============================================
  // 1.5. 正規化後 name_norm の完全一致
  // ============================================
  const normalizedNameNorm = normalizeIngredientNameJs(inputName)
  if (normalizedNameNorm) {
    const exactNormalizedMatch = await searchByExactNameNorm(supabase, normalizedNameNorm)
    if (exactNormalizedMatch) {
      console.log(`[ingredient-matcher] ✅ exact_name_norm: "${inputName}" → "${exactNormalizedMatch.name}"`)
      return {
        input: ingredient,
        matched: exactNormalizedMatch,
        confidence: 'high',
        matchMethod: 'exact_name_norm',
      }
    }
  }

  // ============================================
  // 1.6. 汁物や料理名そのものは食材ベクトル検索に流さない
  // ============================================
  if (isGenericSoupOrDishWord(inputName)) {
    console.log(`[ingredient-matcher] Skip generic dish-like ingredient term: "${inputName}"`)
    return {
      input: ingredient,
      matched: null,
      confidence: 'none',
      matchMethod: 'none',
    }
  }

  // ============================================
  // 1.75. 旧 resolver の alias 辞書を利用した完全一致
  // ============================================
  const aliases = INGREDIENT_ALIASES[inputName] ?? []
  for (const alias of aliases) {
    const aliasExactNameNorm = EXACT_NAME_NORM_MAP[alias]
    if (aliasExactNameNorm) {
      const aliasExactMatch = await searchByExactNameNorm(supabase, aliasExactNameNorm)
      if (aliasExactMatch) {
        console.log(`[ingredient-matcher] ✅ alias_map: "${inputName}" → "${aliasExactMatch.name}" (via "${alias}")`)
        return {
          input: ingredient,
          matched: aliasExactMatch,
          confidence: 'high',
          matchMethod: 'alias_map',
        }
      }
    }

    const aliasNormalizedNameNorm = normalizeIngredientNameJs(alias)
    if (!aliasNormalizedNameNorm) continue

    const aliasNormalizedMatch = await searchByExactNameNorm(supabase, aliasNormalizedNameNorm)
    if (aliasNormalizedMatch) {
      console.log(`[ingredient-matcher] ✅ alias_name_norm: "${inputName}" → "${aliasNormalizedMatch.name}" (via "${alias}")`)
      return {
        input: ingredient,
        matched: aliasNormalizedMatch,
        confidence: 'high',
        matchMethod: 'alias_name_norm',
      }
    }
  }

  // ============================================
  // 2. テキスト類似度検索を先に実行
  // ============================================
  const textResults = await searchByTextSimilarity(supabase, inputName, 0.2, 5)

  if (textResults.length > 0) {
    const bestTextCandidate = {
      ...textResults[0],
      textSignal: textResults[0].similarity,
    }

    if (shouldSelectIngredientWithoutLLM(inputName, bestTextCandidate)) {
      const confidence = (bestTextCandidate.textSignal ?? 0) >= 0.95 ? 'high' : 'medium'
      console.log(`[ingredient-matcher] ✅ text_similarity: "${inputName}" → "${bestTextCandidate.name}" (similarity: ${(bestTextCandidate.similarity * 100).toFixed(0)}%)`)
      return {
        input: ingredient,
        matched: textResults[0],
        confidence,
        matchMethod: 'text_similarity',
      }
    }
  }

  // ============================================
  // 3. ベクトル検索 + テキスト候補統合
  // ============================================
  const embeddingResults = await searchByEmbedding(supabase, inputName, 10, options.precomputedEmbedding)
  const mergedCandidates = mergeIngredientCandidates(
    inputName,
    textResults.map((row) => ({
      ...row,
      textSimilarity: row.similarity,
    })),
    embeddingResults.map((row) => ({
      ...row,
      vectorSimilarity: row.similarity,
    })),
  )

  const llmCandidates = mergedCandidates
    .filter((candidate) => (candidate.textSignal ?? 0) >= 0.25 || (candidate.vectorSimilarity ?? 0) >= 0.1)
    .slice(0, 5)

  if (llmCandidates.length > 0) {
    const deterministicMatch = selectBestCandidateWithoutLLM(inputName, llmCandidates)
    if (deterministicMatch) {
      const { candidate, confidence, matchMethod } = deterministicMatch
      console.log(`[ingredient-matcher] ✅ merged_direct: "${inputName}" → "${candidate.name}"`)
      return {
        input: ingredient,
        matched: toMatchedIngredientData(
          candidate,
          candidate.combinedScore ?? candidate.textSignal ?? candidate.vectorSimilarity ?? candidate.similarity ?? 0,
        ),
        confidence,
        matchMethod,
      }
    }

    console.log(`[ingredient-matcher] "${inputName}": ${llmCandidates.length} merged candidates - ${llmCandidates.map(c => `${c.name.substring(0, 20)}(text=${((c.textSignal ?? 0) * 100).toFixed(0)}%, vec=${((c.vectorSimilarity ?? 0) * 100).toFixed(0)}%)`).join(', ')}`)

    const selectedIdx = await selectBestMatchWithLLM(
      inputName,
      llmCandidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        name_norm: candidate.name_norm,
        similarity: candidate.combinedScore,
        calories_kcal: candidate.calories_kcal ?? null,
      })),
    )

    if (selectedIdx >= 0) {
      const selected = llmCandidates[selectedIdx]
      const selectedSimilarity = selected.combinedScore ?? selected.vectorSimilarity ?? selected.textSignal ?? selected.similarity ?? 0
      const confidence: 'high' | 'medium' | 'low' =
        selectedSimilarity >= 0.9 ? 'high' :
        selectedSimilarity >= 0.5 ? 'medium' :
        'low'

      console.log(`[ingredient-matcher] ✅ embedding_llm: "${inputName}" → "${selected.name}" (combined: ${(selectedSimilarity * 100).toFixed(0)}%)`)
      return {
        input: ingredient,
        matched: toMatchedIngredientData(selected, selectedSimilarity),
        confidence,
        matchMethod: selected.textSignal ? 'text_similarity' : 'embedding_llm',
      }
    }
  }

  // ============================================
  // 4. マッチなし
  // ============================================
  console.log(`[ingredient-matcher] ❌ no match: "${inputName}"`)
  return {
    input: ingredient,
    matched: null,
    confidence: 'none',
    matchMethod: 'none',
  }
}

// ============================================
// 複数材料の一括マッチング
// ============================================

export async function matchIngredients(
  supabase: SupabaseClient,
  ingredients: EstimatedIngredient[]
): Promise<IngredientMatchResult[]> {
  const results = new Array<IngredientMatchResult>(ingredients.length)
  const memo = new Map<string, IngredientMatchMemo>()
  const uniqueEmbeddingInputs = [...new Set(
    ingredients
      .map((ingredient) => ingredient.name.trim())
      .filter((name) => name && !isWaterishIngredient(name))
  )]

  let embeddingMap = new Map<string, number[]>()
  try {
    embeddingMap = await generateEmbeddingsBatch(uniqueEmbeddingInputs)
  } catch (error) {
    console.warn('[ingredient-matcher] batch embedding generation failed, falling back to per-ingredient embeddings:', error)
  }

  let cursor = 0
  const workerCount = Math.min(MAX_INGREDIENT_MATCH_CONCURRENCY, Math.max(1, ingredients.length))

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++
      if (index >= ingredients.length) return

      const ingredient = ingredients[index]
      const memoKey = normalizeIngredientNameJs(ingredient.name) || ingredient.name.trim()
      const cached = memo.get(memoKey)

      if (cached) {
        results[index] = {
          input: ingredient,
          matched: cached.matched,
          confidence: cached.confidence,
          matchMethod: cached.matchMethod,
        }
        continue
      }

      const result = await matchSingleIngredient(supabase, ingredient, {
        precomputedEmbedding: embeddingMap.get(ingredient.name.trim()),
      })

      memo.set(memoKey, {
        matched: result.matched,
        confidence: result.confidence,
        matchMethod: result.matchMethod,
      })
      results[index] = result
    }
  })

  await Promise.all(workers)

  return results
}

// ============================================
// マッチング統計
// ============================================

export interface MatchingStats {
  total: number
  matched: number
  highConfidence: number
  mediumConfidence: number
  lowConfidence: number
  noMatch: number
  matchRate: number
}

export function calculateMatchingStats(results: IngredientMatchResult[]): MatchingStats {
  const total = results.length
  const matched = results.filter(r => r.matched !== null).length
  const highConfidence = results.filter(r => r.confidence === 'high').length
  const mediumConfidence = results.filter(r => r.confidence === 'medium').length
  const lowConfidence = results.filter(r => r.confidence === 'low').length
  const noMatch = results.filter(r => r.confidence === 'none').length

  return {
    total,
    matched,
    highConfidence,
    mediumConfidence,
    lowConfidence,
    noMatch,
    matchRate: total > 0 ? matched / total : 0,
  }
}

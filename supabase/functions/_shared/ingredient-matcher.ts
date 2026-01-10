/**
 * 材料マッチャー（ingredient-matcher.ts）
 * 
 * 材料名からdataset_ingredientsをベクトル検索し、
 * LLMが最適な材料を選択する
 */

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { EXACT_NAME_NORM_MAP, normalizeIngredientNameJs, isWaterishIngredient } from './nutrition-calculator.ts'

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
  matchMethod: 'exact_map' | 'embedding_llm' | 'embedding' | 'text_similarity' | 'none'
}

// ============================================
// OpenAI Embedding生成
// ============================================

async function generateEmbedding(text: string): Promise<number[]> {
  const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set')
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-large',
      input: text,
      dimensions: 1536,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI Embedding API error: ${errorText}`)
  }

  const data = await response.json()
  return data.data[0].embedding
}

// ============================================
// ベクトル検索による材料マッチング
// ============================================

async function searchByEmbedding(
  supabase: SupabaseClient,
  ingredientName: string,
  matchCount: number = 5
): Promise<MatchedIngredientData[]> {
  try {
    const embedding = await generateEmbedding(ingredientName)
    
    const { data, error } = await supabase.rpc('search_ingredients_full_by_embedding', {
      query_embedding: embedding,
      match_count: matchCount,
    })

    if (error) {
      console.error('Vector search error:', error)
      return []
    }

    return data || []
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
  const { data, error } = await supabase.rpc('search_ingredients_by_text_similarity', {
    query_name: ingredientName,
    similarity_threshold: threshold,
    result_limit: limit,
  })

  if (error) {
    console.error('Text similarity search error:', error)
    return []
  }

  return data || []
}

// ============================================
// LLMで最適な材料を選択
// ============================================

async function selectBestMatchWithLLM(
  inputName: string,
  candidates: Array<{ id: string; name: string; name_norm: string; similarity: number; calories_kcal?: number | null }>
): Promise<number> {
  if (candidates.length === 0) return -1
  if (candidates.length === 1) return 0

  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) {
    console.warn('[ingredient-matcher] No API key for LLM selection, using first candidate')
    return 0
  }

  const prompt = `あなたは日本の食品データベースの専門家です。

料理で使われる食材「${inputName}」に最も適切な食品データベースエントリを選んでください。

【候補】
${candidates.map((c, i) => `${i + 1}. ${c.name} (類似度: ${(c.similarity * 100).toFixed(0)}%, ${c.calories_kcal ?? '?'}kcal/100g)`).join('\n')}

【重要なルール】
- 料理に使う「${inputName}」として最も自然なものを選ぶ
- **調理状態を考慮**: ご飯・麦ご飯など「炊いた状態」で使う食材は「めし」「ゆで」を選ぶ。「乾」は乾燥状態でカロリーが3倍近く高いので避ける
- 明らかに全く異なる食材しかない場合は「0」と答える
- 数字だけで答える（例: 「2」）

回答:`

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-nano',
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 10,
        reasoning_effort: "low",
      }),
    })

    if (res.ok) {
      const data = await res.json()
      const content = (data.choices?.[0]?.message?.content ?? '').trim()
      const num = parseInt(content, 10)

      if (num === 0) {
        console.log(`[ingredient-matcher] LLM: 「${inputName}」→ 全候補却下`)
        return -1
      }

      if (num >= 1 && num <= candidates.length) {
        console.log(`[ingredient-matcher] LLM: 「${inputName}」→ ${num}番「${candidates[num - 1].name}」を選択`)
        return num - 1
      }
    }
  } catch (e: any) {
    console.warn(`[ingredient-matcher] LLM selection failed for "${inputName}":`, e?.message)
  }

  // フォールバック: 最初の候補を使用
  console.log(`[ingredient-matcher] LLM selection fallback: using first candidate for "${inputName}"`)
  return 0
}

// ============================================
// name_normでの完全一致検索
// ============================================

async function searchByExactNameNorm(
  supabase: SupabaseClient,
  nameNorm: string
): Promise<MatchedIngredientData | null> {
  const { data, error } = await supabase
    .from('dataset_ingredients')
    .select('*')
    .eq('name_norm', nameNorm)
    .maybeSingle()

  if (error || !data) {
    return null
  }

  return { ...data, similarity: 1.0 }
}

// ============================================
// 単一材料のマッチング
// ============================================

export async function matchSingleIngredient(
  supabase: SupabaseClient,
  ingredient: EstimatedIngredient
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
  // 2. ベクトル検索で10件取得 → LLMが最適なものを選択
  // ============================================
  const embeddingResults = await searchByEmbedding(supabase, inputName, 10)

  if (embeddingResults.length > 0) {
    // 類似度0.2以上の候補のみ
    const validCandidates = embeddingResults.filter(r => r.similarity >= 0.2)
    
    if (validCandidates.length > 0) {
      console.log(`[ingredient-matcher] "${inputName}": ${validCandidates.length} candidates - ${validCandidates.slice(0, 5).map(c => `${c.name.substring(0, 20)}(${(c.similarity * 100).toFixed(0)}%)`).join(', ')}`)
      
      // LLMに最適な候補を選んでもらう
      const selectedIdx = await selectBestMatchWithLLM(inputName, validCandidates)
      
      if (selectedIdx >= 0) {
        const selected = validCandidates[selectedIdx]
        
        // confidenceは類似度に基づく
        let confidence: 'high' | 'medium' | 'low' = 'medium'
        if (selected.similarity >= 0.7) {
          confidence = 'high'
        } else if (selected.similarity >= 0.5) {
          confidence = 'medium'
        } else {
          confidence = 'low'
        }
        
        console.log(`[ingredient-matcher] ✅ embedding_llm: "${inputName}" → "${selected.name}" (similarity: ${(selected.similarity * 100).toFixed(0)}%, ${selected.calories_kcal}kcal/100g)`)
        return {
          input: ingredient,
          matched: selected,
          confidence,
          matchMethod: 'embedding_llm',
        }
      }
    }
  }

  // ============================================
  // 3. フォールバック: テキスト類似度検索
  // ============================================
  const textResults = await searchByTextSimilarity(supabase, inputName, 0.2, 5)

  if (textResults.length > 0) {
    const best = textResults[0]
    
    const confidence = best.similarity >= 0.5 ? 'medium' : 'low'
    console.log(`[ingredient-matcher] ✅ text_similarity: "${inputName}" → "${best.name}" (similarity: ${(best.similarity * 100).toFixed(0)}%)`)
    
    return {
      input: ingredient,
      matched: best,
      confidence,
      matchMethod: 'text_similarity',
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
  const results: IngredientMatchResult[] = []

  for (const ingredient of ingredients) {
    const result = await matchSingleIngredient(supabase, ingredient)
    results.push(result)
  }

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

#!/usr/bin/env node
/**
 * 栄養計算パイプライン テストスクリプト
 * 
 * DB関数とパイプラインロジックをテストする
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// .env.local を読み込み
dotenv.config({ path: join(__dirname, '..', '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing environment variables')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ============================================
// テスト1: 材料検索（テキスト類似度）
// ============================================
async function testTextSimilaritySearch() {
  console.log('\n=== テスト1: テキスト類似度検索 ===')
  
  const testCases = ['鶏もも肉', '白米', 'キャベツ', '醤油', '味噌']
  
  for (const name of testCases) {
    const { data, error } = await supabase.rpc('search_ingredients_by_text_similarity', {
      query_name: name,
      similarity_threshold: 0.3,
      result_limit: 3
    })
    
    if (error) {
      console.error(`  ${name}: エラー - ${error.message}`)
    } else if (data && data.length > 0) {
      console.log(`  ${name}:`)
      data.forEach((d, i) => {
        console.log(`    ${i+1}. ${d.name} (類似度: ${(d.similarity * 100).toFixed(1)}%, ${d.calories_kcal}kcal/100g)`)
      })
    } else {
      console.log(`  ${name}: マッチなし`)
    }
  }
}

// ============================================
// テスト2: 材料検索（ベクトル検索）
// ============================================
async function testVectorSearch() {
  console.log('\n=== テスト2: ベクトル検索 ===')
  
  if (!OPENAI_API_KEY) {
    console.log('  OPENAI_API_KEY がないためスキップ')
    return
  }
  
  const testCases = ['鶏もも肉', '白ごはん', 'キャベツ']
  
  for (const name of testCases) {
    try {
      // Embedding生成
      const embResponse = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-large',
          input: name,
          dimensions: 1536,
        }),
      })
      
      if (!embResponse.ok) {
        console.error(`  ${name}: Embedding生成エラー`)
        continue
      }
      
      const embData = await embResponse.json()
      const embedding = embData.data[0].embedding
      
      // ベクトル検索
      const { data, error } = await supabase.rpc('search_ingredients_full_by_embedding', {
        query_embedding: embedding,
        match_count: 3
      })
      
      if (error) {
        console.error(`  ${name}: エラー - ${error.message}`)
      } else if (data && data.length > 0) {
        console.log(`  ${name}:`)
        data.forEach((d, i) => {
          console.log(`    ${i+1}. ${d.name} (類似度: ${(d.similarity * 100).toFixed(1)}%, ${d.calories_kcal}kcal/100g)`)
        })
      } else {
        console.log(`  ${name}: マッチなし`)
      }
    } catch (e) {
      console.error(`  ${name}: エラー - ${e.message}`)
    }
  }
}

// ============================================
// テスト3: レシピ検索
// ============================================
async function testRecipeSearch() {
  console.log('\n=== テスト3: レシピ検索 ===')
  
  const testCases = ['鶏の照り焼き', '豚の生姜焼き', 'ハンバーグ', '味噌汁']
  
  for (const name of testCases) {
    const { data, error } = await supabase.rpc('search_recipes_with_nutrition', {
      query_name: name,
      similarity_threshold: 0.3,
      result_limit: 3
    })
    
    if (error) {
      console.error(`  ${name}: エラー - ${error.message}`)
    } else if (data && data.length > 0) {
      console.log(`  ${name}:`)
      data.forEach((d, i) => {
        console.log(`    ${i+1}. ${d.name} (類似度: ${(d.similarity * 100).toFixed(1)}%, ${d.calories_kcal}kcal)`)
      })
    } else {
      console.log(`  ${name}: マッチなし`)
    }
  }
}

// ============================================
// テスト4: 栄養計算シミュレーション
// ============================================
async function testNutritionCalculation() {
  console.log('\n=== テスト4: 栄養計算シミュレーション ===')
  
  // 鶏の照り焼き定食の材料
  const ingredients = [
    { name: '鶏もも肉', amount_g: 120 },
    { name: '醤油', amount_g: 15 },
    { name: '砂糖', amount_g: 10 },
    { name: '白米', amount_g: 150 },
    { name: 'キャベツ', amount_g: 50 },
  ]
  
  console.log('  鶏の照り焼き定食の材料:')
  ingredients.forEach(i => console.log(`    - ${i.name}: ${i.amount_g}g`))
  
  let totalCalories = 0
  let totalProtein = 0
  let matchedCount = 0
  
  console.log('\n  マッチング結果:')
  for (const ing of ingredients) {
    const { data, error } = await supabase.rpc('search_ingredients_by_text_similarity', {
      query_name: ing.name,
      similarity_threshold: 0.3,
      result_limit: 1
    })
    
    if (data && data.length > 0) {
      const matched = data[0]
      const factor = ing.amount_g / 100
      const cal = (matched.calories_kcal || 0) * factor
      const protein = (matched.protein_g || 0) * factor
      
      totalCalories += cal
      totalProtein += protein
      matchedCount++
      
      console.log(`    ${ing.name} → ${matched.name} (類似度: ${(matched.similarity * 100).toFixed(1)}%)`)
      console.log(`      ${Math.round(cal)}kcal, タンパク質${protein.toFixed(1)}g`)
    } else {
      console.log(`    ${ing.name} → マッチなし`)
    }
  }
  
  console.log(`\n  計算結果:`)
  console.log(`    合計カロリー: ${Math.round(totalCalories)}kcal`)
  console.log(`    合計タンパク質: ${totalProtein.toFixed(1)}g`)
  console.log(`    マッチ率: ${matchedCount}/${ingredients.length} (${(matchedCount/ingredients.length*100).toFixed(0)}%)`)
  
  // レシピで検証
  const { data: recipes } = await supabase.rpc('search_recipes_with_nutrition', {
    query_name: '鶏の照り焼き',
    similarity_threshold: 0.3,
    result_limit: 1
  })
  
  if (recipes && recipes.length > 0) {
    const ref = recipes[0]
    const deviation = Math.abs((totalCalories - ref.calories_kcal) / ref.calories_kcal) * 100
    console.log(`\n  エビデンス検証:`)
    console.log(`    参照レシピ: ${ref.name} (${ref.calories_kcal}kcal)`)
    console.log(`    偏差: ${deviation.toFixed(1)}%`)
    console.log(`    検証結果: ${deviation <= 20 ? 'OK' : deviation <= 50 ? '警告付きOK' : 'NG'}`)
  }
}

// ============================================
// メイン
// ============================================
async function main() {
  console.log('========================================')
  console.log('栄養計算パイプライン テスト')
  console.log('========================================')
  
  await testTextSimilaritySearch()
  await testVectorSearch()
  await testRecipeSearch()
  await testNutritionCalculation()
  
  console.log('\n========================================')
  console.log('テスト完了')
  console.log('========================================')
}

main().catch(console.error)

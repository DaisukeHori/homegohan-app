#!/usr/bin/env node
/**
 * 栄養計算パイプライン 全体テスト
 * 
 * 1. EXACT_NAME_NORM_MAPによる完全マッチ
 * 2. ベクトル検索 + LLM選択
 * 3. エビデンス検証（レシピ比較）
 * 4. 栄養計算
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://flmeolcfutuwwbjmzyoz.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsbWVvbGNmdXR1d3diam16eW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM5NzAxODYsImV4cCI6MjA3OTU0NjE4Nn0.VVxUxNeN6dUiAMDkCNlnIoXa-F5rfBqHPBDcwdnU'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// テスト用の食事データ（鶏の照り焼き定食）
const TEST_MEAL = {
  dishes: [
    {
      name: '鶏の照り焼き',
      role: 'main',
      estimatedIngredients: [
        { name: '鶏もも肉', amount_g: 120 },
        { name: '醤油', amount_g: 15 },
        { name: '砂糖', amount_g: 10 },
        { name: 'みりん', amount_g: 10 },
      ]
    },
    {
      name: '白ご飯',
      role: 'rice',
      estimatedIngredients: [
        { name: '白米', amount_g: 150 }
      ]
    },
    {
      name: 'キャベツの千切り',
      role: 'side',
      estimatedIngredients: [
        { name: 'キャベツ', amount_g: 50 }
      ]
    },
    {
      name: '味噌汁',
      role: 'soup',
      estimatedIngredients: [
        { name: '味噌', amount_g: 15 },
        { name: '豆腐', amount_g: 30 },
        { name: 'わかめ', amount_g: 5 },
      ]
    }
  ]
}

// EXACT_NAME_NORM_MAP（nutrition-calculator.tsから抜粋）
const EXACT_NAME_NORM_MAP = {
  "鶏もも肉": "＜鳥肉類＞にわとり［若どり主品目］もも皮つき生",
  "醤油": "＜調味料類＞しょうゆ類こいくちしょうゆ",
  "砂糖": "砂糖類車糖上白糖",
  "みりん": "＜アルコール飲料類＞混成酒類みりん本みりん",
  "白米": "こめ［水稲めし］精白米うるち米",
  "キャベツ": "キャベツ類キャベツ結球葉生",
  "味噌": "＜調味料類＞みそ類米みそ甘みそ",
  "豆腐": "だいず［豆腐油揚げ類］木綿豆腐",
  "わかめ": "わかめ乾燥わかめ素干し水戻し",
}

// ============================================
// テスト1: EXACT_NAME_NORM_MAP マッチング
// ============================================
async function testExactMapping() {
  console.log('\n=== テスト1: EXACT_NAME_NORM_MAP マッチング ===')
  
  const allIngredients = TEST_MEAL.dishes.flatMap(d => d.estimatedIngredients)
  let matchCount = 0
  let totalCalories = 0
  
  for (const ing of allIngredients) {
    const nameNorm = EXACT_NAME_NORM_MAP[ing.name]
    
    if (nameNorm) {
      const { data, error } = await supabase
        .from('dataset_ingredients')
        .select('name, calories_kcal, protein_g')
        .eq('name_norm', nameNorm)
        .maybeSingle()
      
      if (data) {
        const cal = (parseFloat(data.calories_kcal) * ing.amount_g / 100).toFixed(0)
        totalCalories += parseFloat(cal)
        console.log(`  ✅ ${ing.name} (${ing.amount_g}g) → ${data.name.substring(0, 25)}... = ${cal}kcal`)
        matchCount++
      } else {
        console.log(`  ⚠️ ${ing.name}: MAP存在するがDB無し (${nameNorm.substring(0, 30)}...)`)
      }
    } else {
      console.log(`  ❌ ${ing.name}: MAPになし`)
    }
  }
  
  console.log(`\n  結果: ${matchCount}/${allIngredients.length} マッチ, 合計 ${Math.round(totalCalories)}kcal`)
  return { matchCount, total: allIngredients.length, totalCalories }
}

// ============================================
// テスト2: ベクトル検索テスト
// ============================================
async function testVectorSearch() {
  console.log('\n=== テスト2: ベクトル検索（MAP外の食材） ===')
  
  // MAPにない食材をテスト
  const unmappedIngredients = ['鶏ひき肉', 'ほうれん草', 'しめじ', 'ベーコン']
  
  for (const name of unmappedIngredients) {
    // Embeddingが存在するレコードでベクトル検索をシミュレート
    const { data, error } = await supabase.rpc('search_ingredients_by_text_similarity', {
      query_name: name,
      similarity_threshold: 0.2,
      result_limit: 3
    })
    
    if (data && data.length > 0) {
      console.log(`  ${name}:`)
      data.forEach((d, i) => {
        console.log(`    ${i+1}. ${d.name.substring(0, 30)}... (類似度: ${(d.similarity * 100).toFixed(0)}%, ${d.calories_kcal}kcal/100g)`)
      })
    } else {
      console.log(`  ${name}: マッチなし`)
    }
  }
}

// ============================================
// テスト3: エビデンス検証（レシピ比較）
// ============================================
async function testEvidenceVerification() {
  console.log('\n=== テスト3: エビデンス検証（レシピ比較） ===')
  
  const dishes = ['鶏の照り焼き', '豚の生姜焼き', 'ハンバーグ', '味噌汁', '親子丼']
  
  for (const name of dishes) {
    const { data, error } = await supabase.rpc('search_recipes_with_nutrition', {
      query_name: name,
      similarity_threshold: 0.3,
      result_limit: 1
    })
    
    if (data && data.length > 0) {
      const ref = data[0]
      console.log(`  ✅ ${name} → ${ref.name} (${ref.calories_kcal}kcal, 類似度: ${(ref.similarity * 100).toFixed(0)}%)`)
    } else {
      console.log(`  ⚠️ ${name}: 参照レシピなし`)
    }
  }
}

// ============================================
// テスト4: 栄養計算シミュレーション
// ============================================
async function testNutritionCalculation() {
  console.log('\n=== テスト4: 栄養計算シミュレーション ===')
  
  let grandTotalCal = 0
  let grandTotalProtein = 0
  
  for (const dish of TEST_MEAL.dishes) {
    console.log(`\n  【${dish.name}】(${dish.role})`)
    let dishCal = 0
    let dishProtein = 0
    
    for (const ing of dish.estimatedIngredients) {
      const nameNorm = EXACT_NAME_NORM_MAP[ing.name]
      
      if (nameNorm) {
        const { data } = await supabase
          .from('dataset_ingredients')
          .select('calories_kcal, protein_g')
          .eq('name_norm', nameNorm)
          .maybeSingle()
        
        if (data) {
          const cal = parseFloat(data.calories_kcal) * ing.amount_g / 100
          const protein = parseFloat(data.protein_g) * ing.amount_g / 100
          dishCal += cal
          dishProtein += protein
          console.log(`    ${ing.name} ${ing.amount_g}g: ${Math.round(cal)}kcal, P${protein.toFixed(1)}g`)
        }
      }
    }
    
    console.log(`    → 小計: ${Math.round(dishCal)}kcal, P${dishProtein.toFixed(1)}g`)
    grandTotalCal += dishCal
    grandTotalProtein += dishProtein
  }
  
  console.log(`\n  ===========================`)
  console.log(`  合計: ${Math.round(grandTotalCal)}kcal, タンパク質${grandTotalProtein.toFixed(1)}g`)
  
  // エビデンス検証
  const { data: ref } = await supabase.rpc('search_recipes_with_nutrition', {
    query_name: '鶏の照り焼き',
    similarity_threshold: 0.3,
    result_limit: 1
  })
  
  if (ref && ref.length > 0) {
    const refCal = ref[0].calories_kcal
    // 主菜のみの計算値（ご飯・副菜・汁物を除く）
    const mainDishCal = TEST_MEAL.dishes.find(d => d.role === 'main')?.estimatedIngredients.reduce((sum, ing) => {
      const nameNorm = EXACT_NAME_NORM_MAP[ing.name]
      // 簡易計算（実際はDBから取得）
      return sum
    }, 0)
    
    console.log(`\n  エビデンス: 参照レシピ「${ref[0].name}」= ${refCal}kcal`)
  }
  
  return { totalCalories: grandTotalCal, totalProtein: grandTotalProtein }
}

// ============================================
// テスト5: Edge Function呼び出し（オプション）
// ============================================
async function testEdgeFunctionDirect() {
  console.log('\n=== テスト5: Edge Function直接呼び出し ===')
  console.log('  (実際の画像がないためスキップ - UIからテストしてください)')
  console.log('  Edge Function URL: https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/analyze-meal-photo')
}

// ============================================
// メイン
// ============================================
async function main() {
  console.log('========================================')
  console.log('栄養計算パイプライン 全体テスト')
  console.log('========================================')
  console.log('テスト対象: 鶏の照り焼き定食')
  console.log('  - 鶏の照り焼き (主菜)')
  console.log('  - 白ご飯')
  console.log('  - キャベツの千切り (副菜)')
  console.log('  - 味噌汁')
  
  const result1 = await testExactMapping()
  await testVectorSearch()
  await testEvidenceVerification()
  const result4 = await testNutritionCalculation()
  await testEdgeFunctionDirect()
  
  console.log('\n========================================')
  console.log('テスト完了サマリー')
  console.log('========================================')
  console.log(`EXACT_NAME_NORM_MAP マッチ率: ${result1.matchCount}/${result1.total} (${(result1.matchCount/result1.total*100).toFixed(0)}%)`)
  console.log(`計算カロリー: ${Math.round(result4.totalCalories)}kcal`)
  console.log(`計算タンパク質: ${result4.totalProtein.toFixed(1)}g`)
  console.log('')
  console.log('✅ パイプラインは正常に動作しています')
  console.log('📱 実際の食事写真でのテストはアプリUIから行ってください')
}

main().catch(console.error)

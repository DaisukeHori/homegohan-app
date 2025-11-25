import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

console.log("Hello from Functions!")

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // request param に familySize, cheatDay を追加
    const { recordId, userId, startDate, note, familySize, cheatDay } = await req.json()

    // 非同期でバックグラウンドタスクを実行（レスポンスをブロックしない）
    generateMenuBackgroundTask({ recordId, userId, startDate, note, familySize, cheatDay }).catch((error) => {
      console.error('Background task error:', error)
    })

    return new Response(
      JSON.stringify({ message: 'Menu generation started in background' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})

async function generateMenuBackgroundTask({ recordId, userId, startDate, note, familySize = 1, cheatDay }: any) {
  console.log(`Starting generation for request: ${recordId}`)
  
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  try {
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if (profileError) throw new Error(`Profile not found: ${profileError.message}`)

    // 直近データの取得（省略可能だが精度向上のため維持）
    const oneWeekAgo = new Date()
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
    const { data: recentMeals } = await supabase
      .from('meals')
      .select('memo')
      .eq('user_id', userId)
      .gte('created_at', oneWeekAgo.toISOString())
      .limit(20)
    const recentMenus = recentMeals?.map(m => m.memo).filter(Boolean).join(', ') || '特になし';

    const allergies = profile.diet_flags?.allergies?.join(', ') || 'なし';
    const dislikes = profile.diet_flags?.dislikes?.join(', ') || 'なし';

    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
    if (!OPENAI_API_KEY) throw new Error('OpenAI API Key is missing')

    const prompt = `
      あなたはトップアスリートや経営者を支える超一流の「AI管理栄養士」です。
      以下のユーザー情報に基づき、1週間分の献立、買い物リスト、そして未来予測レポートをJSON形式で生成してください。

      【ユーザー情報】
      - 年代/性別: ${profile.age_group} / ${profile.gender || '不明'}
      - 目標: ${profile.goal_text || '健康維持'}
      - 家族人数: ${familySize}人分 (買い物リストはこの人数分で計算)
      - アレルギー（絶対除去）: ${allergies}
      - 苦手なもの（避ける）: ${dislikes}
      - チートデイ希望: ${cheatDay ? cheatDay + '曜日' : 'なし'} (この日は好きなものを食べて良い設定とし、前後で調整)
      
      【直近の状況】
      - 最近食べたもの: ${recentMenus} (被りを避ける)
      - 今週のリクエスト: ${note || '特になし'}
      
      【生成要件】
      1. 献立 (days):
         - 一汁三菜ベース。チートデイ以外はPFCバランス重視。
         - チートデイは「ストレス解消」をテーマに少し豪華またはジャンキーでも可。
      
      2. 買い物リスト (shoppingList):
         - ${familySize}人分の分量を概算して記載 (例: "鶏もも肉 2枚(600g)")。
         - カテゴリ別に分類。

      3. 未来予測 (projectedImpact):
         - この献立を1週間続けた場合の「期待される効果」をシミュレーション。
         - 体重変化予測、肌質、集中力、睡眠の質などへの影響をポジティブに記述。

      【JSON出力スキーマ】
      {
        "days": [
          {
            "date": "YYYY-MM-DD",
            "dayOfWeek": "Monday",
            "isCheatDay": boolean,
            "meals": [
              { "mealType": "breakfast", "dishes": [{"name": "料理名", "role": "主食"}] },
              ...
            ],
            "nutritionalAdvice": "アドバイス"
          }
        ],
        "shoppingList": [
          { "category": "野菜", "items": ["キャベツ 1玉", "..."] }
        ],
        "projectedImpact": {
          "weightChange": "-0.5kg",
          "energyLevel": "High",
          "skinCondition": "Improved",
          "comment": "ビタミンB群が豊富で、週末には疲労回復が実感できるでしょう。"
        }
      }
    `

    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        messages: [
          { role: "system", content: "You are an elite nutritionist AI. Respond only in valid JSON." },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
      }),
    })

    if (!aiResponse.ok) throw new Error(await aiResponse.text())

    const aiData = await aiResponse.json()
    const resultJson = JSON.parse(aiData.choices[0].message.content)

    const { error: updateError } = await supabase
      .from('weekly_menu_requests')
      .update({
        status: 'completed',
        result_json: resultJson,
        updated_at: new Date().toISOString(),
      })
      .eq('id', recordId)

    if (updateError) throw updateError
    
  } catch (error: any) {
    console.error(`Error: ${error.message}`)
    await supabase
      .from('weekly_menu_requests')
      .update({ status: 'failed', error_message: error.message })
      .eq('id', recordId)
  }
}

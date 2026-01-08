/**
 * regenerate-shopping-list-v2
 * 
 * 買い物リスト再生成を非同期で実行するEdge Function
 * - 日付ベースモデル対応（user_daily_meals, shopping_lists）
 * - 進捗をshopping_list_requestsテーブルに書き込み
 * - Supabase Realtimeでクライアントに進捗通知
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ============================================
// CORS
// ============================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============================================
// 型定義
// ============================================

interface InputIngredient {
  name: string;
  amount?: string | null;
  count: number;
}

interface QuantityVariant {
  display: string;
  unit: string;
  value: number | null;
}

interface NormalizedItem {
  itemName: string;
  normalizedName: string;
  quantityVariants: QuantityVariant[];
  category: string;
}

interface Progress {
  phase: string;
  message: string;
  percentage: number;
}

// ============================================
// 進捗更新ヘルパー
// ============================================

async function updateProgress(
  supabase: SupabaseClient,
  requestId: string,
  progress: Progress
): Promise<void> {
  await supabase
    .from("shopping_list_requests")
    .update({ progress, updated_at: new Date().toISOString() })
    .eq("id", requestId);
}

async function markCompleted(
  supabase: SupabaseClient,
  requestId: string,
  shoppingListId: string,
  stats: { inputCount: number; outputCount: number; mergedCount: number; totalServings?: number }
): Promise<void> {
  await supabase
    .from("shopping_list_requests")
    .update({
      status: "completed",
      shopping_list_id: shoppingListId,
      progress: { phase: "completed", message: "完了！", percentage: 100 },
      result: { stats },
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);
}

async function markFailed(
  supabase: SupabaseClient,
  requestId: string,
  error: string
): Promise<void> {
  await supabase
    .from("shopping_list_requests")
    .update({
      status: "failed",
      progress: { phase: "failed", message: "エラーが発生しました", percentage: 0 },
      result: { error },
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);
}

// ============================================
// LLMプロンプト生成
// ============================================

function buildPrompt(ingredients: InputIngredient[]): string {
  return `あなたは買い物リストの最適化AIです。スーパーで買い物しやすいリストを作成します。

以下の材料リストを整理してください：
${JSON.stringify(ingredients, null, 2)}

【タスク1: 表記ゆれの統一】
同じ材料の異なる表記を統一してマージ
- 例: 「鶏むね肉」「鶏胸肉」「とりむね」→「鶏むね肉」
- 例: 「玉ねぎ」「たまねぎ」「玉葱」→「玉ねぎ」

【タスク2: 数量の複数表現★重要★】
**すべての食材で、買い物時に便利な複数の単位表現を必ず生成してください。**
ユーザーがタップで切り替えて、自分に合った単位で見られるようにします。

■ 野菜・果物:
- 玉ねぎ: ["3個", "約450g", "中3個"]
- にんじん: ["2本", "約300g"]
- キャベツ: ["1/2個", "約500g"]
- じゃがいも: ["4個", "約400g", "中4個"]
- トマト: ["2個", "約300g", "中2個"]

■ 肉類:
- 鶏むね肉: ["300g", "約1.5枚", "1パック"]
- 豚バラ肉: ["200g", "約8枚", "薄切り1パック"]
- ひき肉: ["300g", "1パック"]
- 鶏もも肉: ["400g", "約2枚", "1パック"]

■ 魚介類:
- 鮭: ["2切れ", "約200g"]
- えび: ["10尾", "約150g", "1パック"]

■ 調味料:
- 醤油: ["大さじ3", "約45ml"]
- 砂糖: ["大さじ2", "約24g"]
- 塩: ["小さじ1", "約5g"]

■ その他:
- 卵: ["3個", "約150g"]
- 豆腐: ["1丁", "約300g"]
- 牛乳: ["200ml", "約1カップ"]

【タスク3: スーパーの棚に合わせたカテゴリ分類★重要★】
日本のスーパーマーケットの一般的な売り場配置に合わせて分類：

- **青果（野菜・果物）**: 野菜全般、果物
- **精肉**: 鶏肉、豚肉、牛肉、ひき肉、ハム、ベーコン、ソーセージ
- **鮮魚**: 魚、貝、えび、いか、たこ、刺身
- **乳製品・卵**: 牛乳、ヨーグルト、チーズ、バター、生クリーム、卵
- **豆腐・練り物**: 豆腐、油揚げ、厚揚げ、納豆、こんにゃく、ちくわ、かまぼこ
- **米・パン・麺**: 米、パン、うどん、そば、パスタ、中華麺、餅
- **調味料**: 醤油、味噌、塩、砂糖、酢、みりん、酒、だし、ソース、ケチャップ、マヨネーズ、ドレッシング
- **油・香辛料**: サラダ油、ごま油、オリーブオイル、胡椒、唐辛子、スパイス類
- **乾物・缶詰**: わかめ、ひじき、昆布、のり、かつお節、干ししいたけ、切り干し大根、缶詰、瓶詰
- **冷凍食品**: 冷凍野菜、冷凍肉、冷凍魚、冷凍食品全般
- **飲料**: お茶、ジュース、コーヒー、水
- **その他**: 上記に当てはまらないもの

【出力形式】JSON
{
  "items": [
    {
      "itemName": "玉ねぎ",
      "normalizedName": "玉ねぎ",
      "quantityVariants": [
        {"display": "3個", "unit": "個", "value": 3},
        {"display": "約450g", "unit": "g", "value": 450}
      ],
      "category": "青果（野菜・果物）"
    }
  ]
}

【★★★ 最重要ルール ★★★】
1. **quantityVariantsは必ず2つ以上**生成すること（数量不明の場合を除く）
   - 重量(g)と個数(個/本/枚/切れ等)の両方を含める
   - 可能なら「パック」「袋」などの購入単位も追加
2. 数値がない場合（「適量」「少々」）のみ、variants を1つにしてよい
3. 入力にない材料を追加しない（ハルシネーション禁止）
4. JSONのみ出力（説明文不要）`;
}

// ============================================
// OpenAI API呼び出し
// ============================================

async function callOpenAI(prompt: string): Promise<NormalizedItem[]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 4000,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Empty response from OpenAI");
  }

  const parsed = JSON.parse(content);
  return parsed.items || [];
}

// ============================================
// バリデーション: ハルシネーション除去
// ============================================

function toHiragana(str: string): string {
  return str.replace(/[\u30A1-\u30F6]/g, (match) =>
    String.fromCharCode(match.charCodeAt(0) - 0x60)
  );
}

function validateItems(
  items: NormalizedItem[],
  inputNames: Set<string>
): NormalizedItem[] {
  return items.filter((item) => {
    const itemNameLower = item.itemName.toLowerCase();
    const normalizedLower = item.normalizedName.toLowerCase();
    const itemNameHira = toHiragana(itemNameLower);
    const normalizedHira = toHiragana(normalizedLower);

    for (const inputName of inputNames) {
      const inputLower = inputName.toLowerCase();
      const inputHira = toHiragana(inputLower);
      if (
        inputLower.includes(itemNameLower) ||
        itemNameLower.includes(inputLower) ||
        inputLower.includes(normalizedLower) ||
        normalizedLower.includes(inputLower) ||
        inputHira.includes(itemNameHira) ||
        itemNameHira.includes(inputHira) ||
        inputHira.includes(normalizedHira) ||
        normalizedHira.includes(inputHira)
      ) {
        return true;
      }
    }
    return false;
  });
}

// ============================================
// 人数設定型
// ============================================

interface MealServings {
  breakfast?: number;
  lunch?: number;
  dinner?: number;
}

interface ServingsConfig {
  default: number;
  byDayMeal: {
    [day: string]: MealServings;
  };
}

// 日付から曜日を取得 (monday, tuesday, ...)
function getDayOfWeek(dateStr: string): string {
  const date = new Date(dateStr);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getDay()];
}

// servingsConfigから人数を取得
function getServingsForSlot(
  config: ServingsConfig | null | undefined,
  dayOfWeek: string,
  mealType: string
): number {
  if (!config) return 1;
  const byDay = config.byDayMeal?.[dayOfWeek];
  if (byDay && byDay[mealType as keyof MealServings] !== undefined) {
    return byDay[mealType as keyof MealServings] ?? config.default ?? 1;
  }
  return config.default ?? 1;
}

// 材料文字列から分量をパース
function parseIngredientAmount(ing: any): { name: string; amount_g: number } | null {
  if (typeof ing === 'object' && ing.name) {
    return { name: ing.name, amount_g: ing.amount_g ?? 0 };
  }
  if (typeof ing === 'string') {
    // "玉ねぎ 50g" → { name: "玉ねぎ", amount_g: 50 }
    const match = ing.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*g$/);
    if (match) {
      return { name: match[1].trim(), amount_g: parseFloat(match[2]) };
    }
    // 数量なしの場合
    return { name: ing.trim(), amount_g: 0 };
  }
  return null;
}

// ============================================
// メイン処理（日付ベースモデル対応）
// ============================================

async function processRegeneration(
  supabase: SupabaseClient,
  requestId: string,
  userId: string,
  startDate: string,
  endDate: string,
  servingsConfig?: ServingsConfig | null
): Promise<void> {
  try {
    // Phase 1: 材料抽出
    await updateProgress(supabase, requestId, {
      phase: "extracting",
      message: `献立から材料を抽出中...（${startDate}〜${endDate}）`,
      percentage: 10,
    });

    // servingsConfigがなければユーザープロフィールから取得
    let effectiveServingsConfig = servingsConfig;
    if (!effectiveServingsConfig) {
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("servings_config, family_size")
        .eq("id", userId)
        .single();
      
      if (profile?.servings_config) {
        effectiveServingsConfig = profile.servings_config as ServingsConfig;
      } else if (profile?.family_size) {
        effectiveServingsConfig = { default: profile.family_size, byDayMeal: {} };
      }
    }

    // 日付ベースで献立を取得（user_daily_meals → planned_meals）
    const { data: dailyMeals, error: mealsError } = await supabase
      .from("user_daily_meals")
      .select(`
        id,
        day_date,
        planned_meals (
          id,
          meal_type,
          ingredients,
          dishes
        )
      `)
      .eq("user_id", userId)
      .gte("day_date", startDate)
      .lte("day_date", endDate);

    if (mealsError) throw mealsError;

    // 材料を抽出（人数倍率適用）
    const ingredientsMap = new Map<string, InputIngredient>();
    let totalServings = 0;

    (dailyMeals || []).forEach((dailyMeal: any) => {
      const dayDate = dailyMeal.day_date;
      const dayOfWeek = getDayOfWeek(dayDate);
      
      (dailyMeal.planned_meals || []).forEach((meal: any) => {
        const mealType = meal.meal_type;
        
        // この食事の人数を取得
        const servings = getServingsForSlot(effectiveServingsConfig, dayOfWeek, mealType);
        
        // 人数が0の場合はスキップ（外食など）
        if (servings === 0) return;
        
        totalServings += servings;
        
        if (meal.dishes && Array.isArray(meal.dishes)) {
          meal.dishes.forEach((dish: any) => {
            if (dish.ingredients && Array.isArray(dish.ingredients)) {
              dish.ingredients.forEach((ing: any) => {
                const parsed = parseIngredientAmount(ing);
                if (!parsed) return;
                
                const { name, amount_g } = parsed;
                const scaledAmount = amount_g * servings;
                const amountStr = scaledAmount > 0 ? `${Math.round(scaledAmount)}g` : null;

                if (name) {
                  const key = `${name}|${amountStr || ""}`;
                  const existing = ingredientsMap.get(key);
                  if (existing) {
                    existing.count++;
                  } else {
                    ingredientsMap.set(key, {
                      name: name.trim(),
                      amount: amountStr,
                      count: 1,
                    });
                  }
                }
              });
            }
          });
        } else if (meal.ingredients && Array.isArray(meal.ingredients)) {
          meal.ingredients.forEach((ingredient: string) => {
            const parsed = parseIngredientAmount(ingredient);
            if (!parsed) return;
            
            const { name, amount_g } = parsed;
            const scaledAmount = amount_g * servings;
            const amountStr = scaledAmount > 0 ? `${Math.round(scaledAmount)}g` : null;
            const key = `${name}|${amountStr || ""}`;
            
            const existing = ingredientsMap.get(key);
            if (existing) {
              existing.count++;
            } else {
              ingredientsMap.set(key, {
                name: name.trim(),
                amount: amountStr,
                count: 1,
              });
            }
          });
        }
      });
    });

    console.log(`Total servings calculated: ${totalServings}`);

    const rawIngredients = Array.from(ingredientsMap.values());

    // 既存のアクティブな買い物リストをアーカイブ
    await supabase
      .from("shopping_lists")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("status", "active");

    // 新しい買い物リストを作成
    const { data: newShoppingList, error: listError } = await supabase
      .from("shopping_lists")
      .insert({
        user_id: userId,
        start_date: startDate,
        end_date: endDate,
        status: "active",
        servings_config: effectiveServingsConfig,
        title: `${startDate}〜${endDate}の買い物リスト`,
      })
      .select("id")
      .single();

    if (listError) throw listError;
    const shoppingListId = newShoppingList.id;

    if (rawIngredients.length === 0) {
      // 材料がない場合は空のリストで完了
      await markCompleted(supabase, requestId, shoppingListId, {
        inputCount: 0,
        outputCount: 0,
        mergedCount: 0,
        totalServings: 0,
      });
      return;
    }

    // Phase 2: AI正規化
    await updateProgress(supabase, requestId, {
      phase: "normalizing",
      message: "AIが材料を整理中...",
      percentage: 30,
    });

    const inputNames = new Set(rawIngredients.map((ing) => ing.name));
    const prompt = buildPrompt(rawIngredients);
    const rawItems = await callOpenAI(prompt);

    // Phase 3: バリデーション
    await updateProgress(supabase, requestId, {
      phase: "validating",
      message: "整合性チェック中...",
      percentage: 60,
    });

    const validatedItems = validateItems(rawItems, inputNames);

    // Phase 4: カテゴリ分類・保存準備
    await updateProgress(supabase, requestId, {
      phase: "categorizing",
      message: "カテゴリ分類中...",
      percentage: 70,
    });

    const newItems = validatedItems.map((item) => ({
      shopping_list_id: shoppingListId,
      item_name: item.itemName,
      normalized_name: item.normalizedName,
      quantity: item.quantityVariants[0]?.display || null,
      quantity_variants: item.quantityVariants,
      selected_variant_index: 0,
      category: item.category,
      source: "generated",
      is_checked: false,
    }));

    // Phase 5: 保存
    await updateProgress(supabase, requestId, {
      phase: "saving",
      message: "保存中...",
      percentage: 85,
    });

    if (newItems.length > 0) {
      const { error: insertError } = await supabase
        .from("shopping_list_items")
        .insert(newItems);

      if (insertError) throw insertError;
    }

    // 完了
    const stats = {
      inputCount: rawIngredients.length,
      outputCount: validatedItems.length,
      mergedCount: rawIngredients.length - validatedItems.length,
      totalServings,
    };

    await markCompleted(supabase, requestId, shoppingListId, stats);
  } catch (error) {
    console.error("Regeneration error:", error);
    await markFailed(
      supabase,
      requestId,
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}

// ============================================
// メインハンドラ
// ============================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { requestId, userId, startDate, endDate, servingsConfig } = await req.json();

    if (!requestId || !userId || !startDate || !endDate) {
      return new Response(
        JSON.stringify({ error: "requestId, userId, startDate, endDate are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Service Role Keyでクライアント作成（RLSバイパス）
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 非同期で処理開始（即座にレスポンス返す）
    processRegeneration(supabase, requestId, userId, startDate, endDate, servingsConfig || null);

    return new Response(
      JSON.stringify({ success: true, requestId }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Handler error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

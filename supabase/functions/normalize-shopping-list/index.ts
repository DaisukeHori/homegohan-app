/**
 * normalize-shopping-list
 * 
 * 買い物リストの材料を正規化・マージするEdge Function
 * - 表記ゆれの吸収（鶏むね肉/鶏胸肉/とりむね → 鶏むね肉）
 * - 同一材料の数量合算（200g + 300g → 500g）
 * - 異なる単位は別バリエーションとして保持（タップ切り替え用）
 * - カテゴリ分類
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { createLogger, generateRequestId } from "../_shared/db-logger.ts";
import { withOpenAIUsageContext, generateExecutionId } from "../_shared/llm-usage.ts";

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

interface NormalizeOutput {
  items: NormalizedItem[];
  stats: {
    inputCount: number;
    outputCount: number;
    mergedCount: number;
  };
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
    },
    {
      "itemName": "鶏むね肉",
      "normalizedName": "鶏むね肉",
      "quantityVariants": [
        {"display": "400g", "unit": "g", "value": 400},
        {"display": "約2枚", "unit": "枚", "value": 2},
        {"display": "1パック", "unit": "パック", "value": 1}
      ],
      "category": "精肉"
    },
    {
      "itemName": "醤油",
      "normalizedName": "醤油",
      "quantityVariants": [
        {"display": "大さじ4", "unit": "大さじ", "value": 4},
        {"display": "約60ml", "unit": "ml", "value": 60}
      ],
      "category": "調味料"
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

async function callOpenAI(
  prompt: string,
  logger: ReturnType<typeof createLogger>
): Promise<NormalizedItem[]> {
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
      max_completion_tokens: 16000, // 200+アイテムのJSON出力に対応
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("OpenAI API error", new Error(errorText));
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Empty response from OpenAI");
  }

  try {
    const parsed = JSON.parse(content);
    return parsed.items || [];
  } catch (e) {
    logger.error("Failed to parse LLM response", e, { content });
    throw new Error("Failed to parse LLM response as JSON");
  }
}

// ============================================
// バリデーション: 入力に存在しない材料を除去
// ============================================

function validateItems(
  items: NormalizedItem[],
  inputNames: Set<string>,
  logger: ReturnType<typeof createLogger>
): NormalizedItem[] {
  // 正規化した入力名のセット（ひらがな化して比較）
  const normalizedInputNames = new Set<string>();
  inputNames.forEach((name) => {
    normalizedInputNames.add(name.toLowerCase());
    // ひらがな/カタカナの揺れも吸収
    normalizedInputNames.add(toHiragana(name.toLowerCase()));
  });

  return items.filter((item) => {
    const itemNameLower = item.itemName.toLowerCase();
    const normalizedLower = item.normalizedName.toLowerCase();
    const itemNameHira = toHiragana(itemNameLower);
    const normalizedHira = toHiragana(normalizedLower);

    // 入力のいずれかに部分一致すれば許可
    let matched = false;
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
        matched = true;
        break;
      }
    }

    if (!matched) {
      logger.warn("Rejected hallucinated item", {
        itemName: item.itemName,
        normalizedName: item.normalizedName,
      });
    }

    return matched;
  });
}

// カタカナをひらがなに変換
function toHiragana(str: string): string {
  return str.replace(/[\u30A1-\u30F6]/g, (match) =>
    String.fromCharCode(match.charCodeAt(0) - 0x60)
  );
}

// ============================================
// メインハンドラ
// ============================================

Deno.serve(async (req: Request) => {
  // CORS対応
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const requestId = generateRequestId();
  const executionId = generateExecutionId();
  const logger = createLogger("normalize-shopping-list", requestId);

  // Supabaseクライアント作成（トークン使用量記録用）
  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    const { ingredients } = (await req.json()) as {
      ingredients: InputIngredient[];
    };

    if (!ingredients || !Array.isArray(ingredients)) {
      return new Response(
        JSON.stringify({ error: "ingredients array is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (ingredients.length === 0) {
      return new Response(
        JSON.stringify({
          items: [],
          stats: { inputCount: 0, outputCount: 0, mergedCount: 0 },
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    logger.info("Starting normalization", { inputCount: ingredients.length });

    // 入力名のセットを作成（バリデーション用）
    const inputNames = new Set(ingredients.map((ing) => ing.name));

    // LLM呼び出し（トークン使用量計測付き）
    const rawItems = await withOpenAIUsageContext({
      functionName: "normalize-shopping-list",
      executionId,
      requestId,
      supabaseClient,
    }, async () => {
      const prompt = buildPrompt(ingredients);
      return await callOpenAI(prompt, logger);
    });

    // バリデーション: ハルシネーション除去
    const validatedItems = validateItems(rawItems, inputNames, logger);

    // 統計
    const stats = {
      inputCount: ingredients.length,
      outputCount: validatedItems.length,
      mergedCount: ingredients.length - validatedItems.length,
    };

    logger.info("Normalization completed", { stats });

    const output: NormalizeOutput = {
      items: validatedItems,
      stats,
    };

    return new Response(JSON.stringify(output), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    logger.error("Normalization failed", error);
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

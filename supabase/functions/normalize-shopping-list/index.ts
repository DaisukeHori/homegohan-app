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
import { corsHeaders } from "../_shared/cors.ts";
import { createLogger, generateRequestId } from "../_shared/db-logger.ts";

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
  return `あなたは買い物リストの最適化AIです。

以下の材料リストを整理してください：
${JSON.stringify(ingredients, null, 2)}

【タスク】
1. **表記ゆれの統一**: 同じ材料の異なる表記を統一
   - 例: 「鶏むね肉」「鶏胸肉」「とりむね」→「鶏むね肉」
   - 例: 「玉ねぎ」「たまねぎ」「玉葱」→「玉ねぎ」

2. **数量の整理**: 同じ材料の数量をまとめる
   - 同じ単位なら合算: 「200g」+「300g」→「500g」
   - **異なる単位は可能な限り換算して合算**し、quantityVariants は「同じ必要量の別表現」として保持
   - 換算が難しい場合は「約」や注記を付ける（例: "2枚(約500g)"）
   - 「適量」「少々」は無視して数値のある方を優先

3. **カテゴリ分類**: 野菜/肉/魚/乳製品/調味料/乾物/豆腐・大豆/卵/麺・米/その他

【出力形式】JSON
{
  "items": [
    {
      "itemName": "鶏むね肉",
      "normalizedName": "鶏むね肉",
      "quantityVariants": [
        {"display": "500g", "unit": "g", "value": 500},
        {"display": "2枚", "unit": "枚", "value": 2}
      ],
      "category": "肉"
    },
    {
      "itemName": "玉ねぎ",
      "normalizedName": "玉ねぎ",
      "quantityVariants": [
        {"display": "3個", "unit": "個", "value": 3}
      ],
      "category": "野菜"
    }
  ]
}

【重要ルール】
- quantityVariants は単位ごとに1エントリ（同単位は合算済み）
- 数値がない場合（「適量」等）は value: null、display: "適量"
- 入力にない材料を追加しない（ハルシネーション禁止）。入力材料はまとめるだけで、勝手に増やさない
- JSONのみ出力（説明文不要）`;
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
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 4000,
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
  const logger = createLogger("normalize-shopping-list", requestId);

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

    // LLM呼び出し
    const prompt = buildPrompt(ingredients);
    const rawItems = await callOpenAI(prompt, logger);

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

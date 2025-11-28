// filename: supabase/functions/knowledge-gpt/index.ts
// OpenAI Chat Completions API 互換のエンドポイント
// 内部で OpenAI Agents SDK（ナレッジ付き）を呼び出す

import {
  fileSearchTool,
  Agent,
  type AgentInputItem,
  Runner,
  withTrace,
} from "@openai/agents";
import { z } from "zod";
import { corsHeaders } from '../_shared/cors.ts'

console.log("Knowledge-GPT Function loaded")

// ===== Tool definitions (Vector Store) =====
const fileSearch = fileSearchTool([
  "vs_690c5840e4c48191bbe8798dc9f0a3a7",
]);

// ===== 出力スキーマ（献立用） =====
const KondateSchema = z.object({
  days: z.array(
    z.object({
      date: z.string(),
      meals: z.array(
        z.object({
          mealType: z.string(),
          dishes: z.array(
            z.object({
              name: z.string(),
              role: z.string(),
              cal: z.any(),
              protein: z.number(),
              description: z.string().optional(),
            }),
          ),
          totalCalories: z.any(),
          cookingTime: z.string(),
          ingredients: z.array(z.string()),
          recipeSteps: z.array(z.string()),
        }),
      ),
      dailyTotalCalories: z.any(),
      nutritionalAdvice: z.string(),
    }),
  ),
  weeklyAdvice: z.string(),
  shoppingList: z.array(
    z.object({
      category: z.string(),
      items: z.array(z.string()),
    }),
  ),
});

// ===== エージェント定義 =====
const kondateAgent = new Agent({
  name: "kondate",
  instructions: `あなたは「ほめゴハン」アプリ専属のAI管理栄養士です。
ユーザーの健康状態、目標、好み、制約に基づいて、完全にパーソナライズされた1週間分の献立を生成します。

# あなたの役割
- ユーザーを褒めながら、健康的で美味しい献立を提案
- 栄養バランスを考慮したメニュー設計
- 実際に作れる具体的なレシピを提供

# 生成ルール

## 必須要件
1. **必ず7日分**の献立を生成（days配列に7つのオブジェクト）
2. 各日に **朝食(breakfast)、昼食(lunch)、夕食(dinner)** を含める
3. 各食事に **主菜(main)** を必ず1つ含める
4. 各料理に **cal（カロリー）** と **protein（タンパク質）** を必ず付与
5. 各食事に **ingredients（材料）** と **recipeSteps（作り方）** を必ず含める

## 栄養目標（デフォルト）
- 1日のカロリー: 1800-2200kcal
- タンパク質: 60-80g
- 脂質: 50-70g
- 炭水化物: 250-300g

## 料理の役割（role）
- main: 主菜（メインディッシュ）
- side: 副菜
- soup: 汁物
- rice: ご飯、パン、麺類
- salad: サラダ
- dessert: デザート

## 材料リスト（ingredients）のフォーマット
- 「食材名 分量」の形式で記載
- 例: ["鶏むね肉 200g", "玉ねぎ 1/2個", "醤油 大さじ2"]

## 調理手順（recipeSteps）のフォーマット
- 番号付きで5-8ステップ程度

# 禁止事項
- アレルギー食材は**絶対に使用しない**
- 苦手な食材は**避ける**

# 出力形式
必ず指定されたJSONスキーマに従って出力してください。

献立サンプルはToolsの"Kondate"とレシピは"recipe"にいっぱい入ってます。
適宜確認してそれを踏まえて回答してください。`,
  model: "gpt-4.1-mini",
  tools: [fileSearch],
  outputType: KondateSchema,
  modelSettings: {
    reasoning: {
      effort: "low",
      summary: "auto",
    },
    store: true,
  },
});

// ===== OpenAI API互換のリクエスト/レスポンス型 =====

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  response_format?: { type: string };
}

interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: "stop" | "length" | "content_filter";
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ===== エージェント実行 =====
async function runAgent(userMessage: string): Promise<string> {
  return await withTrace("knowledge_gpt", async () => {
    const conversationHistory: AgentInputItem[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: userMessage }],
      },
    ];

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "knowledge-gpt",
        workflow_id: "wf_690c583127f48190bdc25d5f6070b40d04e6784c5b05232a",
      },
    });

    const result = await runner.run(kondateAgent, [...conversationHistory]);
    
    if (!result.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    return JSON.stringify(result.finalOutput);
  });
}

// ===== Edge Function HTTP ハンドラ =====
Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: { message: "Method not allowed", type: "invalid_request_error" } }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body: ChatCompletionRequest = await req.json().catch(() => ({ messages: [] }));

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return new Response(
        JSON.stringify({ error: { message: "messages is required", type: "invalid_request_error" } }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // messagesからユーザーの入力を抽出
    // systemメッセージ + userメッセージを結合
    const systemMessage = body.messages.find(m => m.role === "system")?.content || "";
    const userMessages = body.messages.filter(m => m.role === "user").map(m => m.content);
    
    const combinedInput = systemMessage 
      ? `${systemMessage}\n\n${userMessages.join("\n")}`
      : userMessages.join("\n");

    console.log("Knowledge-GPT received request, input length:", combinedInput.length);

    // エージェント実行
    const agentOutput = await runAgent(combinedInput);

    console.log("Knowledge-GPT agent completed");

    // OpenAI API互換のレスポンスを生成
    const response: ChatCompletionResponse = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "knowledge-gpt-1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: agentOutput,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,  // エージェントSDKでは取得不可
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: any) {
    console.error("knowledge-gpt error:", e);
    return new Response(
      JSON.stringify({
        error: {
          message: e?.message ?? String(e),
          type: "internal_error",
        },
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});


// filename: supabase/functions/knowledge-gpt/index.ts
// OpenAI Chat Completions API 互換のエンドポイント
// Agent SDK がDenoで動作しない場合のフォールバック版

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from '../_shared/cors.ts'
import { withOpenAIUsageContext, generateExecutionId } from "../_shared/llm-usage.ts";
import OpenAI from "openai";

console.log("Knowledge-GPT Function loaded (Fallback Mode)")

// ===== OpenAI client =====
function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });
}

// ===== テキスト埋め込み生成 =====
async function embedText(text: string, dimensions: number = 384): Promise<number[]> {
  const openai = getOpenAI();
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions,
  });
  return response.data[0].embedding;
}

// ===== レシピ検索結果の型 =====
interface RecipeSearchResult {
  id: string;
  externalId: string;
  name: string;
  nutrition: {
    calories: number;
    protein: number;
    fat: number;
    carbs: number;
    sodium: number;
    fiber: number;
  };
  ingredients: string;
  score: number;
}

// ===== レシピ検索実行関数 =====
async function executeRecipeSearch(
  supabase: SupabaseClient,
  query: string,
  maxResults: number = 5
): Promise<RecipeSearchResult[]> {
  console.log(`[search_recipes] Searching for: "${query}", maxResults: ${maxResults}`);

  // クエリの埋め込みを生成（384次元）
  const embedding = await embedText(query, 384);

  // ハイブリッド検索を実行
  const { data, error } = await supabase.rpc("search_recipes_hybrid", {
    query_text: query,
    query_embedding: embedding,
    match_count: maxResults,
    similarity_threshold: 0.15,
  });

  if (error) {
    console.error("[search_recipes] RPC error:", error);
    throw new Error(`レシピ検索に失敗しました: ${error.message}`);
  }

  console.log(`[search_recipes] Found ${data?.length || 0} recipes`);

  // 結果を整形
  return (data || []).map((r: any) => ({
    id: r.id,
    externalId: r.external_id,
    name: r.name,
    nutrition: {
      calories: r.calories_kcal || 0,
      protein: r.protein_g || 0,
      fat: r.fat_g || 0,
      carbs: r.carbs_g || 0,
      sodium: r.sodium_g || 0,
      fiber: r.fiber_g || 0,
    },
    ingredients: r.ingredients_text?.split('\n').slice(0, 5).join('、') || '',
    score: r.combined_score || 0,
  }));
}

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
  mode?: 'json' | 'chat';
  stream?: boolean;  // ストリーミングモード
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

// ===== Markdownコードブロックを除去するヘルパー =====
function stripMarkdownCodeBlock(text: string): string {
  let cleaned = text.trim();

  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1) {
      cleaned = cleaned.substring(firstNewline + 1);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }
  }

  return cleaned.trim();
}

// ===== Tool定義（Function Calling用） =====
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_recipes",
      description: `レシピデータベースから料理を検索します。
ユーザーが特定の料理を希望した場合（「肉じゃがにして」「カレーがいい」など）や、
献立の提案を求めた場合に使用してください。`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "検索する料理名またはキーワード（例：肉じゃが、鶏肉料理）",
          },
          maxResults: {
            type: "number",
            description: "取得する最大件数（デフォルト: 5）",
          },
        },
        required: ["query"],
      },
    },
  },
];

// ===== ツール実行 =====
async function executeTool(
  toolName: string,
  args: Record<string, any>,
  supabase: SupabaseClient
): Promise<string> {
  switch (toolName) {
    case "search_recipes": {
      const results = await executeRecipeSearch(
        supabase,
        args.query,
        Math.min(args.maxResults ?? 5, 10)
      );
      return JSON.stringify(results, null, 2);
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

// ===== チャット実行（直接OpenAI API使用） =====
async function runChat(
  messages: ChatMessage[],
  mode: string = 'json',
  supabase?: SupabaseClient
): Promise<string> {
  const openai = getOpenAI();

  // メッセージをOpenAI形式に変換
  const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // JSON モードの場合はシステムプロンプトに指示を追加
  if (mode === 'json' && openaiMessages[0]?.role === 'system') {
    openaiMessages[0].content += "\n\n【重要】回答は必ず純粋なJSONのみを出力してください。```json などのMarkdownコードブロックで囲まないでください。";
  }

  console.log("[runChat] Starting with", openaiMessages.length, "messages, mode:", mode);

  // ツールを使用可能にするかどうか（chatモードのみ）
  const useTools = mode === 'chat' && supabase;

  // 最初の呼び出し
  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: openaiMessages,
    ...(useTools ? { tools } : {}),
    max_completion_tokens: 4000,
    reasoning_effort: "low",  // 推論時間を短縮
  } as any);

  let result = response.choices[0];

  // ツール呼び出しがある場合は実行
  if (result.message.tool_calls && supabase) {
    console.log("[runChat] Tool calls detected:", result.message.tool_calls.length);

    // アシスタントメッセージを追加
    openaiMessages.push(result.message as any);

    // 各ツールを実行
    for (const toolCall of result.message.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`[runChat] Executing tool: ${toolCall.function.name}`, args);

      const toolResult = await executeTool(toolCall.function.name, args, supabase);

      openaiMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      } as any);
    }

    // 再度呼び出してツール結果を反映
    const followUpResponse = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: openaiMessages,
      max_completion_tokens: 4000,
      reasoning_effort: "low",  // 推論時間を短縮
    } as any);

    result = followUpResponse.choices[0];
  }

  const content = result.message.content || "";

  if (mode === 'json') {
    return stripMarkdownCodeBlock(content);
  }

  return content;
}

// ===== ストリーミングチャット実行 =====
async function* runChatStream(
  messages: ChatMessage[],
  mode: string = 'chat',
  supabase?: SupabaseClient
): AsyncGenerator<string, void, unknown> {
  const openai = getOpenAI();

  // メッセージをOpenAI形式に変換
  const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  console.log("[runChatStream] Starting stream with", openaiMessages.length, "messages");

  // ツールを使用可能にするかどうか（chatモードのみ）
  const useTools = mode === 'chat' && supabase;

  // ストリーミング呼び出し
  const stream = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: openaiMessages,
    ...(useTools ? { tools } : {}),
    max_completion_tokens: 4000,
    reasoning_effort: "low",
    stream: true,
  } as any) as unknown as AsyncIterable<any>;

  const toolCalls: any[] = [];

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;

    // テキストコンテンツがあれば出力
    if (delta?.content) {
      yield delta.content;
    }

    // ツール呼び出しの蓄積
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.index !== undefined) {
          if (!toolCalls[tc.index]) {
            toolCalls[tc.index] = { id: '', function: { name: '', arguments: '' } };
          }
          if (tc.id) toolCalls[tc.index].id = tc.id;
          if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name;
          if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  // ツール呼び出しがあった場合は実行して再度ストリーム
  if (toolCalls.length > 0 && supabase) {
    console.log("[runChatStream] Tool calls detected:", toolCalls.length);

    // アシスタントメッセージ（ツール呼び出し含む）を追加
    openaiMessages.push({
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    } as any);

    // 各ツールを実行
    for (const toolCall of toolCalls) {
      if (!toolCall.function.name) continue;
      const args = JSON.parse(toolCall.function.arguments || '{}');
      console.log(`[runChatStream] Executing tool: ${toolCall.function.name}`, args);

      const toolResult = await executeTool(toolCall.function.name, args, supabase);

      openaiMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      } as any);
    }

    // 再度ストリーミング呼び出し
    const followUpStream = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: openaiMessages,
      max_completion_tokens: 4000,
      reasoning_effort: "low",
      stream: true,
    } as any) as unknown as AsyncIterable<any>;

    for await (const chunk of followUpStream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
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

    // 認証（verify_jwt=false を補完）
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: { message: "Authorization header required", type: "invalid_request_error" } }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] ?? authHeader;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (token !== serviceRoleKey) {
      const supabaseAuth = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error" } }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const body: ChatCompletionRequest = await req.json().catch(() => ({ messages: [] }));

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return new Response(
        JSON.stringify({ error: { message: "messages is required", type: "invalid_request_error" } }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const mode = body.mode || 'json';
    const isStreaming = body.stream === true;

    console.log("Knowledge-GPT received request");
    console.log("Messages count:", body.messages.length);
    console.log("Mode:", mode, "Streaming:", isStreaming);

    // LLMトークン使用量計測
    const executionId = generateExecutionId();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // ストリーミングモード
    if (isStreaming) {
      const chatId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      // ReadableStreamを作成してSSEを返す
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          try {
            for await (const chunk of runChatStream(body.messages, mode, supabase)) {
              // OpenAI互換のSSE形式
              const data = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: "knowledge-gpt-1",
                choices: [{
                  index: 0,
                  delta: { content: chunk },
                  finish_reason: null,
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            }

            // 終了メッセージ
            const doneData = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model: "knowledge-gpt-1",
              choices: [{
                index: 0,
                delta: {},
                finish_reason: "stop",
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneData)}\n\n`));
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          } catch (e: any) {
            console.error("Streaming error:", e);
            const errorData = { error: { message: e?.message ?? String(e) } };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorData)}\n\n`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // 非ストリーミングモード（従来通り）
    const output = await withOpenAIUsageContext({
      functionName: "knowledge-gpt",
      executionId,
      supabaseClient: supabase,
    }, async () => {
      return await runChat(body.messages, mode, supabase);
    });

    console.log("Knowledge-GPT completed, output length:", output.length);

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
            content: output,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
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

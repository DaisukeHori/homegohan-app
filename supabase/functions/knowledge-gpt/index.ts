// filename: supabase/functions/knowledge-gpt/index.ts
// OpenAI Chat Completions API 互換のエンドポイント
// 内部で OpenAI Agents SDK（ナレッジ付き）を呼び出す
// プロンプトは呼び出し元から渡される（このFunction内には固定しない）
// mode: 'json' = JSON出力（献立生成用）, mode: 'chat' = 自然言語（AIアシスタント用）

import {
  fileSearchTool,
  Agent,
  type AgentInputItem,
  Runner,
  withTrace,
} from "@openai/agents";
import { corsHeaders } from '../_shared/cors.ts'

console.log("Knowledge-GPT Function loaded")

// ===== Tool definitions (Vector Store) =====
const fileSearch = fileSearchTool([
  "vs_690c5840e4c48191bbe8798dc9f0a3a7",
]);

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
  mode?: 'json' | 'chat'; // 追加: 出力モード
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
  // ```json ... ``` や ``` ... ``` を除去
  let cleaned = text.trim();
  
  // ```json または ``` で始まる場合
  if (cleaned.startsWith('```')) {
    // 最初の行を除去
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1) {
      cleaned = cleaned.substring(firstNewline + 1);
    }
    // 最後の ``` を除去
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }
  }
  
  return cleaned.trim();
}

// ===== エージェント実行 =====
async function runAgent(systemPrompt: string, userMessage: string, mode: string = 'json'): Promise<string> {
  return await withTrace("knowledge_gpt", async () => {
    // エージェントを動的に作成（システムプロンプトを呼び出し元から受け取る）
    let enhancedSystemPrompt = systemPrompt;
    
    // モードによって指示を追加
    if (mode === 'json') {
      // JSONモード: 献立生成など
      enhancedSystemPrompt = systemPrompt + "\n\n【重要】回答は必ず純粋なJSONのみを出力してください。```json などのMarkdownコードブロックで囲まないでください。説明文も不要です。JSONデータのみを返してください。";
    }
    // mode === 'chat' の場合は何も追加しない（自然言語での応答を期待）
    
    const agent = new Agent({
      name: "knowledge-gpt",
      instructions: enhancedSystemPrompt || "あなたは優秀なAIアシスタントです。ナレッジベースを参照して回答してください。",
      model: "gpt-4o-mini",
      tools: [fileSearch],
    });

    const conversationHistory: AgentInputItem[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: userMessage }],
      },
    ];

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "knowledge-gpt",
        workflow_id: "wf_knowledge_gpt_compatible",
      },
    });

    const result = await runner.run(agent, [...conversationHistory]);
    
    let outputText = "";
    
    if (!result.finalOutput) {
      // finalOutputがない場合、最後のアシスタントメッセージを探す
      const lastAssistantItem = result.newItems.find(item => 
        item.rawItem.role === 'assistant' && 
        item.rawItem.content
      );
      
      if (lastAssistantItem && Array.isArray(lastAssistantItem.rawItem.content)) {
        const textContent = lastAssistantItem.rawItem.content.find(
          (c: any) => c.type === 'output_text' || c.type === 'text'
        );
        if (textContent && textContent.text) {
          outputText = textContent.text;
        } else {
          throw new Error("Agent result is undefined");
        }
      } else {
        throw new Error("Agent result is undefined");
      }
    } else if (typeof result.finalOutput === 'object') {
      // finalOutputがオブジェクトならJSON文字列に変換
      return JSON.stringify(result.finalOutput);
    } else {
      outputText = String(result.finalOutput);
    }
    
    // JSONモードの場合のみMarkdownコードブロックを除去
    if (mode === 'json') {
      return stripMarkdownCodeBlock(outputText);
    }
    
    return outputText;
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

    // messagesからsystemメッセージとuserメッセージを分離
    const systemMessage = body.messages.find(m => m.role === "system")?.content || "";
    const userMessages = body.messages.filter(m => m.role === "user").map(m => m.content);
    const userMessage = userMessages.join("\n\n");
    
    // モードを取得（デフォルト: json）
    const mode = body.mode || 'json';

    console.log("Knowledge-GPT received request");
    console.log("System prompt length:", systemMessage.length);
    console.log("User message length:", userMessage.length);
    console.log("Mode:", mode);

    // エージェント実行（システムプロンプトとユーザーメッセージを渡す）
    const agentOutput = await runAgent(systemMessage, userMessage, mode);

    console.log("Knowledge-GPT agent completed, output length:", agentOutput.length);

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

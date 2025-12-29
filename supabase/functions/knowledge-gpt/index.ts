// filename: supabase/functions/knowledge-gpt/index.ts
// OpenAI Chat Completions API 互換のエンドポイント
// 内部で OpenAI Agents SDK（ナレッジ付き）を呼び出す

import { createClient } from "jsr:@supabase/supabase-js@2";
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
  mode?: 'json' | 'chat';
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

// ===== エージェント実行 =====
async function runAgent(systemPrompt: string, userMessage: string, mode: string = 'json'): Promise<string> {
  return await withTrace("knowledge_gpt", async () => {
    let enhancedSystemPrompt = systemPrompt;
    
    if (mode === 'json') {
      enhancedSystemPrompt = systemPrompt + "\n\n【重要】回答は必ず純粋なJSONのみを出力してください。```json などのMarkdownコードブロックで囲まないでください。説明文も不要です。JSONデータのみを返してください。";
    }
    
    const agent = new Agent({
      name: "knowledge-gpt",
      instructions: enhancedSystemPrompt || "あなたは優秀なAIアシスタントです。ナレッジベースを参照して回答してください。",
      model: "gpt-5-mini",
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
      return JSON.stringify(result.finalOutput);
    } else {
      outputText = String(result.finalOutput);
    }
    
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

    const systemMessage = body.messages.find(m => m.role === "system")?.content || "";
    const userMessages = body.messages.filter(m => m.role === "user").map(m => m.content);
    const userMessage = userMessages.join("\n\n");
    const mode = body.mode || 'json';

    console.log("Knowledge-GPT received request");
    console.log("System prompt length:", systemMessage.length);
    console.log("User message length:", userMessage.length);
    console.log("Mode:", mode);

    const agentOutput = await runAgent(systemMessage, userMessage, mode);

    console.log("Knowledge-GPT completed, output length:", agentOutput.length);

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

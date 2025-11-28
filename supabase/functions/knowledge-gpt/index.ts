// filename: supabase/functions/knowledge-gpt/index.ts
// OpenAI Chat Completions API 互換のエンドポイント（ストリーミング対応）
// 内部で OpenAI Agents SDK（ナレッジ付き）を呼び出す
// プロンプトは呼び出し元から渡される（このFunction内には固定しない）
// mode: 'json' = JSON出力（献立生成用）, mode: 'chat' = 自然言語（AIアシスタント用）
// stream: true = ストリーミングレスポンス

import {
  fileSearchTool,
  Agent,
  type AgentInputItem,
  Runner,
  withTrace,
} from "@openai/agents";
import { corsHeaders } from '../_shared/cors.ts'

console.log("Knowledge-GPT Function loaded (Streaming Support)")

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
  stream?: boolean;
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

// ===== エージェント実行（非ストリーミング） =====
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

// ===== ストリーミングエージェント実行 =====
async function* runAgentStreaming(systemPrompt: string, userMessage: string, mode: string = 'json'): AsyncGenerator<string, void, unknown> {
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
      __trace_source__: "knowledge-gpt-stream",
      workflow_id: "wf_knowledge_gpt_stream",
    },
  });

  // ストリーミング実行
  const stream = runner.runStreamed(agent, [...conversationHistory]);
  
  let fullContent = "";
  
  for await (const event of stream) {
    // raw_model_stream_event からテキストチャンクを取得
    if (event.type === 'raw_model_stream_event') {
      const data = event.data as any;
      if (data?.type === 'content_block_delta' && data?.delta?.text) {
        fullContent += data.delta.text;
        yield data.delta.text;
      } else if (data?.type === 'response.output_text.delta' && data?.delta) {
        fullContent += data.delta;
        yield data.delta;
      }
    }
  }
  
  // 何も出力されなかった場合、最終結果を取得して一括で返す
  if (!fullContent && stream.finalOutput) {
    const output = typeof stream.finalOutput === 'object' 
      ? JSON.stringify(stream.finalOutput) 
      : String(stream.finalOutput);
    yield mode === 'json' ? stripMarkdownCodeBlock(output) : output;
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
    const stream = body.stream || false;

    console.log("Knowledge-GPT received request");
    console.log("System prompt length:", systemMessage.length);
    console.log("User message length:", userMessage.length);
    console.log("Mode:", mode, "Stream:", stream);

    // ストリーミングモード
    if (stream) {
      const encoder = new TextEncoder();
      const responseId = `chatcmpl-${crypto.randomUUID()}`;
      
      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            const generator = runAgentStreaming(systemMessage, userMessage, mode);
            
            for await (const chunk of generator) {
              // OpenAI SSE形式でチャンクを送信
              const sseData = {
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "knowledge-gpt-1",
                choices: [{
                  index: 0,
                  delta: { content: chunk },
                  finish_reason: null,
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseData)}\n\n`));
            }
            
            // 終了メッセージ
            const endData = {
              id: responseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "knowledge-gpt-1",
              choices: [{
                index: 0,
                delta: {},
                finish_reason: "stop",
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(endData)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (error: any) {
            console.error("Streaming error:", error);
            const errorData = { error: { message: error.message, type: "internal_error" } };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorData)}\n\n`));
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
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
    const agentOutput = await runAgent(systemMessage, userMessage, mode);

    console.log("Knowledge-GPT agent completed, output length:", agentOutput.length);

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

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }
  return new OpenAI({ apiKey });
}

function stripMarkdownCodeBlock(text: string): string {
  let cleaned = text.trim();

  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1) {
      cleaned = cleaned.substring(firstNewline + 1);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3).trim();
    }
  }

  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const jsonStart = cleaned.search(/[\{\[]/);
    if (jsonStart > 0) {
      cleaned = cleaned.substring(jsonStart);
    }
  }

  const lastBrace = cleaned.lastIndexOf('}');
  const lastBracket = cleaned.lastIndexOf(']');
  const jsonEnd = Math.max(lastBrace, lastBracket);
  if (jsonEnd > 0 && jsonEnd < cleaned.length - 1) {
    cleaned = cleaned.substring(0, jsonEnd + 1);
  }

  return cleaned.trim();
}

function safeJsonParse(text: string): any {
  let cleaned = stripMarkdownCodeBlock(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (char) => {
      if (char === '\n' || char === '\r' || char === '\t') return char;
      return '';
    });
    return JSON.parse(cleaned);
  }
}

function buildExistingSummary(session: any): any | null {
  if (!session || typeof session !== 'object') return null;
  if (!session.summary) return null;

  const cs = session.context_snapshot && typeof session.context_snapshot === 'object' ? session.context_snapshot : {};
  const keyFacts = Array.isArray((cs as any).key_facts) ? (cs as any).key_facts : [];
  const userInsights = Array.isArray((cs as any).user_insights) ? (cs as any).user_insights : [];
  const keyTopics = Array.isArray(session.key_topics) ? session.key_topics : [];
  const actionsTaken = Array.isArray(session.action_history)
    ? session.action_history
        .map((x: any) => (typeof x === 'string' ? x : x?.action))
        .filter((x: any) => typeof x === 'string')
    : [];

  return {
    title: session.title ?? null,
    summary: session.summary ?? null,
    key_facts: keyFacts,
    key_topics: keyTopics,
    actions_taken: actionsTaken,
    user_insights: userInsights,
  };
}

// セッション要約を生成
export async function POST(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let existingSummary: any | null = null;

  try {
    // セッション所有者確認
    const { data: session } = await supabase
      .from('ai_consultation_sessions')
      .select('*')
      .eq('id', params.sessionId)
      .single();

    if (!session || session.user_id !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    existingSummary = buildExistingSummary(session);

    // セッションの全メッセージを取得
    const { data: messages } = await supabase
      .from('ai_consultation_messages')
      .select('role, content, created_at, is_important')
      .eq('session_id', params.sessionId)
      .order('created_at', { ascending: true });

    if (!messages || messages.length === 0) {
      // UI側で「失敗」扱いにしないため、2xxで返す
      return NextResponse.json({ success: true, summary: existingSummary }, { status: 200 });
    }

    // 重要マークされたメッセージを抽出
    const importantMessages = messages.filter((m: any) => m.is_important);

    // 会話内容を整形
    const conversationText = messages
      .filter((m: any) => m.role !== 'system')
      .map((m: any) => `[${m.role === 'user' ? 'ユーザー' : 'AI'}] ${m.content}`)
      .join('\n\n');

    // AIに要約を依頼
    const summaryPrompt = `以下の会話を要約してください。

【要約ルール】
1. 固有名詞（人名、店名、商品名、料理名など）は必ず保持
2. 数値・定量的な情報（体重、カロリー、日数、金額など）は日付とともに箇条書きで記載
3. 決定事項・約束事項は明確に記載
4. 実行されたアクション（献立作成、目標設定など）を記載
5. ユーザーの好み・傾向で新たに判明したことを記載
6. その他の内容は簡潔に要約

【出力形式】
以下のJSON形式で出力してください：
{
  "title": "セッションの簡潔なタイトル（15文字以内）",
  "summary": "会話の概要（200文字以内）",
  "key_facts": [
    {
      "date": "YYYY-MM-DD または null",
      "category": "体重|カロリー|目標|決定事項|好み|その他",
      "content": "具体的な内容"
    }
  ],
  "key_topics": ["トピック1", "トピック2"],
  "actions_taken": ["実行されたアクション1", "アクション2"],
  "user_insights": ["ユーザーについて新たに分かったこと"]
}

【会話内容】
${conversationText}

${importantMessages.length > 0 ? `
【ユーザーが重要とマークしたメッセージ】
${importantMessages.map((m: any) => `- ${m.content.substring(0, 200)}`).join('\n')}
` : ''}`;

    const openai = getOpenAI();
    const MAX_ATTEMPTS = 3;
    let summaryData: any | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const retryNote =
          attempt === 1
            ? ''
            : '\n\n【再生成指示】前回の出力がJSONとして解析できませんでした。必ずパース可能な純粋なJSONのみを返してください。';

        const completion = await openai.chat.completions.create({
          model: 'gpt-5-mini',
          messages: [
            { role: 'system', content: 'あなたは会話を正確に要約するアシスタントです。JSONのみを出力してください。' },
            { role: 'user', content: summaryPrompt + retryNote },
          ],
          temperature: 0.3,
          max_tokens: 1500,
          response_format: { type: 'json_object' },
        });

        const summaryContent = completion.choices[0]?.message?.content;
        if (!summaryContent) throw new Error('要約の生成に失敗しました');

        const parsed = safeJsonParse(summaryContent);
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as any).summary !== 'string') {
          throw new Error('Invalid summary JSON');
        }

        summaryData = parsed;
        break;
      } catch (e) {
        console.error(`Summary generation attempt ${attempt} failed:`, e);
      }
    }

    if (!summaryData) {
      // 生成に失敗してもUI側で「失敗」扱いにしない
      return NextResponse.json({ success: true, summary: existingSummary }, { status: 200 });
    }

    // セッションを更新
    const { error: updateError } = await supabase
      .from('ai_consultation_sessions')
      .update({
        title: typeof summaryData.title === 'string' ? summaryData.title : session.title,
        summary: summaryData.summary,
        key_topics: Array.isArray(summaryData.key_topics) ? summaryData.key_topics : [],
        action_history: [
          ...(session.action_history || []),
          ...(Array.isArray(summaryData.actions_taken) ? summaryData.actions_taken : []).map((action: string) => ({
            action,
            date: new Date().toISOString(),
          })),
        ],
        summary_generated_at: new Date().toISOString(),
        // key_factsはsummaryに含めて保存（後で参照しやすいように）
        context_snapshot: {
          ...session.context_snapshot,
          key_facts: Array.isArray(summaryData.key_facts) ? summaryData.key_facts : [],
          user_insights: Array.isArray(summaryData.user_insights) ? summaryData.user_insights : [],
        },
      })
      .eq('id', params.sessionId);

    if (updateError) {
      // 保存に失敗しても、生成結果は返す（ユーザー体験を優先）
      console.error('Summary session update failed:', updateError);
    }

    return NextResponse.json({
      success: true,
      summary: summaryData,
    });

  } catch (error: any) {
    console.error('Summary generation error:', error);
    // UI側で「失敗」扱いにしない
    return NextResponse.json({ success: true, summary: existingSummary }, { status: 200 });
  }
}


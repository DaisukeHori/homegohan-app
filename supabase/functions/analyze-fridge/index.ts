import { corsHeaders } from '../_shared/cors.ts';
import { createFastLLMClient, getFastLLMModel } from '../_shared/fast-llm.ts';
import { requireAuth } from '../_shared/auth.ts';
import { createLogger, generateRequestId } from '../_shared/db-logger.ts';

const openai = createFastLLMClient();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // JWT 認証
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) {
    return new Response(authResult.body, {
      status: authResult.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const { userId } = authResult;

  const requestId = generateRequestId();
  const logger = createLogger('analyze-fridge', requestId).withUser(userId);

  try {
    const { imageUrl } = await req.json();

    if (!imageUrl) {
      return new Response(JSON.stringify({ error: 'Image URL is required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    logger.info('Analyzing fridge image', { imageUrl: imageUrl.slice(0, 80) });

    // Vision API
    const response = await openai.chat.completions.create({
      model: getFastLLMModel(),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `この画像（冷蔵庫の中身や食材）に写っている食材をリストアップしてください。
                     また、見た目から判断して「使いかけ」や「鮮度が落ちていそう」なものがあれば、それを優先消費候補 (expiringSoon) としてマークしてください。
                     結果は以下のJSON形式のみで出力してください。余計な説明は不要です。

                     {
                       "ingredients": ["キャベツ", "卵", "牛乳"],
                       "expiringSoon": ["キャベツ (使いかけ)", "牛乳"]
                     }`,
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
      max_tokens: 500,
      response_format: { type: 'json_object' },
    } as any);

    const result = JSON.parse(response.choices[0].message.content || '{}');
    logger.info('Fridge analysis complete', { ingredientCount: result.ingredients?.length ?? 0 });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error: any) {
    logger.error('Error analyzing fridge', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});

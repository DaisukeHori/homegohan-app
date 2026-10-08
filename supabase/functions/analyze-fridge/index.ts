import { corsHeaders } from '../_shared/cors.ts';
import { createFastLLMClient, getFastLLMModel } from '../_shared/fast-llm.ts';
import { requireAuth } from '../_shared/auth.ts';
import { createLogger, generateRequestId } from '../_shared/db-logger.ts';
import { validateAnalyzeFridgeRequest } from './validate-request.ts';

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
    // 本文が JSON として読めないのは呼び出し側の誤りなので、500 ではなく 400 で返す
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      logger.warn('Invalid analyze-fridge request', { reason: 'invalid_json' });
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // imageUrl はそのまま外部の Vision API に渡るため、型・長さ・https の URL かどうかを先に確かめる (#1227)
    const validation = validateAnalyzeFridgeRequest(body);
    if (!validation.ok) {
      logger.warn('Invalid analyze-fridge request', { reason: validation.reason, ...validation.meta });
      return new Response(JSON.stringify({ error: validation.message }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }
    const { imageUrl, host } = validation;

    // 署名付き URL の token がログに残らないよう、URL 全体ではなくホストと長さだけ記録する
    logger.info('Analyzing fridge image', { imageHost: host, imageUrlLength: imageUrl.length });

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
    // 上流 API のエラー文などの内部情報はクライアントに返さない (詳細は上のログで追える)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});

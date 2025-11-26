import { serve } from 'https://deno.land/std@0.178.0/http/server.ts';
import OpenAI from 'npm:openai';
import { corsHeaders } from '../_shared/cors.ts';

const openai = new OpenAI({
  apiKey: Deno.env.get('OPENAI_API_KEY'),
});

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { imageUrl } = await req.json();

    if (!imageUrl) {
      return new Response(JSON.stringify({ error: 'Image URL is required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // OpenAI Vision API
    const response = await openai.chat.completions.create({
      model: 'gpt-4o', // Vision対応モデル
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
                     }` 
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
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    console.error('Error analyzing fridge:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});



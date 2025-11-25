import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

export async function POST(request: Request) {
  const supabase = createClient(cookies());

  try {
    const { prompt } = await request.json();

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Google Generative AI (Nano Banana / Gemini) API 呼び出し
    const API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;
    
    if (!API_KEY) {
      return NextResponse.json({ error: 'Google AI API Key is missing' }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(API_KEY);
    
    // 環境変数でモデルを切り替え可能
    // 注意: 無料プランでは画像生成モデルのクォータが0の場合があります
    // 有料プランが必要な場合: gemini-2.5-flash-preview-image または gemini-3-pro-image-preview
    // 無料で利用可能なモデル: gemini-2.0-flash-exp (テキスト生成のみ、画像生成は未対応)
    // 画像生成には有料プランが必要です
    const modelName = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-preview-image';
    
    // プロンプトの構築（料理写真用に最適化）
    const enhancedPrompt = `A delicious, appetizing, professional food photography shot of ${prompt}. Natural lighting, high resolution, minimalist plating, Japanese cuisine style.`;

    let imageBase64 = '';

    try {
      // Gemini REST APIを直接呼び出し（画像生成モデル用）
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: enhancedPrompt
            }]
          }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: {
              aspectRatio: '1:1'
            }
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Gemini API Error:", errorText);
        
        // 429エラー（クォータ超過）の場合は、より詳細なエラーメッセージを返す
        if (response.status === 429) {
          let errorMessage = '画像生成のクォータが超過しました。';
          try {
            const errorData = JSON.parse(errorText);
            if (errorData.error?.message) {
              errorMessage = errorData.error.message;
              // リトライ可能な時間がある場合は追加情報を提供
              if (errorData.error?.details) {
                const retryInfo = errorData.error.details.find((d: any) => d.retryDelay);
                if (retryInfo) {
                  errorMessage += ` しばらく待ってから再度お試しください。`;
                }
              }
            }
          } catch (e) {
            // JSON解析に失敗した場合はデフォルトメッセージを使用
          }
          return NextResponse.json({ 
            error: errorMessage,
            code: 'QUOTA_EXCEEDED',
            suggestion: 'Google AI Studioでプランとクォータを確認してください: https://ai.dev/usage'
          }, { status: 429 });
        }
        
        throw new Error(`Gemini API returned ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      
      // レスポンスから画像データを抽出
      const parts = data.candidates?.[0]?.content?.parts || [];
      
      for (const part of parts) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
          imageBase64 = part.inlineData.data;
          break;
        }
      }

      if (!imageBase64) {
        console.error("Response structure:", JSON.stringify(data, null, 2));
        throw new Error('No image data in response. The model may not support image generation.');
      }

    } catch (genError: any) {
      console.error("Gemini Generation Error:", genError);
      throw new Error(`Failed to generate image: ${genError.message || 'Unknown error'}`);
    }

    const buffer = Buffer.from(imageBase64, 'base64');

    // 3. Supabase Storage へアップロード
    const fileName = `generated/${user.id}/${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage
      .from('fridge-images')
      .upload(fileName, buffer, {
        contentType: 'image/png',
        upsert: true
      });

    if (uploadError) throw uploadError;

    // 4. 公開URLの取得
    const { data: { publicUrl } } = supabase.storage
      .from('fridge-images')
      .getPublicUrl(fileName);

    return NextResponse.json({ imageUrl: publicUrl });

  } catch (error: any) {
    console.error("Image Gen Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

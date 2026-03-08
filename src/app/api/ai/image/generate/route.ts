import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { GoogleGenAI, createUserContent } from '@google/genai';

interface ReferenceImageInput {
  base64: string;
  mimeType?: string;
}

const DEFAULT_IMAGE_GENERATION_MODEL = 'gemini-3.1-flash-image-preview';

function normalizeReferenceImages(raw: unknown): ReferenceImageInput[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map<ReferenceImageInput | null>((item) => {
      const image = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
      const base64 = typeof image.base64 === 'string' && image.base64.trim() ? image.base64.trim() : null;
      if (!base64) return null;

      return {
        base64: base64.replace(/^data:image\/\w+;base64,/, ''),
        mimeType: typeof image.mimeType === 'string' && image.mimeType.trim() ? image.mimeType.trim() : 'image/png',
      };
    })
    .filter((image): image is ReferenceImageInput => image !== null);
}

function getQuotaErrorMessage(rawError: string): string {
  try {
    const parsed = JSON.parse(rawError);
    if (parsed.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // ignore JSON parse failure
  }

  return '画像生成のクォータが超過しました。しばらく待ってから再度お試しください。';
}

export async function POST(request: Request) {
  const supabase = createClient(cookies());

  try {
    const { prompt, images } = await request.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Google AI API Key is missing' }, { status: 500 });
    }

    const modelName = process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_GENERATION_MODEL;
    const ai = new GoogleGenAI({ apiKey });

    const enhancedPrompt = `Create a delicious, appetizing, professional food photography shot of ${prompt}. Natural lighting, high resolution, minimalist plating, Japanese cuisine style.`;
    const referenceImages = normalizeReferenceImages(images);

    let imageBase64 = '';
    let textResponse = '';

    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: createUserContent([
          enhancedPrompt,
          ...referenceImages.map((image) => ({
            inlineData: {
              mimeType: image.mimeType || 'image/png',
              data: image.base64,
            },
          })),
        ]),
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: '1:1',
          },
        },
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          textResponse += part.text;
        }
        if (part.inlineData?.mimeType?.startsWith('image/') && part.inlineData.data) {
          imageBase64 = part.inlineData.data;
          break;
        }
      }

      if (!imageBase64) {
        throw new Error('No image data in response. The model may not support image generation.');
      }
    } catch (genError: any) {
      console.error('Gemini Generation Error:', genError);

      const status = genError?.status || genError?.code;
      const rawMessage = typeof genError?.message === 'string' ? genError.message : '';
      if (status === 429 || rawMessage.includes('429')) {
        return NextResponse.json({
          error: getQuotaErrorMessage(rawMessage),
          code: 'QUOTA_EXCEEDED',
          suggestion: 'Google AI Studioで Nano Banana 2 のクォータを確認してください: https://ai.google.dev/gemini-api/docs/image-generation',
        }, { status: 429 });
      }

      throw new Error(`Failed to generate image: ${rawMessage || 'Unknown error'}`);
    }

    const buffer = Buffer.from(imageBase64, 'base64');
    const bucketName = 'fridge-images';
    const fileName = `generated/${user.id}/${Date.now()}.png`;

    const { error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(fileName, buffer, {
        contentType: 'image/png',
        upsert: true,
        cacheControl: '3600',
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);

      const errorMessage = uploadError.message || String(uploadError);
      const errorStatus = (uploadError as any).statusCode || (uploadError as any).status;

      if (
        errorMessage.includes('Bucket not found') ||
        errorMessage.includes('not found') ||
        errorMessage.includes('does not exist') ||
        errorStatus === 404
      ) {
        return NextResponse.json({
          error: `Storage bucket '${bucketName}' not found.`,
          code: 'BUCKET_NOT_FOUND',
          details: errorMessage,
          suggestion: `1. Go to Supabase Dashboard → Storage\n2. Verify bucket '${bucketName}' exists and is Public\n3. Check bucket name spelling (case-sensitive)`,
        }, { status: 404 });
      }

      if (
        errorMessage.includes('permission') ||
        errorMessage.includes('policy') ||
        errorMessage.includes('RLS') ||
        errorMessage.includes('new row violates') ||
        errorStatus === 403
      ) {
        return NextResponse.json({
          error: `Permission denied for Storage bucket '${bucketName}'.`,
          code: 'PERMISSION_DENIED',
          details: errorMessage,
          suggestion: `Set up Storage RLS policies:\n1. Go to Supabase Dashboard → Storage → ${bucketName}\n2. Click "Policies" tab\n3. Create policy:\n   - Policy name: "Allow authenticated users to upload"\n   - Allowed operation: INSERT\n   - Target roles: authenticated\n   - USING expression: auth.role() = 'authenticated'\n   - WITH CHECK expression: auth.role() = 'authenticated'`,
        }, { status: 403 });
      }

      return NextResponse.json({
        error: `Failed to upload image: ${errorMessage}`,
        code: 'UPLOAD_ERROR',
        details: errorMessage,
      }, { status: 500 });
    }

    const { data: { publicUrl } } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return NextResponse.json({
      imageUrl: publicUrl,
      modelUsed: modelName,
      referenceImageCount: referenceImages.length,
      text: textResponse.trim(),
    });
  } catch (error: any) {
    console.error('Image Gen Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

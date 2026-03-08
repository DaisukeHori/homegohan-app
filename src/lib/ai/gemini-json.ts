import { DEFAULT_GEMINI_VISION_MODEL } from './image-recognition';

export interface GeminiImageInput {
  base64: string;
  mimeType?: string;
}

interface GenerateGeminiJsonOptions {
  prompt: string;
  schema: Record<string, unknown>;
  images?: GeminiImageInput[];
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
}

export function getGoogleAiApiKey(): string {
  const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;
  if (!apiKey) {
    throw new Error('Google AI API key is not configured');
  }
  return apiKey;
}

export async function fetchImageAsBase64(imageUrl: string): Promise<GeminiImageInput> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error('Failed to fetch image');
  }

  const buffer = await response.arrayBuffer();

  return {
    base64: Buffer.from(buffer).toString('base64'),
    mimeType: response.headers.get('content-type') || 'image/jpeg',
  };
}

export async function generateGeminiJson<T>({
  prompt,
  schema,
  images = [],
  temperature = 0.1,
  maxOutputTokens = 2048,
  model = process.env.GEMINI_VISION_MODEL || DEFAULT_GEMINI_VISION_MODEL,
}: GenerateGeminiJsonOptions): Promise<{ data: T; model: string; rawText: string }> {
  const apiKey = getGoogleAiApiKey();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          ...images.map((image) => ({
            inlineData: {
              mimeType: image.mimeType || 'image/jpeg',
              data: image.base64.replace(/^data:image\/\w+;base64,/, ''),
            },
          })),
        ],
      }],
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${errorText}`);
  }

  const payload = await response.json();
  const rawText = payload.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || '')
    .join('')
    .trim();

  if (!rawText) {
    throw new Error('Gemini API returned no JSON content');
  }

  return {
    data: JSON.parse(rawText) as T,
    model,
    rawText,
  };
}

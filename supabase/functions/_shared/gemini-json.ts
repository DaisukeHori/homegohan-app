export interface GeminiImageInput {
  base64: string
  mimeType?: string
}

interface GenerateGeminiJsonOptions {
  prompt: string
  schema: Record<string, unknown>
  images?: GeminiImageInput[]
  temperature?: number
  maxOutputTokens?: number
  model?: string
}

export const DEFAULT_GEMINI_VISION_MODEL = 'gemini-3-pro-preview'

export async function generateGeminiJson<T>({
  prompt,
  schema,
  images = [],
  temperature = 0.1,
  maxOutputTokens = 2048,
  model = Deno.env.get('GEMINI_VISION_MODEL') || DEFAULT_GEMINI_VISION_MODEL,
}: GenerateGeminiJsonOptions): Promise<{ data: T; model: string; rawText: string }> {
  const apiKey = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY') || Deno.env.get('GOOGLE_GEN_AI_API_KEY')
  if (!apiKey) {
    throw new Error('Google AI API Key is missing')
  }

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
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini API error: ${errorText}`)
  }

  const payload = await response.json()
  const rawText = payload.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || '')
    .join('')
    .trim()

  if (!rawText) {
    throw new Error('Gemini API returned no JSON content')
  }

  return {
    data: JSON.parse(rawText) as T,
    model,
    rawText,
  }
}

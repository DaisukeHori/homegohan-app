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
  retryOnParseFailure?: boolean;
  signal?: AbortSignal;
}

const STRICT_JSON_INSTRUCTIONS = [
  '出力は厳密なJSONのみを返してください。',
  'Markdownのコードブロックや説明文は返さないでください。',
  'キーは必ずダブルクォートで囲んでください。',
  'JSONは1つのオブジェクトまたは配列のみを返してください。',
].join('\n');

function stripJsonCodeFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonBlock(text: string): string | null {
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1).trim();
  }

  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    return text.slice(arrayStart, arrayEnd + 1).trim();
  }

  return null;
}

function repairCommonJsonIssues(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([}\]"0-9eE.\-])(\s*)("([^"\\]|\\.)*"\s*:)/g, '$1,$2$3')
    .replace(/\n/g, ' ')
    .trim();
}

function parseGeminiJsonText<T>(rawText: string): T {
  const attempts = new Set<string>();
  const candidates = [
    rawText.trim(),
    stripJsonCodeFence(rawText),
    extractJsonBlock(stripJsonCodeFence(rawText)) ?? '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (attempts.has(candidate)) continue;
    attempts.add(candidate);

    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Fall through to repaired attempt.
    }

    const repaired = repairCommonJsonIssues(candidate);
    if (!repaired || attempts.has(repaired)) continue;
    attempts.add(repaired);

    try {
      return JSON.parse(repaired) as T;
    } catch {
      // Keep trying candidates.
    }
  }

  const preview = rawText.slice(0, 240);
  const error = new Error(`Gemini API returned invalid JSON: ${preview}`) as Error & { rawText?: string };
  error.rawText = rawText;
  throw error;
}

async function requestGeminiRawText({
  prompt,
  schema,
  images = [],
  temperature,
  maxOutputTokens,
  model,
  signal,
}: {
  prompt: string;
  schema: Record<string, unknown>;
  images: GeminiImageInput[];
  temperature: number;
  maxOutputTokens: number;
  model: string;
  signal?: AbortSignal;
}): Promise<string> {
  const apiKey = getGoogleAiApiKey();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    signal,
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: `${prompt}\n\n${STRICT_JSON_INSTRUCTIONS}` },
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

  return rawText;
}

export function getGoogleAiApiKey(): string {
  const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_GEN_AI_API_KEY;
  if (!apiKey) {
    throw new Error('Google AI API key is not configured');
  }
  return apiKey;
}

// #272 SSRF対策: 許可するホスト名のリスト
// 環境変数 NEXT_PUBLIC_SUPABASE_URL からプロジェクト固有ホストを動的に取得し、静的フォールバックと結合する
function getAllowedImageHosts(): string[] {
  const hosts: string[] = [];

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) {
    try {
      const { hostname } = new URL(supabaseUrl);
      if (hostname) hosts.push(hostname);
    } catch {
      // 不正な URL は無視
    }
  }

  // 静的フォールバック（上で取得できなかった場合のみ使用）
  if (!hosts.includes('flmeolcfutuwwbjmzyoz.supabase.co')) {
    hosts.push('flmeolcfutuwwbjmzyoz.supabase.co');
  }

  return hosts;
}

// プライベートIPレンジおよびlink-localを拒否する
function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') return true;
  const privatePatterns = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^0\./,
    /^240\./,
  ];
  return privatePatterns.some((p) => p.test(hostname));
}

export async function fetchImageAsBase64(imageUrl: string): Promise<GeminiImageInput> {
  // #272 SSRF対策: URLパースしてホスト名を検証
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    throw new Error('Invalid image URL');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Image URL must use HTTPS');
  }

  if (isPrivateHost(parsedUrl.hostname)) {
    throw new Error('Image URL points to a private/internal host');
  }

  const allowedHosts = getAllowedImageHosts();
  if (!allowedHosts.includes(parsedUrl.hostname)) {
    throw new Error(`Image host not allowed: ${parsedUrl.hostname}`);
  }

  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
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
  retryOnParseFailure = true,
  signal,
}: GenerateGeminiJsonOptions): Promise<{ data: T; model: string; rawText: string }> {
  const effectiveOptions = {
    prompt,
    schema,
    images,
    temperature,
    maxOutputTokens,
    model,
    signal,
  };

  const rawText = await requestGeminiRawText(effectiveOptions);

  try {
    return {
      data: parseGeminiJsonText<T>(rawText),
      model,
      rawText,
    };
  } catch (firstError) {
    if (!retryOnParseFailure) {
      throw firstError;
    }

    const retryRawText = await requestGeminiRawText({
      ...effectiveOptions,
      prompt: `${prompt}\n\n前回の応答は壊れたJSONでした。今度は厳密なJSONのみを返してください。`,
      temperature: 0,
      maxOutputTokens,
      model,
      schema,
      images,
      signal,
    });

    try {
      return {
        data: parseGeminiJsonText<T>(retryRawText),
        model,
        rawText: retryRawText,
      };
    } catch (retryError) {
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      const originalMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const error = new Error(`${message} (first attempt: ${originalMessage})`) as Error & {
        rawText?: string;
        firstRawText?: string;
      };
      error.rawText = retryError instanceof Error && 'rawText' in retryError
        ? (retryError as Error & { rawText?: string }).rawText ?? retryRawText
        : retryRawText;
      error.firstRawText = firstError instanceof Error && 'rawText' in firstError
        ? (firstError as Error & { rawText?: string }).rawText ?? rawText
        : rawText;
      throw error;
    }
  }
}

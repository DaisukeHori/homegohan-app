import { generateGeminiJson } from '../../../../lib/ai/gemini-json';
import {
  aggregateClassifyPhotoResults,
  classifyPhotoSchema,
  mealRecognitionSchema,
  normalizeMealRecognitionResult,
  normalizeClassifyPhotoResult,
  resolveClassifyPhotoType,
  DEFAULT_GEMINI_CLASSIFY_MODEL,
  type ClassifyPhotoResult,
  type ClassifyPhotoWithMealAnalysisResult,
  type MealRecognitionResult,
  type PhotoType,
} from '../../../../lib/ai/image-recognition';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

interface ImageInput {
  base64: string;
  mimeType?: string;
}

const CLASSIFY_MODEL = process.env.GEMINI_CLASSIFY_MODEL || DEFAULT_GEMINI_CLASSIFY_MODEL;

export type { PhotoType };

function recoverClassificationFromRawText(rawText: string): ClassifyPhotoResult | null {
  const pairRegex = /"type"\s*:\s*"(meal|fridge|health_checkup|weight_scale|unknown)"[\s\S]{0,120}?"confidence"\s*:\s*([01](?:\.\d+)?)/;
  const pair = rawText.match(pairRegex);

  if (pair) {
    const recoveredType = pair[1] as PhotoType;
    const recoveredConf = Number(pair[2]);
    return normalizeClassifyPhotoResult({
      type: recoveredType,
      confidence: recoveredConf,
    });
  }

  const typeOnly = rawText.match(/"type"\s*:\s*"(meal|fridge|health_checkup|weight_scale|unknown)"/);
  if (!typeOnly) {
    // 型が見当たらない場合は unknown を返す
    return normalizeClassifyPhotoResult({ type: 'unknown', confidence: 0.0 });
  }

  const recoveredType = typeOnly[1] as PhotoType;
  return normalizeClassifyPhotoResult({
    type: recoveredType,
    confidence: recoveredType === 'unknown' ? 0.0 : 0.7,
  });
}

function buildPrompt(imageCount: number): string {
  const imageCountText = imageCount > 1 ? `${imageCount}枚の` : '';
  return `この${imageCountText}画像セットの主な用途を判別してください。

まず「これは食事・料理の写真ですか？」を判断してください。
明確に食事・料理だと判断できる場合のみ "meal" を返してください。

以下の4つのカテゴリから最も適切なものを選んでください：

1. "meal" - 食事・料理の写真
   【例】定食（米飯＋主菜＋副菜＋汁物）、単品料理、弁当、丼、ラーメン、
        パスタ、サラダ、ケーキ、カフェの飲み物、和食、洋食、中華。
        料理が明確に写っている場合に選んでください。
2. "fridge" - 冷蔵庫の中身や買い物食材の写真（冷蔵庫の内部が写っている場合）
3. "health_checkup" - 健康診断結果や検査票など紙の書類のみ
4. "weight_scale" - 体重計や体組成計のディスプレイ写真のみ

判定ルール:
- 複数枚ある場合は、画像全体を見て最も一貫したカテゴリを選んでください
- 体重計ディスプレイ写真は必ず "weight_scale" を最優先で判定してください
- 紙の健康診断結果と体重計ディスプレイは厳密に区別してください
- 料理・食事が明確に写っている場合は "meal" を返してください
- 4カテゴリのどれにも当てはまらない場合や、画像が不鮮明・空白・テスト画像の場合は "unknown" を返してください
- 判定に自信がない場合は confidence を低く設定してください

JSON では次の2項目だけ返してください:
- "type": 上記4カテゴリのいずれか（"meal" / "fridge" / "health_checkup" / "weight_scale" / "unknown"）
- "confidence": 0.0 から 1.0 の小数（判定に自信がない場合は低い値を設定する）

説明文や候補配列は返さないでください。`;
}

function buildMealAnalysisPrompt(mealType?: string, imageCount: number = 1): string {
  const mealTypeLabel = mealType === 'breakfast' ? '朝食'
    : mealType === 'lunch' ? '昼食'
    : mealType === 'dinner' ? '夕食'
    : mealType === 'snack' ? 'おやつ'
    : mealType === 'midnight_snack' ? '夜食'
    : '食事';

  const imageCountText = imageCount > 1 ? `${imageCount}枚の` : '';

  return `あなたは「ほめゴハン」という食事記録アプリの分析AIです。
この${imageCountText}${mealTypeLabel}の写真に写っている料理を、栄養計算の下準備として構造化してください。

重要ルール:
- 写っている料理だけを数えてください。見えていない小鉢や調味料を想像で増やさないでください
- 料理名は一般的な名前にしてください
- 1皿ごとに「見えている量」と「見えている主要材料」と「皿全体の推定栄養」を返してください
- visiblePortionWeightG は、その皿全体の見た目量を 1人前として推定してください
- visibleIngredients は、写真から見えている主要材料だけを返してください
- estimatedNutrition は、見えていない油・衣・汁の塩分・ルーなども含めた皿全体の現実的な栄養推定にしてください
- 油、衣、吸油、隠れた調味料など、写真から明確に見えない要素は visibleIngredients に入れないでください
- cookingMethod は fried / grilled / stir_fried / simmered / steamed / boiled / raw / rice / soup / baked / other の中から最も近いものを選んでください
- 定食なら、ご飯・汁物・主菜・副菜/サラダを分けてください
- ご飯は炊いた後の量として見積もり、通常は 80g〜220g の範囲で考えてください
- 汁物は器1杯として見積もり、通常は 120g〜220g の範囲で考えてください
- JSON 以外は返さないでください

返却形式:
{
  "dishes": [
    {
      "name": "料理名",
      "role": "main または side または soup または rice または salad または dessert",
      "cookingMethod": "fried など",
      "visiblePortionWeightG": 皿全体の見た目量(g),
      "visibleIngredients": [
        { "name": "写真から見える主要材料名", "amount_g": 推定量(g) }
      ],
      "estimatedNutrition": {
        "calories_kcal": 推定カロリー,
        "protein_g": 推定たんぱく質,
        "fat_g": 推定脂質,
        "carbs_g": 推定炭水化物,
        "fiber_g": 推定食物繊維,
        "salt_eq_g": 推定食塩相当量,
        "confidence": "high または medium または low"
      }
    }
  ]
}`;
}

// confidence が低い / unknown と判断する閾値
const CLASSIFY_CONFIDENCE_THRESHOLD = 0.5;
const CLASSIFY_RETRY_TEMPERATURE = 0.4;

// 画像の最小バイトサイズ（1px ブランク JPEG 等の極小画像を除外するための閾値）
// 通常の 100x100px JPEG でも数 KB 以上になるため、1000 バイト未満は無効とみなす
const MIN_IMAGE_BYTES = 1000;

/**
 * base64 画像が最低品質要件を満たしているか検証する。
 * 極小・空白画像（例: 1px ブランク JPEG）は unknown を強制して AI 呼び出しをスキップする。
 */
function isImageSufficientQuality(images: ImageInput[]): boolean {
  for (const image of images) {
    if (!image.base64 || image.base64.length === 0) return false;
    // base64 文字数からバイト数を近似 (実際のバイト数 ≈ base64 長 × 3/4)
    const approxBytes = Math.floor(image.base64.length * 0.75);
    if (approxBytes < MIN_IMAGE_BYTES) return false;
  }
  return true;
}

async function requestClassification(
  images: ImageInput[],
  temperature = 0.1,
): Promise<{ result: ClassifyPhotoResult; model: string }> {
  const { data, model } = await generateGeminiJson<ClassifyPhotoResult>({
    prompt: buildPrompt(images.length),
    schema: classifyPhotoSchema as unknown as Record<string, unknown>,
    images,
    temperature,
    maxOutputTokens: 96,
    model: CLASSIFY_MODEL,
    retryOnParseFailure: false,
    signal: AbortSignal.timeout(25_000),
  });

  return {
    result: normalizeClassifyPhotoResult(data),
    model,
  };
}

/**
 * 1回目の confidence が低い場合に temperature を上げて再分類する。
 * 最大3回リトライし、最も confidence の高い結果を返す。
 * すべてのリトライで unknown になった場合は meal にフォールバックする。
 */
async function requestClassificationWithRetry(
  images: ImageInput[],
): Promise<{ result: ClassifyPhotoResult; model: string }> {
  const first = await requestClassification(images);
  if (
    first.result.type !== 'unknown' &&
    first.result.confidence >= CLASSIFY_CONFIDENCE_THRESHOLD
  ) {
    return first;
  }

  // confidence が低い / unknown → temperature を上げて最大3回再試行
  const retries = await Promise.all([
    requestClassification(images, CLASSIFY_RETRY_TEMPERATURE).catch(() => null),
    requestClassification(images, CLASSIFY_RETRY_TEMPERATURE).catch(() => null),
    requestClassification(images, CLASSIFY_RETRY_TEMPERATURE).catch(() => null),
  ]);

  const candidates = [first, ...retries.filter((r): r is NonNullable<typeof r> => r !== null)];

  // unknown でなく confidence が最も高いものを優先
  const nonUnknown = candidates.filter((c) => c.result.type !== 'unknown');
  if (nonUnknown.length > 0) {
    const best = nonUnknown.sort((a, b) => b.result.confidence - a.result.confidence)[0];
    console.info('Photo Classification: low-confidence retry picked better result', {
      firstType: first.result.type,
      firstConf: first.result.confidence,
      bestType: best.result.type,
      bestConf: best.result.confidence,
    });
    return best;
  }

  // すべてのリトライで unknown になった場合は unknown を返す
  console.warn('Photo Classification: all retries returned unknown, returning unknown', {
    firstConf: first.result.confidence,
    candidateCount: candidates.length,
  });
  return {
    result: normalizeClassifyPhotoResult({ type: 'unknown', confidence: first.result.confidence }),
    model: first.model,
  };
}

async function requestMealAnalysis(
  images: ImageInput[],
  mealType?: string,
): Promise<MealRecognitionResult | undefined> {
  const { data } = await generateGeminiJson<MealRecognitionResult>({
    prompt: buildMealAnalysisPrompt(mealType, images.length),
    schema: mealRecognitionSchema as unknown as Record<string, unknown>,
    images,
    temperature: 0.1,
    maxOutputTokens: 1024,
    model: CLASSIFY_MODEL,
    retryOnParseFailure: false,
    signal: AbortSignal.timeout(25_000),
  });

  const normalized = normalizeMealRecognitionResult(data);
  return normalized.dishes.length > 0 ? normalized : undefined;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const startedAt = Date.now();
    const body = await request.json();
    const includeMealAnalysis = Boolean(body.includeMealAnalysis);
    const mealType = typeof body.mealType === 'string' ? body.mealType : undefined;
    const images: ImageInput[] = Array.isArray(body.images) && body.images.length > 0
      ? body.images
      : body.imageBase64
        ? [{ base64: body.imageBase64, mimeType: body.mimeType || 'image/jpeg' }]
        : [];

    if (images.length === 0) {
      return NextResponse.json({ error: 'Image Base64 is required' }, { status: 400 });
    }

    // #151: 極小・空白画像（例: 1px ブランク JPEG）は AI に送らず unknown を返す
    if (!isImageSufficientQuality(images)) {
      console.warn('Photo Classification: image rejected due to insufficient quality (too small)', {
        imageCount: images.length,
        approxBytesFirst: images[0] ? Math.floor(images[0].base64.length * 0.75) : 0,
      });
      return NextResponse.json({
        type: 'unknown',
        confidence: 0.0,
        description: '画像が小さすぎるか無効です',
        modelUsed: CLASSIFY_MODEL,
      });
    }

    const classifyStartedAt = Date.now();
    const { result: initialResult, model } = await requestClassificationWithRetry(images);
    const classifyElapsedMs = Date.now() - classifyStartedAt;

    // #151: confidence 閾値チェック — 低信頼度の分類は unknown として扱う
    const FINAL_CONFIDENCE_THRESHOLD = 0.6;
    if (initialResult.confidence < FINAL_CONFIDENCE_THRESHOLD && initialResult.type !== 'unknown') {
      console.info('Photo Classification: confidence below threshold, treating as unknown', {
        type: initialResult.type,
        confidence: initialResult.confidence,
        threshold: FINAL_CONFIDENCE_THRESHOLD,
      });
      // 信頼度が低すぎる場合は unknown として扱うが、元の型情報は candidates に保持する
      const lowConfResult = normalizeClassifyPhotoResult({
        type: 'unknown',
        confidence: initialResult.confidence,
        candidates: [{ type: initialResult.type, confidence: initialResult.confidence }],
      });
      return NextResponse.json({ ...lowConfResult, modelUsed: model });
    }

    let result: ClassifyPhotoResult | ClassifyPhotoWithMealAnalysisResult = initialResult;

    if (images.length > 1 && !resolveClassifyPhotoType(initialResult).type) {
      const fallbackStartedAt = Date.now();
      const perImageResults = await Promise.all(
        images.map(async (image) => (await requestClassification([image])).result),
      );
      const aggregatedResult = aggregateClassifyPhotoResults(perImageResults);
      console.info('Photo Classification: fell back to per-image aggregation', {
        imageCount: images.length,
        initial: initialResult,
        aggregated: aggregatedResult,
        fallbackElapsedMs: Date.now() - fallbackStartedAt,
      });
      result = aggregatedResult;
    }

    let mealAnalysisElapsedMs = 0;
    if (includeMealAnalysis && result.type === 'meal') {
      const mealAnalysisStartedAt = Date.now();
      const mealAnalysis = await requestMealAnalysis(images, mealType);
      mealAnalysisElapsedMs = Date.now() - mealAnalysisStartedAt;
      result = {
        ...result,
        mealAnalysis,
      };
    }

    console.info('Photo Classification: completed', {
      imageCount: images.length,
      resolvedType: result.type,
      model,
      classifyElapsedMs,
      mealAnalysisElapsedMs,
      mealAnalysisDishCount: 'mealAnalysis' in result ? (result.mealAnalysis?.dishes.length ?? 0) : 0,
      totalElapsedMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ...result,
      modelUsed: model,
    });
  } catch (error: any) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (isTimeout) {
      console.error('Photo Classification: AI timeout after 25s');
      return NextResponse.json(
        { error: 'AI が応答しませんでした、もう一度お試しください' },
        { status: 504 },
      );
    }

    const rawTexts = [
      typeof error?.rawText === 'string' ? error.rawText : '',
      typeof error?.firstRawText === 'string' ? error.firstRawText : '',
    ].filter(Boolean);

    for (const rawText of rawTexts) {
      const recovered = recoverClassificationFromRawText(rawText);
      if (recovered) {
        console.warn('Photo Classification: recovered from malformed JSON', {
          recovered,
          preview: rawText.slice(0, 160),
        });
        return NextResponse.json({
          ...recovered,
          modelUsed: CLASSIFY_MODEL,
          recovered: true,
        });
      }
    }

    console.error('Photo Classification Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

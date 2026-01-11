import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * 健康診断結果写真解析API
 *
 * GPT-4o Vision で健康診断票から検査値を抽出
 */

// 抽出する健康診断項目
interface ExtractedHealthData {
  // 基本情報
  checkupDate?: string;       // 受診日
  facilityName?: string;      // 医療機関名
  checkupType?: string;       // 検査種別

  // 身体測定
  height?: number;            // 身長 cm
  weight?: number;            // 体重 kg
  bmi?: number;               // BMI
  waistCircumference?: number; // 腹囲 cm

  // 血圧
  bloodPressureSystolic?: number;  // 収縮期血圧
  bloodPressureDiastolic?: number; // 拡張期血圧

  // 血液検査
  hemoglobin?: number;        // ヘモグロビン g/dL
  hba1c?: number;             // HbA1c %
  fastingGlucose?: number;    // 空腹時血糖 mg/dL

  // 脂質
  totalCholesterol?: number;  // 総コレステロール mg/dL
  ldlCholesterol?: number;    // LDLコレステロール mg/dL
  hdlCholesterol?: number;    // HDLコレステロール mg/dL
  triglycerides?: number;     // 中性脂肪 mg/dL

  // 肝機能
  ast?: number;               // AST(GOT) U/L
  alt?: number;               // ALT(GPT) U/L
  gammaGtp?: number;          // γ-GTP U/L

  // 腎機能
  creatinine?: number;        // クレアチニン mg/dL
  egfr?: number;              // eGFR mL/min/1.73m²
  uricAcid?: number;          // 尿酸 mg/dL
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { imageBase64, mimeType } = body;

    if (!imageBase64) {
      return NextResponse.json({ error: 'Image Base64 is required' }, { status: 400 });
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OpenAI API Key is not configured' }, { status: 500 });
    }

    const prompt = `この健康診断結果の画像から、検査値を抽出してください。

読み取れる項目について、以下のJSON形式で出力してください：

{
  "checkupDate": "YYYY-MM-DD形式の受診日（読み取れない場合はnull）",
  "facilityName": "医療機関名（読み取れない場合はnull）",
  "checkupType": "定期健診/人間ドック/特定健診など（読み取れない場合はnull）",

  "height": 身長cm（数値、読み取れない場合はnull）,
  "weight": 体重kg（数値、読み取れない場合はnull）,
  "bmi": BMI（数値、読み取れない場合はnull）,
  "waistCircumference": 腹囲cm（数値、読み取れない場合はnull）,

  "bloodPressureSystolic": 収縮期血圧mmHg（数値、読み取れない場合はnull）,
  "bloodPressureDiastolic": 拡張期血圧mmHg（数値、読み取れない場合はnull）,

  "hemoglobin": ヘモグロビンg/dL（数値、読み取れない場合はnull）,
  "hba1c": HbA1c%（数値、読み取れない場合はnull）,
  "fastingGlucose": 空腹時血糖mg/dL（数値、読み取れない場合はnull）,

  "totalCholesterol": 総コレステロールmg/dL（数値、読み取れない場合はnull）,
  "ldlCholesterol": LDLコレステロールmg/dL（数値、読み取れない場合はnull）,
  "hdlCholesterol": HDLコレステロールmg/dL（数値、読み取れない場合はnull）,
  "triglycerides": 中性脂肪mg/dL（数値、読み取れない場合はnull）,

  "ast": AST(GOT) U/L（数値、読み取れない場合はnull）,
  "alt": ALT(GPT) U/L（数値、読み取れない場合はnull）,
  "gammaGtp": γ-GTP U/L（数値、読み取れない場合はnull）,

  "creatinine": クレアチニンmg/dL（数値、読み取れない場合はnull）,
  "egfr": eGFR mL/min/1.73m²（数値、読み取れない場合はnull）,
  "uricAcid": 尿酸mg/dL（数値、読み取れない場合はnull）,

  "confidence": 読み取り精度 0.0〜1.0（画質や読みやすさから判断）,
  "notes": "読み取り時の注意事項や不明点（50文字程度）"
}

注意：
- 読み取れた項目のみを含めてください
- 数値は単位を含めず純粋な数値で
- 不明確な値は null としてください
- JSONのみを出力してください`;

    // Base64データをdata URL形式に変換
    const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",  // OCR精度のためgpt-4oを使用
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }
        ],
        max_completion_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', errorText);
      return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return NextResponse.json({ error: 'AI analysis returned no content' }, { status: 500 });
    }

    // JSONを抽出
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse AI response:', content);
      return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 });
    }

    const extractedData: ExtractedHealthData & { confidence?: number; notes?: string } = JSON.parse(jsonMatch[0]);

    // 読み取れた項目数をカウント
    const fieldCount = Object.entries(extractedData)
      .filter(([key, value]) =>
        key !== 'confidence' &&
        key !== 'notes' &&
        value !== null &&
        value !== undefined
      ).length;

    return NextResponse.json({
      extractedData,
      fieldCount,
      confidence: extractedData.confidence || 0.5,
      notes: extractedData.notes || '',
      modelUsed: 'gpt-4o',
    });

  } catch (error: any) {
    console.error("Health Checkup Analysis Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

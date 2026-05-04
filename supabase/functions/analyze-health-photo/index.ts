import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { generateGeminiJson } from "../_shared/gemini-json.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AnalysisResult {
  type: 'weight_scale' | 'blood_pressure' | 'thermometer' | 'unknown';
  values: {
    weight?: number;
    body_fat_percentage?: number;
    muscle_mass?: number;
    systolic_bp?: number;
    diastolic_bp?: number;
    heart_rate?: number;
    body_temp?: number;
  };
  confidence: number;
  raw_text?: string;
}

const analysisSchema = {
  type: 'object',
  required: ['type', 'values', 'confidence', 'raw_text'],
  properties: {
    type: { type: 'string', enum: ['weight_scale', 'blood_pressure', 'thermometer', 'unknown'] },
    values: {
      type: 'object',
      properties: {
        weight: { type: ['number', 'null'] },
        body_fat_percentage: { type: ['number', 'null'] },
        muscle_mass: { type: ['number', 'null'] },
        systolic_bp: { type: ['number', 'null'] },
        diastolic_bp: { type: ['number', 'null'] },
        heart_rate: { type: ['number', 'null'] },
        body_temp: { type: ['number', 'null'] },
      },
    },
    confidence: { type: 'number' },
    raw_text: { type: 'string' },
  },
} as const;

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampConfidence(value: unknown): number {
  const numeric = toOptionalNumber(value);
  if (numeric === undefined) return 0;
  return Math.max(0, Math.min(1, Math.round(numeric * 100) / 100));
}

function normalizeAnalysisResult(raw: unknown): AnalysisResult {
  const input = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const values = typeof input.values === 'object' && input.values !== null ? input.values as Record<string, unknown> : {};
  const type = ['weight_scale', 'blood_pressure', 'thermometer', 'unknown'].includes(input.type as string)
    ? input.type as AnalysisResult['type']
    : 'unknown';

  return {
    type,
    values: {
      weight: toOptionalNumber(values.weight),
      body_fat_percentage: toOptionalNumber(values.body_fat_percentage),
      muscle_mass: toOptionalNumber(values.muscle_mass),
      systolic_bp: toOptionalNumber(values.systolic_bp),
      diastolic_bp: toOptionalNumber(values.diastolic_bp),
      heart_rate: toOptionalNumber(values.heart_rate),
      body_temp: toOptionalNumber(values.body_temp),
    },
    confidence: clampConfidence(input.confidence),
    raw_text: typeof input.raw_text === 'string' ? input.raw_text.trim() : undefined,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authorization header required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const formData = await req.formData();
    const imageFile = formData.get("image") as File | null;
    const imageBase64 = formData.get("image_base64") as string | null;
    const deviceType = formData.get("device_type") as string || "auto";
    const mimeTypeField = formData.get("mime_type") as string | null;

    let base64Image: string;
    let mimeType: string;

    if (imageFile) {
      const buffer = await imageFile.arrayBuffer();
      base64Image = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      mimeType = imageFile.type || "image/jpeg";
    } else if (imageBase64) {
      base64Image = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      mimeType = mimeTypeField || "image/jpeg";
    } else {
      return new Response(
        JSON.stringify({ error: "Image is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data, model, rawText } = await generateGeminiJson<AnalysisResult>({
      prompt: buildAnalysisPrompt(deviceType),
      schema: analysisSchema as unknown as Record<string, unknown>,
      images: [{ base64: base64Image, mimeType }],
      temperature: 0.1,
      maxOutputTokens: 1024,
    });

    const result = normalizeAnalysisResult(data);

    return new Response(
      JSON.stringify({
        success: true,
        result,
        raw_response: rawText,
        model_used: model,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function buildAnalysisPrompt(deviceType: string): string {
  const basePrompt = `あなたは健康機器の画面を読み取る専門家です。
画像に表示されている数値を正確に読み取ってください。

方針:
- 数値が読み取れない項目は null にしてください
- 単位は含めず純粋な数値だけを返してください
- 小数点は表示どおりに維持してください
- raw_text には画面上で読めた主要テキストをそのまま入れてください
- confidence は読み取り確実性を 0.0 から 1.0 で返してください`;

  if (deviceType === "weight_scale") {
    return `${basePrompt}

この画像は体重計または体組成計の画面です。体重、体脂肪率、筋肉量などを読み取ってください。`;
  }

  if (deviceType === "blood_pressure") {
    return `${basePrompt}

この画像は血圧計の画面です。収縮期血圧、拡張期血圧、脈拍を読み取ってください。`;
  }

  if (deviceType === "thermometer") {
    return `${basePrompt}

この画像は体温計の画面です。体温を読み取ってください。`;
  }

  return `${basePrompt}

画像の種類を自動判定し、適切な健康機器カテゴリを選んだ上で数値を読み取ってください。`;
}

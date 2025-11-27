import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // JWT認証
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

    // リクエストボディを取得
    const formData = await req.formData();
    const imageFile = formData.get("image") as File | null;
    const imageBase64 = formData.get("image_base64") as string | null;
    const deviceType = formData.get("device_type") as string || "auto"; // weight_scale, blood_pressure, thermometer, auto

    let base64Image: string;
    let mimeType: string;

    if (imageFile) {
      // ファイルからBase64に変換
      const buffer = await imageFile.arrayBuffer();
      base64Image = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      mimeType = imageFile.type || "image/jpeg";
    } else if (imageBase64) {
      // 既にBase64の場合
      base64Image = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      mimeType = "image/jpeg";
    } else {
      return new Response(
        JSON.stringify({ error: "Image is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Gemini APIで画像を分析
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) {
      return new Response(
        JSON.stringify({ error: "Gemini API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const prompt = buildAnalysisPrompt(deviceType);

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Image,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error("Gemini API error:", errorText);
      return new Response(
        JSON.stringify({ error: "Failed to analyze image" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geminiData = await geminiResponse.json();
    const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // JSONを抽出
    const result = parseAnalysisResult(responseText);

    return new Response(
      JSON.stringify({
        success: true,
        result,
        raw_response: responseText,
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

以下のJSON形式で回答してください：
{
  "type": "weight_scale" | "blood_pressure" | "thermometer" | "unknown",
  "values": {
    "weight": 数値（kg単位、体重計の場合）,
    "body_fat_percentage": 数値（%、体脂肪率が表示されている場合）,
    "muscle_mass": 数値（kg、筋肉量が表示されている場合）,
    "systolic_bp": 数値（mmHg、収縮期血圧）,
    "diastolic_bp": 数値（mmHg、拡張期血圧）,
    "heart_rate": 数値（bpm、脈拍）,
    "body_temp": 数値（℃、体温）
  },
  "confidence": 0.0〜1.0の信頼度,
  "raw_text": "画面に表示されている全てのテキスト"
}

注意事項：
- 数値が読み取れない項目はnullにしてください
- 単位は必ず変換してください（例：65.2kgなら65.2）
- 小数点以下は元の表示を維持してください
- 信頼度は読み取りの確実性を示します（はっきり読める: 0.9以上、やや不鮮明: 0.7-0.9、不鮮明: 0.7未満）
`;

  if (deviceType === "weight_scale") {
    return basePrompt + "\n\nこの画像は体重計の画面です。体重、体脂肪率、筋肉量などを読み取ってください。";
  } else if (deviceType === "blood_pressure") {
    return basePrompt + "\n\nこの画像は血圧計の画面です。収縮期血圧、拡張期血圧、脈拍を読み取ってください。";
  } else if (deviceType === "thermometer") {
    return basePrompt + "\n\nこの画像は体温計の画面です。体温を読み取ってください。";
  } else {
    return basePrompt + "\n\n画像の種類を自動判定し、適切な数値を読み取ってください。";
  }
}

function parseAnalysisResult(responseText: string): AnalysisResult {
  try {
    // JSONブロックを抽出
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        type: parsed.type || "unknown",
        values: {
          weight: parsed.values?.weight ?? null,
          body_fat_percentage: parsed.values?.body_fat_percentage ?? null,
          muscle_mass: parsed.values?.muscle_mass ?? null,
          systolic_bp: parsed.values?.systolic_bp ?? null,
          diastolic_bp: parsed.values?.diastolic_bp ?? null,
          heart_rate: parsed.values?.heart_rate ?? null,
          body_temp: parsed.values?.body_temp ?? null,
        },
        confidence: parsed.confidence ?? 0.5,
        raw_text: parsed.raw_text,
      };
    }
  } catch (e) {
    console.error("Failed to parse response:", e);
  }

  return {
    type: "unknown",
    values: {},
    confidence: 0,
    raw_text: responseText,
  };
}


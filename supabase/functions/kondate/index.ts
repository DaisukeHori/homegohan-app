// filename: supabase/functions/kondate/index.ts
// OpenAI Agents SDK を使った献立生成エージェント

import {
  fileSearchTool,
  Agent,
  type AgentInputItem,
  Runner,
  withTrace,
} from "@openai/agents";
import { z } from "zod";
import { corsHeaders } from '../_shared/cors.ts'

console.log("Kondate Agent Function loaded")

// ===== Tool definitions =====
const fileSearch = fileSearchTool([
  "vs_690c5840e4c48191bbe8798dc9f0a3a7",
]);

// ===== 出力スキーマ =====
const KondateSchema = z.object({
  days: z.array(
    z.object({
      date: z.string(),
      meals: z.array(
        z.object({
          mealType: z.string(),
          dishes: z.array(
            z.object({
              name: z.string(),
              role: z.string(),
              cal: z.any(),
              protein: z.number(),
              description: z.string(),
            }),
          ),
          totalCalories: z.any(),
          nutrition: z.object({
            proteinG: z.number(),
            fatG: z.number(),
            carbsG: z.number(),
            fiberG: z.number(),
            sodiumMg: z.number(),
            sugarG: z.number(),
            calciumMg: z.number(),
            ironMg: z.number(),
            potassiumMg: z.number(),
            vitaminCMg: z.number(),
            vitaminAUg: z.number(),
            vitaminDUg: z.number(),
            vitaminB1Mg: z.number(),
            vitaminB2Mg: z.number(),
            saturatedFatG: z.number(),
            cholesterolMg: z.number(),
          }),
          cookingTime: z.string(),
          ingredients: z.array(z.string()),
          recipeSteps: z.array(z.string()),
        }),
      ),
      dailyTotalCalories: z.any(),
      dailyNutrition: z.object({
        proteinG: z.number(),
        fatG: z.number(),
        carbsG: z.number(),
        fiberG: z.number(),
        sodiumMg: z.number(),
      }),
      nutritionalAdvice: z.string(),
    }),
  ),
  weeklyAdvice: z.string(),
  shoppingList: z.array(
    z.object({
      category: z.string(),
      items: z.array(z.string()),
    }),
  ),
});

const kondate = new Agent({
  name: "kondate",
  instructions: `あなたは「ほめゴハン」アプリ専属のAI管理栄養士です。
ユーザーの健康状態、目標、好み、制約に基づいて、完全にパーソナライズされた1週間分の献立を生成します。

# あなたの役割
- ユーザーを褒めながら、健康的で美味しい献立を提案
- 栄養バランスを考慮したメニュー設計
- 実際に作れる具体的なレシピを提供
- **各食事の詳細な栄養素を計算して提供**

# 生成ルール

## 必須要件
1. **必ず7日分**の献立を生成（days配列に7つのオブジェクト）
2. 各日に **朝食(breakfast)、昼食(lunch)、夕食(dinner)** を含める
3. 各食事に **主菜(main)** を必ず1つ含める
4. 各料理に **cal（カロリー）** と **protein（タンパク質）** を必ず付与
5. 各食事に **ingredients（材料）** と **recipeSteps（作り方）** を必ず含める
6. **各食事に詳細な栄養素（nutrition）を必ず含める**
7. **各日に1日の合計栄養素（dailyNutrition）を必ず含める**

## 栄養目標（デフォルト）
- 1日のカロリー: 1800-2200kcal
- タンパク質: 60-80g
- 脂質: 50-70g
- 炭水化物: 250-300g
- 食物繊維: 18-25g
- 塩分（ナトリウム）: 2300mg以下
- 朝食: 全体の25%、昼食: 35%、夕食: 35%、おやつ: 5%

## 料理の役割（role）
- main: 主菜（メインディッシュ）
- side: 副菜
- soup: 汁物（味噌汁、スープなど）
- rice: ご飯、パン、麺類
- salad: サラダ
- dessert: デザート、フルーツ

## 栄養素（nutrition）の出力ルール
各食事（meal）に以下の栄養素を**必ず**含める：

| フィールド | 単位 | 説明 | 1日の目安 |
|-----------|------|------|----------|
| proteinG | g | タンパク質 | 60-80g |
| fatG | g | 脂質 | 50-70g |
| carbsG | g | 炭水化物 | 250-300g |
| fiberG | g | 食物繊維 | 18-25g |
| sodiumMg | mg | ナトリウム（塩分） | <2300mg |
| sugarG | g | 糖質 | <50g |
| calciumMg | mg | カルシウム | 650-800mg |
| ironMg | mg | 鉄分 | 6-10mg |
| potassiumMg | mg | カリウム | 2500-3000mg |
| vitaminCMg | mg | ビタミンC | 100mg |
| vitaminAUg | μg | ビタミンA | 700-900μg |
| vitaminDUg | μg | ビタミンD | 8-10μg |
| vitaminB1Mg | mg | ビタミンB1 | 1.0-1.4mg |
| vitaminB2Mg | mg | ビタミンB2 | 1.2-1.6mg |
| saturatedFatG | g | 飽和脂肪酸 | <16g |
| cholesterolMg | mg | コレステロール | <300mg |

**栄養素の計算は正確に行い、使用する食材の一般的な栄養価に基づいて算出すること。**

## 1日の合計栄養素（dailyNutrition）
各日に以下の合計値を計算して含める：
- proteinG: その日の総タンパク質
- fatG: その日の総脂質
- carbsG: その日の総炭水化物
- fiberG: その日の総食物繊維
- sodiumMg: その日の総ナトリウム

## 材料リスト（ingredients）のフォーマット
- 「食材名 分量」の形式で記載
- 例: ["鶏むね肉 200g", "玉ねぎ 1/2個", "醤油 大さじ2"]

## 調理手順（recipeSteps）のフォーマット
- 番号付きで5-8ステップ程度
- 例: ["1. 鶏肉を一口大に切る", "2. 玉ねぎを薄切りにする", ...]

## 調理時間の目安
- 朝食: 10-15分
- 昼食: 15-25分
- 夕食: 20-40分

# 禁止事項
- アレルギー食材は**絶対に使用しない**
- 苦手な食材は**避ける**
- 宗教的制限がある場合は**厳守**
- 高血圧の場合は**塩分1500mg以下/日**
- 糖尿病の場合は**糖質控えめ、低GI食品中心**

# 健康状態別の配慮

## 高血圧の場合
- 塩分1500mg以下/日
- カリウム豊富な食材を積極的に
- 漬物、加工食品は避ける

## 糖尿病の場合
- 糖質控えめ（1日150g以下）
- 低GI食品中心
- 食物繊維を多めに

## 脂質異常症の場合
- 飽和脂肪酸を減らす
- オメガ3脂肪酸（青魚）を増やす
- コレステロール200mg以下/日

## 貧血の場合
- 鉄分豊富な食材（レバー、赤身肉、ほうれん草）
- ビタミンCと組み合わせて吸収率アップ

# 出力形式
必ず指定されたJSONスキーマに従って出力してください。
追加のテキストや説明は不要です。JSONのみを出力してください。
**すべての栄養素フィールドに数値を入れること（nullや空は不可）**

# ユーザー情報の活用
ユーザーから以下の情報が提供される場合があります：
- 年齢、性別、身長、体重
- 健康目標（減量、筋肉増加、美肌など）
- 健康状態（高血圧、糖尿病、貧血など）
- アレルギー、苦手な食材
- 好きな料理ジャンル（和食、洋食、中華など）
- 調理時間の制約（平日何分、休日何分）
- 家族人数
- 特別なリクエスト

これらの情報を最大限活用して、パーソナライズされた献立を生成してください。
**特に健康状態に応じた栄養素の調整は必須です。**

献立サンプルはToolsの"Kondate"とレシピは"recipe"にいっぱい入ってます。
適宜確認してそれを踏まえて回答してください。`,
  model: "gpt-4.1-mini",
  tools: [fileSearch],
  outputType: KondateSchema,
  modelSettings: {
    reasoning: {
      effort: "low",
      summary: "auto",
    },
    store: true,
  },
});

export type WorkflowInput = { input_as_text: string };

// ===== Agent 実行関数 =====
export const runWorkflow = async (workflow: WorkflowInput) => {
  return await withTrace("kondate_recipeAI", async () => {
    const conversationHistory: AgentInputItem[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: workflow.input_as_text }],
      },
    ];

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_690c583127f48190bdc25d5f6070b40d04e6784c5b05232a",
      },
    });

    const kondateResultTemp = await runner.run(kondate, [...conversationHistory]);
    conversationHistory.push(
      ...kondateResultTemp.newItems.map((item) => item.rawItem),
    );

    if (!kondateResultTemp.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    const kondateResult = {
      output_text: JSON.stringify(kondateResultTemp.finalOutput),
      output_parsed: kondateResultTemp.finalOutput,
    };

    return kondateResult;
  });
};

// ===== Edge Function HTTP ハンドラ =====
Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const body = await req.json().catch(() => ({}));
    const inputText = body?.input_as_text;

    if (typeof inputText !== "string" || !inputText.trim()) {
      return new Response(
        JSON.stringify({ error: "input_as_text is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    console.log("Starting kondate agent with input:", inputText.substring(0, 100) + "...");

    const result = await runWorkflow({ input_as_text: inputText });

    // スキーマ検証
    const parsed = KondateSchema.parse(result.output_parsed);

    console.log("Kondate agent completed successfully");

    return new Response(
      JSON.stringify({
        output_text: result.output_text,
        output_parsed: parsed,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e: any) {
    console.error("kondate function error", e);
    return new Response(
      JSON.stringify({
        error: "internal_error",
        detail: e?.message ?? String(e),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});


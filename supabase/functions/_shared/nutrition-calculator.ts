// 栄養計算の共通ロジック

// 栄養計算用の型
// UIで表示される全栄養素に対応した型
export type NutritionTotals = {
  // 基本栄養素
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
  sugar_g: number;           // 糖質
  sodium_g: number;          // 塩分相当量 (g単位)
  
  // ミネラル
  potassium_mg: number;      // カリウム
  calcium_mg: number;        // カルシウム
  phosphorus_mg: number;     // リン
  magnesium_mg: number;      // マグネシウム
  iron_mg: number;           // 鉄分
  zinc_mg: number;           // 亜鉛
  iodine_ug: number;         // ヨウ素
  
  // 脂質詳細
  saturated_fat_g: number;   // 飽和脂肪酸
  monounsaturated_fat_g: number;   // 一価不飽和脂肪酸
  polyunsaturated_fat_g: number;   // 多価不飽和脂肪酸
  cholesterol_mg: number;    // コレステロール
  
  // ビタミン
  vitamin_a_ug: number;
  vitamin_b1_mg: number;
  vitamin_b2_mg: number;
  vitamin_b6_mg: number;
  vitamin_b12_ug: number;
  vitamin_c_mg: number;
  vitamin_d_ug: number;
  vitamin_e_mg: number;
  vitamin_k_ug: number;
  folic_acid_ug: number;     // 葉酸
};

export function emptyNutrition(): NutritionTotals {
  return {
    // 基本栄養素
    calories_kcal: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    fiber_g: 0,
    sugar_g: 0,
    sodium_g: 0,
    
    // ミネラル
    potassium_mg: 0,
    calcium_mg: 0,
    phosphorus_mg: 0,
    magnesium_mg: 0,
    iron_mg: 0,
    zinc_mg: 0,
    iodine_ug: 0,
    
    // 脂質詳細
    saturated_fat_g: 0,
    monounsaturated_fat_g: 0,
    polyunsaturated_fat_g: 0,
    cholesterol_mg: 0,
    
    // ビタミン
    vitamin_a_ug: 0,
    vitamin_b1_mg: 0,
    vitamin_b2_mg: 0,
    vitamin_b6_mg: 0,
    vitamin_b12_ug: 0,
    vitamin_c_mg: 0,
    vitamin_d_ug: 0,
    vitamin_e_mg: 0,
    vitamin_k_ug: 0,
    folic_acid_ug: 0,
  };
}

// 食材名の正規化（dataset_ingredients 側の正規化に合わせる）
export function normalizeIngredientNameJs(name: string): string {
  return String(name ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（）()]/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

// 水系食材は栄養計算をスキップ
export function isWaterishIngredient(raw: string): boolean {
  const n = normalizeIngredientNameJs(raw);
  if (!n) return false;
  if (n === "水" || n === "お湯" || n === "湯" || n === "熱湯") return true;
  if (n.startsWith("水")) return true;
  return false;
}

// よく使う調味料・食材のエイリアス（LLMが生成する名前 → DB上の名前）
export const INGREDIENT_ALIASES: Record<string, string[]> = {
  // 調味料
  "醤油": ["しょうゆ", "こいくちしょうゆ", "濃口醤油"],
  "しょうゆ": ["醤油", "こいくちしょうゆ"],
  "酢": ["穀物酢", "米酢", "食酢"],
  "みりん": ["本みりん", "みりん風調味料"],
  "料理酒": ["清酒", "日本酒"],
  "塩": ["食塩", "精製塩"],
  "砂糖": ["上白糖", "グラニュー糖"],
  "味噌": ["みそ", "米みそ", "合わせみそ"],
  // 油
  "ごま油": ["ごま油", "香味ごま油"],
  "サラダ油": ["調合油", "植物油"],
  "オリーブ油": ["オリーブオイル"],
  // 野菜
  "もやし": ["りょくとうもやし", "緑豆もやし", "大豆もやし"],
  "ねぎ": ["長ねぎ", "白ねぎ", "青ねぎ"],
  "にんにく": ["ガーリック"],
  "しょうが": ["生姜", "おろししょうが"],
  "生姜": ["しょうが", "おろししょうが"],
  "人参": ["にんじん"],
  "にんじん": ["人参"],
  "玉ねぎ": ["たまねぎ"],
  "たまねぎ": ["玉ねぎ"],
  // ごま
  "すりごま": ["ごま", "いりごま", "白ごま"],
  "いりごま": ["ごま", "すりごま", "白ごま"],
  "白ごま": ["ごま", "いりごま"],
  // だし
  "鶏がらスープの素": ["チキンブイヨン", "鶏がらだし"],
  "和風だし": ["かつおだし", "だしの素"],
  "中華だし": ["鶏がらスープ", "ウェイパー"],
  "だし汁": ["かつおだし", "だし"],
  "顆粒だし": ["だしの素", "ほんだし"],
  "かつおだし顆粒": ["だしの素", "ほんだし"],
  // 肉
  "鶏むね肉": ["若どり むね 皮なし", "鶏肉 むね"],
  "鶏もも肉": ["若どり もも", "鶏肉 もも"],
  "豚ひき肉": ["ぶた ひき肉"],
  "牛ひき肉": ["うし ひき肉"],
  "豚こま切れ肉": ["ぶた こま切れ", "豚肉"],
  "豚ロース薄切り": ["ぶた ロース", "豚肉"],
  "鶏ひき肉": ["若どり ひき肉"],
  // 魚（漢字⇔ひらがな変換）
  "鯖": ["さば", "まさば"],
  "鯖切り身": ["さば", "まさば"],
  "さば": ["鯖", "まさば"],
  "さば切り身": ["さば", "まさば"],
  "鮭": ["さけ", "しろさけ"],
  "鮭切り身": ["さけ", "しろさけ"],
  "鰤": ["ぶり"],
  "鰤切り身": ["ぶり"],
  // 卵
  "卵": ["鶏卵", "全卵", "たまご"],
  "たまご": ["鶏卵", "卵", "全卵"],
  // ご飯・米
  "ご飯": ["こめ めし", "精白米"],
  "白米": ["こめ めし", "精白米"],
  "麦ご飯": ["おおむぎ", "押麦"],
  "玄米ご飯": ["こめ めし 玄米"],
};

// 栄養値を加算するヘルパー関数
export function addNutritionFromMatch(totals: NutritionTotals, matched: any, amount_g: number) {
  const factor = amount_g / 100.0;
  const add = (key: keyof NutritionTotals, v: number | string | null | undefined) => {
    // DBからの値は文字列の場合があるので、parseFloatで変換
    const num = typeof v === 'string' ? parseFloat(v) : v;
    if (num != null && Number.isFinite(num)) {
      totals[key] += num * factor;
    }
  };

  // 基本栄養素（DBに存在するカラムのみ）
  add("calories_kcal", matched.calories_kcal);
  add("protein_g", matched.protein_g);
  add("fat_g", matched.fat_g);
  add("carbs_g", matched.carbs_g);
  add("fiber_g", matched.fiber_g);
  // sugar_g: DBに存在しないので計算しない（常に0）
  add("sodium_g", matched.salt_eq_g);        // 塩分相当量
  
  // ミネラル
  add("potassium_mg", matched.potassium_mg);
  add("calcium_mg", matched.calcium_mg);
  add("phosphorus_mg", matched.phosphorus_mg);
  add("magnesium_mg", matched.magnesium_mg);
  add("iron_mg", matched.iron_mg);
  add("zinc_mg", matched.zinc_mg);
  add("iodine_ug", matched.iodine_ug);
  
  // 脂質詳細（saturated/mono/poly unsaturated_fat_gはDBに存在しない）
  add("cholesterol_mg", matched.cholesterol_mg);
  
  // ビタミン
  add("vitamin_a_ug", matched.vitamin_a_ug);
  add("vitamin_b1_mg", matched.vitamin_b1_mg);
  add("vitamin_b2_mg", matched.vitamin_b2_mg);
  add("vitamin_b6_mg", matched.vitamin_b6_mg);
  add("vitamin_b12_ug", matched.vitamin_b12_ug);
  add("vitamin_c_mg", matched.vitamin_c_mg);
  add("vitamin_d_ug", matched.vitamin_d_ug);
  add("vitamin_e_mg", matched.vitamin_e_alpha_mg);  // DB: vitamin_e_alpha_mg → 型: vitamin_e_mg
  add("vitamin_k_ug", matched.vitamin_k_ug);
  add("folic_acid_ug", matched.folic_acid_ug);
}

// LLMでマッチング結果を検証（明らかな間違いを弾く）
async function validateMatchesWithLLM(
  matches: Array<{ inputName: string; matchedName: string; idx: number }>
): Promise<Set<number>> {
  if (matches.length === 0) return new Set();
  
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    console.warn("[nutrition] No API key for LLM validation, skipping");
    return new Set();
  }
  
  // バッチで検証（最大20件ずつ）
  const invalidIndices = new Set<number>();
  const batchSize = 20;
  
  for (let i = 0; i < matches.length; i += batchSize) {
    const batch = matches.slice(i, i + batchSize);
    const prompt = `以下の食材マッチング結果を検証してください。
「入力食材名」と「マッチした食材名」が明らかに異なる食材の場合は "NG" と判定してください。
同じ食材、または調理形態の違い（生/茹で等）、部位の違い程度なら "OK" です。

${batch.map((m, j) => `${j + 1}. 入力:「${m.inputName}」→ マッチ:「${m.matchedName}」`).join("\n")}

各行について OK または NG だけを答えてください。例: "1. OK\n2. NG\n3. OK"`;

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5-mini",
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: 200,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content ?? "";
        const lines = content.split("\n");
        
        for (let j = 0; j < batch.length; j++) {
          const line = lines[j] ?? "";
          if (line.includes("NG")) {
            invalidIndices.add(batch[j].idx);
            console.log(`[nutrition] LLM rejected: 「${batch[j].inputName}」→「${batch[j].matchedName}」`);
          }
        }
      }
    } catch (e: any) {
      console.warn("[nutrition] LLM validation failed:", e?.message);
    }
  }
  
  return invalidIndices;
}

// LLMに候補リストから最適なマッチを選んでもらう（リトライ付き）
async function selectBestMatchWithLLM(
  inputName: string,
  candidates: Array<{ id: string; name: string; name_norm: string; similarity: number }>
): Promise<number> {
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return 0; // 1件なら選択の余地なし
  
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    console.warn("[nutrition] No API key for LLM selection, using first candidate");
    return 0;
  }
  
  const MAX_RETRIES = 3;
  const candidateList = candidates.map((c, i) => `${i + 1}. ${c.name} (類似度: ${(c.similarity * 100).toFixed(0)}%)`).join("\n");
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // リトライ時はより明確な指示を追加
    const retryHint = attempt > 1 ? `\n\n※前回の回答が数字として認識できませんでした。必ず半角数字1文字だけで回答してください。` : "";
    
    const prompt = `あなたは日本の食品データベースの専門家です。

料理で使われる食材「${inputName}」に最も適切な食品データベースエントリを選んでください。

【候補】
${candidateList}

【重要なルール】
- 料理に使う「${inputName}」として最も自然なものを選ぶ
- **調理状態を考慮**: ご飯・麦ご飯など「炊いた状態」で使う食材は「めし」「ゆで」を選ぶ。「乾」は乾燥状態でカロリーが3倍近く高いので避ける
- 明らかに全く異なる食材しかない場合は「0」と答える
- **数字だけで答える**（例: 「2」）- 説明は不要${retryHint}

回答:`;

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5-mini",
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: 10,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const content = (data.choices?.[0]?.message?.content ?? "").trim();
        
        // 数字を抽出（文字列の中から最初の数字を探す）
        const numMatch = content.match(/\d+/);
        const num = numMatch ? parseInt(numMatch[0], 10) : NaN;
        
        if (num === 0) {
          console.log(`[nutrition] LLM: 「${inputName}」→ 全候補却下 (attempt ${attempt})`);
          return -1;
        }
        
        if (num >= 1 && num <= candidates.length) {
          console.log(`[nutrition] LLM: 「${inputName}」→ ${num}番「${candidates[num - 1].name}」を選択 (attempt ${attempt})`);
          return num - 1;
        }
        
        // パース失敗 - リトライ
        console.warn(`[nutrition] LLM response parse failed for "${inputName}" (attempt ${attempt}): "${content}"`);
      } else {
        const errorText = await res.text().catch(() => "unknown");
        console.warn(`[nutrition] LLM API error for "${inputName}" (attempt ${attempt}): ${res.status} - ${errorText}`);
      }
    } catch (e: any) {
      console.warn(`[nutrition] LLM selection failed for "${inputName}" (attempt ${attempt}):`, e?.message);
    }
    
    // リトライ前に少し待機（最後の試行では待たない）
    if (attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // 全リトライ失敗 - フォールバック: 最初の候補を使用
  console.log(`[nutrition] LLM selection fallback after ${MAX_RETRIES} retries: using first candidate for "${inputName}"`);
  return 0;
}

// Embedding API を呼び出す
export async function embedTexts(texts: string[], dimensions = 1536): Promise<number[][]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OpenAI API Key is missing");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-large",
      input: texts,
      dimensions,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Embeddings API error: ${t}`);
  }
  const json = await res.json();
  const data = json?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error("Embeddings API returned invalid data");
  }
  return data.map((d: any) => d?.embedding) as number[][];
}

// DBに実際に存在するカラムのみを選択
// 存在しないカラム: sugar_g, saturated_fat_g, monounsaturated_fat_g, polyunsaturated_fat_g
const INGREDIENT_SELECT = `
  id, name, name_norm,
  calories_kcal, protein_g, fat_g, carbs_g, fiber_g, salt_eq_g,
  potassium_mg, calcium_mg, phosphorus_mg, magnesium_mg, iron_mg, zinc_mg, iodine_ug,
  cholesterol_mg,
  vitamin_a_ug, vitamin_b1_mg, vitamin_b2_mg, vitamin_b6_mg, vitamin_b12_ug,
  folic_acid_ug, vitamin_c_mg, vitamin_d_ug, vitamin_k_ug, vitamin_e_alpha_mg
`.replace(/\s+/g, " ").trim();

// よく使う食材の正確な name_norm マッピング（DBの正確な値を使用）
// LLMが出力する名前 → DBのname_norm（DBから取得した正確な値）
export const EXACT_NAME_NORM_MAP: Record<string, string> = {
  // 調味料 - しょうゆ
  "醤油": "＜調味料類＞しょうゆ類こいくちしょうゆ",
  "しょうゆ": "＜調味料類＞しょうゆ類こいくちしょうゆ",
  "しょう油": "＜調味料類＞しょうゆ類こいくちしょうゆ",
  "濃口醤油": "＜調味料類＞しょうゆ類こいくちしょうゆ",
  "薄口醤油": "＜調味料類＞しょうゆ類うすくちしょうゆ",
  "うすくちしょうゆ": "＜調味料類＞しょうゆ類うすくちしょうゆ",
  
  // 調味料 - 酒・みりん
  "酒": "＜アルコール飲料類＞混成酒類合成清酒",
  "料理酒": "＜アルコール飲料類＞混成酒類合成清酒",
  "清酒": "＜アルコール飲料類＞混成酒類合成清酒",
  "日本酒": "＜アルコール飲料類＞混成酒類合成清酒",
  "みりん": "＜アルコール飲料類＞混成酒類みりん本みりん",
  "本みりん": "＜アルコール飲料類＞混成酒類みりん本みりん",
  
  // 調味料 - 油
  "サラダ油": "植物油脂類調合油",
  "調合油": "植物油脂類調合油",
  "植物油": "植物油脂類調合油",
  "油": "植物油脂類調合油",
  "ごま油": "植物油脂類ごま油",
  "オリーブ油": "植物油脂類オリーブ油",
  "オリーブオイル": "植物油脂類オリーブ油",
  
  // 調味料 - 砂糖（正確なname_norm: 砂糖類車糖上白糖）
  "砂糖": "砂糖類車糖上白糖",
  "上白糖": "砂糖類車糖上白糖",
  "グラニュー糖": "砂糖類グラニュー糖",
  
  // 調味料 - 味噌
  "味噌": "＜調味料類＞みそ類米みそ甘みそ",
  "みそ": "＜調味料類＞みそ類米みそ甘みそ",
  "合わせ味噌": "＜調味料類＞みそ類米みそ甘みそ",
  
  // 調味料 - 塩
  "塩": "＜調味料類＞食塩類食塩",
  "食塩": "＜調味料類＞食塩類食塩",
  
  // 調味料 - 酢
  "酢": "＜調味料類＞食酢類穀物酢",
  "穀物酢": "＜調味料類＞食酢類穀物酢",
  "米酢": "＜調味料類＞食酢類米酢",
  "黒酢": "＜調味料類＞食酢類黒酢",  // 54kcal/100g
  
  // 調味料 - だし類（顆粒・固形は高カロリー、液体だしは低カロリーなので注意）
  "鶏がらスープの素": "＜調味料類＞だし類顆粒中華だし",  // 210kcal/100g（顆粒）※「鶏がらだし」(7kcal)は液体なので別物！
  "中華だし": "＜調味料類＞だし類顆粒中華だし",
  "中華だし顆粒": "＜調味料類＞だし類顆粒中華だし",  // AIが出力するバリエーション
  "中華スープの素": "＜調味料類＞だし類顆粒中華だし",
  "顆粒中華だし": "＜調味料類＞だし類顆粒中華だし",
  "鶏ガラスープの素": "＜調味料類＞だし類顆粒中華だし",
  "チキンスープの素": "＜調味料類＞だし類顆粒中華だし",
  "和風だしの素": "＜調味料類＞だし類顆粒和風だし",  // 223kcal/100g
  "顆粒和風だし": "＜調味料類＞だし類顆粒和風だし",
  "ほんだし": "＜調味料類＞だし類顆粒和風だし",
  "かつおだしの素": "＜調味料類＞だし類顆粒和風だし",
  "コンソメ": "＜調味料類＞だし類固形ブイヨン",  // 233kcal/100g
  "固形コンソメ": "＜調味料類＞だし類固形ブイヨン",
  "ブイヨン": "＜調味料類＞だし類固形ブイヨン",
  "固形ブイヨン": "＜調味料類＞だし類固形ブイヨン",
  
  // ごま
  "すりごま": "ごまむき",  // 570kcal/100g
  "すり胡麻": "ごまむき",
  "白すりごま": "ごまむき",
  "いりごま": "ごまいり",  // 605kcal/100g
  "炒りごま": "ごまいり",
  "白いりごま": "ごまいり",
  "黒いりごま": "ごまいり",
  "白ごま": "ごまいり",  // 「白ごま」も炒りごまとして扱う
  "黒ごま": "ごまいり",
  "ねりごま": "ごまねり",  // 646kcal/100g
  "練りごま": "ごまねり",
  
  // 野菜
  "玉ねぎ": "たまねぎ類たまねぎりん茎生",
  "たまねぎ": "たまねぎ類たまねぎりん茎生",
  "玉葱": "たまねぎ類たまねぎりん茎生",
  "人参": "にんじん類にんじん根皮なし生",
  "にんじん": "にんじん類にんじん根皮なし生",
  "ほうれん草": "ほうれんそう葉冬採り生",
  "ほうれんそう": "ほうれんそう葉冬採り生",
  "小松菜": "こまつな葉生",
  "ごぼう": "ごぼう根生",
  "牛蒡": "ごぼう根生",
  "ねぎ": "ねぎ類根深ねぎ葉軟白生",
  "長ねぎ": "ねぎ類根深ねぎ葉軟白生",
  "白ねぎ": "ねぎ類根深ねぎ葉軟白生",
  "大根": "だいこん類だいこん根皮つき生",
  "だいこん": "だいこん類だいこん根皮つき生",
  "キャベツ": "キャベツ類キャベツ結球葉生",
  "白菜": "はくさい結球葉生",  // 13kcal/100g - 芽キャベツ(52kcal)と間違えないこと！
  "はくさい": "はくさい結球葉生",
  "ハクサイ": "はくさい結球葉生",
  "なす": "なす類なす果実生",
  "ナス": "なす類なす果実生",
  "茄子": "なす類なす果実生",
  "ピーマン": "ピーマン類青ピーマン果実生",
  "しょうが": "しょうが類しょうが根茎皮なし生",
  "生姜": "しょうが類しょうが根茎皮なし生",
  "にんにく": "にんにく類にんにくりん茎生",
  "ニンニク": "にんにく類にんにくりん茎生",
  "れんこん": "れんこん根茎生",  // 66kcal/100g
  "蓮根": "れんこん根茎生",
  "レンコン": "れんこん根茎生",
  "ブロッコリー": "ブロッコリー花序生",  // 37kcal/100g（生）
  "ぶろっこりー": "ブロッコリー花序生",
  
  // 海藻
  "乾燥わかめ": "わかめ乾燥わかめ素干し水戻し",  // 22kcal/100g（水戻し状態）
  "乾燥ワカメ": "わかめ乾燥わかめ素干し水戻し",
  "カットわかめ": "わかめ乾燥わかめ素干し水戻し",
  
  // 魚（name_normでは「・」がないことに注意！）
  "鯖": "＜魚類＞さば類まさば生",
  "さば": "＜魚類＞さば類まさば生",
  "サバ": "＜魚類＞さば類まさば生",
  "鯖切り身": "＜魚類＞さば類まさば生",
  "さば切り身": "＜魚類＞さば類まさば生",
  "鮭": "＜魚類＞さけます類しろさけ生",
  "さけ": "＜魚類＞さけます類しろさけ生",
  "サケ": "＜魚類＞さけます類しろさけ生",
  "生鮭": "＜魚類＞さけます類しろさけ生",
  "鮭切り身": "＜魚類＞さけます類しろさけ生",
  "銀鮭": "＜魚類＞さけます類ぎんざけ養殖生",
  "ぎんざけ": "＜魚類＞さけます類ぎんざけ養殖生",
  "鰤": "＜魚類＞ぶり成魚生",
  "ぶり": "＜魚類＞ぶり成魚生",
  "ブリ": "＜魚類＞ぶり成魚生",
  
  // 肉（name_normでは「・」がないことに注意！）
  "鶏もも肉": "＜鳥肉類＞にわとり［若どり主品目］もも皮つき生",
  "鶏モモ肉": "＜鳥肉類＞にわとり［若どり主品目］もも皮つき生",
  "鶏むね肉": "＜鳥肉類＞にわとり［若どり主品目］むね皮つき生",
  "鶏胸肉": "＜鳥肉類＞にわとり［若どり主品目］むね皮つき生",
  "豚ロース": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",
  "豚ロース肉": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",
  "豚ロース薄切り": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",
  "豚ロース薄切り肉": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",
  "豚ロース切り落とし": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",
  "豚肉ロース": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",
  "豚薄切り肉": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",  // 部位不明の薄切りはロースとして扱う
  "豚薄切り": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",
  "豚うす切り肉": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",
  "豚切り落とし": "＜畜肉類＞ぶた［大型種肉］ロース脂身つき生",
  "豚バラ肉": "＜畜肉類＞ぶた［大型種肉］ばら脂身つき生",
  "豚バラ": "＜畜肉類＞ぶた［大型種肉］ばら脂身つき生",
  "豚バラ薄切り": "＜畜肉類＞ぶた［大型種肉］ばら脂身つき生",
  "豚バラ薄切り肉": "＜畜肉類＞ぶた［大型種肉］ばら脂身つき生",
  "豚こま切れ肉": "＜畜肉類＞ぶた［大型種肉］かた脂身つき生",
  "豚こま肉": "＜畜肉類＞ぶた［大型種肉］かた脂身つき生",
  "豚こま": "＜畜肉類＞ぶた［大型種肉］かた脂身つき生",
  "豚肉": "＜畜肉類＞ぶた［大型種肉］かた脂身つき生",
  "豚もも肉": "＜畜肉類＞ぶた［大型種肉］もも脂身つき生",
  "豚モモ肉": "＜畜肉類＞ぶた［大型種肉］もも脂身つき生",
  "豚ひき肉": "＜畜肉類＞ぶた［ひき肉］生",
  "豚挽き肉": "＜畜肉類＞ぶた［ひき肉］生",
  
  // 卵
  "卵": "鶏卵全卵生",
  "たまご": "鶏卵全卵生",
  "鶏卵": "鶏卵全卵生",
  
  // 豆腐・大豆製品（name_normでは「・」がないことに注意！）
  "豆腐": "だいず［豆腐油揚げ類］木綿豆腐",
  "木綿豆腐": "だいず［豆腐油揚げ類］木綿豆腐",
  "絹ごし豆腐": "だいず［豆腐油揚げ類］絹ごし豆腐",
  "油揚げ": "だいず［豆腐油揚げ類］油揚げ生",
  
  // 海藻
  "わかめ": "わかめ乾燥わかめ素干し水戻し",
  "乾燥わかめ": "わかめ乾燥わかめ素干し水戻し",
  
  // ツナ・缶詰
  "ツナ": "＜魚類＞まぐろ類缶詰油漬フレークホワイト",
  "ツナ缶": "＜魚類＞まぐろ類缶詰油漬フレークホワイト",
  
  // 柑橘類
  "ゆず果汁": "かんきつ類ゆず果汁生",
  "柚子果汁": "かんきつ類ゆず果汁生",
  "レモン": "かんきつ類レモン全果生",
  "レモン汁": "かんきつ類レモン果汁生",
  
  // だし
  "だし": "＜調味料類＞だし類かつおだし荒節",
  "だし汁": "＜調味料類＞だし類かつおだし荒節",
  "顆粒だし": "＜調味料類＞だし類かつおだし荒節",
  "かつおだし": "＜調味料類＞だし類かつおだし荒節",
  
  // ご飯・米（「めし」= 炊いた状態、「乾」= 乾燥状態 の区別が重要！）
  "ご飯": "こめ［水稲めし］精白米うるち米",
  "白米": "こめ［水稲めし］精白米うるち米",
  "白ご飯": "こめ［水稲めし］精白米うるち米",
  "麦ご飯": "おおむぎ押麦めし",  // 炊いた状態: 118kcal/100g（乾燥状態は329kcal/100gなので注意！）
  "麦飯": "おおむぎ押麦めし",
  "押麦": "おおむぎ押麦めし",     // 「押麦」単体も炊いた状態として扱う（麦ご飯の材料として使用されるため）
  "押麦ご飯": "おおむぎ押麦めし",
  "もち麦ご飯": "おおむぎ押麦めし",
  "もち麦": "おおむぎ押麦めし",   // もち麦も炊いた状態として扱う
  
  // 玄米（炊いた状態: 152kcal/100g、乾燥穀粒は346kcalなので注意）
  "玄米ご飯": "こめ［水稲めし］玄米",
  "玄米": "こめ［水稲めし］玄米",
  "玄米（炊いた）": "こめ［水稲めし］玄米",  // AIが出力するバリエーション
  "発芽玄米ご飯": "こめ［水稲めし］発芽玄米",
  "発芽玄米": "こめ［水稲めし］発芽玄米",
};

export async function calculateNutritionFromIngredients(
  supabase: any,
  ingredients: Array<{ name: string; amount_g: number; note?: string }>
): Promise<NutritionTotals> {
  const totals = emptyNutrition();
  
  // 入力を詳細にログ
  console.log(`[nutrition] INPUT: ingredients=${JSON.stringify(ingredients?.slice(0, 3) ?? null)}...`);
  
  if (!ingredients || ingredients.length === 0) {
    console.log("[nutrition] No ingredients provided");
    return totals;
  }

  // 水系食材を除外した材料リスト
  const validIngredients = ingredients.filter(i => !isWaterishIngredient(i.name) && i.amount_g > 0);
  console.log(`[nutrition] Valid: ${validIngredients.length}/${ingredients.length} - ${validIngredients.slice(0, 5).map(i => `${i.name}(${i.amount_g}g)`).join(", ")}`);
  
  if (validIngredients.length === 0) return totals;

  // 検索候補を生成（EXACT_NAME_NORM_MAP + エイリアス + 正規化名）
  const searchCandidates: string[] = [];
  for (const ing of validIngredients) {
    const name = ing.name;
    // 1. EXACT_NAME_NORM_MAP に登録されている正確な name_norm を追加
    const exactNorm = EXACT_NAME_NORM_MAP[name];
    if (exactNorm) {
      searchCandidates.push(exactNorm);
    }
    // 2. 正規化した名前を追加
    searchCandidates.push(normalizeIngredientNameJs(name));
    // 3. エイリアスも追加
    const aliases = INGREDIENT_ALIASES[name] ?? [];
    for (const alias of aliases) {
      const aliasExactNorm = EXACT_NAME_NORM_MAP[alias];
      if (aliasExactNorm) {
        searchCandidates.push(aliasExactNorm);
      }
      searchCandidates.push(normalizeIngredientNameJs(alias));
    }
  }
  const uniqueNorms = Array.from(new Set(searchCandidates)).filter(Boolean);
  console.log(`[nutrition] Search candidates (${uniqueNorms.length}): ${uniqueNorms.slice(0, 10).join(", ")}${uniqueNorms.length > 10 ? "..." : ""}`);

  // 完全一致検索（EXACT_NAME_NORM_MAP + エイリアスを含む）
  const { data: exactRows, error: exactErr } = await supabase
    .from("dataset_ingredients")
    .select(INGREDIENT_SELECT)
    .in("name_norm", uniqueNorms);

  if (exactErr) {
    console.error("[nutrition] Failed to fetch ingredients:", exactErr.message);
    return totals;
  }
  
  console.log(`[nutrition] DB query returned: ${exactRows?.length ?? 0} rows`);
  if (exactRows && exactRows.length > 0) {
    console.log(`[nutrition] Matches: ${exactRows.slice(0, 5).map((r: any) => `${r.name_norm?.substring(0, 15)}(${r.calories_kcal}kcal)`).join(", ")}`);
  } else {
    console.log(`[nutrition] NO MATCHES! Candidates were: ${uniqueNorms.slice(0, 3).join(", ")}`);
  }

  // name_norm をキーにしたマップを作成
  const ingredientMap = new Map<string, any>();
  for (const row of exactRows ?? []) {
    if (row?.name_norm) ingredientMap.set(String(row.name_norm), row);
  }

  // マッチ結果を格納（検証前は栄養値を加算しない）
  type PendingMatch = {
    idx: number;
    ing: typeof validIngredients[0];
    matched: any;
    matchMethod: string;
    needsValidation: boolean; // 完全一致以外は検証が必要
  };
  const pendingMatches: PendingMatch[] = [];
  const matchResults: string[] = [];
  const unmatchedIngredients: { ing: typeof validIngredients[0]; idx: number }[] = [];

  // Phase 1: 各食材についてマッチングを試みる（栄養値はまだ加算しない）
  console.log(`[nutrition] === Phase 1: Matching ${validIngredients.length} ingredients ===`);
  
  for (let idx = 0; idx < validIngredients.length; idx++) {
    const ing = validIngredients[idx];
    let matched: any = null;
    let matchMethod = "none";
    let needsValidation = false;

    // 1. EXACT_NAME_NORM_MAP で正確なマッチングを試みる（最優先）
    const exactNormKey = EXACT_NAME_NORM_MAP[ing.name];
    console.log(`[nutrition] [${idx}] "${ing.name}" → MAP=${exactNormKey ? "found" : "NOT_FOUND"}`);
    
    if (exactNormKey) {
      matched = ingredientMap.get(exactNormKey);
      if (matched) {
        matchMethod = "exact_map";
        console.log(`[nutrition] [${idx}] ✅ exact_map: ${matched.calories_kcal}kcal/100g`);
      } else {
        console.log(`[nutrition] [${idx}] ⚠️ MAP key found but DB miss! key="${exactNormKey.substring(0, 30)}..."`);
      }
    }

    // 2. 正規化名で完全一致を試みる
    if (!matched) {
      const norm = normalizeIngredientNameJs(ing.name);
      matched = ingredientMap.get(norm);
      if (matched) {
        matchMethod = "exact";
        console.log(`[nutrition] [${idx}] ✅ exact: norm="${norm}" → ${matched.calories_kcal}kcal/100g`);
      }
    }

    // 3. エイリアス経由で EXACT_NAME_NORM_MAP を試みる
    if (!matched) {
      const aliases = INGREDIENT_ALIASES[ing.name] ?? [];
      for (const alias of aliases) {
        const aliasExactNorm = EXACT_NAME_NORM_MAP[alias];
        if (aliasExactNorm) {
          matched = ingredientMap.get(aliasExactNorm);
          if (matched) {
            matchMethod = `alias_map(${alias})`;
            console.log(`[nutrition] [${idx}] ✅ alias_map: "${alias}" → ${matched.calories_kcal}kcal/100g`);
            break;
          }
        }
      }
    }

    // 4. エイリアスで正規化名の完全一致を試みる
    if (!matched) {
      const aliases = INGREDIENT_ALIASES[ing.name] ?? [];
      for (const alias of aliases) {
        const aliasNorm = normalizeIngredientNameJs(alias);
        matched = ingredientMap.get(aliasNorm);
        if (matched) {
          matchMethod = `alias(${alias})`;
          console.log(`[nutrition] [${idx}] ✅ alias: "${alias}" → ${matched.calories_kcal}kcal/100g`);
          break;
        }
      }
    }

    // 完全一致がなければベクトル検索対象に追加
    if (!matched) {
      console.log(`[nutrition] [${idx}] ❌ UNMATCHED → will try vector search`);
      unmatchedIngredients.push({ ing, idx });
      continue;
    }
    
    pendingMatches.push({ idx, ing, matched, matchMethod, needsValidation });
  }
  
  console.log(`[nutrition] Phase 1 result: ${pendingMatches.length} matched, ${unmatchedIngredients.length} unmatched`);

  // Phase 2: ベクトル検索 + LLM選択（完全一致しなかった食材に対して）
  if (unmatchedIngredients.length > 0) {
    console.log(`[nutrition] === Phase 2: Vector search + LLM selection for ${unmatchedIngredients.length} ingredients ===`);
    try {
      const texts = unmatchedIngredients.map(u => u.ing.name);
      const embeddings = await embedTexts(texts, 1536);
      
      // 並列でベクトル検索を実行
      const searchResults = await Promise.all(
        unmatchedIngredients.map(async ({ ing }, i) => {
          const emb = embeddings[i];
          const { data: rows, error: embErr } = await supabase.rpc("search_dataset_ingredients_by_embedding", {
            query_embedding: emb,
            match_count: 5,
          });
          return { ing, rows: embErr ? [] : (rows ?? []) };
        })
      );
      
      // 各食材について、LLMに最適な候補を選んでもらう
      for (let i = 0; i < unmatchedIngredients.length; i++) {
        const { ing, idx } = unmatchedIngredients[i];
        const rows = searchResults[i].rows;
        
        if (rows.length === 0) {
          console.log(`[nutrition] [${idx}] "${ing.name}": no vector search results`);
          matchResults[idx] = `${ing.name}(${ing.amount_g}g) → UNMATCHED (no candidates)`;
          continue;
        }
        
        // 類似度0.1以上の候補のみ
        const validCandidates = rows.filter((r: any) => r.similarity >= 0.1);
        if (validCandidates.length === 0) {
          console.log(`[nutrition] [${idx}] "${ing.name}": all candidates below threshold`);
          matchResults[idx] = `${ing.name}(${ing.amount_g}g) → UNMATCHED (low similarity)`;
          continue;
        }
        
        console.log(`[nutrition] [${idx}] "${ing.name}": ${validCandidates.length} candidates - ${validCandidates.map((c: any) => `${c.name?.substring(0, 15)}(${(c.similarity * 100).toFixed(0)}%)`).join(", ")}`);
        
        // LLMに最適な候補を選んでもらう
        const selectedIdx = await selectBestMatchWithLLM(ing.name, validCandidates);
        
        if (selectedIdx === -1) {
          // LLMが全候補を却下
          matchResults[idx] = `${ing.name}(${ing.amount_g}g) → UNMATCHED (LLM rejected all)`;
          continue;
        }
        
        const selected = validCandidates[selectedIdx];
        
        // 選択された候補の詳細データを取得
        const { data: row } = await supabase
          .from("dataset_ingredients")
          .select(INGREDIENT_SELECT)
          .eq("id", selected.id)
          .maybeSingle();
        
        if (row) {
          pendingMatches.push({
            idx,
            ing,
            matched: row,
            matchMethod: `vector+llm(${selected.similarity?.toFixed(2) ?? "?"})`,
            needsValidation: false, // LLMが選んだので検証不要
          });
        } else {
          matchResults[idx] = `${ing.name}(${ing.amount_g}g) → UNMATCHED (DB fetch failed)`;
        }
      }
    } catch (e: any) {
      console.error("[nutrition] Vector search + LLM selection failed:", e?.message ?? e);
      for (const { ing, idx } of unmatchedIngredients) {
        matchResults[idx] = `${ing.name}(${ing.amount_g}g) → UNMATCHED (error)`;
      }
    }
  }
  
  console.log(`[nutrition] After Phase 2: ${pendingMatches.length} total matches`);

  // Phase 3: LLM検証（完全一致以外のマッチを検証）- ベクトル検索はLLMが選んだので検証不要
  const matchesToValidate = pendingMatches.filter(m => m.needsValidation);
  let invalidIndices = new Set<number>();
  
  if (matchesToValidate.length > 0) {
    console.log(`[nutrition] Validating ${matchesToValidate.length} fuzzy matches with LLM...`);
    invalidIndices = await validateMatchesWithLLM(
      matchesToValidate.map(m => ({
        inputName: m.ing.name,
        matchedName: m.matched.name,
        idx: m.idx,
      }))
    );
    if (invalidIndices.size > 0) {
      console.log(`[nutrition] LLM rejected ${invalidIndices.size} matches`);
    }
  }

  // Phase 4: 検証を通過したマッチのみ栄養値を加算
  console.log(`[nutrition] === Phase 4: Calculating nutrition from ${pendingMatches.length} matches ===`);
  let runningTotal = 0;
  
  for (const m of pendingMatches) {
    if (invalidIndices.has(m.idx)) {
      matchResults[m.idx] = `${m.ing.name}(${m.ing.amount_g}g) → ${m.matched.name}[${m.matchMethod}] ❌ LLM却下`;
      console.log(`[nutrition] ❌ ${m.ing.name}: LLM rejected match`);
      continue;
    }

    // 計算詳細を出力
    const calPer100g = parseFloat(m.matched.calories_kcal) || 0;
    const amount = m.ing.amount_g;
    const calcCal = (calPer100g * amount) / 100;
    runningTotal += calcCal;
    
    console.log(`[nutrition] ✅ ${m.ing.name}: ${amount}g × ${calPer100g}kcal/100g = ${Math.round(calcCal)}kcal (累計: ${Math.round(runningTotal)}kcal)`);
    
    matchResults[m.idx] = `${m.ing.name}(${m.ing.amount_g}g) → ${m.matched.name}[${m.matchMethod}](${m.matched.calories_kcal}kcal/100g)`;
    addNutritionFromMatch(totals, m.matched, m.ing.amount_g);
  }

  // ログ出力
  const validResults = matchResults.filter(Boolean);
  console.log(`[nutrition] === FINAL RESULT ===`);
  console.log(`[nutrition] Matched: ${validResults.length}/${validIngredients.length} ingredients`);
  console.log(`[nutrition] Total: ${Math.round(totals.calories_kcal)}kcal, P:${totals.protein_g.toFixed(1)}g, F:${totals.fat_g.toFixed(1)}g, C:${totals.carbs_g.toFixed(1)}g`);

  return totals;
}

// ===================================
// 参照レシピとの妥当性検証・調整機能
// ===================================

// 参照レシピの栄養情報の型
export type ReferenceNutrition = {
  name: string;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  sodium_g: number | null;
};

// 検証結果の型
export type NutritionValidationResult = {
  isValid: boolean;           // 妥当かどうか
  calculatedCalories: number; // 計算したカロリー
  referenceCalories: number;  // 参照元のカロリー
  deviationPercent: number;   // 乖離率（%）
  adjustedNutrition: NutritionTotals | null;  // 調整後の栄養値（調整した場合）
  referenceSource: string;    // 参照元（dataset_recipes or dataset_menu_sets）
  message: string;            // 検証メッセージ
};

// 料理名から参照レシピを検索
async function findReferenceRecipe(
  supabase: any,
  dishName: string
): Promise<ReferenceNutrition | null> {
  // 料理名の主要キーワードを抽出（マッチング精度向上用）
  const getKeywords = (name: string): string[] => {
    // 括弧内を除去し、主要な単語を抽出
    const cleaned = name.replace(/[（()）]/g, "").replace(/の|と|風|仕立て|焼き方|炊き方/g, " ");
    return cleaned.split(/[\s　・、]+/).filter(w => w.length >= 2);
  };
  
  const dishKeywords = getKeywords(dishName);
  
  // 1. dataset_recipesからtrigram類似検索
  try {
    const { data: recipes, error: recipeErr } = await supabase.rpc("search_similar_dataset_recipes", {
      query_name: dishName,
      similarity_threshold: 0.15, // 適度な閾値
      result_limit: 5, // 候補を増やして最適な参照を見つける
    });

    if (!recipeErr && Array.isArray(recipes) && recipes.length > 0) {
      // 複数候補から最も関連性の高いものを選ぶ
      for (const recipe of recipes) {
        const { data: recipeDetail, error: detailErr } = await supabase
          .from("dataset_recipes")
          .select("name, calories_kcal, protein_g, fat_g, carbs_g, sodium_g")
          .eq("id", recipe.id)
          .maybeSingle();
        
        if (!detailErr && recipeDetail && recipeDetail.calories_kcal) {
          const refKeywords = getKeywords(recipeDetail.name);
          
          // キーワードの一致度をチェック（少なくとも1つのキーワードが一致すること）
          const hasMatchingKeyword = dishKeywords.some(dk => 
            refKeywords.some(rk => dk.includes(rk) || rk.includes(dk))
          );
          
          // 「ご飯」「白米」「麦ご飯」などの基本料理は特別処理
          const isBasicRice = /ご飯|白米|麦ご飯|玄米/.test(dishName);
          const refIsRice = /ご飯|炊き方|米/.test(recipeDetail.name);
          
          if (hasMatchingKeyword || (isBasicRice && refIsRice)) {
            console.log(`[nutrition-validate] Found reference in dataset_recipes: "${recipeDetail.name}" (${recipeDetail.calories_kcal}kcal)`);
            return {
              name: recipeDetail.name,
              calories_kcal: recipeDetail.calories_kcal,
              protein_g: recipeDetail.protein_g,
              fat_g: recipeDetail.fat_g,
              carbs_g: recipeDetail.carbs_g,
              sodium_g: recipeDetail.sodium_g,
            };
          }
        }
      }
    }
  } catch (e: any) {
    console.warn(`[nutrition-validate] Recipe search failed: ${e?.message}`);
  }

  // 2. dataset_menu_setsのdishes JSONBから検索
  try {
    // まず料理名で部分一致検索
    const searchTerm = dishName.length > 4 ? dishName.substring(0, 4) : dishName;
    const { data: menuSets, error: menuErr } = await supabase
      .from("dataset_menu_sets")
      .select("title, calories_kcal, protein_g, fat_g, carbs_g, sodium_g, dishes")
      .ilike("title", `%${searchTerm}%`)
      .not("calories_kcal", "is", null)
      .limit(5);
    
    if (!menuErr && Array.isArray(menuSets) && menuSets.length > 0) {
      // dishesの中から該当する料理を探す
      for (const menuSet of menuSets) {
        if (Array.isArray(menuSet.dishes)) {
          for (const dish of menuSet.dishes) {
            if (dish.name && dish.name.includes(searchTerm) && dish.calories_kcal) {
              console.log(`[nutrition-validate] Found reference in dataset_menu_sets dish: "${dish.name}" (${dish.calories_kcal}kcal)`);
              return {
                name: dish.name,
                calories_kcal: dish.calories_kcal,
                protein_g: dish.protein_g ?? null,
                fat_g: dish.fat_g ?? null,
                carbs_g: dish.carbs_g ?? null,
                sodium_g: dish.sodium_g ?? null,
              };
            }
          }
        }
      }
      
      // 料理が見つからない場合、献立全体のカロリーを参考にする
      // （1汁3菜の場合、主菜は約40-50%のカロリーと仮定）
      const firstSet = menuSets[0];
      if (firstSet.calories_kcal) {
        // 主菜っぽい名前かどうかチェック
        const isMainDish = /肉|魚|鯖|鮭|鶏|豚|牛|焼|炒|煮/.test(dishName);
        const estimatedRatio = isMainDish ? 0.4 : 0.15; // 主菜40%, 副菜15%
        const estimatedCal = Math.round(firstSet.calories_kcal * estimatedRatio);
        
        console.log(`[nutrition-validate] Estimated from menu set "${firstSet.title}": ~${estimatedCal}kcal (${estimatedRatio * 100}% of ${firstSet.calories_kcal}kcal)`);
        return {
          name: `${firstSet.title} (推定)`,
          calories_kcal: estimatedCal,
          protein_g: firstSet.protein_g ? firstSet.protein_g * estimatedRatio : null,
          fat_g: firstSet.fat_g ? firstSet.fat_g * estimatedRatio : null,
          carbs_g: firstSet.carbs_g ? firstSet.carbs_g * estimatedRatio : null,
          sodium_g: firstSet.sodium_g ? firstSet.sodium_g * estimatedRatio : null,
        };
      }
    }
  } catch (e: any) {
    console.warn(`[nutrition-validate] Menu set search failed: ${e?.message}`);
  }

  return null;
}

// 栄養値の妥当性を検証し、必要に応じて調整
export async function validateAndAdjustNutrition(
  supabase: any,
  dishName: string,
  calculatedNutrition: NutritionTotals,
  options?: {
    maxDeviationPercent?: number;  // 許容乖離率（デフォルト: 50%）
    useReferenceIfInvalid?: boolean;  // 不正の場合に参照元を使用（デフォルト: true）
  }
): Promise<NutritionValidationResult> {
  const maxDeviation = options?.maxDeviationPercent ?? 50;
  const useReference = options?.useReferenceIfInvalid ?? true;

  // 参照レシピを検索
  const reference = await findReferenceRecipe(supabase, dishName);
  
  if (!reference || !reference.calories_kcal) {
    // 参照レシピが見つからない場合、計算値をそのまま使用
    return {
      isValid: true,
      calculatedCalories: calculatedNutrition.calories_kcal,
      referenceCalories: 0,
      deviationPercent: 0,
      adjustedNutrition: null,
      referenceSource: "none",
      message: `参照レシピなし（計算値 ${Math.round(calculatedNutrition.calories_kcal)}kcal を使用）`,
    };
  }

  const refCal = reference.calories_kcal;
  const calcCal = calculatedNutrition.calories_kcal;
  
  // 乖離率を計算（参照値が0の場合は計算値が0より大きければ無限大とみなす）
  let deviationPercent = 0;
  if (refCal > 0) {
    deviationPercent = Math.abs((calcCal - refCal) / refCal) * 100;
  } else if (calcCal > 0) {
    deviationPercent = 100; // 参照が0で計算値が0より大きい
  }

  const isValid = deviationPercent <= maxDeviation;

  if (isValid) {
    console.log(`[nutrition-validate] ✅ "${dishName}": 計算=${Math.round(calcCal)}kcal, 参照=${refCal}kcal (乖離${deviationPercent.toFixed(1)}%) → 妥当`);
    return {
      isValid: true,
      calculatedCalories: calcCal,
      referenceCalories: refCal,
      deviationPercent,
      adjustedNutrition: null,
      referenceSource: "dataset_recipes",
      message: `妥当（計算=${Math.round(calcCal)}kcal, 参照=${refCal}kcal, 乖離${deviationPercent.toFixed(0)}%）`,
    };
  }

  // 不正な場合
  console.log(`[nutrition-validate] ⚠️ "${dishName}": 計算=${Math.round(calcCal)}kcal, 参照=${refCal}kcal (乖離${deviationPercent.toFixed(1)}%) → 不正`);

  if (useReference && reference) {
    // 参照元の値を使用して調整
    const adjustedNutrition = { ...calculatedNutrition };
    
    // カロリーに基づいてスケーリング係数を計算
    const scaleFactor = calcCal > 0 ? refCal / calcCal : 1;
    
    // 参照元の値があればそれを使用、なければスケーリング
    adjustedNutrition.calories_kcal = refCal;
    adjustedNutrition.protein_g = reference.protein_g ?? adjustedNutrition.protein_g * scaleFactor;
    adjustedNutrition.fat_g = reference.fat_g ?? adjustedNutrition.fat_g * scaleFactor;
    adjustedNutrition.carbs_g = reference.carbs_g ?? adjustedNutrition.carbs_g * scaleFactor;
    adjustedNutrition.sodium_g = reference.sodium_g ?? adjustedNutrition.sodium_g * scaleFactor;
    
    // その他の栄養素はスケーリング
    adjustedNutrition.fiber_g *= scaleFactor;
    adjustedNutrition.sugar_g *= scaleFactor;
    adjustedNutrition.potassium_mg *= scaleFactor;
    adjustedNutrition.calcium_mg *= scaleFactor;
    adjustedNutrition.phosphorus_mg *= scaleFactor;
    adjustedNutrition.magnesium_mg *= scaleFactor;
    adjustedNutrition.iron_mg *= scaleFactor;
    adjustedNutrition.zinc_mg *= scaleFactor;
    adjustedNutrition.iodine_ug *= scaleFactor;
    adjustedNutrition.cholesterol_mg *= scaleFactor;
    adjustedNutrition.saturated_fat_g *= scaleFactor;
    adjustedNutrition.monounsaturated_fat_g *= scaleFactor;
    adjustedNutrition.polyunsaturated_fat_g *= scaleFactor;
    adjustedNutrition.vitamin_a_ug *= scaleFactor;
    adjustedNutrition.vitamin_b1_mg *= scaleFactor;
    adjustedNutrition.vitamin_b2_mg *= scaleFactor;
    adjustedNutrition.vitamin_b6_mg *= scaleFactor;
    adjustedNutrition.vitamin_b12_ug *= scaleFactor;
    adjustedNutrition.vitamin_c_mg *= scaleFactor;
    adjustedNutrition.vitamin_d_ug *= scaleFactor;
    adjustedNutrition.vitamin_e_mg *= scaleFactor;
    adjustedNutrition.vitamin_k_ug *= scaleFactor;
    adjustedNutrition.folic_acid_ug *= scaleFactor;

    console.log(`[nutrition-validate] 📝 調整後: ${Math.round(adjustedNutrition.calories_kcal)}kcal (参照元「${reference.name}」を採用)`);

    return {
      isValid: false,
      calculatedCalories: calcCal,
      referenceCalories: refCal,
      deviationPercent,
      adjustedNutrition,
      referenceSource: "dataset_recipes",
      message: `調整済み（計算=${Math.round(calcCal)}kcal → 参照=${refCal}kcal に修正）`,
    };
  }

  return {
    isValid: false,
    calculatedCalories: calcCal,
    referenceCalories: refCal,
    deviationPercent,
    adjustedNutrition: null,
    referenceSource: "dataset_recipes",
    message: `要確認（計算=${Math.round(calcCal)}kcal, 参照=${refCal}kcal, 乖離${deviationPercent.toFixed(0)}%）`,
  };
}

// 複数の料理の栄養を一括検証・調整
export async function validateAndAdjustMultipleDishes(
  supabase: any,
  dishes: Array<{ name: string; nutrition: NutritionTotals }>,
  options?: {
    maxDeviationPercent?: number;
    useReferenceIfInvalid?: boolean;
  }
): Promise<Array<{ name: string; nutrition: NutritionTotals; validationResult: NutritionValidationResult }>> {
  const results: Array<{ name: string; nutrition: NutritionTotals; validationResult: NutritionValidationResult }> = [];
  
  console.log(`[nutrition-validate] Validating ${dishes.length} dishes...`);
  
  for (const dish of dishes) {
    const validationResult = await validateAndAdjustNutrition(
      supabase,
      dish.name,
      dish.nutrition,
      options
    );
    
    results.push({
      name: dish.name,
      nutrition: validationResult.adjustedNutrition ?? dish.nutrition,
      validationResult,
    });
  }
  
  const adjustedCount = results.filter(r => r.validationResult.adjustedNutrition !== null).length;
  if (adjustedCount > 0) {
    console.log(`[nutrition-validate] ${adjustedCount}/${dishes.length} dishes were adjusted based on reference recipes`);
  }
  
  return results;
}

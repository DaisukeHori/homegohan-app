// 栄養計算の共通ロジック

// 栄養計算用の型
export type NutritionTotals = {
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
  sodium_g: number;
  potassium_mg: number;
  calcium_mg: number;
  phosphorus_mg: number;
  iron_mg: number;
  zinc_mg: number;
  iodine_ug: number;
  cholesterol_mg: number;
  vitamin_b1_mg: number;
  vitamin_b2_mg: number;
  vitamin_b6_mg: number;
  vitamin_b12_ug: number;
  folic_acid_ug: number;
  vitamin_c_mg: number;
  vitamin_a_ug: number;
  vitamin_d_ug: number;
  vitamin_k_ug: number;
  vitamin_e_mg: number;
};

export function emptyNutrition(): NutritionTotals {
  return {
    calories_kcal: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    fiber_g: 0,
    sodium_g: 0,
    potassium_mg: 0,
    calcium_mg: 0,
    phosphorus_mg: 0,
    iron_mg: 0,
    zinc_mg: 0,
    iodine_ug: 0,
    cholesterol_mg: 0,
    vitamin_b1_mg: 0,
    vitamin_b2_mg: 0,
    vitamin_b6_mg: 0,
    vitamin_b12_ug: 0,
    folic_acid_ug: 0,
    vitamin_c_mg: 0,
    vitamin_a_ug: 0,
    vitamin_d_ug: 0,
    vitamin_k_ug: 0,
    vitamin_e_mg: 0,
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
  // ごま
  "すりごま": ["ごま", "いりごま", "白ごま"],
  "いりごま": ["ごま", "すりごま", "白ごま"],
  "白ごま": ["ごま", "いりごま"],
  // だし
  "鶏がらスープの素": ["チキンブイヨン", "鶏がらだし"],
  "和風だし": ["かつおだし", "だしの素"],
  "中華だし": ["鶏がらスープ", "ウェイパー"],
  // 肉
  "鶏むね肉": ["若どり むね 皮なし", "鶏肉 むね"],
  "鶏もも肉": ["若どり もも", "鶏肉 もも"],
  "豚ひき肉": ["ぶた ひき肉"],
  "牛ひき肉": ["うし ひき肉"],
  // 卵
  "卵": ["鶏卵", "全卵", "たまご"],
  "たまご": ["鶏卵", "卵", "全卵"],
};

// 栄養値を加算するヘルパー関数
export function addNutritionFromMatch(totals: NutritionTotals, matched: any, amount_g: number) {
  const factor = amount_g / 100.0;
  const add = (key: keyof NutritionTotals, v: number | null | undefined) => {
    if (v != null && Number.isFinite(v)) {
      totals[key] += v * factor;
    }
  };

  add("calories_kcal", matched.calories_kcal);
  add("protein_g", matched.protein_g);
  add("fat_g", matched.fat_g);
  add("carbs_g", matched.carbs_g);
  add("fiber_g", matched.fiber_g);
  add("sodium_g", matched.salt_eq_g);
  add("potassium_mg", matched.potassium_mg);
  add("calcium_mg", matched.calcium_mg);
  add("phosphorus_mg", matched.phosphorus_mg);
  add("iron_mg", matched.iron_mg);
  add("zinc_mg", matched.zinc_mg);
  add("iodine_ug", matched.iodine_ug);
  add("cholesterol_mg", matched.cholesterol_mg);
  add("vitamin_b1_mg", matched.vitamin_b1_mg);
  add("vitamin_b2_mg", matched.vitamin_b2_mg);
  add("vitamin_b6_mg", matched.vitamin_b6_mg);
  add("vitamin_b12_ug", matched.vitamin_b12_ug);
  add("folic_acid_ug", matched.folic_acid_ug);
  add("vitamin_c_mg", matched.vitamin_c_mg);
  add("vitamin_a_ug", matched.vitamin_a_ug);
  add("vitamin_d_ug", matched.vitamin_d_ug);
  add("vitamin_k_ug", matched.vitamin_k_ug);
  add("vitamin_e_mg", matched.vitamin_e_alpha_mg);
}

// Embedding API を呼び出す
export async function embedTexts(texts: string[], dimensions = 384): Promise<number[][]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OpenAI API Key is missing");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
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

const INGREDIENT_SELECT = "id, name, name_norm, calories_kcal, protein_g, fat_g, carbs_g, fiber_g, salt_eq_g, potassium_mg, calcium_mg, phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg, vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug, vitamin_k_ug, vitamin_e_alpha_mg";

export async function calculateNutritionFromIngredients(
  supabase: any,
  ingredients: Array<{ name: string; amount_g: number; note?: string }>
): Promise<NutritionTotals> {
  const totals = emptyNutrition();
  
  if (!ingredients || ingredients.length === 0) {
    console.log("[nutrition] No ingredients provided");
    return totals;
  }

  // 水系食材を除外した材料リスト
  const validIngredients = ingredients.filter(i => !isWaterishIngredient(i.name) && i.amount_g > 0);
  console.log(`[nutrition] Valid ingredients: ${validIngredients.length}/${ingredients.length}`, validIngredients.map(i => `${i.name}(${i.amount_g}g)`).join(", "));
  
  if (validIngredients.length === 0) return totals;

  // エイリアスを含めた検索候補を生成
  const searchCandidates: string[] = [];
  for (const ing of validIngredients) {
    const name = ing.name;
    searchCandidates.push(normalizeIngredientNameJs(name));
    // エイリアスも追加
    const aliases = INGREDIENT_ALIASES[name] ?? [];
    for (const alias of aliases) {
      searchCandidates.push(normalizeIngredientNameJs(alias));
    }
  }
  const uniqueNorms = Array.from(new Set(searchCandidates)).filter(Boolean);
  console.log(`[nutrition] Search candidates: ${uniqueNorms.join(", ")}`);

  // 完全一致検索（エイリアスを含む）
  const { data: exactRows, error: exactErr } = await supabase
    .from("dataset_ingredients")
    .select(INGREDIENT_SELECT)
    .in("name_norm", uniqueNorms);

  if (exactErr) {
    console.error("[nutrition] Failed to fetch ingredients:", exactErr.message);
    return totals;
  }
  
  console.log(`[nutrition] Exact match count: ${exactRows?.length ?? 0}`);
  if (exactRows && exactRows.length > 0) {
    console.log(`[nutrition] Exact matches: ${exactRows.map((r: any) => `${r.name}(${r.calories_kcal}kcal/100g)`).join(", ")}`);
  }

  // name_norm をキーにしたマップを作成
  const ingredientMap = new Map<string, any>();
  for (const row of exactRows ?? []) {
    if (row?.name_norm) ingredientMap.set(String(row.name_norm), row);
  }

  // マッチ結果を格納
  const matchResults: string[] = [];
  const unmatchedIngredients: { ing: typeof validIngredients[0]; idx: number }[] = [];

  // 各食材についてマッチングを試みる
  for (let idx = 0; idx < validIngredients.length; idx++) {
    const ing = validIngredients[idx];
    const norm = normalizeIngredientNameJs(ing.name);
    let matched = ingredientMap.get(norm);
    let matchMethod = matched ? "exact" : "none";

    // エイリアスで完全一致を試みる
    if (!matched) {
      const aliases = INGREDIENT_ALIASES[ing.name] ?? [];
      for (const alias of aliases) {
        const aliasNorm = normalizeIngredientNameJs(alias);
        matched = ingredientMap.get(aliasNorm);
        if (matched) {
          matchMethod = `alias(${alias})`;
          break;
        }
      }
    }

    // 完全一致がない場合、trigram 類似検索
    if (!matched) {
      const { data: sims, error: simErr } = await supabase.rpc("search_similar_dataset_ingredients", {
        query_name: ing.name,
        similarity_threshold: 0.15,
        result_limit: 5,
      });
      if (!simErr && Array.isArray(sims) && sims.length > 0) {
        // 油系の食材は油系のみにマッチさせる
        const isOil = /油|オイル/.test(ing.name);
        const candidates = sims.filter((s: any) => {
          if (isOil) return /油|オイル/.test(s.name ?? "");
          return true;
        });
        const best = candidates[0] ?? sims[0];
        if (best?.id && best.similarity >= 0.15) {
          const { data: row } = await supabase
            .from("dataset_ingredients")
            .select(INGREDIENT_SELECT)
            .eq("id", best.id)
            .maybeSingle();
          if (row) {
            matched = row;
            matchMethod = `trgm(${best.similarity?.toFixed(2) ?? "?"})`;
          }
        }
      }
    }

    // まだマッチしない場合、後でベクトル検索
    if (!matched) {
      unmatchedIngredients.push({ ing, idx });
      continue;
    }
    
    matchResults[idx] = `${ing.name}(${ing.amount_g}g) → ${matched.name}[${matchMethod}](${matched.calories_kcal}kcal/100g)`;
    
    // 栄養値を加算
    addNutritionFromMatch(totals, matched, ing.amount_g);
  }

  // ベクトル検索（未マッチの食材）
  if (unmatchedIngredients.length > 0) {
    console.log(`[nutrition] Vector search for ${unmatchedIngredients.length} unmatched ingredients`);
    try {
      const texts = unmatchedIngredients.map(u => u.ing.name);
      const embeddings = await embedTexts(texts, 384);
      
      for (let i = 0; i < unmatchedIngredients.length; i++) {
        const { ing, idx } = unmatchedIngredients[i];
        const emb = embeddings[i];
        
        const { data: rows, error: embErr } = await supabase.rpc("search_dataset_ingredients_by_embedding", {
          query_embedding: emb,
          match_count: 5,
        });
        
        if (!embErr && Array.isArray(rows) && rows.length > 0) {
          // 油系の食材は油系のみにマッチさせる
          const isOil = /油|オイル/.test(ing.name);
          const candidates = rows.filter((r: any) => {
            if (isOil) return /油|オイル/.test(r.name ?? "");
            return true;
          });
          const best = candidates[0] ?? rows[0];
          
          if (best?.id) {
            const { data: row } = await supabase
              .from("dataset_ingredients")
              .select(INGREDIENT_SELECT)
              .eq("id", best.id)
              .maybeSingle();
            
            if (row) {
              matchResults[idx] = `${ing.name}(${ing.amount_g}g) → ${row.name}[vector(${best.similarity?.toFixed(2) ?? "?"})](${row.calories_kcal}kcal/100g)`;
              addNutritionFromMatch(totals, row, ing.amount_g);
              continue;
            }
          }
        }
        
        matchResults[idx] = `${ing.name}(${ing.amount_g}g) → UNMATCHED`;
      }
    } catch (e: any) {
      console.error("[nutrition] Vector search failed:", e?.message ?? e);
      for (const { ing, idx } of unmatchedIngredients) {
        matchResults[idx] = `${ing.name}(${ing.amount_g}g) → UNMATCHED`;
      }
    }
  }

  // ログ出力
  const validResults = matchResults.filter(Boolean);
  console.log(`[nutrition] Match results:\n  ${validResults.join("\n  ")}`);
  console.log(`[nutrition] Total: ${Math.round(totals.calories_kcal)}kcal, P:${totals.protein_g.toFixed(1)}g, F:${totals.fat_g.toFixed(1)}g, C:${totals.carbs_g.toFixed(1)}g`);

  return totals;
}

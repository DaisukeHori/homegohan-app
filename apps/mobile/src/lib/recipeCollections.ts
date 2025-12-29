import { supabase } from "./supabase";

export type RecipeCollection = {
  id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  is_public: boolean | null;
  recipe_ids: string[] | null;
};

export async function listMyRecipeCollections(): Promise<RecipeCollection[]> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Unauthorized");

  const { data, error } = await supabase
    .from("recipe_collections")
    .select("id,user_id,name,description,is_public,recipe_ids")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as any;
}

export async function createRecipeCollection(name: string, description?: string | null): Promise<RecipeCollection> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Unauthorized");

  const { data, error } = await supabase
    .from("recipe_collections")
    .insert({
      user_id: auth.user.id,
      name,
      description: description ?? null,
      is_public: false,
    })
    .select("id,user_id,name,description,is_public,recipe_ids")
    .single();
  if (error || !data) throw error ?? new Error("Failed to create collection");
  return data as any;
}

export async function addRecipeToCollection(collectionId: string, recipeId: string): Promise<void> {
  const { data: col, error: colErr } = await supabase
    .from("recipe_collections")
    .select("id,recipe_ids,user_id")
    .eq("id", collectionId)
    .single();
  if (colErr || !col) throw colErr ?? new Error("Collection not found");

  const current = (col.recipe_ids as any as string[]) ?? [];
  const next = current.includes(recipeId) ? current : [...current, recipeId];

  const { error: updErr } = await supabase.from("recipe_collections").update({ recipe_ids: next }).eq("id", collectionId);
  if (updErr) throw updErr;

  // 補助テーブル（存在する場合）も更新（重複はPKで抑止）
  await supabase.from("recipe_collection_items").insert({ collection_id: collectionId, recipe_id: recipeId }).throwOnError();
}

export async function removeRecipeFromCollection(collectionId: string, recipeId: string): Promise<void> {
  const { data: col, error: colErr } = await supabase
    .from("recipe_collections")
    .select("id,recipe_ids")
    .eq("id", collectionId)
    .single();
  if (colErr || !col) throw colErr ?? new Error("Collection not found");

  const current = (col.recipe_ids as any as string[]) ?? [];
  const next = current.filter((x) => x !== recipeId);

  const { error: updErr } = await supabase.from("recipe_collections").update({ recipe_ids: next }).eq("id", collectionId);
  if (updErr) throw updErr;

  await supabase.from("recipe_collection_items").delete().eq("collection_id", collectionId).eq("recipe_id", recipeId).throwOnError();
}




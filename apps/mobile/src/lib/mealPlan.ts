import { supabase } from "./supabase";

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

/**
 * Get or create user_daily_meals for a specific date
 * Returns the daily_meal_id for the specified date
 */
export async function ensureDailyMealId(dateStr?: string): Promise<string> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Unauthorized");

  const targetDate = dateStr || formatLocalDate(new Date());

  // 1) Check if daily meal exists for this date
  const { data: existing, error: existingErr } = await supabase
    .from("user_daily_meals")
    .select("id")
    .eq("user_id", auth.user.id)
    .eq("day_date", targetDate)
    .maybeSingle();
  
  if (existingErr) throw existingErr;
  if (existing?.id) return existing.id;

  // 2) Create new daily meal record
  const { data: created, error: createErr } = await supabase
    .from("user_daily_meals")
    .insert({
      user_id: auth.user.id,
      day_date: targetDate,
      is_cheat_day: false,
    })
    .select("id")
    .single();
  
  if (createErr || !created) throw createErr ?? new Error("Failed to create daily meal");

  return created.id;
}

/**
 * Get the active shopping list for the user
 * Returns the shopping_list_id or null if none exists
 */
export async function getActiveShoppingListId(): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Unauthorized");

  const { data: activeList, error } = await supabase
    .from("shopping_lists")
    .select("id")
    .eq("user_id", auth.user.id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return activeList?.id || null;
}

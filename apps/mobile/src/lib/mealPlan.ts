import { supabase } from "./supabase";

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

function getWeekStartMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function ensureActiveMealPlanId(): Promise<string> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Unauthorized");

  // 1) 既存アクティブ
  const { data: active, error: activeErr } = await supabase
    .from("meal_plans")
    .select("id")
    .eq("user_id", auth.user.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeErr) throw activeErr;
  if (active?.id) return active.id;

  // 2) 今週のプランがあればそれをアクティブ化
  const now = new Date();
  const ws = getWeekStartMonday(now);
  const we = new Date(ws);
  we.setDate(we.getDate() + 6);
  const weekStartStr = ws.toISOString().split("T")[0];
  const weekEndStr = we.toISOString().split("T")[0];

  const { data: thisWeek, error: weekErr } = await supabase
    .from("meal_plans")
    .select("id")
    .eq("user_id", auth.user.id)
    .eq("start_date", weekStartStr)
    .maybeSingle();
  if (weekErr) throw weekErr;

  if (thisWeek?.id) {
    await supabase.from("meal_plans").update({ is_active: false }).eq("user_id", auth.user.id);
    await supabase.from("meal_plans").update({ is_active: true }).eq("id", thisWeek.id).eq("user_id", auth.user.id);
    return thisWeek.id;
  }

  // 3) 作成
  await supabase.from("meal_plans").update({ is_active: false }).eq("user_id", auth.user.id);

  const title = `${ws.getMonth() + 1}月${ws.getDate()}日〜の献立`;
  const { data: created, error: createErr } = await supabase
    .from("meal_plans")
    .insert({
      user_id: auth.user.id,
      title,
      start_date: weekStartStr,
      end_date: weekEndStr,
      status: "active",
      is_active: true,
    })
    .select("id")
    .single();
  if (createErr || !created) throw createErr ?? new Error("Failed to create meal plan");

  return created.id;
}




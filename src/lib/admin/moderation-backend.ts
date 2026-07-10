/**
 * モデレーション API の実テーブルアクセス層
 *
 * #1041 (F4-04) 修正: 実在しない `moderation_items` テーブル参照を廃止し、
 * 実在する `moderation_flags` (food/meal 用) / `recipe_flags` (recipe 用) に統一する。
 * `ai_content` タイプはバックエンドテーブルが存在しないため未サポート (要 migration)。
 *
 * 重要: BAN 対象ユーザー (`user_id`) は各フラグテーブル自身の `user_id` /
 * `reporter_id` ではなく、フラグが指す **コンテンツの所有者** (meals.user_id /
 * recipes.user_id) を用いる。フラグテーブル側の user_id は通報者を指す可能性があり
 * 誤って通報者を BAN する重大な事故につながるため、meal_id / recipe_id 経由の
 * 参照を正とする。
 *
 * #1041 round-2 (D/F) 修正: `meals`/`recipes` は admin bypass 無しの RLS
 * (所有者本人のみ参照可) のため、user-scoped client でこのモジュールの関数を
 * 呼ぶと embed (`meals(...)`/`recipes(...)`) が null 化し、BAN 対象所有者が
 * 取得できず BAN が skip される (偽成功)。加えて `moderation_flags_admin_all`
 * は admin/super_admin のみのため、content_moderator が呼ぶと 0 件/0 行更新に
 * なる。呼び出し側 (route) は **requireRole 等の authz を通した後** に
 * `getSupabaseAdmin()` (service-role) を渡すこと。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModerationType } from './moderation-schemas';

/** 現時点で実バックエンドテーブルが存在するモデレーション対象タイプ */
export type ModerationBackedType = 'food' | 'recipe';

export function isModerationBacked(type: ModerationType): type is ModerationBackedType {
  return type === 'food' || type === 'recipe';
}

export interface NormalizedModerationItem {
  id: string;
  type: ModerationBackedType;
  content_url: string | null;
  reporter_count: number;
  /** コンテンツ所有者 (BAN 対象)。所有者取得に失敗した場合は null */
  user_id: string | null;
  status: string;
  reason: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string | null;
}

type RawRow = Record<string, unknown>;

function normalizeFoodRow(row: RawRow): NormalizedModerationItem {
  const meal = (row.meals as { user_id?: string | null; photo_url?: string | null } | null) ?? null;
  return {
    id: row.id as string,
    type: 'food',
    content_url: meal?.photo_url ?? null,
    // moderation_flags は 1 通報 = 1 行のため、集約は行わず 1 件として扱う
    reporter_count: 1,
    user_id: meal?.user_id ?? null,
    status: (row.status as string | null) ?? 'pending',
    reason: (row.reason as string | null) ?? null,
    resolution_note: (row.resolution_note as string | null) ?? null,
    resolved_by: (row.resolved_by as string | null) ?? null,
    resolved_at: (row.resolved_at as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function normalizeRecipeRow(row: RawRow): NormalizedModerationItem {
  const recipe = (row.recipes as { user_id?: string | null; image_url?: string | null } | null) ?? null;
  return {
    id: row.id as string,
    type: 'recipe',
    // #1041 round-2 (G) 修正: recipes.image_url が実在する (database.types.ts) ため、
    // 常に null 固定にせず実データを反映する。
    content_url: recipe?.image_url ?? null,
    reporter_count: 1,
    user_id: recipe?.user_id ?? null,
    status: (row.status as string | null) ?? 'pending',
    reason: (row.reason as string | null) ?? null,
    // recipe_flags に resolution_note 列は存在しない (要 migration、監査ログにのみ記録)
    resolution_note: null,
    resolved_by: (row.reviewed_by as string | null) ?? null,
    resolved_at: (row.reviewed_at as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function backingTable(type: ModerationBackedType): 'moderation_flags' | 'recipe_flags' {
  return type === 'food' ? 'moderation_flags' : 'recipe_flags';
}

/**
 * 指定タイプ・ステータスのモデレーション対象一覧を取得する。
 * DB エラー時は例外を throw する (呼び出し側で fail-closed に処理すること)。
 */
export async function fetchModerationList(
  supabase: SupabaseClient<any>,
  type: ModerationBackedType,
  status: string,
  limit: number,
): Promise<NormalizedModerationItem[]> {
  if (type === 'food') {
    const { data, error } = await supabase
      .from('moderation_flags')
      .select('*, meals(user_id, photo_url)')
      .eq('status', status)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => normalizeFoodRow(row as RawRow));
  }

  const { data, error } = await supabase
    .from('recipe_flags')
    .select('*, recipes(user_id, image_url)')
    .eq('status', status)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => normalizeRecipeRow(row as RawRow));
}

/**
 * 指定タイプ・ステータスの件数を取得する。DB エラー時は例外を throw する。
 */
export async function countModeration(
  supabase: SupabaseClient<any>,
  type: ModerationBackedType,
  status: string,
): Promise<number> {
  const { count, error } = await supabase
    .from(backingTable(type))
    .select('*', { count: 'exact', head: true })
    .eq('status', status);
  if (error) throw error;
  return count ?? 0;
}

/**
 * 単一のモデレーション対象を取得する。
 * 見つからない場合は null を返す (エラーではない)。DB エラー時は例外を throw する。
 */
export async function fetchModerationSingle(
  supabase: SupabaseClient<any>,
  type: ModerationBackedType,
  id: string,
): Promise<NormalizedModerationItem | null> {
  if (type === 'food') {
    const { data, error } = await supabase
      .from('moderation_flags')
      .select('*, meals(user_id, photo_url)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? normalizeFoodRow(data as RawRow) : null;
  }

  const { data, error } = await supabase
    .from('recipe_flags')
    .select('*, recipes(user_id, image_url)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeRecipeRow(data as RawRow) : null;
}

export interface ResolveModerationParams {
  status: string;
  resolvedBy: string;
  resolutionNote: string | null;
}

/**
 * モデレーション対象のステータスを更新する。DB エラー時は例外を throw する。
 * 呼び出し前に fetchModerationSingle 等で対象の存在確認を行うこと。
 */
export async function resolveModerationItem(
  supabase: SupabaseClient<any>,
  type: ModerationBackedType,
  id: string,
  params: ResolveModerationParams,
): Promise<void> {
  const nowIso = new Date().toISOString();

  if (type === 'food') {
    const { error } = await supabase
      .from('moderation_flags')
      .update({
        status: params.status,
        resolved_by: params.resolvedBy,
        resolved_at: nowIso,
        resolution_note: params.resolutionNote,
      })
      .eq('id', id);
    if (error) throw error;
    return;
  }

  // recipe_flags: resolution_note 列が存在しないため保存不可 (要 migration)
  const { error } = await supabase
    .from('recipe_flags')
    .update({
      status: params.status,
      reviewed_by: params.resolvedBy,
      reviewed_at: nowIso,
    })
    .eq('id', id);
  if (error) throw error;
}

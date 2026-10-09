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
 *
 * #1101: 違反コンテンツの「削除」は、行を消さずに `hidden_at` を入れて「隠す」
 * (`hideModeratedContent`)。隠した行は RLS により本人以外には見えず、保管期間のあとに
 * 完全削除する (削除ジョブは別の作業)。注意: service-role で `meals` / `recipes` を読むコードは
 * RLS を通らないので、他のユーザーに見せる一覧を作るなら `hidden_at IS NULL` で絞ること。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModerationType } from './moderation-schemas';

/** 現時点で実バックエンドテーブルが存在するモデレーション対象タイプ */
export type ModerationBackedType = 'food' | 'recipe';

export function isModerationBacked(type: ModerationType): type is ModerationBackedType {
  return type === 'food' || type === 'recipe';
}

export interface NormalizedModerationItem {
  /** 通報 (moderation_flags.id / recipe_flags.id) の ID。コンテンツ本体の ID は `content_id` */
  id: string;
  type: ModerationBackedType;
  /**
   * 通報されたコンテンツ本体の ID (meals.id / recipes.id)。`hideModeratedContent` の対象。
   * 通報にコンテンツが紐づいていない (meal_id / recipe_id が NULL) ときは null
   */
  content_id: string | null;
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
    content_id: (row.meal_id as string | null) ?? null,
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
    content_id: (row.recipe_id as string | null) ?? null,
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

/**
 * 通報されたコンテンツ本体のテーブル (food = 食事 meals / recipe = レシピ recipes)。
 * タイプを足したら、ここで型エラーになる (対応するテーブルを決めずに、別のテーブルの行を隠さないため)
 */
function contentTable(type: ModerationBackedType): 'meals' | 'recipes' {
  switch (type) {
    case 'food':
      return 'meals';
    case 'recipe':
      return 'recipes';
    default: {
      const unsupported: never = type;
      throw new Error(`hideModeratedContent: 対応していないタイプです (${String(unsupported)})`);
    }
  }
}

export interface HideModeratedContentParams {
  /** `hidden_by` に記録する運営ユーザー (操作した人) */
  hiddenBy: string;
  /**
   * `hidden_reason` に記録する理由。この列はコンテンツの持ち主も読めるので、運営の自由記述
   * (解決メモ) は入れず、`moderation:<action>` のような短い識別子にする。
   * 解決メモは監査ログ (admin_audit_logs) と moderation_flags.resolution_note に残る。
   */
  reason: string;
}

/**
 * 通報されたコンテンツ (meals / recipes の行) を「隠す」(#1101)。行は消さない。
 *
 * `hidden_at` を入れると、RLS により本人以外 (家族・他のログインユーザー・未ログイン) には
 * 見えなくなる (本人には見える)。完全な削除は保管期間のあとに別のジョブで行う。
 * `hidden_*` を書き換えられるのは service-role だけ (DB のトリガー guard_hidden_content_columns)
 * なので、`supabase` には、認可 (requireRole) を通したあとの `getSupabaseAdmin()` を渡すこと。
 *
 * - すでに隠れている行は上書きしない (`hidden_at IS NULL` の行だけ更新する)。保管期間は
 *   最初に隠した日時から数える。同じコンテンツへの 2 件目の通報を処理しても、起点は延びない
 * - 行がもう無い (持ち主が先に消した) ときも、何も更新せずに成功する。隠す対象が無いだけで、失敗ではない
 * - DB エラー時は例外を throw する。呼び出し側で「隠せなかった」と明示し、成功を装わないこと
 */
export async function hideModeratedContent(
  supabase: SupabaseClient<any>,
  type: ModerationBackedType,
  contentId: string,
  params: HideModeratedContentParams,
): Promise<void> {
  const { error } = await supabase
    .from(contentTable(type))
    .update({
      hidden_at: new Date().toISOString(),
      hidden_by: params.hiddenBy,
      hidden_reason: params.reason,
    })
    .eq('id', contentId)
    .is('hidden_at', null);
  if (error) throw error;
}

/**
 * モデレーション API の実テーブルアクセス層
 *
 * #1041 (F4-04) 修正: 実在しない `moderation_items` テーブル参照を廃止し、
 * 実在する `moderation_flags` (food/meal 用) / `recipe_flags` (recipe 用) に統一する。
 * `ai_content` タイプはバックエンドテーブルが存在しないため未サポート (要 migration)。
 * ai_content を指定された API は、空の一覧や 404 ではなく 501 (OP_NOT_SUPPORTED) を返し、
 * 画面には ai_content の選択肢を出さない (#1911。未完成の機能は画面に出さない)。
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
 * 取得できず BAN が skip される (偽成功)。加えて `moderation_flags_admin_select` (旧 `moderation_flags_admin_all`。#1917 で SELECT だけ)
 * は admin/super_admin のみのため、content_moderator が呼ぶと 0 件/0 行更新に
 * なる。呼び出し側 (route) は **requireRole 等の authz を通した後** に
 * `getSupabaseAdmin()` (service-role) を渡すこと。
 *
 * #1101: 違反コンテンツの「削除」は、行を消さずに `hidden_at` を入れて「隠す」
 * (`hideModeratedContent`)。隠した行は RLS により本人以外には見えず、隠してから 90 日 (保管期間) を
 * 過ぎたら、pg_cron のジョブ `purge-hidden-content` (#1538) が行と、ほかで使っていない画像を完全に消す。
 * 戻すのは `src/lib/admin/hidden-content-restore.ts` (`POST /api/admin/moderation/{type}/{id}/restore`。#1538)。
 * 戻した行は完全削除のジョブ `purge-hidden-content` の対象から外れる。
 * 注意: service-role で `meals` / `recipes` を読むコードは
 * RLS を通らないので、他のユーザーに見せる一覧を作るなら `hidden_at IS NULL` で絞ること。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModerationType } from './moderation-schemas';
import { parsePhotoObjectUrl, signPhotoUrlsForAuthorizedViewer, type PhotoSigningAdmin } from '../photo-storage-signing';

/** 現時点で実バックエンドテーブルが存在するモデレーション対象タイプ */
export type ModerationBackedType = 'food' | 'recipe';

export function isModerationBacked(type: ModerationType): type is ModerationBackedType {
  return type === 'food' || type === 'recipe';
}

/** バックエンドの無いタイプ (ai_content) を指定された API の 501 の本文 (#1128) */
export const AI_CONTENT_NOT_SUPPORTED_MESSAGE =
  'AIコンテンツの審査はできません。審査できるのは、食事画像とレシピの通報だけです。';

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
  /**
   * 通報されたコンテンツ本体が運営に隠されている (#1101) なら、その日時 (ISO)。隠れていない・コンテンツが無いときは null (#1538)。
   * 画面はこれで「非表示中」のバッジと「非表示の解除」の欄を出す
   */
  hidden_at: string | null;
  created_at: string | null;
}

type RawRow = Record<string, unknown>;

function normalizeFoodRow(row: RawRow): NormalizedModerationItem {
  const meal = (row.meals as { user_id?: string | null; photo_url?: string | null; hidden_at?: string | null } | null) ?? null;
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
    hidden_at: meal?.hidden_at ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

function normalizeRecipeRow(row: RawRow): NormalizedModerationItem {
  const recipe = (row.recipes as { user_id?: string | null; image_url?: string | null; hidden_at?: string | null } | null) ?? null;
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
    hidden_at: recipe?.hidden_at ?? null,
    created_at: (row.created_at as string | null) ?? null,
  };
}

/**
 * 通報されたコンテンツの写真 (content_url) を、運営の画面で見られる署名付き URL に替える (#1365 段 1)。
 * 食事写真・冷蔵庫写真のバケットは非公開なので、保存された公開 URL をそのまま返さない。
 * 写真の持ち主は通報された利用者 (運営本人ではない) なので、持ち主の確認はせず、呼び出し側の requireRole
 * (admin / super_admin / content_moderator) を通ったことを条件に署名する。呼び出し側は requireRole の後にだけ呼ぶこと。
 * 2 つのバケットの URL でないもの (外部の画像など) はそのまま。署名できなかった写真は null (表示しない)。
 */
export async function withSignedModerationContentUrls<T extends Pick<NormalizedModerationItem, 'content_url'>>(
  admin: PhotoSigningAdmin,
  items: readonly T[],
): Promise<T[]> {
  const photoUrls = items
    .map((item) => item.content_url)
    .filter((url): url is string => typeof url === 'string' && parsePhotoObjectUrl(url) !== null);
  if (photoUrls.length === 0) return [...items];
  const signedUrls = await signPhotoUrlsForAuthorizedViewer(admin, photoUrls);
  return items.map((item) =>
    typeof item.content_url === 'string' && Object.prototype.hasOwnProperty.call(signedUrls, item.content_url)
      ? { ...item, content_url: signedUrls[item.content_url] }
      : item,
  );
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
      .select('*, meals(user_id, photo_url, hidden_at)')
      .eq('status', status)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => normalizeFoodRow(row as RawRow));
  }

  const { data, error } = await supabase
    .from('recipe_flags')
    .select('*, recipes(user_id, image_url, hidden_at)')
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
      .select('*, meals(user_id, photo_url, hidden_at)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? normalizeFoodRow(data as RawRow) : null;
  }

  const { data, error } = await supabase
    .from('recipe_flags')
    .select('*, recipes(user_id, image_url, hidden_at)')
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

/** hideModeratedContent の結果 */
export interface HideModeratedContentResult {
  /**
   * 通報されたコンテンツの行があったか。持ち主が先に消していて行が無いときは false
   * (隠す対象が無いだけで、失敗ではない)。すでに隠れていた行は true (隠れた状態にある)。
   * 監査ログの hidden は、これが true のときだけ true にする (#1445: 行が無いのに hidden: true と記録していた)
   */
  contentFound: boolean;
  /** この呼び出しで新しく隠した行の ID (すでに隠れていた行・無かった行は含まない) */
  hiddenIds: string[];
}

/**
 * 食事の「中身」の列 (#1101)。家族へのペースト (paste_meal_to_family) が元の行から複製する列のうち、
 * 通報の対象になるもの (写真とメモ。eaten_at / meal_type は日時と区分で、中身ではない)。
 * ペーストの複製をまとめて隠すときは、この列が通報された行と同じ値の行だけを対象にする。
 */
type MealContent = { photo_url: string | null; memo: string | null };

/** 2 つの食事の中身 (写真とメモ) が同じか。NULL どうしも同じとみなす (SQL の IS NOT DISTINCT FROM と同じ) */
function isSameMealContent(a: MealContent, b: MealContent): boolean {
  return a.photo_url === b.photo_url && a.memo === b.memo;
}

/**
 * 通報されたコンテンツ (meals / recipes の行) を「隠す」(#1101)。行は消さない。
 *
 * `hidden_at` を入れると、RLS により本人以外 (家族・他のログインユーザー・未ログイン) には
 * 見えなくなる (本人には見える)。隠してから 90 日 (保管期間) を過ぎたら、pg_cron のジョブ
 * `purge-hidden-content` (#1538) が行と、ほかで使っていない画像を完全に消す。
 * `hidden_*` を書き換えられるのは service-role だけ (DB のトリガー trg_meals_guard_hidden_columns・trg_recipes_guard_hidden_columns (関数 guard_hidden_content_columns))
 * なので、`supabase` には、認可 (requireRole) を通したあとの `getSupabaseAdmin()` を渡すこと。
 *
 * - 食事 (food) は、家族へのペースト (paste_meal_to_family) で同じ写真・メモの行が家族のメンバーの
 *   持ち物として複製されている。通報された行だけを隠すと、同じ中身の複製が家族に見えたまま残るので、
 *   同じ `paste_group_id` の行のうち、**中身 (写真とメモ) が通報された行と同じもの**をまとめて隠す。
 *   複製の持ち主には、自分の行として見えたまま (本人には見える、の規則どおり)。隠した行は、ペーストの元にできない (DB の関数が拒否する)
 * - 同じ `paste_group_id` でも、中身が違う行は隠さない。ペーストのあとで持ち主が自分の行 (元の行・複製) の
 *   写真やメモを書き換えられるので、`paste_group_id` が同じでも、通報された中身と同じとは限らない
 *   (書き換えた複製が通報されたとき、元の持ち主の、違反していない元の行まで隠さないため)。
 *   `paste_group_id` 自体は、ログインユーザーが書き換えられない (DB のトリガー trg_meals_guard_paste_group_id (関数 guard_meal_paste_group_id)。
 *   書けるのはペーストの関数だけ) ので、他人の行を自分の行と同じまとまりに入れることもできない
 * - 同じまとまりの行を読んでから、隠す行を ID で更新する (2 回に分ける。メモは長くなりうるので、URL の絞り込みに入れない)。
 *   読んだあとの、ほんの短い間に持ち主が中身を書き換えた行は、読んだときの中身で判断する
 * - すでに隠れている行は上書きしない (`hidden_at IS NULL` の行だけ更新する)。保管期間は
 *   最初に隠した日時から数える。同じコンテンツへの 2 件目の通報を処理しても、起点は延びない
 * - 行がもう無い (持ち主が先に消した) ときも、何も更新せずに成功する。隠す対象が無いだけで、失敗ではない
 * - DB エラー時は例外を throw する。呼び出し側で「隠せなかった」と明示し、成功を装わないこと
 *
 * @returns 行があったか (contentFound) と、この呼び出しで新しく隠した行の ID (hiddenIds。すでに隠れていた行・無かった行は含まない)
 */
export async function hideModeratedContent(
  supabase: SupabaseClient<any>,
  type: ModerationBackedType,
  contentId: string,
  params: HideModeratedContentParams,
): Promise<HideModeratedContentResult> {
  const table = contentTable(type);
  // 隠す行の ID。既定は通報された行だけ。食事でペーストの複製があれば、同じ paste_group_id で中身が同じ行すべて
  let targetIds: string[] = [contentId];
  if (table === 'meals') {
    const { data: source, error: sourceError } = await supabase
      .from('meals')
      .select('paste_group_id, photo_url, memo')
      .eq('id', contentId)
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) return { contentFound: false, hiddenIds: [] }; // 行がもう無い。隠す対象が無いだけで、失敗ではない
    const flagged = source as MealContent & { paste_group_id: string | null };
    if (flagged.paste_group_id) {
      const { data: groupRows, error: groupError } = await supabase
        .from('meals')
        .select('id, photo_url, memo')
        .eq('paste_group_id', flagged.paste_group_id)
        .is('hidden_at', null);
      if (groupError) throw groupError;
      targetIds = ((groupRows ?? []) as Array<MealContent & { id: string }>)
        .filter((row) => row.id === contentId || isSameMealContent(row, flagged))
        .map((row) => row.id);
      // まとまりの中に、まだ隠れていない同じ中身の行が無い (通報された行もすでに隠れている)
      if (targetIds.length === 0) return { contentFound: true, hiddenIds: [] };
    }
  }

  const { data, error } = await supabase
    .from(table)
    .update({
      hidden_at: new Date().toISOString(),
      hidden_by: params.hiddenBy,
      hidden_reason: params.reason,
    })
    .in('id', targetIds)
    .is('hidden_at', null)
    .select('id'); // 隠した行の ID を返す (監査ログに残し、運営が戻すときの手がかりにする)
  if (error) throw error;
  const hiddenIds = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  // 食事は、上で通報された行があることを確かめてある (無ければ先に返している)
  if (hiddenIds.length > 0 || table === 'meals') return { contentFound: true, hiddenIds };

  // レシピで 1 行も更新しなかった: すでに隠れていたのか、行が無いのかを確かめる (#1445)
  const { data: existing, error: existingError } = await supabase
    .from(table)
    .select('id')
    .eq('id', contentId)
    .maybeSingle();
  if (existingError) throw existingError;
  return { contentFound: existing !== null, hiddenIds };
}

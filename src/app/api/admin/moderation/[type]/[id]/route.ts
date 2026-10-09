/**
 * GET  /api/admin/moderation/{type}/{id} — 個別モデレーションアイテム取得
 * POST /api/admin/moderation/{type}/{id} — 個別モデレーション (承認/却下)
 * PUT  /api/admin/moderation/{type}/{id} — モデレーション個別解決 (E2E: w5-12-admin-adversarial G-28, G-29, G-30)
 * operator/02-api-spec.md §5 準拠
 * 権限: admin, super_admin, content_moderator
 *
 * #1128: type=ai_content (AI コンテンツ) の審査は準備中 (未対応)。バックエンドテーブルが無いため、
 * GET / POST / PUT のどれも 404 (該当なし) ではなく 501 (OP_NOT_SUPPORTED) を返す。
 *
 * #1041 (F4-04) 修正: 実在しない `moderation_items` テーブル参照を廃止し、
 * 実テーブル (moderation_flags / recipe_flags) を参照する。
 * BAN 対象ユーザーはフラグテーブル自身の user_id/reporter_id ではなく、
 * フラグが指すコンテンツの所有者 (meals.user_id / recipes.user_id) を用いる
 * (通報者を誤って BAN する事故を防ぐため)。
 * DB エラー時は 404 に丸めず 500 を返す (fail-closed)。
 *
 * #1041 round-2 (A/D/F) 修正:
 *  - `NOT_FOUND_RESPONSE` を module スコープの単一 `NextResponse.json(...)` (body は
 *    1 回しか読めない ReadableStream) にしていたため、複数リクエストで使い回すと
 *    2 回目以降が 0 バイトの空 body になっていた (next dev で実証済み)。
 *    `notFoundResponse()` として都度生成する。
 *  - `meals`/`recipes` の embed は admin bypass 無し RLS で null 化され、
 *    content_moderator は `moderation_flags_admin_all` (admin/super_admin のみ) に
 *    阻まれ 0 件/0 行更新になっていた。requireRole 通過後に service-role
 *    (`getSupabaseAdmin()`) へ切り替えて解消する。
 *  - BAN は `admin_set_user_roles` で `roles=['banned']` にするだけで
 *    管理画面 (`frozen_at` ベースの `is_banned`) に一切反映されなかった。
 *    `/api/admin/users/[id]/freeze` と同じ frozen_at 機構に統一する
 *    (`@/lib/admin/user-ban`)。BAN 失敗時は success:true を返さない。
 *
 * #1041 round-3 (W1/W2) 修正:
 *  - (W1) `applyUserBan()` が返す一時 BAN の解除予定日時 (`unbanAt`) を監査ログに
 *    記録していなかった (freeze route は `unban_at` を記録済み)。temp ban の期限は
 *    永続化する列が無いため、監査ログが唯一の記録経路。パリティを合わせる。
 *  - (W2) BAN を要求するアクション (delete_and_temp_ban/delete_and_perm_ban) で
 *    コンテンツ所有者が特定できない (削除済み等で null) 場合、従来は黙って BAN を
 *    スキップし 200 `{ ban_applied: null }` を返していた (status 更新のみ成功した
 *    偽成功)。422 `OP_BAN_TARGET_UNRESOLVED` を返すようにする。
 *
 * #1041 round-4 (S) 修正: BAN 適用条件に `|| action === 'delete_and_warn'` が
 * 含まれていたが、`delete_and_warn` (BAN を伴わない警告) にはこのブロック内に
 * 対応処理が無く (実体は常に実行される監査ログ INSERT のみ)、dead condition
 * だった。挙動を変えず `banRequested` のみの条件に整理する。
 *
 * #1101 修正: `delete_*` アクションは通報の状態を rejected にするだけで、通報された
 * コンテンツ (meals / recipes) には何もしていなかった (「削除」と名乗る偽成功)。
 * コンテンツを消さずに `hidden_at` を入れて「隠す」(`hideModeratedContent`)。隠した行は
 * RLS により本人以外には見えず、保管期間のあとに完全削除する (削除ジョブは別の作業)。
 *  - 判定の保存 (`resolveModerationItem`) のあと、BAN の前に隠す。隠せなかったら BAN はせず、
 *    500 `OP_CONTENT_HIDE_FAILED` を返す (成功を装わない)。判定は保存済みで、同じ操作をもう一度
 *    実行すれば隠し直せる (すでに隠れている行は上書きしない)
 *  - 通報にコンテンツが紐づかない (`content_id` が null。持ち主が先に消した等) ときは、隠す対象が
 *    無いので隠さずに続行する。監査ログには `hidden: false` と `content_id: null` が残る
 *  - 監査ログの details に `content_id` と `hidden`、この操作で新しく隠した行の ID (`hidden_ids`) を記録する
 *  - 食事は、家族へのペーストで作られた複製 (同じ `paste_group_id`) もまとめて隠す
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import {
  ModerationResolveBodySchema,
  MODERATION_TYPES,
  isModerationDeleteAction,
  type ModerationType,
} from '@/lib/admin/moderation-schemas';
import {
  AI_CONTENT_NOT_SUPPORTED_MESSAGE,
  fetchModerationSingle,
  hideModeratedContent,
  isModerationBacked,
  resolveModerationItem,
} from '@/lib/admin/moderation-backend';
import { notSupportedResponse } from '@/lib/admin/not-supported';
import { applyUserBan } from '@/lib/admin/user-ban';

export const dynamic = 'force-dynamic';

type Params = { params: { type: string; id: string } };

function notFoundResponse() {
  return NextResponse.json(
    { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } },
    { status: 404 },
  );
}

function internalErrorResponse() {
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: '内部エラーが発生しました' } },
    { status: 500 },
  );
}

/** 監査ログ用にエラーを文字列にする (supabase-js のエラーは Error とは限らない) */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message ? message : String(err);
}

export async function GET(_request: Request, { params }: Params) {
  try {
    await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    throw err;
  }

  const { type, id } = params;

  if (!MODERATION_TYPES.includes(type as ModerationType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: `type は ${MODERATION_TYPES.join(', ')} のいずれかである必要があります` } },
      { status: 400 },
    );
  }

  const moderationType = type as ModerationType;

  // ai_content は準備中 (未対応。バックエンドテーブルが無い)。404 (該当なし) ではなく 501 で未対応と伝える (#1128)。
  if (!isModerationBacked(moderationType)) {
    return notSupportedResponse(AI_CONTENT_NOT_SUPPORTED_MESSAGE);
  }

  // requireRole 通過後のみ到達する。meals/recipes の embed は admin bypass 無し
  // RLS で null 化され、content_moderator は moderation_flags_admin_all
  // (admin/super_admin のみ) に阻まれるため service-role が必須 (#1041 round-2)。
  const supabaseAdmin = getSupabaseAdmin();

  try {
    const item = await fetchModerationSingle(supabaseAdmin, moderationType, id);
    if (!item) {
      return notFoundResponse();
    }
    return NextResponse.json({ data: item });
  } catch (err) {
    console.error('[api/admin/moderation/[type]/[id]] GET error:', err instanceof Error ? err.message : err);
    return internalErrorResponse();
  }
}

export async function POST(request: Request, { params }: Params) {
  return handleResolve(request, params);
}

export async function PUT(request: Request, { params }: Params) {
  return handleResolve(request, params);
}

async function handleResolve(request: Request, params: { type: string; id: string }) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    throw err;
  }

  const { type, id } = params;

  // type バリデーション
  if (!MODERATION_TYPES.includes(type as ModerationType)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: `type は ${MODERATION_TYPES.join(', ')} のいずれかである必要があります` } },
      { status: 400 },
    );
  }

  const moderationType = type as ModerationType;

  // ai_content は準備中 (未対応。バックエンドテーブルが無い)。404 (該当なし) ではなく 501 で未対応と伝える (#1128)。
  // 本文の検証より前に返す (未対応の機能には、入力の良し悪しを答えない)。
  if (!isModerationBacked(moderationType)) {
    return notSupportedResponse(AI_CONTENT_NOT_SUPPORTED_MESSAGE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = ModerationResolveBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { action, ban_duration_days, resolution_note } = parseResult.data;

  // delete_and_temp_ban は ban_duration_days 必須
  if (action === 'delete_and_temp_ban' && !ban_duration_days) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'delete_and_temp_ban の場合は ban_duration_days が必須です' } },
      { status: 400 },
    );
  }

  // delete_and_perm_ban は super_admin のみ
  if (action === 'delete_and_perm_ban' && !actor.roles.includes('super_admin')) {
    return NextResponse.json(
      { error: { code: 'OP_PERMISSION_DENIED', message: '永久 BAN は super_admin のみ実行可能です' } },
      { status: 403 },
    );
  }

  // requireRole 通過後のみ到達する。meals/recipes の embed 取得・
  // moderation_flags/recipe_flags の更新・BAN (user_profiles.frozen_at 更新) は
  // admin bypass 無し RLS で拒否/null 化されるため service-role が必須
  // (#1041 round-2 D/F)。admin_audit_logs への INSERT のみ user-scoped
  // client を使う (#1028 パターンに合わせる)。
  const supabaseAdmin = getSupabaseAdmin();
  const supabase = await createClient();
  const newStatus = action === 'approve' ? 'approved' : action === 'escalate' ? 'escalated' : 'rejected';

  let item;
  try {
    item = await fetchModerationSingle(supabaseAdmin, moderationType, id);
  } catch (err) {
    console.error('[api/admin/moderation/[type]/[id]] fetch error:', err instanceof Error ? err.message : err);
    return internalErrorResponse();
  }

  if (!item) {
    return notFoundResponse();
  }

  // BAN 対象はフラグが指すコンテンツの所有者 (meals.user_id / recipes.user_id)。
  // フラグ行自身の user_id/reporter_id (通報者) を誤って使わないこと。
  const contentUserId = item.user_id;

  try {
    await resolveModerationItem(supabaseAdmin, moderationType, id, {
      status: newStatus,
      resolvedBy: actor.id,
      resolutionNote: resolution_note ?? null,
    });
  } catch (err) {
    console.error('[api/admin/moderation/[type]/[id]] update error:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '更新に失敗しました' } },
      { status: 500 },
    );
  }

  // #1101: delete_* アクションは、通報されたコンテンツ (meals / recipes の行) を「隠す」。
  // 行は消さず、hidden_at を入れて本人以外に見えなくする (完全削除は保管期間のあと)。
  // 判定の保存 (上の resolveModerationItem) のあと、BAN の前に行う。隠せなかったときは、
  // BAN をせずに 500 を返す (「削除した」と見せかけない)。判定は保存済みなので、同じ操作を
  // もう一度実行すれば隠し直せる。通報にコンテンツが紐づいていなければ、隠す対象が無い。
  const contentId = item.content_id;
  const hideRequested = isModerationDeleteAction(action);
  let contentHidden = false;
  // この操作で新しく隠した行の ID (食事はペーストの複製を含む)。運営が戻すときの手がかりとして監査ログに残す
  let hiddenIds: string[] = [];
  let hideErrorMessage: string | null = null;
  if (hideRequested && contentId !== null) {
    try {
      hiddenIds = await hideModeratedContent(supabaseAdmin, moderationType, contentId, {
        hiddenBy: actor.id,
        // 持ち主も読める列なので、解決メモ (運営の自由記述) は入れない
        reason: `moderation:${action}`,
      });
      contentHidden = true;
    } catch (err) {
      // 監査ログ (admin_audit_logs.details.hide_error) にだけ残す。レスポンスには出さない (固定の文面を返す)
      hideErrorMessage = describeError(err);
      createLogger('POST /api/admin/moderation/[type]/[id]', generateRequestId())
        .withUser(actor.id)
        .error('通報されたコンテンツを隠せませんでした', err, {
          moderation_type: type,
          flag_id: id,
          content_id: contentId,
        });
    }
  }
  const hideFailed = hideErrorMessage !== null;

  // BAN アクションの場合、/api/admin/users/[id]/freeze と同じ frozen_at 機構で
  // BAN を適用する (#1041 round-2 D: 'banned' roles 追加は管理画面に反映されない
  // 偽成功だった)。
  let banApplied: boolean | null = null;
  let banErrorMessage: string | null = null;
  let banUnbanAt: string | null = null;
  const banRequested = action === 'delete_and_temp_ban' || action === 'delete_and_perm_ban';
  // #1041 round-3 (W2): BAN を要求したのにコンテンツ所有者が特定できない
  // (削除済み等で null) 場合、従来は黙ってスキップし 200 { ban_applied: null }
  // を返していた。ここでは即座に返さず、まず監査ログに記録してから 422 で
  // 明示する (status 更新は既に成功しているため取り消さない)。
  const banTargetUnresolved = banRequested && !contentUserId;

  // #1041 round-4 (S): 従来は `(banRequested || action === 'delete_and_warn')` の
  // 条件だったが、`delete_and_warn` (BAN を伴わない警告) には対応処理が無く
  // (実体は下の監査ログ INSERT のみで、それは action によらず常に実行される)、
  // `delete_and_warn` 側は dead condition だった。挙動を変えず条件を整理する。
  // #1101: コンテンツを隠せなかったときは BAN しない (隠れていないコンテンツが残ったまま
  // 持ち主だけ止めることになる)。同じ操作をやり直せば、隠してから BAN する。
  if (contentUserId && banRequested && !hideFailed) {
    const banResult = await applyUserBan(supabaseAdmin, {
      userId: contentUserId,
      actorId: actor.id,
      banType: action === 'delete_and_perm_ban' ? 'permanent' : 'temporary',
      reason: `[moderation:${type}] ${resolution_note ?? action}`,
      durationDays: ban_duration_days,
    });
    banApplied = banResult.success;
    banUnbanAt = banResult.unbanAt;
    if (!banResult.success) {
      banErrorMessage = banResult.error ?? 'BAN の適用に失敗しました';
      console.error('[api/admin/moderation/[type]/[id]] BAN failed:', banErrorMessage);
    }
  }

  // 監査ログ INSERT
  await supabase.from('admin_audit_logs').insert({
    actor_id: actor.id,
    action_type: `admin.moderation.${action}`,
    target_id: id,
    target_type: `moderation_item:${type}`,
    details: {
      action,
      moderation_type: type,
      ban_duration_days,
      resolution_note,
      content_user_id: contentUserId,
      // #1101: 通報されたコンテンツ本体の ID と、隠したかどうか。delete_* 以外のアクション、
      // コンテンツが紐づかない通報、隠せなかったときは hidden: false (隠せなかった理由は hide_error)
      content_id: contentId,
      hidden: contentHidden,
      hidden_ids: hiddenIds,
      hide_error: hideErrorMessage,
      ban_applied: banTargetUnresolved ? null : banApplied,
      ban_error: banTargetUnresolved
        ? 'BAN 対象ユーザーを特定できませんでした (コンテンツ所有者不明)'
        : hideFailed && banRequested
          ? 'コンテンツを隠せなかったため BAN を実行していません'
          : banErrorMessage,
      // #1041 round-3 (W1): freeze route (unban_at) とのパリティ。temp ban の
      // 解除予定日時を永続化する列が無いため、監査ログが唯一の記録経路。
      unban_at: banUnbanAt,
    },
    severity: action.includes('ban') || hideFailed ? 'warn' : 'info',
    ip_address: request.headers.get('x-forwarded-for'),
  });

  // #1101: 判定 (status 更新) は保存済みだが、コンテンツを隠せなかった。200 (「削除した」の
  // 偽成功) にせず 500 で明示する。BAN は実行していない。同じ操作をもう一度実行すると隠し直せる。
  if (hideFailed) {
    return NextResponse.json(
      {
        error: {
          code: 'OP_CONTENT_HIDE_FAILED',
          message: banRequested
            ? 'コンテンツを非表示にできませんでした。モデレーション判定自体は保存されていますが、BAN はまだ実行していません。もう一度同じ操作を実行してください。'
            : 'コンテンツを非表示にできませんでした。モデレーション判定自体は保存されています。もう一度同じ操作を実行してください。',
        },
        data: { status: newStatus, content_hidden: false, ban_applied: null },
      },
      { status: 500 },
    );
  }

  // #1041 round-3 (W2): BAN を要求したがコンテンツ所有者を特定できない場合は、
  // モデレーション判定 (status 更新) 自体は保存済みでも 200 (ban_applied: null
  // の偽成功) を返さず 422 で明示する。
  if (banTargetUnresolved) {
    return NextResponse.json(
      {
        error: {
          code: 'OP_BAN_TARGET_UNRESOLVED',
          message:
            'BAN 対象ユーザーを特定できませんでした (コンテンツ所有者が不明のため)。モデレーション判定自体は保存されています。',
        },
        data: { status: newStatus, ban_applied: null },
      },
      { status: 422 },
    );
  }

  // #1041 round-2 (D): モデレーション自体 (status 更新) は既に成功しているが、
  // BAN 適用に失敗した場合は success:true を返さず、部分失敗を明示する。
  if (banApplied === false) {
    return NextResponse.json(
      {
        error: {
          code: 'OP_BAN_FAILED',
          message: banErrorMessage ?? 'BAN の適用に失敗しました (モデレーション判定自体は保存されています)',
        },
        data: { status: newStatus, ban_applied: false },
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ data: { success: true, status: newStatus, ban_applied: banApplied } });
}

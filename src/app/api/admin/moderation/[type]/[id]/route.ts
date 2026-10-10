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
 *  - 順番は「隠す → 判定の保存 (`resolveModerationItem`) → BAN」。隠せなかったら判定を保存せず
 *    (通報は審査待ち pending のまま)、BAN もせずに 500 `OP_CONTENT_HIDE_FAILED` を返す (成功を装わない)。
 *    審査待ちのままなので、画面を開き直しても審査のフォームが出て、同じ操作をもう一度実行できる。
 *    隠したあとで判定の保存に失敗したときも、審査待ちのまま 500 を返す。隠すのは冪等 (すでに隠れている
 *    行は上書きしない) なので、やり直しても保管期間の起点は延びない
 *  - 通報にコンテンツが紐づかない (`content_id` が null。持ち主が先に消した等) ときは、隠す対象が
 *    無いので隠さずに続行する。監査ログには `hidden: false` と `content_id: null` が残る
 *  - 監査ログの details に `content_id` と `hidden`、この操作で新しく隠した行の ID (`hidden_ids`)、判定を保存したか
 *    (`status_saved`。保存できなかった理由は `status_error`) を記録する。隠せなかったとき・隠したあとで判定を保存できなかった
 *    ときも、監査ログ (severity warn) を残す
 *  - 食事は、家族へのペーストで作られた複製 (同じ `paste_group_id`) のうち、中身 (写真とメモ) が通報された
 *    行と同じものもまとめて隠す (中身を書き換えた行は隠さない)
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
import { applyUserBan, BAN_INTERNAL_ERROR_MESSAGE } from '@/lib/admin/user-ban';

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
  const banRequested = action === 'delete_and_temp_ban' || action === 'delete_and_perm_ban';
  const contentId = item.content_id;

  /** 監査ログ (admin_audit_logs) に 1 行入れる。失敗で返すときも、成功で返すときも、同じ形で残す */
  const insertAuditLog = async (
    outcome: {
      contentHidden: boolean;
      hiddenIds: string[];
      hideError: string | null;
      /** 判定 (通報の status) を保存したか */
      statusSaved: boolean;
      statusError: string | null;
      banApplied: boolean | null;
      banError: string | null;
      unbanAt: string | null;
    },
    failed: boolean,
  ) => {
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
        hidden: outcome.contentHidden,
        hidden_ids: outcome.hiddenIds,
        hide_error: outcome.hideError,
        // #1101: 判定を保存したか (隠せなかったときは、判定を保存せずに返す。保存できなかった理由は status_error)
        status_saved: outcome.statusSaved,
        status_error: outcome.statusError,
        ban_applied: outcome.banApplied,
        ban_error: outcome.banError,
        // #1041 round-3 (W1): freeze route (unban_at) とのパリティ。temp ban の
        // 解除予定日時を永続化する列が無いため、監査ログが唯一の記録経路。
        unban_at: outcome.unbanAt,
      },
      severity: action.includes('ban') || failed ? 'warn' : 'info',
      ip_address: request.headers.get('x-forwarded-for'),
    });
  };

  // #1101: delete_* アクションは、通報されたコンテンツ (meals / recipes の行) を「隠す」。
  // 行は消さず、hidden_at を入れて本人以外に見えなくする (完全削除は保管期間のあと)。
  // 順番は「隠す → 判定の保存 → BAN」。隠すのを判定の保存より先に行うのは、隠せなかったときに通報を
  // 審査待ち (pending) のまま残すため。判定を先に保存すると、隠せなかった通報が審査済みになって一覧
  // (pending) から消え、画面を開き直すと審査のフォームも出ないので、違反コンテンツが見えたまま
  // やり直す手段が無くなる。隠すのは冪等 (すでに隠れている行は上書きしない) なので、隠したあとで
  // 判定の保存に失敗しても、同じ操作をもう一度実行すればよい。通報にコンテンツが紐づいていなければ、隠す対象が無い。
  const hideRequested = isModerationDeleteAction(action);
  let contentHidden = false;
  // この操作で新しく隠した行の ID (食事はペーストの複製を含む)。運営が戻すときの手がかりとして監査ログに残す
  let hiddenIds: string[] = [];
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
      const hideErrorMessage = describeError(err);
      createLogger('POST /api/admin/moderation/[type]/[id]', generateRequestId())
        .withUser(actor.id)
        .error('通報されたコンテンツを隠せませんでした', err, {
          moderation_type: type,
          flag_id: id,
          content_id: contentId,
        });
      await insertAuditLog(
        {
          contentHidden: false,
          hiddenIds: [],
          hideError: hideErrorMessage,
          statusSaved: false,
          statusError: null,
          banApplied: null,
          banError: banRequested ? 'コンテンツを隠せなかったため BAN を実行していません' : null,
          unbanAt: null,
        },
        true,
      );
      // 判定は保存していない (通報は審査待ちのまま)。200 (「削除した」の偽成功) にせず 500 で明示する。
      // 画面を開き直しても審査のフォームが出るので、同じ操作をもう一度実行できる
      return NextResponse.json(
        {
          error: {
            code: 'OP_CONTENT_HIDE_FAILED',
            message: banRequested
              ? 'コンテンツを非表示にできませんでした。モデレーション判定はまだ保存しておらず、BAN も実行していません (審査待ちのままです)。もう一度同じ操作を実行してください。'
              : 'コンテンツを非表示にできませんでした。モデレーション判定はまだ保存していません (審査待ちのままです)。もう一度同じ操作を実行してください。',
          },
          data: { status: item.status, content_hidden: false, ban_applied: null },
        },
        { status: 500 },
      );
    }
  }

  try {
    await resolveModerationItem(supabaseAdmin, moderationType, id, {
      status: newStatus,
      resolvedBy: actor.id,
      resolutionNote: resolution_note ?? null,
    });
  } catch (err) {
    console.error('[api/admin/moderation/[type]/[id]] update error:', err instanceof Error ? err.message : err);
    // #1101: コンテンツはもう隠したのに判定を保存できなかったときは、隠した行の ID を監査ログに残す
    // (やり直したときは、すでに隠れている行を上書きしないので、hidden_ids が空になる。ここで残さないと、どの行を隠したか分からなくなる)
    if (contentHidden) {
      await insertAuditLog(
        {
          contentHidden,
          hiddenIds,
          hideError: null,
          statusSaved: false,
          statusError: describeError(err),
          banApplied: null,
          banError: banRequested ? '判定を保存できなかったため BAN を実行していません' : null,
          unbanAt: null,
        },
        true,
      );
      return NextResponse.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: banRequested
              ? 'モデレーション判定を保存できませんでした。コンテンツは非表示にしましたが、BAN はまだ実行していません (審査待ちのままです)。もう一度同じ操作を実行してください。'
              : 'モデレーション判定を保存できませんでした。コンテンツは非表示にしました (審査待ちのままです)。もう一度同じ操作を実行してください。',
          },
          data: { status: item.status, content_hidden: true, ban_applied: null },
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '更新に失敗しました' } },
      { status: 500 },
    );
  }

  // BAN アクションの場合、/api/admin/users/[id]/freeze と同じ frozen_at 機構で
  // BAN を適用する (#1041 round-2 D: 'banned' roles 追加は管理画面に反映されない
  // 偽成功だった)。
  let banApplied: boolean | null = null;
  /** 監査ログ (ban_error) に残す、BAN できなかった理由。DB の失敗なら元のエラー文 (応答の本文には出さない) */
  let banErrorMessage: string | null = null;
  /** 応答の本文に出してよい、BAN を断った理由 (こちらが書いた文)。DB の失敗のときは null のまま */
  let banRuleRejectionMessage: string | null = null;
  let banUnbanAt: string | null = null;
  // #1041 round-3 (W2): BAN を要求したのにコンテンツ所有者が特定できない
  // (削除済み等で null) 場合、従来は黙ってスキップし 200 { ban_applied: null }
  // を返していた。ここでは即座に返さず、まず監査ログに記録してから 422 で
  // 明示する (status 更新は既に成功しているため取り消さない)。
  const banTargetUnresolved = banRequested && !contentUserId;

  // #1041 round-4 (S): 従来は `(banRequested || action === 'delete_and_warn')` の
  // 条件だったが、`delete_and_warn` (BAN を伴わない警告) には対応処理が無く
  // (実体は下の監査ログ INSERT のみで、それは action によらず常に実行される)、
  // `delete_and_warn` 側は dead condition だった。挙動を変えず条件を整理する。
  // #1101: ここに来るのは、コンテンツを隠せた (または隠す対象が無い) ときだけ。隠してから BAN する
  if (contentUserId && banRequested) {
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
      if (banResult.kind === 'not_found' || banResult.kind === 'super_admin') {
        // 対象が見つからない / super_admin は BAN できない。こちらが書いた文なので、そのまま本文にも出す
        banErrorMessage = banResult.error ?? BAN_INTERNAL_ERROR_MESSAGE;
        banRuleRejectionMessage = banErrorMessage;
      } else {
        // #1172: DB の読み書きの失敗 (kind: 'internal')。元のエラーは構造化ログと監査ログ (ban_error。hide_error / status_error と
        // 同じ扱い) にだけ残し、応答の本文には固定の文を返す (下の OP_BAN_FAILED)。理由の種類が分からない失敗も、安全側でこちらに倒す
        const cause = banResult.cause ?? banResult.error;
        banErrorMessage = describeError(cause);
        createLogger('POST /api/admin/moderation/[type]/[id]', generateRequestId())
          .withUser(actor.id)
          .error('BAN を適用できませんでした', cause, {
            moderation_type: type,
            flag_id: id,
            content_user_id: contentUserId,
          });
      }
    }
  }

  // 監査ログ INSERT
  await insertAuditLog(
    {
      contentHidden,
      hiddenIds,
      hideError: null,
      statusSaved: true,
      statusError: null,
      banApplied: banTargetUnresolved ? null : banApplied,
      banError: banTargetUnresolved
        ? 'BAN 対象ユーザーを特定できませんでした (コンテンツ所有者不明)'
        : banErrorMessage,
      unbanAt: banUnbanAt,
    },
    false,
  );

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
          message: banRuleRejectionMessage ?? `${BAN_INTERNAL_ERROR_MESSAGE} (モデレーション判定自体は保存されています)`,
        },
        data: { status: newStatus, ban_applied: false },
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ data: { success: true, status: newStatus, ban_applied: banApplied } });
}

/**
 * GET /api/admin/users — ユーザー一覧・検索
 * operator/02-api-spec.md §4 準拠
 *
 * #1326: 1 件以上返した検索は、1 回の検索 = 1 行で admin.user.list を監査ログに残す
 * (検索条件と件数だけ。返した行の ID や値は入れない)。
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { buildListViewDetails, recordAdminAudit } from '@/lib/admin/audit';
import { UsersSearchSchema, type UserListItem, type UserListSortKey, type UsersListResponse } from '@/lib/admin/users-schemas';
import { canViewUserEmail, fetchUserEmails, findUserIdsByEmail } from '@/lib/admin/user-emails';
import { buildUserSearchFilter } from '@/lib/admin/users-search';
import { isAccountFrozen } from '@/lib/auth/frozen';
import { jstDayStartTimestamp } from '@/lib/date-utils';
import { jstOptionalDayRangeTimestamps } from '@/lib/jst-day-ranges';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';
import { FREE_PLAN_KEY } from '@/lib/billing/core';
import { LIST_ORDERS, orderListBy, type ListOrder } from '@/lib/api/list-order';

export const dynamic = 'force-dynamic';

/** ログの発生元 (src/lib/admin/user-emails.ts がメール取得の失敗を記録するときに使う) */
const LOG_SOURCE = 'GET /api/admin/users';

/**
 * sort の鍵と向きごとの user_profiles の並び (#2120 W3-2)。鍵 (USER_LIST_SORT_KEYS) を足すと並びの漏れが型の誤りになる。
 * sort が無ければ登録日の順 (USER_LIST_DEFAULT_SORT)。同じ値の行は id の順で、ページの境目でも順が変わらない (#2139 T1)。
 * NULL の位置はいままでどおり (昇順は最後・降順は最初。まだログインしていない人の last_login_at は空)
 */
const USER_LIST_ORDERS: Readonly<Record<UserListSortKey, Readonly<Record<'asc' | 'desc', ListOrder>>>> = {
  registered_at: { asc: LIST_ORDERS.adminUsersByRegisteredAtAsc, desc: LIST_ORDERS.adminUsersByRegisteredAtDesc },
  last_login: { asc: LIST_ORDERS.adminUsersByLastLoginAsc, desc: LIST_ORDERS.adminUsersByLastLoginDesc },
};
const USER_LIST_DEFAULT_SORT: UserListSortKey = 'registered_at';

export async function GET(request: Request) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'support']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: operatorForbiddenMessageOf(err) } },
        { status: 403 },
      );
    }
    throw err;
  }

  const { searchParams } = new URL(request.url);
  const parseResult = UsersSearchSchema.safeParse(Object.fromEntries(searchParams));
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'パラメータが不正です', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const params = parseResult.data;
  // requireRole 通過後のみ到達する。RLS は user_profiles に自分の行のみの
  // ポリシーしか無いため、admin/support 向け一覧取得には service_role が必須 (#1028)。
  const supabase = getSupabaseAdmin();

  // メールアドレスを見てよいのは admin / super_admin だけ (#1145)。support は一覧を見られるが、
  // メールは引かず、メールでの検索も効かせない (検索でメールの存在を推測させない)。
  const canSeeEmail = canViewUserEmail(actor.roles);

  // 全文検索 (email/name/id)
  // 検索語は buildUserSearchFilter が引用符・LIKE のワイルドカードをエスケープして or=(...) にする
  // (以前は文字列連結で、"," ")" で構文エラーになり、"%" "_" がワイルドカードとして働いた)。
  // メールの部分一致は admin / super_admin だけ。見つかった user_id を id.in.(...) で足す。
  const searchTerm = params.q?.trim();
  let searchFilter: string | null = null;
  if (searchTerm) {
    const emailMatchedIds = canSeeEmail ? await findUserIdsByEmail(supabase, searchTerm, LOG_SOURCE) : [];
    searchFilter = buildUserSearchFilter(searchTerm, emailMatchedIds);
  }

  // プランの絞り込み (#2112 Z5)。前後の空白を除いて空なら「指定なし」(検索語 q と同じ扱い。監査の検索条件にも残らない)。
  // 以前は plan を受け取って監査の検索条件に残すだけで一覧を絞らず、全プランの利用者を返していた
  // (監査には plan で絞ったように残った)。監査には、一覧の絞り込みに使ったこの値を残す
  const planFilter = params.plan?.trim() || undefined;

  // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectUsers) から作る。
  // 絞り込みを 2 か所に書くと、片方だけ直したときに件数と一覧がずれるため。
  // 凍結の判定の時刻も 1 回だけ決める (一覧と件数で同じ時刻を使う)
  const nowIso = new Date().toISOString();
  const selectUsers = (options: { head?: boolean } = {}) => {
    // ユーザープロファイルを検索
    let query = supabase
      .from('user_profiles')
      .select(
        `
      id,
      nickname,
      roles,
      organization_id,
      plan_key_cached,
      last_login_at,
      created_at,
      frozen_at,
      frozen_reason,
      frozen_by,
      unban_at
    `,
        listCountOptions(options.head),
      );

    if (searchFilter) {
      query = query.or(searchFilter);
    }

    // ロールフィルタ
    if (params.role) {
      query = query.contains('roles', [params.role]);
    }

    // プランフィルタ (#2112 Z5): 応答の plan_key と同じ意味で絞る。応答は plan_key_cached が空 (NULL) の利用者を
    // 'free' として返すので、plan=free は plan_key_cached が NULL か 'free' の行。それ以外は plan_key_cached の一致。
    // 一覧と件数の数え直しの両方に効く (selectUsers の中にあるため)
    if (planFilter === FREE_PLAN_KEY) {
      query = query.or(`plan_key_cached.is.null,plan_key_cached.eq.${FREE_PLAN_KEY}`);
    } else if (planFilter) {
      query = query.eq('plan_key_cached', planFilter);
    }

    // ステータスフィルタ
    // #1030 round-2: is_banned (レスポンス側) は isAccountFrozen (unban_at 考慮) で
    // 判定するため、フィルタ条件も同じ意味論に揃える。frozen_at IS NOT NULL だけで
    // 判定すると、一時 BAN が期限切れ (unban_at <= now) になったユーザーが
    // status=banned で検索すると is_banned: false のまま一覧に出てしまい、
    // status=active からは除外され続ける不整合が生じる。
    if (params.status === 'banned') {
      // 凍結中 かつ (無期限 BAN または unban_at が未到来)
      query = query
        .not('frozen_at', 'is', null)
        .or(`unban_at.is.null,unban_at.gt.${nowIso}`);
    } else if (params.status === 'active') {
      // 未凍結、または一時 BAN が期限切れ (unban_at が過去) で自動解除扱い
      query = query.or(
        `frozen_at.is.null,and(frozen_at.not.is.null,unban_at.not.is.null,unban_at.lte.${nowIso})`,
      );
    } else if (params.status === 'deleted') {
      // #2107 Y10: 退会 (src/lib/account-deletion.ts の auth.admin.deleteUser) は auth.users の行を消し、user_profiles の行も
      // 外部キーの ON DELETE CASCADE (user_profiles_id_fkey) で消える。user_profiles に削除済みのユーザーの行は無いので、
      // 削除済みの絞り込みは 1 行も当たらない (主キーの id は null にならない)。一覧と件数の数え直しの両方に効く。
      // 以前はこの分岐が無く、status=deleted で絞らずに生きているユーザーを返していた (削除済みの一覧に生きているユーザーが並んだ)
      query = query.is('id', null);
    }

    // 登録日フィルタ (#1433): 登録日 FROM の JST 0 時以上、登録日 TO の翌日の JST 0 時未満。
    // 日付の文字列をそのまま created_at (timestamptz) と比べると UTC の 0 時 = JST 9 時と読まれ、
    // JST の 0:00〜8:59 に登録したユーザーが FROM の日から落ち、TO の日の 0:00 より後がまるごと落ちる。
    const { fromTimestamp: registeredFrom, toTimestampExclusive: registeredToExclusive } =
      jstOptionalDayRangeTimestamps(params.registered_from, params.registered_to);
    if (registeredFrom) {
      query = query.gte('created_at', registeredFrom);
    }
    if (registeredToExclusive) {
      query = query.lt('created_at', registeredToExclusive);
    }

    // 最終ログイン (#1433): 「最終ログイン日がこの日より前」= その日の JST 0 時より前 (その日にログインした人は含めない)。
    if (params.last_login_before) {
      query = query.lt('last_login_at', jstDayStartTimestamp(params.last_login_before));
    }
    return query;
  };

  // ソート
  const listOrder = USER_LIST_ORDERS[params.sort ?? USER_LIST_DEFAULT_SORT][params.order];

  // ページネーション
  const from = (params.page - 1) * params.per_page;
  const to = from + params.per_page - 1;

  // 件数より後ろのページ (416 / PGRST103) は、失敗にせず空のページと本当の件数にする (src/lib/api/list-range.ts)
  const { data, error, count } = await resolveBeyondLastPage(
    await orderListBy(selectUsers(), listOrder).range(from, to),
    () => selectUsers({ head: true }),
    LOG_SOURCE,
  );

  if (error) {
    console.error('[api/admin/users] DB error:', error.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'データベースエラーが発生しました' } },
      { status: 500 },
    );
  }

  const rows = data ?? [];

  // メールアドレス (#1145): 一覧に出た id のぶんだけを、service_role 専用の RPC で auth.users から引く。
  // auth.admin.listUsers() は先頭 50 件しか引けないため使わない (#1204)。
  // 引けなかった (メールを持たない / 取得に失敗した) 行は null。support には引かない。
  const emails = canSeeEmail
    ? await fetchUserEmails(
        supabase,
        rows.map((u) => u.id),
        LOG_SOURCE,
      )
    : new Map<string, string>();

  // 応答の形は UserListItem (src/lib/admin/users-schemas.ts) が正本。一覧の画面 (/admin/users・/support/users) も同じ型で読む (#1717)
  const users: UserListItem[] = rows.map((u) => ({
    id: u.id,
    email: emails.get(u.id) ?? null,
    nickname: u.nickname,
    plan_key: u.plan_key_cached ?? FREE_PLAN_KEY,
    roles: u.roles ?? ['user'],
    // #1030: 一時 BAN は unban_at 経過後に自動解除扱いとする (判定時比較)。
    is_banned: isAccountFrozen({
      frozenAt: (u as { frozen_at?: string | null }).frozen_at ?? null,
      unbanAt: (u as { unban_at?: string | null }).unban_at ?? null,
    }),
    frozen_at: (u as { frozen_at?: string | null }).frozen_at ?? null,
    frozen_reason: (u as { frozen_reason?: string | null }).frozen_reason ?? null,
    frozen_by: (u as { frozen_by?: string | null }).frozen_by ?? null,
    unban_at: (u as { unban_at?: string | null }).unban_at ?? null,
    last_login_at: u.last_login_at,
    registered_at: u.created_at,
    meal_count: 0, // 集計は別クエリが必要
    organization_id: u.organization_id,
  }));

  // #1326: 一覧・検索の閲覧を、1 回の検索 = 1 行で監査ログに残す。検索条件 (検索語を含む) と件数だけを入れ、
  // 返した行の ID や値は入れない。0 件のときは情報を返していないので記録しない (07-audit-monitoring.md §4.1.1)。
  // 記録は本人の権限の client で行う (RLS の audit_logs_insert_admins は actor_id = auth.uid() を強制する)。
  // 記録に失敗しても一覧は返す (失敗は db-logger に error で残る)。
  if (users.length > 0) {
    await recordAdminAudit({
      supabase: await createClient(),
      actorId: actor.id,
      actionType: 'admin.user.list',
      targetType: 'user',
      details: buildListViewDetails(
        {
          q: params.q?.trim(),
          plan: planFilter,
          role: params.role,
          status: params.status,
          registered_from: params.registered_from,
          registered_to: params.registered_to,
          last_login_before: params.last_login_before,
          sort: params.sort,
          order: params.order,
          page: params.page,
          per_page: params.per_page,
        },
        users.length,
        count ?? null,
      ),
      request,
      routeName: LOG_SOURCE,
    });
  }

  const body: UsersListResponse = {
    data: users,
    meta: {
      total: count ?? 0,
      page: params.page,
      per_page: params.per_page,
    },
  };
  return NextResponse.json(
    body,
    // メールアドレスを含むため、共有キャッシュに残さない
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

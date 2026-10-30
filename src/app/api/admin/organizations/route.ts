/**
 * GET  /api/admin/organizations — 組織一覧取得
 * POST /api/admin/organizations — 組織作成
 * 権限: admin, super_admin
 *
 * operator/02-api-spec.md §4 (GET /api/admin/organizations :330・POST /api/admin/organizations :341) 準拠
 * E2E: w5-12-admin-adversarial C-14, C-14b, C-15, C-15b, C-16
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { isRaisedExceptionWithCode } from '@/lib/errors/db-raised-code';
import { z } from 'zod';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { ORG_PLAN_DEFAULT, ORG_PLAN_VALUES } from '@/lib/org-plans';
import { escapeLikePattern } from '@/lib/admin/users-search';

export const dynamic = 'force-dynamic';

const OrgSearchSchema = z.object({
  q: z.string().optional(),
  plan: z.enum(ORG_PLAN_VALUES).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(30),
});

const OrgCreateSchema = z.object({
  name: z.string().min(1, { message: '組織の名前 (name) は必須です' }).max(200),
  plan: z.enum(ORG_PLAN_VALUES).optional().default(ORG_PLAN_DEFAULT),
  // organizations.owner_id は active な行では NOT NULL (CHECK organizations_active_has_owner。#1103 項目 10 → #1917)。作る組織は active。
  // 本文では省略してよく、未指定時は呼び出し元の運営を owner にする (下の POST で必ず埋める)
  owner_id: z.string().uuid().optional(),
});

export async function GET(request: Request) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin']);
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

  void actor;

  const { searchParams } = new URL(request.url);
  const parseResult = OrgSearchSchema.safeParse(Object.fromEntries(searchParams));
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'パラメータが不正です', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { q, plan, page, per_page } = parseResult.data;
  // requireRole を通った運営だけが来る。organizations の SELECT のポリシーは所属している人の行 (organizations_select_member) だけで、
  // 運営の client では自分の組織しか読めない (一覧が欠け、作成の応答を受け取れなかったあとの確かめも作った組織を読めなかった。#2112 Z2)。
  // 利用者の一覧 (src/app/api/admin/users/route.ts。#1028) と同じく、一覧と件数は service_role で読む
  const supabase = getSupabaseAdmin();

  try {
    // 一覧と、範囲外のページのときの件数の取り直し (countOrganizations) は、同じ絞り込み (selectOrganizations) を使う。
    // 絞り込みを 2 か所に書くと、片方だけ直したときに件数と一覧がずれるため
    const filters: OrgListFilters = { q, plan };
    const from = (page - 1) * per_page;
    const to = from + per_page - 1;
    const { data, error, count, status } = await selectOrganizations(supabase, filters)
      .range(from, to)
      .order('created_at', { ascending: false });

    // 件数より後ろのページ (最後のページの唯一の行が消えたあと、同じページで読み直したときなど) は、PostgREST が
    // 416 (PGRST103) を返す。これを失敗にも「0 件」にもせず、空のページと本当の件数を返す (画面は件数から最後のページへ
    // 取り直す)。ローカルの Supabase では 416 の本文が途中で切れて error.code が取れないことがあるので、HTTP の
    // ステータスでも判定する (src/app/api/admin/inquiries/route.ts と同じ)。件数も取れなければ下の 500 にする
    if (error && isBeyondLastPage(error, status)) {
      const total = await countOrganizations(supabase, filters);
      if (total !== null) {
        return NextResponse.json({ organizations: [], meta: { total, page, per_page } });
      }
    }

    if (error) {
      // 読み出しの失敗を 200 の空の一覧 (total 0) で返すと、画面は「組織はまだありません」と見せてしまい、
      // 本当に 0 件なのか失敗なのかを見分けられない。失敗は 500 で返す (画面は取得の失敗と「再読み込み」を出す)
      console.error('[api/admin/organizations] GET error:', error.message);
      return listFailedResponse();
    }

    return NextResponse.json({
      organizations: data ?? [],
      meta: { total: count ?? 0, page, per_page },
    });
  } catch (err) {
    console.error('[api/admin/organizations] GET unexpected error:', err);
    // 想定外の例外も、空の一覧にせず 500 で返す (上の error と同じ理由)
    return listFailedResponse();
  }
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin']);
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
      { status: 400 },
    );
  }

  const parseResult = OrgCreateSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }

  const { name, plan, owner_id } = parseResult.data;
  const supabase = await createClient();

  // owner_id は必ず渡す (active な行では NOT NULL (CHECK organizations_active_has_owner)。#1103 項目 10 → #1917)。
  // 明示的に指定がない場合は呼び出し元 admin を owner とする
  const effectiveOwnerId = owner_id ?? actor.id;

  // 組織の行・オーナーの所属 (organization_id・org_role = 'owner'・加入日 joined_org_at = 今日・is_active_in_org = true)・席の行を、
  // DB 関数 admin_create_organization の 1 つのトランザクションで書く (#2107 Y4。最新の定義は
  // supabase/migrations/20261031100000_create_organization_owner_joined_at.sql (#2120 W1))。関数はオーナーの user_profiles の行をロックしてから
  // 所属を確かめるので、同じオーナーの同時の作成・応答が切れたあとの押し直しは 1 つだけ通る。途中で止まれば組織の行も残らない
  // (以前は所属の確認・組織の INSERT・席の行・所属の更新を別々の要求で行い、確認と更新の間に 2 つ目が通ると組織が 2 つでき、
  // 所属の更新に失敗しても組織が残った)。route は表に直接書かない
  const supabaseAdmin = getSupabaseAdmin();
  const { data: created, error: createError } = await supabaseAdmin.rpc('admin_create_organization', {
    p_name: name,
    p_plan: plan,
    p_owner_id: effectiveOwnerId,
  });

  if (createError) {
    // DB 関数が P0001 + コードの完全一致で止めた形だけを拾う。コードの判定は共通の関数で行い、route では (ログのほかに) `.message` を読まない (#1917)
    // オーナーがすでに組織に所属している (応答が切れたあとの押し直しで、直前に自分が作った組織のこともある。#2107 Y5)
    if (isRaisedExceptionWithCode(createError, OWNER_ALREADY_IN_ORG)) {
      return NextResponse.json(
        { error: { code: OWNER_ALREADY_IN_ORG, message: OWNER_ALREADY_IN_ORG_MESSAGE } },
        { status: 409 },
      );
    }
    // 退会の途中の人はオーナーにしない (#1917 の続き。DB のトリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting()) が
    // 関数の中の organizations の INSERT を止める。supabase/migrations/20261023130000_account_deletion_owner_guard.sql)。作らずに 409 で返す
    if (isRaisedExceptionWithCode(createError, OWNER_ACCOUNT_DELETING)) {
      return NextResponse.json(
        { error: { code: OWNER_ACCOUNT_DELETING, message: OWNER_ACCOUNT_DELETING_MESSAGE } },
        { status: 409 },
      );
    }
    // オーナーにする人が auth.users に居ない (運営がオーナーの ID を打ち間違えたなど。#2112 Z2)。関数の a の organizations の INSERT が
    // 外部キー organizations_owner_id_fkey (auth.users を参照) の違反 (23503) で止まり、何も書かれていない。関数の中のほかの外部キーは
    // ここでは違反しない (b のオーナーの user_profiles は a が通ったあと = オーナーが auth.users に居る・e の席の行は作った組織を指す)。
    // 押し直しても同じなので、一般の 500 にせず、ID が誤っていることが分かる文で返す
    if (createError.code === PG_FOREIGN_KEY_VIOLATION) {
      return NextResponse.json(
        { error: { code: OWNER_NOT_FOUND, message: OWNER_NOT_FOUND_MESSAGE } },
        { status: 422 },
      );
    }
    console.error('[api/admin/organizations] POST create error:', createError.message);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '組織の作成に失敗しました' } },
      { status: 500 },
    );
  }

  // 関数は作った組織を返す。形が違えば (起きないはず)、作れたとは言わずに一覧で確かめさせる (作成そのものは commit 済みのことがある)
  const parsedOrg = CreatedOrganizationSchema.safeParse(created);
  if (!parsedOrg.success) {
    console.error('[api/admin/organizations] POST create returned an unexpected shape');
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: ORG_CREATED_UNREADABLE_MESSAGE } },
      { status: 500 },
    );
  }
  const org = parsedOrg.data;

  // 監査ログ
  await recordAdminAudit({
    supabase,
    actorId: actor.id,
    actionType: 'admin.organization.create',
    targetId: org.id,
    targetType: 'organization',
    details: { name, plan },
    severity: 'info',
    request,
    routeName: 'api/admin/organizations POST',
  });

  return NextResponse.json({ organization: org });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET の道具 (行番号を参照する設計書があるので、GET と POST の本体の行はずらさず、ここ (ファイルの末尾) に置く)
// ─────────────────────────────────────────────────────────────────────────────

/** PostgREST が「件数より後ろのページ」(Range Not Satisfiable) で返す HTTP ステータス */
const HTTP_RANGE_NOT_SATISFIABLE = 416;
/** 同じときに PostgREST が返す error.code */
const POSTGREST_RANGE_NOT_SATISFIABLE_CODE = 'PGRST103';

/**
 * 一覧の行の列。owner_id は、組織の作成の応答を受け取れなかった画面が、読み直した組織が自分の送った作成か (送ったオーナーか) を
 * 比べるのに使う (運営だけの API。#2112 Z2。src/app/admin/organizations/OrganizationsManager.tsx の isSameOrganization)
 */
const ORG_LIST_COLUMNS = 'id, name, plan, owner_id, created_at, updated_at';

/** 一覧の絞り込み (GET のクエリの q・plan) */
interface OrgListFilters {
  q?: string;
  plan?: OrgSearchInput['plan'];
}

type OrgSearchInput = z.infer<typeof OrgSearchSchema>;
/** 一覧を読む client (service_role。GET の本体の説明) */
type ListClient = ReturnType<typeof getSupabaseAdmin>;

/**
 * organizations を一覧の列で読み、絞り込み (組織名の部分一致・プラン) を付ける。件数は exact で数える。
 * head: true のときは行を返さず件数だけを数える (範囲外のページのときの件数の取り直し)
 */
function selectOrganizations(supabase: ListClient, filters: OrgListFilters, options: { head?: boolean } = {}) {
  let query = supabase
    .from('organizations')
    .select(ORG_LIST_COLUMNS, { count: 'exact', head: options.head === true });
  if (filters.q) {
    // 組織名の % と _ (と \) は文字どおりに一致させる (「100%」で全部の組織に当てない。利用者の一覧の検索と同じ。#2112 Z2)
    query = query.ilike('name', `%${escapeLikePattern(filters.q)}%`);
  }
  if (filters.plan) {
    query = query.eq('plan', filters.plan);
  }
  return query;
}

/** 読み出しの失敗が「件数より後ろのページ」(416 / PGRST103) か */
function isBeyondLastPage(error: { code?: string | null }, status: number): boolean {
  return status === HTTP_RANGE_NOT_SATISFIABLE || error.code === POSTGREST_RANGE_NOT_SATISFIABLE_CODE;
}

/** 同じ絞り込みの件数だけを数え直す。数えられなければ null (呼び出し側は 500 にする) */
async function countOrganizations(supabase: ListClient, filters: OrgListFilters): Promise<number | null> {
  try {
    const { count, error } = await selectOrganizations(supabase, filters, { head: true });
    if (error || count === null) {
      console.error('[api/admin/organizations] GET count error:', error?.message ?? 'count is null');
      return null;
    }
    return count;
  } catch (err) {
    console.error('[api/admin/organizations] GET count unexpected error:', err);
    return null;
  }
}

/** 一覧を読み出せなかったときの 500 (画面は API の文をそのまま出す) */
function listFailedResponse() {
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: '組織の一覧を取得できませんでした' } },
    { status: 500 },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST の道具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 作る組織のオーナーが退会の途中 (退会の印 account_deletion_guards が新しい) のときに、トリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting()) が
 * RAISE するコード (supabase/migrations/20261023130000_account_deletion_owner_guard.sql)。応答の code にもそのまま使う
 */
const OWNER_ACCOUNT_DELETING = 'OWNER_ACCOUNT_DELETING';

/** 退会の手続き中のオーナーを断るときの文 (英字の項目名 owner_id を運営に見せない。#2107 Y5 の同じ型) */
const OWNER_ACCOUNT_DELETING_MESSAGE = '指定したオーナーは退会の手続き中です';

/**
 * 作る組織のオーナーがすでに組織に所属しているときに、DB 関数 admin_create_organization が RAISE するコード
 * (supabase/migrations/20261030150000_create_organization_atomic.sql)。応答の code にもそのまま使う
 */
const OWNER_ALREADY_IN_ORG = 'OWNER_ALREADY_IN_ORG';

/**
 * オーナーがすでに組織に所属しているときの文 (#2107 Y5)。応答が切れたあとに押し直すと、直前に自分が作った組織で断られるので、
 * 「別の組織」とは言わず、一覧で確かめさせる。英字の項目名 (owner_id) を運営に見せない (画面はこの文をそのまま出す)
 */
const OWNER_ALREADY_IN_ORG_MESSAGE =
  '指定したオーナーはすでに組織に所属しています (直前に作成した組織かもしれません。一覧で確かめてください)';

/** PostgreSQL の外部キーの違反の SQLSTATE (オーナーにする人が auth.users に居ない。organizations_owner_id_fkey) */
const PG_FOREIGN_KEY_VIOLATION = '23503';

/** オーナーにする人が auth.users に居ないときの応答の code (#2112 Z2) */
const OWNER_NOT_FOUND = 'OWNER_NOT_FOUND';

/** オーナーにする人が auth.users に居ないときの文 (英字の項目名 owner_id を運営に見せない。画面はこの文をそのまま出す) */
const OWNER_NOT_FOUND_MESSAGE = '指定したオーナーのユーザーが見つかりません';

/** DB 関数が作った組織を返したが、形が違って読めなかったときの文 (作成は済んでいることがあるので、一覧で確かめさせる) */
const ORG_CREATED_UNREADABLE_MESSAGE = '組織の作成の結果を読み取れませんでした。一覧で確かめてください';

/** DB 関数 admin_create_organization が返す、作った組織 (応答の organization。以前の route の応答と同じ列) */
const CreatedOrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  plan: z.string().nullable(),
  owner_id: z.string().uuid(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

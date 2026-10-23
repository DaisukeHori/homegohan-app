/**
 * GET /api/admin/sales/leads - 見込み客一覧
 * POST /api/admin/sales/leads - 見込み客作成
 *
 * operator/02-api-spec.md §14 準拠
 * 権限: sales, admin, super_admin
 *
 * #1326: 一覧は担当者の連絡先 (氏名・メール・電話) を返すため、1 件以上返したとき、
 * 1 回の取得 = 1 行で admin.sales.lead.list を監査ログに残す (絞り込みの条件と件数だけ)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED, authFailureNested } from '@/lib/api/error-responses';
import { leadListQuerySchema, createLeadSchema } from '@/lib/admin/sales-schemas';
import { internalError } from '@/lib/api/errors';
import { buildListViewDetails, recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

/** 400: 本文・クエリの検証の失敗の文 (項目ごとの理由は details に添える。message は画面がそのまま出す文なので文字列にする) */
const VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';

export async function GET(request: NextRequest) {
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);

    const { searchParams } = new URL(request.url);
    const queryResult = leadListQuerySchema.safeParse({
      stage: searchParams.get('stage') ?? undefined,
      assigned_to: searchParams.get('assigned_to') ?? undefined,
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
    });

    if (!queryResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE, details: queryResult.error.flatten() } },
        { status: 400 },
      );
    }

    const { stage, assigned_to, page, per_page } = queryResult.data;
    const supabase = await createClient();

    let query = supabase
      .from('sales_leads')
      .select(
        `
        id,
        company_name,
        industry,
        employee_count,
        contact_name,
        contact_email,
        contact_phone,
        source,
        stage,
        assigned_to,
        estimated_acv,
        notes,
        converted_org_id,
        created_at,
        updated_at
      `,
        { count: 'exact' },
      )
      .order('updated_at', { ascending: false })
      .range((page - 1) * per_page, page * per_page - 1);

    if (stage) query = query.eq('stage', stage);
    if (assigned_to) query = query.eq('assigned_to', assigned_to);

    const { data, error, count } = await query;

    if (error) {
      return internalError('GET /api/admin/sales/leads', error, { userId: currentUser.id }, { shape: 'nested' });
    }

    const rows = data ?? [];
    // #1326: 一覧の閲覧を 1 回 = 1 行で残す。0 件のときは情報を返していないので記録しない。
    // 記録に失敗しても一覧は返す (失敗は db-logger に error で残る)
    if (rows.length > 0) {
      await recordAdminAudit({
        supabase,
        actorId: currentUser.id,
        actionType: 'admin.sales.lead.list',
        targetType: 'sales_lead',
        details: buildListViewDetails({ stage, assigned_to, page, per_page }, rows.length, count ?? null),
        request,
        routeName: 'api/admin/sales/leads GET',
      });
    }

    return NextResponse.json({
      data,
      meta: { total: count ?? 0, page, per_page },
    });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/sales/leads', err, { log_context: '[sales/leads] GET error' }, { shape: 'nested' });
  }
}

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const currentUser = await requireRole(['sales', 'admin', 'super_admin']);

    const body = await request.json();
    const parseResult = createLeadSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: VALIDATION_ERROR_MESSAGE, details: parseResult.error.flatten() } },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const inputData = parseResult.data;

    // assigned_to が未指定の場合は作成者を割り当て
    const insertData = {
      ...inputData,
      assigned_to: inputData.assigned_to ?? currentUser.id,
      contact_email: inputData.contact_email || null,
    };

    const { data: lead, error } = await supabase
      .from('sales_leads')
      .insert(insertData)
      .select()
      .single();

    if (error || !lead) {
      return internalError('POST /api/admin/sales/leads', error, { userId: currentUser.id }, { shape: 'nested' });
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: currentUser.id,
      actionType: 'admin.sales.lead.create',
      targetId: lead.id,
      targetType: 'sales_lead',
      details: { company_name: insertData.company_name, stage: 'approach' },
      severity: 'info',
      request,
      routeName: 'api/admin/sales/leads POST',
    });

    return NextResponse.json({ data: lead }, { status: 201 });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('POST /api/admin/sales/leads', err, { log_context: '[sales/leads] POST error' }, { shape: 'nested' });
  }
}

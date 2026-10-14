/**
 * GET/POST/PUT/DELETE /api/org/departments — 部署管理 API
 * 所属組織の org_role が owner / admin のユーザーのみ (#1235)。判定は共通の requireOrgAdmin() (#1161)
 *
 * #1235 第2段 (設計 v2 §3.3.1):
 *  - 参照テーブルを実在する departments に修正 (organization_departments は存在しない)
 *  - レスポンスを画面の Department の形にそろえる
 *    (id / name / parentId / managerId / displayOrder / memberCount / createdAt)
 *  - memberCount は user_profiles.department_id の人数を service_role で集計する
 *    (user_profiles の SELECT は本人の行だけのため。組織の管理者に人数だけを返す)
 *  - チャレンジ・招待・子部署から参照されている部署の削除 (23503) は 409、対象が無ければ 404
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { readJsonBody } from '@/lib/http-params';

const MAX_NAME_LENGTH = 100;
const DEPARTMENT_COLUMNS = 'id, name, parent_id, manager_id, display_order, created_at';

interface DepartmentRow {
  id: string;
  name: string;
  parent_id: string | null;
  manager_id: string | null;
  display_order: number | null;
  created_at: string | null;
}

/**
 * 500 の本文は汎用メッセージだけにする (#1172: Supabase / Postgres の生のエラー文を返さない)。
 * 詳細は db-logger (app_logs) にだけ残す。
 */
function internalError(method: string, message: string, err: unknown) {
  createLogger(`${method} /api/org/departments`, generateRequestId()).error(message, err);
  return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, { status: 500 });
}

function handleError(method: string, err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
  }
  return internalError(method, '部署 API の処理に失敗しました', err);
}

function toDto(row: DepartmentRow, memberCount: number) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    managerId: row.manager_id,
    displayOrder: row.display_order ?? 0,
    memberCount,
    createdAt: row.created_at,
  };
}

function validateName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
}

function invalidNameResponse() {
  return NextResponse.json(
    { error: { code: 'VALIDATION_ERROR', message: `name は必須です (${MAX_NAME_LENGTH} 文字以内)` } },
    { status: 400 },
  );
}

/** 組織内の department_id → 所属人数 (service_role で集計。呼び出し前に requireOrgAdmin を通すこと) */
async function fetchMemberCounts(organizationId: string): Promise<Map<string, number>> {
  const { data, error } = await getSupabaseAdmin()
    .from('user_profiles')
    .select('department_id')
    .eq('organization_id', organizationId)
    .not('department_id', 'is', null);
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ department_id: string }>) {
    counts.set(row.department_id, (counts.get(row.department_id) ?? 0) + 1);
  }
  return counts;
}

function invalidJsonResponse() {
  return NextResponse.json(
    { error: { code: 'INVALID_JSON', message: 'リクエストボディが不正です' } },
    { status: 400 },
  );
}

export async function GET() {
  try {
    const { profile } = await requireOrgAdmin();
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('departments')
      .select(DEPARTMENT_COLUMNS)
      .eq('organization_id', profile.organization_id)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) {
      return internalError('GET', '部署一覧の取得に失敗しました', error);
    }
    const counts = await fetchMemberCounts(profile.organization_id);
    const departments = ((data ?? []) as DepartmentRow[]).map((row) => toDto(row, counts.get(row.id) ?? 0));
    return NextResponse.json({ departments });
  } catch (err) {
    return handleError('GET', err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { profile } = await requireOrgAdmin();
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return invalidJsonResponse();
    const body = (parsed.body ?? {}) as { name?: unknown };
    const name = validateName(body.name);
    if (!name) return invalidNameResponse();

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('departments')
      .insert({ name, organization_id: profile.organization_id })
      .select(DEPARTMENT_COLUMNS)
      .single();
    if (error) {
      return internalError('POST', '部署の作成に失敗しました', error);
    }
    return NextResponse.json({ department: toDto(data as DepartmentRow, 0) }, { status: 201 });
  } catch (err) {
    return handleError('POST', err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { profile } = await requireOrgAdmin();
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return invalidJsonResponse();
    const body = (parsed.body ?? {}) as { id?: unknown; name?: unknown };
    const id = body.id;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'id は必須です' } }, { status: 400 });
    }
    const name = validateName(body.name);
    if (!name) return invalidNameResponse();

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('departments')
      .update({ name })
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .select(DEPARTMENT_COLUMNS)
      .maybeSingle();
    if (error) {
      return internalError('PUT', '部署の更新に失敗しました', error);
    }
    if (!data) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: '部署が見つかりません' } }, { status: 404 });
    }
    const counts = await fetchMemberCounts(profile.organization_id);
    return NextResponse.json({ department: toDto(data as DepartmentRow, counts.get(id) ?? 0) });
  } catch (err) {
    return handleError('PUT', err);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { profile } = await requireOrgAdmin();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'id は必須です' } }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('departments')
      .delete()
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .select('id');
    if (error) {
      // 23503: チャレンジ (organization_challenges.department_id)・招待 (organization_invites.department_id)・
      //        子部署 (departments.parent_id) から参照されている。所属メンバー (user_profiles.department_id) は
      //        ON DELETE SET NULL のため削除を止めない
      if (error.code === '23503') {
        return NextResponse.json(
          {
            error: {
              code: 'DEPARTMENT_IN_USE',
              message: 'チャレンジ・招待・子部署から参照されているため削除できません',
            },
          },
          { status: 409 },
        );
      }
      return internalError('DELETE', '部署の削除に失敗しました', error);
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: '部署が見つかりません' } }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return handleError('DELETE', err);
  }
}

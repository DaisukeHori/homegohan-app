import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { readJsonBody } from '@/lib/http-params';
import { NextResponse } from 'next/server';

/**
 * 認可エラー (401 / 403) はそのまま返し、それ以外は 500 の汎用メッセージにする。
 * 生のエラー文は返さず (#1172)、詳細は db-logger (app_logs) にだけ残す。
 */
function handleError(method: 'GET' | 'POST', error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  createLogger(`${method} /api/announcements`, generateRequestId()).error('お知らせの処理に失敗しました', error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// お知らせ一覧
//   mode=public : 一般公開用。認証不要 (公開済みのお知らせだけ)
//   それ以外    : 管理用。admin / super_admin のみ (共通の requireRole()、#1161)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode'); // 'admin' | 'public'

  try {
    // 管理用：権限チェック
    if (mode !== 'public') {
      await requireRole(['admin', 'super_admin']);
    }

    const supabase = await createClient();
    let query = supabase.from('announcements').select('*').order('created_at', { ascending: false });

    if (mode === 'public') {
      // 一般公開用
      query = query.eq('is_public', true);
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ announcements: data });

  } catch (error) {
    return handleError('GET', error);
  }
}

// お知らせ作成 (admin / super_admin のみ。共通の requireRole()、#1161)
export async function POST(request: Request) {
  try {
    // 1. 権限チェック
    const actor = await requireRole(['admin', 'super_admin']);

    // 2. 作成
    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const { title, content, isPublic } = (parsedBody.body ?? {}) as {
      title?: unknown;
      content?: unknown;
      isPublic?: unknown;
    };

    // title / content は NOT NULL 列。未入力のまま DB に渡すと制約違反が 500 になるため、先に 400 で返す
    if (typeof title !== 'string' || title.trim() === '' || typeof content !== 'string' || content.trim() === '') {
      return NextResponse.json({ error: 'title and content are required' }, { status: 400 });
    }
    if (isPublic !== undefined && typeof isPublic !== 'boolean') {
      return NextResponse.json({ error: 'isPublic must be a boolean' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('announcements')
      .insert({
        title,
        content,
        is_public: isPublic,
        created_by: actor.id,
        published_at: isPublic ? new Date().toISOString() : null
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ announcement: data });

  } catch (error) {
    return handleError('POST', error);
  }
}

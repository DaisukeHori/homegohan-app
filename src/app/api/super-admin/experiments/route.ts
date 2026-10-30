/**
 * GET  /api/super-admin/experiments  — A/B テスト一覧
 * POST /api/super-admin/experiments  — A/B テスト作成
 * operator/02-api-spec.md §15 準拠
 *
 * 作成で同じキーの実験がすでにある (一意の制約 experiments_key_key の違反 23505) ときは 409 OP_EXPERIMENT_KEY_DUPLICATE (#2093 W1)。
 * 機能フラグ・機能パッケージ・クーポン・プランの作成と同じ形。以前は 500 (「処理中にエラーが発生しました」) で、作成の応答が切れたあとに
 * 押し直すと、作成は済んでいるのに失敗の文が出た
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import {
  CreateExperimentSchema,
  EXPERIMENT_KEY_DUPLICATE_ERROR_CODE,
  EXPERIMENT_KEY_DUPLICATE_MESSAGE,
} from '@/lib/super-admin/experiments-schemas';
import { internalError } from '@/lib/api/errors';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';
import { recordAdminAudit } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { readJsonBody, SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE } from '@/lib/super-admin/validation-errors';

/** Postgres の一意の制約の違反 (unique_violation)。experiments の一意の制約は key (experiments_key_key) と主キーの id で、id は DB が作る */
const PG_UNIQUE_VIOLATION = '23505';
/** 同じキーの実験がすでにあるときの HTTP ステータス (409 Conflict) */
const EXPERIMENT_KEY_DUPLICATE_HTTP_STATUS = 409;

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/super-admin/experiments';

export async function GET(request: NextRequest) {
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
    const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('per_page') ?? '50')));

    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectExperiments) から作る
    const selectExperiments = (options: { head?: boolean } = {}) => {
      let query = supabase
        .from('experiments')
        .select('*', listCountOptions(options.head));

      if (status) {
        query = query.eq('status', status);
      }

      return query;
    };

    const { data, error, count } = await resolveBeyondLastPage(
      await selectExperiments()
        .order('created_at', { ascending: false })
        .range((page - 1) * perPage, page * perPage - 1),
      () => selectExperiments({ head: true }),
      LIST_ROUTE_NAME,
    );

    if (error) {
      return internalError(LIST_ROUTE_NAME, error, { userId: user.id }, { shape: 'nested' });
    }

    return NextResponse.json({
      data: data ?? [],
      meta: { total: count ?? 0, page, per_page: perPage },
    });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/super-admin/experiments', err, {}, { shape: 'nested' });
  }
}

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const user = await requireRole(['super_admin']);
    const supabase = await createClient();
    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      // #1654: 本文が JSON として読めないときは 400 (外側の catch の 500 に落とさない)。コードはこの route の他の 400 と同じ VALIDATION_ERROR
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE } },
        { status: 400 },
      );
    }
    const body = bodyResult.body;

    const parsed = CreateExperimentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    // 書き込みは service_role だけ (requireRole を通したあと。運営の直接の書き込みを塞いだ。#1917 の続き)
    const { data, error } = await getSupabaseAdmin()
      .from('experiments')
      .insert({
        ...parsed.data,
        status: 'draft',
        created_by: user.id,
      })
      .select()
      .single();

    if (error) {
      // 同じキーの実験がすでにある (押し直しを含む) は 409 と日本語の文 (500 にしない。#2093 W1)
      if (error.code === PG_UNIQUE_VIOLATION) {
        return NextResponse.json(
          { error: { code: EXPERIMENT_KEY_DUPLICATE_ERROR_CODE, message: EXPERIMENT_KEY_DUPLICATE_MESSAGE } },
          { status: EXPERIMENT_KEY_DUPLICATE_HTTP_STATUS },
        );
      }
      return internalError('POST /api/super-admin/experiments', error, { userId: user.id }, { shape: 'nested' });
    }

    // 監査ログ
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      actionType: 'super_admin.plan.create',
      targetType: 'experiment',
      targetId: data.id,
      details: { key: parsed.data.key, name: parsed.data.name },
      severity: 'info',
      request,
      routeName: 'api/super-admin/experiments POST',
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('POST /api/super-admin/experiments', err, {}, { shape: 'nested' });
  }
}

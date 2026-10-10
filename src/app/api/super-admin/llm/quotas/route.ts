/**
 * GET   /api/super-admin/llm/quotas  — クォータ一覧 (設計上の目安。実際の AI 呼び出しには適用されない)
 * PATCH /api/super-admin/llm/quotas  — クォータ変更 (準備中・未対応。501 OP_NOT_SUPPORTED)
 * operator/02-api-spec.md §8 準拠
 *
 * #1149: LLM 利用クォータの管理は準備中 (未対応)。オーナー判断 (2026-10-08) で、作るまでは「準備中」と明示する。
 *   - GET が返すのはコードに直接書いた目安の値で、DB には保存されていない。AI を呼ぶ処理 (献立生成・相談・
 *     栄養計算など) はこの値を見ていないため、どの AI 機能も、この値では止まらない。
 *     それが分かるよう、応答に `enforced: false` を付ける。
 *   - 以前の PATCH は、値をどこにも保存せず、監査ログ (super_admin.llm_quota.override) だけを残して
 *     受け取った値をそのまま返していた。変更できたように見えるが、実際には何も変わらず、
 *     監査ログには「クォータを変更した」という事実と異なる記録だけが残った。
 *     いまの PATCH は何も保存せず、監査ログも残さず、501 を返す。
 *
 * 注意: この API は、AI プロバイダーへの送信を止めたり制限したりしない
 * (オーナー判断: 海外の AI プロバイダーへのデータ送信は止めない)。クォータを実際に効かせるかどうかは別の判断が要る。
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { respondNotSupported } from '@/lib/admin/not-supported';
import { LLM_QUOTA_UPDATE_NOT_SUPPORTED_MESSAGE, LLM_QUOTAS_NOT_ENFORCED_NOTE } from '@/lib/super-admin/llm-schemas';
import { internalError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireRole(['super_admin']);

    // デフォルトクォータ設定を返す (per operator/06-ai-llm.md §5.1)
    // 設計上の目安であり、DB には保存されておらず、AI の呼び出しにも適用されない (enforced: false)
    const defaultQuotas = [
      { plan_key: 'free', daily_limit: 50, monthly_limit: 1000 },
      { plan_key: 'pro', daily_limit: 500, monthly_limit: 10000 },
      { plan_key: 'family_basic', daily_limit: 800, monthly_limit: 20000 },
      { plan_key: 'family_pro', daily_limit: 1500, monthly_limit: 50000 },
      { plan_key: 'org_starter', daily_limit: 200, monthly_limit: 5000 },
      { plan_key: 'org_standard', daily_limit: 500, monthly_limit: 10000 },
      { plan_key: 'org_pro', daily_limit: 1000, monthly_limit: 30000 },
      { plan_key: 'org_enterprise', daily_limit: null, monthly_limit: null },
    ];

    return NextResponse.json({ data: defaultQuotas, enforced: false, note: LLM_QUOTAS_NOT_ENFORCED_NOTE });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    return internalError('GET /api/super-admin/llm/quotas', err, {}, { shape: 'nested' });
  }
}

export async function PATCH() {
  return respondNotSupported({
    routeName: 'PATCH /api/super-admin/llm/quotas',
    roles: ['super_admin'],
    message: LLM_QUOTA_UPDATE_NOT_SUPPORTED_MESSAGE,
  });
}

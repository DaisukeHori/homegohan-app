/**
 * GET /api/admin/finance/nps
 * NPS / CSAT 集計
 * operator/01-data-model.md §3.14
 * 権限: admin, super_admin, finance
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { NpsQuerySchema } from '@/lib/admin/finance-schemas';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['admin', 'super_admin', 'finance']);
    const supabase = createClient();

    const { searchParams } = new URL(request.url);
    const query = NpsQuerySchema.parse({
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      plan_key: searchParams.get('plan_key') ?? undefined,
    });

    // NPS サーベイ集計
    let npsQuery = supabase
      .from('nps_surveys')
      .select('id, score, comment, plan_key, responded_at')
      .not('responded_at', 'is', null);

    if (query.from) npsQuery = npsQuery.gte('sent_at', query.from);
    if (query.to) npsQuery = npsQuery.lte('sent_at', query.to);
    if (query.plan_key) npsQuery = npsQuery.eq('plan_key', query.plan_key);

    const { data: npsResponses, error: npsError } = await npsQuery.order('responded_at', { ascending: false });

    if (npsError) throw new Error(npsError.message);

    const responses = npsResponses ?? [];
    const total = responses.length;
    const promoters = responses.filter((r) => r.score >= 9).length;
    const passives = responses.filter((r) => r.score >= 7 && r.score <= 8).length;
    const detractors = responses.filter((r) => r.score <= 6).length;
    const npsScore = total > 0
      ? Math.round(((promoters - detractors) / total) * 100 * 10) / 10
      : 0;
    const avgScore = total > 0
      ? Math.round(responses.reduce((s, r) => s + r.score, 0) / total * 10) / 10
      : 0;

    // 送信数 (responded_at なし含む)
    let sentQuery = supabase.from('nps_surveys').select('id', { count: 'exact', head: true });
    if (query.from) sentQuery = sentQuery.gte('sent_at', query.from);
    if (query.to) sentQuery = sentQuery.lte('sent_at', query.to);
    if (query.plan_key) sentQuery = sentQuery.eq('plan_key', query.plan_key);
    const { count: sentCount } = await sentQuery;

    const responseRate = (sentCount ?? 0) > 0
      ? Math.round((total / (sentCount ?? 1)) * 100 * 10) / 10
      : 0;

    // CSAT 集計
    let csatQuery = supabase
      .from('csat_feedbacks')
      .select('id, score, comment, ticket_id, created_at');
    if (query.from) csatQuery = csatQuery.gte('created_at', query.from);
    if (query.to) csatQuery = csatQuery.lte('created_at', query.to);

    const { data: csatResponses, error: csatError } = await csatQuery.order('created_at', { ascending: false });

    if (csatError) throw new Error(csatError.message);

    const csatData = csatResponses ?? [];
    const csatTotal = csatData.length;
    const csatAvg = csatTotal > 0
      ? Math.round(csatData.reduce((s, r) => s + r.score, 0) / csatTotal * 10) / 10
      : 0;
    const csatDist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    for (const r of csatData) {
      csatDist[String(r.score)] = (csatDist[String(r.score)] ?? 0) + 1;
    }

    return NextResponse.json({
      data: {
        nps: {
          total_responses: total,
          promoters,
          passives,
          detractors,
          nps_score: npsScore,
          avg_score: avgScore,
          response_rate: responseRate,
          recent_comments: responses.slice(0, 10).map((r) => ({
            id: r.id,
            score: r.score,
            comment: r.comment,
            plan_key: r.plan_key,
            responded_at: r.responded_at,
          })),
        },
        csat: {
          total_responses: csatTotal,
          avg_score: csatAvg,
          score_distribution: csatDist,
          recent_feedbacks: csatData.slice(0, 10).map((r) => ({
            id: r.id,
            score: r.score,
            comment: r.comment,
            ticket_id: r.ticket_id,
            created_at: r.created_at,
          })),
        },
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: err.message } },
        { status: 403 },
      );
    }
    console.error('[finance/nps] unexpected error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

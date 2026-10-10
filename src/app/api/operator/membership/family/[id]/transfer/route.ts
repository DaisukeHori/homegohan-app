/**
 * POST /api/operator/membership/family/[id]/transfer
 * 家族代表者強制譲渡
 * 05-operator-emergency-ui.md §7 準拠
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import { resolveAuthEmails } from '@/lib/membership/resolve-auth-emails';
import { sendEmail } from '@/lib/emails/send';
import { emailFailureReasons } from '@/lib/emails/send-result';
import { renderForceTransferEmail } from '@/lib/emails/membership/operator-force-transfer';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'POST /api/operator/membership/family/[id]/transfer';

const BodySchema = z.object({
  to_user_id: z.string().uuid(),
  reason: z.string().min(1).max(1000),
});

/**
 * 通知・候補の取得に使う service_role のクライアント。接続情報は env-required の getter で取り出す (#1434)。
 * 欠けていれば MissingEnvError (message は固定の文で、変数名はサーバーのログにだけ残る)。
 */
function getServiceRoleClient() {
  const { url, serviceRoleKey } = getSupabaseServiceConfig();
  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const logger = createLogger(ROUTE_NAME, generateRequestId());
  try {
    const { userId: operatorId } = await requireSuperAdmin();
    const { id: familyId } = params;

    const body = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }
    const { to_user_id, reason } = parsed.data;

    // 通知メール用に、RPC 実行"前"の旧代表者と家族名を控えておく (#1209)。
    // operator_force_representative_transfer は family_groups.representative_id を新代表者へ
    // 書き換えてから戻るため、RPC の後に読み直すと「旧代表者」が新代表者自身になってしまう。
    // その結果、本当の旧代表者に旧オーナー向けの通知が届かず、新代表者宛の「旧オーナー」欄も
    // 新代表者自身のアドレスになる。
    // 通知は best-effort (設計 §8) なので、ここで失敗しても譲渡は止めず、後段で通知だけを省く。
    let preFg: { name: string | null; representative_id: string } | null = null;
    let preFgError: unknown = null;
    try {
      const { data, error } = await getServiceRoleClient()
        .from('family_groups')
        .select('name, representative_id')
        .eq('id', familyId)
        .maybeSingle();
      preFg = data;
      preFgError = error;
    } catch (err) {
      preFgError = err;
    }

    const supabase = createClient();

    // RPC 実行
    const { data: family, error: rpcError } = await supabase.rpc('operator_force_representative_transfer', {
      p_family_id: familyId,
      p_new_rep_id: to_user_id,
      p_reason: reason,
    });

    if (rpcError) {
      const code = rpcError.message.includes('TARGET_NOT_IN_FAMILY')
        ? 'TARGET_NOT_IN_FAMILY'
        : rpcError.message.includes('NOT_OPERATOR')
          ? 'FORBIDDEN'
          : 'INTERNAL_ERROR';
      // 想定外の失敗 (DB の障害など) は、生のエラー文を本文に出さず、構造化ログに残して 500 にする (#1172)
      if (code === 'INTERNAL_ERROR') return internalError(ROUTE_NAME, rpcError, { userId: operatorId }, { shape: 'nested' });
      return NextResponse.json({ error: { code, message: rpcError.message } }, { status: code === 'FORBIDDEN' ? 403 : 400 });
    }

    // 通知メール (best-effort)。譲渡はすでに完了しているので、失敗しても 200 を返し、ログに残す。
    // ログには宛先のメールアドレスを残さない。
    const log = logger.withUser(operatorId);
    if (!preFg) {
      // 旧代表者が分からないまま送ると、旧代表者に一般メンバー向けの本文が届いてしまう。
      // 誤った宛先・本文で送るより、送らずにログへ残す (譲渡自体は完了している)。
      log.error(
        '譲渡前の家族情報を取得できなかったため、通知メールを送信しませんでした',
        preFgError ?? new Error('family_groups の行が見つかりません'),
        { family_id: familyId, to_user_id },
      );
      return NextResponse.json({ data: family });
    }

    try {
      const admin = getServiceRoleClient();

      const { data: members, error: membersError } = await admin
        .from('family_members')
        .select('user_id')
        .eq('family_id', familyId)
        .eq('status', 'active');
      // 読めなかったときに「メンバーがいない」と区別がつかず、黙って誰にも送らなくなるのを防ぐ (下の catch で記録する)
      if (membersError) throw membersError;

      // アカウントを持たない子供は user_id が NULL (通知先にならない)。.in() に null を渡すと uuid として解釈できず失敗する
      const userIds = (members ?? [])
        .map((m) => m.user_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      // 旧代表者・家族名は RPC 実行前に控えた値を使う (RPC 後の representative_id は新代表者)
      const familyName = preFg.name ?? '';
      const oldRepId = preFg.representative_id;

      // auth.users のメールアドレス。listUsers() は先頭 50 件しか返さないため、通知先と
      // 旧・新代表者の分だけを引く (#1204)。取得できなかった人は警告ログに残り、その人には送らない
      const emailMap = await resolveAuthEmails([...userIds, oldRepId, to_user_id], { admin, logger: log });

      const { data: profiles } = await admin
        .from('user_profiles')
        .select('id, nickname')
        .in('id', userIds);
      const nicknameMap: Record<string, string> = {};
      for (const p of profiles ?? []) {
        nicknameMap[p.id] = p.nickname ?? '';
      }

      const newOwnerEmail = emailMap.get(to_user_id) ?? '';
      const oldOwnerEmail = oldRepId ? (emailMap.get(oldRepId) ?? '') : '';

      const emailTasks = userIds.flatMap((uid) => {
        const recipientEmail = emailMap.get(uid);
        if (!recipientEmail) return [];

        let role: 'old_owner' | 'new_owner' | 'member' = 'member';
        if (uid === oldRepId) role = 'old_owner';
        if (uid === to_user_id) role = 'new_owner';

        const envelope = renderForceTransferEmail({
          recipient_email: recipientEmail,
          recipient_name: nicknameMap[uid] ?? null,
          scope: 'family',
          scope_name: familyName,
          old_owner_email: oldOwnerEmail,
          new_owner_email: newOwnerEmail,
          reason,
          recipient_role: role,
        });
        return [sendEmail(envelope)];
      });

      const results = await Promise.allSettled(emailTasks);
      // 送れなかったもの: reject (想定外の例外) と ok: false の結果 (sendEmail は配信の失敗で例外を投げない)。
      // 1 通ごとの詳細 (文面の名前・マスクした宛先・エラーコード) は sendEmail が app_logs に記録している
      const failures = emailFailureReasons(results);
      if (failures.length > 0) {
        // 個別の送信失敗も握りつぶさず記録する (ログに宛先のメールアドレスは残さない)
        log.error('通知メールの一部を送信できませんでした', failures[0], {
          family_id: familyId,
          to_user_id,
          failed_count: failures.length,
        });
      }
    } catch (emailErr) {
      log.error('通知メール送信処理に失敗しました (譲渡は完了済み)', emailErr, {
        family_id: familyId,
        to_user_id,
      });
    }

    return NextResponse.json({ data: family });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    // 本文は汎用メッセージだけにし、元のエラーは構造化ログに残す (#1172)
    return internalError(ROUTE_NAME, err, {}, { shape: 'nested' });
  }
}

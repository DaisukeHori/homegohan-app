/**
 * メールの送信待ち (email_outbox) の DB の読み書き (#1193)。worker (src/lib/emails/outbox.ts の processEmailOutbox) に渡す OutboxStore の実装。
 * 正典: docs/design/operator/10-logs-and-mail-retry.md §6.4。判断 (取り合い・回数・dead の判定・伏せ字) は DB の RPC (§5.2) が行う。
 */
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { parseClaimedRows, type EmailTransportFailure, type OutboxFailOutcome, type OutboxStore } from '@/lib/emails/outbox';

/** RPC の失敗は例外にする (worker の route が 500 にして app_logs に残す。黙って 0 件にしない) */
function rpcError(name: string, error: { message: string; code?: string }): Error {
  return new Error(`${name} failed: ${error.code ?? 'unknown'}`); // message に DB の生の文を入れない (ログは cause で持つ)
}
export function createOutboxStore(admin = getSupabaseAdmin()): OutboxStore {
  return {
    async claim(workerId, limit, leaseSeconds) {
      const { data, error } = await admin.rpc('claim_email_outbox', { p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw rpcError('claim_email_outbox', error);
      return parseClaimedRows(data);
    },
    async complete(id, workerId, resendMessageId) {
      const { data, error } = await admin.rpc('complete_email_outbox', { p_id: id, p_worker_id: workerId, p_resend_message_id: resendMessageId });
      if (error) throw rpcError('complete_email_outbox', error);
      return data === true;
    },
    async fail(id, workerId, failure: EmailTransportFailure, policy): Promise<OutboxFailOutcome> {
      const { data, error } = await admin.rpc('fail_email_outbox', {
        p_id: id, p_worker_id: workerId, p_error_code: failure.code, p_error_message: failure.message,
        p_status_code: failure.statusCode, p_retryable: failure.retryable,
        p_max_attempts: policy.maxAttempts, p_retry_after_seconds: policy.retryAfterSeconds,
      });
      if (error) throw rpcError('fail_email_outbox', error);
      return data === 'queued' || data === 'dead' ? data : 'ignored';
    },
  };
}

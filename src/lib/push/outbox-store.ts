/**
 * Push 通知の送信待ち (push_outbox) の DB の読み書き (#1136)。worker の本体 (./outbox の processPushOutbox) に渡す PushOutboxStore。
 * service_role のクライアント (getSupabaseAdmin) だけを使う。RPC の名前と引数は migration (20261016237000_push_outbox.sql) の逐語。
 * RPC の失敗・戻りの形の誤りは throw する (route が 500 にする)。
 * 設計: docs/design/mobile/06-push-send.md §6.5
 */
import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import {
  parseClaimedRows,
  parseReceiptRows,
  type PushOutboxCleanupResult,
  type PushOutboxFailOutcome,
  type PushOutboxStore,
  type PushUserEligibility,
} from './outbox';

/** loadEligibility が読む user_profiles の列 (送る条件の材料だけ。名前・メールアドレスは読まない) */
const ProfileEligibilityRowSchema = z.object({
  id: z.string(),
  frozen_at: z.string().nullable(),
  unban_at: z.string().nullable(),
  terms_version_accepted: z.string().nullable(),
  privacy_version_accepted: z.string().nullable(),
});
/** loadEligibility が読む notification_preferences の列 (全体の on/off と夜間の時刻だけ) */
const PreferenceEligibilityRowSchema = z.object({
  user_id: z.string(),
  notifications_enabled: z.boolean(),
  quiet_hours_start: z.string().nullable(),
  quiet_hours_end: z.string().nullable(),
});
/** fail_push_outbox の戻り値 */
const FailOutcomeSchema = z.enum(['requeued', 'dead', 'ignored']);
/** complete / defer / record の戻り値 (更新できたら true) */
const UpdatedSchema = z.boolean();
/** cleanup_push_outbox の戻り (1 行) */
const CleanupRowSchema = z.object({
  expired: z.number().int().nonnegative(),
  sent_deleted: z.number().int().nonnegative(),
  dead_deleted: z.number().int().nonnegative(),
});

/** notification_preferences の行が無い利用者の既定 (列の既定と同じ: 通知は on・夜間の時刻は worker の既定 22:00 / 07:00) */
const DEFAULT_NOTIFICATIONS_ENABLED = true;

/** service_role で push_outbox の RPC と、送る条件の材料の表を読む store を作る */
export function createOutboxStore(): PushOutboxStore {
  const admin = getSupabaseAdmin();
  return {
    async claimQueued(workerId, limit, leaseSeconds) {
      const { data, error } = await admin.rpc('claim_push_outbox', {
        p_worker_id: workerId,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw error;
      return parseClaimedRows(data);
    },

    async loadEligibility(userIds) {
      const result = new Map<string, PushUserEligibility>();
      if (userIds.length === 0) return result;
      const ids = [...userIds];
      const profiles = await admin
        .from('user_profiles')
        .select('id, frozen_at, unban_at, terms_version_accepted, privacy_version_accepted')
        .in('id', ids);
      if (profiles.error) throw profiles.error;
      const preferences = await admin
        .from('notification_preferences')
        .select('user_id, notifications_enabled, quiet_hours_start, quiet_hours_end')
        .in('user_id', ids);
      if (preferences.error) throw preferences.error;

      const prefsByUser = new Map(
        z.array(PreferenceEligibilityRowSchema).parse(preferences.data ?? []).map((row) => [row.user_id, row]),
      );
      // プロフィールの行がある利用者だけ入れる (無い利用者は worker が profile_missing で dead にする)
      for (const profile of z.array(ProfileEligibilityRowSchema).parse(profiles.data ?? [])) {
        const prefs = prefsByUser.get(profile.id);
        result.set(profile.id, {
          frozenAt: profile.frozen_at,
          unbanAt: profile.unban_at,
          termsVersionAccepted: profile.terms_version_accepted,
          privacyVersionAccepted: profile.privacy_version_accepted,
          notificationsEnabled: prefs ? prefs.notifications_enabled : DEFAULT_NOTIFICATIONS_ENABLED,
          quietHoursStart: prefs ? prefs.quiet_hours_start : null,
          quietHoursEnd: prefs ? prefs.quiet_hours_end : null,
        });
      }
      return result;
    },

    async complete(id, workerId, receiptId) {
      const { data, error } = await admin.rpc('complete_push_outbox', {
        p_id: id,
        p_worker_id: workerId,
        p_receipt_id: receiptId,
      });
      if (error) throw error;
      return UpdatedSchema.parse(data);
    },

    async fail(input): Promise<PushOutboxFailOutcome> {
      const { data, error } = await admin.rpc('fail_push_outbox', {
        p_id: input.id,
        p_worker_id: input.workerId,
        p_error_code: input.errorCode,
        p_error_message: input.errorMessage,
        p_status_code: input.statusCode,
        p_retryable: input.retryable,
        p_max_attempts: input.maxAttempts,
        p_retry_after_seconds: input.retryAfterSeconds,
      });
      if (error) throw error;
      return FailOutcomeSchema.parse(data);
    },

    async defer(id, workerId, untilIso) {
      const { data, error } = await admin.rpc('defer_push_outbox', {
        p_id: id,
        p_worker_id: workerId,
        p_until: untilIso,
      });
      if (error) throw error;
      return UpdatedSchema.parse(data);
    },

    async claimReceipts(workerId, limit, minAgeSeconds, leaseSeconds) {
      const { data, error } = await admin.rpc('claim_push_receipts', {
        p_worker_id: workerId,
        p_limit: limit,
        p_min_age_seconds: minAgeSeconds,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw error;
      return parseReceiptRows(data);
    },

    async recordReceipt(id, workerId, status, receiptError) {
      const { data, error } = await admin.rpc('record_push_receipt', {
        p_id: id,
        p_worker_id: workerId,
        p_status: status,
        p_error: receiptError,
      });
      if (error) throw error;
      return UpdatedSchema.parse(data);
    },

    async deleteToken(pushTokenId) {
      const { count, error } = await admin.from('user_push_tokens').delete({ count: 'exact' }).eq('id', pushTokenId);
      if (error) throw error;
      return (count ?? 0) > 0;
    },

    async cleanup(): Promise<PushOutboxCleanupResult> {
      const { data, error } = await admin.rpc('cleanup_push_outbox');
      if (error) throw error;
      const rows = z.array(CleanupRowSchema).min(1).parse(data);
      const row = rows[0]!;
      return { expired: row.expired, sent: row.sent_deleted, dead: row.dead_deleted };
    },
  };
}

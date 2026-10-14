/**
 * 宛先停止リスト (email_blacklist) の読み書き。サーバー専用。#1184
 *
 * - 書く側: POST /api/webhooks/resend が、Resend から届いたハードバウンス・苦情の宛先を addToEmailBlacklist で入れる。
 * - 読む側: sendEmail (send.ts) が、送る前に lookupEmailSuppression で宛先を引く。載っていれば送らない。
 *
 * 宛先は小文字にそろえて (normalizeEmailAddress) 入れる。引くときは、そろえた形と元の形の両方で引く
 * (運営が SQL などで大文字を含む形のまま入れた行も見落とさないため)。
 *
 * email_blacklist は運営 (admin / super_admin) にしか RLS を開けていないので、service_role で読み書きする。
 * 表の正本は docs/design/operator/01-data-model.md §3.19 (reason は 'bounce' / 'complaint' / 'manual' のどれか)。
 */
import { getSupabaseAdmin } from '@/lib/supabase/server';

/** email_blacklist.reason に入れる値のうち、Webhook が入れるもの ('manual' は運営が手で入れる) */
export type EmailBlacklistReason = 'bounce' | 'complaint';

/**
 * 送る前に停止リストを引くときの待ち時間の上限 (ミリ秒)。
 * これを超えたら引けなかったものとして送る (下の lookupEmailSuppression の説明)。
 * DB が遅いときに、招待などの本体の操作の応答まで長く待たせないための値。
 */
const SUPPRESSION_LOOKUP_TIMEOUT_MS = 3000;

/** 停止リストのキーにする形。前後の空白を取り、小文字にそろえる */
export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * 送る前の停止リストの引き当ての結果。
 * - suppressed: 載っている (送らない)
 * - clear: 載っていない (送る)
 * - lookup_failed: 引けなかった (DB の失敗・時間切れ・設定の不足)。呼び出し側は送る
 */
export type EmailSuppressionLookup =
  | { status: 'suppressed'; reason: string }
  | { status: 'clear' }
  | { status: 'lookup_failed'; error: unknown };

/**
 * 宛先が停止リストに載っているかを引く。例外は投げない。
 *
 * 引けなかったときは lookup_failed を返し、呼び出し側 (sendEmail) は送る (止めない側に倒す)。
 * 停止リストの読み出しの一時的な失敗で、招待・通知のメールを全部止めてしまわないため。
 * 載っている宛先にたまたま 1 通届くことはあり得るが、停止の仕組みが無かった前の状態より悪くはならない。
 */
export async function lookupEmailSuppression(address: string): Promise<EmailSuppressionLookup> {
  try {
    const normalized = normalizeEmailAddress(address);
    const candidates = [...new Set([normalized, address])];
    const { data, error } = await getSupabaseAdmin()
      .from('email_blacklist')
      .select('email, reason')
      .in('email', candidates)
      .limit(1)
      .abortSignal(AbortSignal.timeout(SUPPRESSION_LOOKUP_TIMEOUT_MS));
    if (error) return { status: 'lookup_failed', error };
    const row = data?.[0];
    return row ? { status: 'suppressed', reason: row.reason } : { status: 'clear' };
  } catch (error) {
    return { status: 'lookup_failed', error };
  }
}

/** addToEmailBlacklist の結果。DB の生のエラー文は返さない (ログ・呼び出し側の 500 の cause にだけ使う) */
export type AddToEmailBlacklistResult = { ok: true } | { ok: false; error: unknown };

/**
 * 宛先を停止リストに入れる。同じ宛先が既に載っていれば何もしない (ON CONFLICT DO NOTHING)。
 * そのため、同じイベントが何度届いても結果は変わらない (冪等)。最初に載った理由と時刻が残る
 * (運営が手で入れた 'manual' の行も上書きしない)。
 *
 * @param addresses 宛先 (小文字にそろえて、重複を除いて入れる)
 * @param reason    'bounce' (ハードバウンス) / 'complaint' (迷惑メールの報告)
 * @param addedAt   受けた時刻 (ISO 8601)
 */
export async function addToEmailBlacklist(
  addresses: readonly string[],
  reason: EmailBlacklistReason,
  addedAt: string,
): Promise<AddToEmailBlacklistResult> {
  const emails = [...new Set(addresses.map(normalizeEmailAddress).filter((email) => email !== ''))];
  if (emails.length === 0) return { ok: true };
  try {
    const { error } = await getSupabaseAdmin()
      .from('email_blacklist')
      .upsert(
        emails.map((email) => ({ email, reason, added_at: addedAt })),
        { onConflict: 'email', ignoreDuplicates: true },
      );
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

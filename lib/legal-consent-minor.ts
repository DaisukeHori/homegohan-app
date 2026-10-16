/**
 * 18 歳未満の本人の「保護者の同意とのつながり」を DB に聞いて、同意ゲートの入力に足す (#1173)。
 *
 * lib/legal-consent.ts は副作用のない関数だけのファイルなので、DB に聞く処理はここに置く。
 * 全リクエストの前に動く proxy (src/proxy.ts) から lib/supabase/middleware.ts 経由で import される。依存は @supabase/ssr の型と shared だけに保つ。
 * 呼ぶのは middleware の画面の分岐と /api の分岐、同意画面のサーバー側、GET /api/legal/status の route。
 * /auth/callback は呼ばない (初期設定前の新しいアカウントは、同意画面が数え直す)。
 */
import type { createServerClient } from '@supabase/ssr';
import { requiresParentalConsent, todayLocal, type LegalConsentProfile } from '@homegohan/shared';

/** middleware・同意画面・GET /api/legal/status の route が使う Supabase のクライアント (3 つとも @supabase/ssr の createServerClient で作る) */
type GuardianRpcClient = Pick<ReturnType<typeof createServerClient>, 'rpc'>;

/**
 * 18 歳未満の本人について、保護者の同意とのつながり (DB の legal_minor_has_guardian_path()) を聞き、
 * minor_guardian_ok に入れて返す (#1173)。行が無い・生年月日が無い・18 歳以上なら DB に聞かず、受け取った値をそのまま返す。
 * DB への問い合わせが失敗したときは minor_guardian_ok = true (素通り)。middleware はプロフィールを読めないときに
 * 判定を飛ばす (#348) のと同じ扱い。18 歳未満の新しい自己登録は accept_legal_documents が断るので、素通りでも開かない。
 */
export async function withMinorGuardianStatus<P extends LegalConsentProfile>(
  supabase: GuardianRpcClient,
  profile: P | null | undefined,
  today: string = todayLocal(),
): Promise<P | null | undefined> {
  const birthDate = profile?.birth_date;
  if (!profile || !birthDate || !requiresParentalConsent(birthDate, today)) return profile;
  const { data, error } = await supabase.rpc('legal_minor_has_guardian_path');
  return { ...profile, minor_guardian_ok: error ? true : data === true };
}

/**
 * 不審なログインの判定 (純関数)。設計の正典 docs/design/cross/16-auth-history-sessions.md §12.3・§10.1。
 */
import { SERVER_DEVICE_FAMILY_KEY, UNKNOWN_DEVICE_FAMILY_KEY } from './device-family';

export interface LoginContext {
  /** deviceFamilyOf(user_agent).key */
  readonly deviceFamilyKey: string;
  /** user_sessions_metadata.ip_network の文字列 (例 "203.0.113.0/24")。無ければ null */
  readonly ipNetwork: string | null;
  readonly countryCode: string | null;
}
export type LoginAlertReason = 'first_login' | 'history_expired' | 'known' | 'new_device' | 'new_country' | 'new_device_and_country';
export interface LoginAlertDecision {
  readonly isNewDevice: boolean;
  readonly isNewIp: boolean;
  readonly isNewCountry: boolean;
  /** メールを送るか = 新しい端末の種類 または 新しい国。IP の範囲だけでは送らない (§7.1) */
  readonly shouldNotify: boolean;
  readonly reason: LoginAlertReason;
}
/** prior が空のとき、初めてのログインか、履歴が保持期間で消えたのかを見分ける材料 (§10.1) */
export interface LoginHistoryHorizon {
  /** auth.users.created_at (auth.admin.getUserById の user.created_at) */
  readonly accountCreatedAt: Date;
  /** worker の now() */
  readonly now: Date;
  /** LOGIN_HISTORY_RETENTION_DAYS (constants.ts。実装では import して渡す) */
  readonly retentionDays: number;
}
/**
 * 端末を表さない種類 (「不明な端末」)。device-family.ts の SERVER_DEVICE_FAMILY_KEY ('other/server') と UNKNOWN_DEVICE_FAMILY_KEY
 * ('other/other')。prior に同じ値があっても既知にしない (§10.1・§7.1)
 */
const UNIDENTIFIED_DEVICE_FAMILY_KEYS: ReadonlySet<string> = new Set([SERVER_DEVICE_FAMILY_KEY, UNKNOWN_DEVICE_FAMILY_KEY]);
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
/**
 * prior = 同じ利用者の、この行より前に作られた行すべて (live・終わった行の両方。期間では絞らない §13.3)。
 * prior が空で、アカウントの年齢が保持の日数以下なら初めてのログイン (消えた行はあり得ない §10.1)。
 * 保持の日数を超えていれば、履歴が消えた (比べる相手が無い) とみなし、新しい端末として知らせる (不明な端末でも同じ)。
 * current が不明な端末 (UNIDENTIFIED_DEVICE_FAMILY_KEYS) なら、prior に同じ値があっても新しい端末とする
 * (Node の既定の UA で GoTrue を直接呼ぶ攻撃者 S-4 を、何もしないで既知にさせない)。
 */
export function decideLoginAlert(
  current: LoginContext,
  prior: ReadonlyArray<LoginContext>,
  horizon: LoginHistoryHorizon,
): LoginAlertDecision {
  if (prior.length === 0) {
    const accountAgeMs = horizon.now.getTime() - horizon.accountCreatedAt.getTime();
    if (accountAgeMs <= horizon.retentionDays * MS_PER_DAY) {
      return { isNewDevice: false, isNewIp: false, isNewCountry: false, shouldNotify: false, reason: 'first_login' };
    }
    return {
      isNewDevice: true,
      isNewIp: current.ipNetwork !== null,
      isNewCountry: false,
      shouldNotify: true,
      reason: 'history_expired',
    };
  }
  const deviceKnown =
    !UNIDENTIFIED_DEVICE_FAMILY_KEYS.has(current.deviceFamilyKey) &&
    prior.some((p) => p.deviceFamilyKey === current.deviceFamilyKey);
  const isNewDevice = !deviceKnown;
  const isNewIp = current.ipNetwork !== null && !prior.some((p) => p.ipNetwork === current.ipNetwork);
  const priorWithCountry = prior.filter((p) => p.countryCode !== null);
  const isNewCountry =
    current.countryCode !== null && priorWithCountry.length > 0 && !priorWithCountry.some((p) => p.countryCode === current.countryCode);
  const reason: LoginAlertReason =
    isNewDevice && isNewCountry ? 'new_device_and_country' : isNewDevice ? 'new_device' : isNewCountry ? 'new_country' : 'known';
  return { isNewDevice, isNewIp, isNewCountry, shouldNotify: isNewDevice || isNewCountry, reason };
}

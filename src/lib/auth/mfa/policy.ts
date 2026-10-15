/**
 * 運営ロールの MFA (二段階認証) の方針 (純関数) と、猶予の環境変数の読み取り (#1176)
 *
 * 正典: docs/design/cross/12-operator-mfa.md §12.1 (ポリシー)・§12.2 (環境変数)。
 * 判定 decideOperatorAssurance は I/O を持たない。claims と factors を集めて渡すのは呼び出し側 (段 B の assertOperatorAssurance)。
 * 段 A で使うのは、status の route (GET /api/auth/mfa/status) が猶予の日時を読む readMfaEnforceFromEnv と、
 * 自己サービスの route の認可に渡す MFA_REQUIRED_ROLES。
 */
import type { RoleName } from '@/lib/auth/types';
import { createLogger } from '@/lib/db-logger';

/**
 * TOTP を必須にするロール (cross/01 §5.1 / 要件 §17.2)。この 4 つだけが登録できる (対象 = 必須)。
 * support / sales / content_moderator / org_admin は対象外 (任意の MFA は §27 Q-3)。
 * 写し: DB の public.operator_mfa_satisfied() の配列 (cross/12 §11.4)・apps/mobile の MOBILE_MFA_REQUIRED_ROLES・e2e の E2E_MFA_REQUIRED_ROLES。一致はそれぞれのテストが確かめる
 */
export const MFA_REQUIRED_ROLES = ['super_admin', 'admin', 'finance', 'org_industrial_doctor'] as const satisfies ReadonlyArray<RoleName>;

export type MfaRequiredRole = (typeof MFA_REQUIRED_ROLES)[number];

/** 猶予の開始日時を上書きする環境変数の名前。値を読むのは src/lib/auth/mfa/policy.ts の readMfaEnforceFromEnv だけ (src/lib/env.ts の readOnlyBy) */
export const OPERATOR_MFA_ENFORCE_FROM_ENV_NAME = 'OPERATOR_MFA_ENFORCE_FROM';

/**
 * ISO 8601 の日時でタイムゾーンを必ず持つもの (例: 2026-11-01T00:00:00+09:00 / 2026-10-31T15:00:00Z)。日付だけ・TZ 無しは受け付けない (解釈が環境で変わるため)。
 * 時差は -23:59〜+23:59 の形だけ。年月日時分秒は位置のグループ (ENFORCE_FROM_GROUP の番号) で取り出し、isExistingWallClock で実在する日時かを確かめる
 * (Date.parse は 2026-02-30 を 3/2 として受け付けるので、形と Date.parse だけでは打ち間違いを見逃す)。
 * 名前つきのグループ ((?<year>…)) は使わない: tsconfig.json の target が ES2017 で、TS1503 になる
 */
const ENFORCE_FROM_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** ENFORCE_FROM_PATTERN の位置のグループの番号 (match[0] は文字列の全体)。秒 (6) は省略できる */
const ENFORCE_FROM_GROUP = { year: 1, month: 2, day: 3, hour: 4, minute: 5, second: 6 } as const;

/** 秒を省いた文字列 (2026-11-01T00:00+09:00) の秒 */
const OMITTED_SECOND = 0;

/** Date の月は 0 始まり (文字列の月 = getUTCMonth() + 1) */
const MONTH_INDEX_OFFSET = 1;

/** 文字列に書かれた年月日時分秒 (時差を当てる前の壁時計) */
interface WallClockParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** ENFORCE_FROM_PATTERN に合った結果から、年月日時分秒を数で取り出す */
function wallClockPartsOf(match: RegExpExecArray): WallClockParts {
  const secondText: string | undefined = match[ENFORCE_FROM_GROUP.second];
  return {
    year: Number(match[ENFORCE_FROM_GROUP.year]),
    month: Number(match[ENFORCE_FROM_GROUP.month]),
    day: Number(match[ENFORCE_FROM_GROUP.day]),
    hour: Number(match[ENFORCE_FROM_GROUP.hour]),
    minute: Number(match[ENFORCE_FROM_GROUP.minute]),
    second: secondText === undefined ? OMITTED_SECOND : Number(secondText),
  };
}

/**
 * 年月日時分秒 (時差を当てる前の壁時計) が実在するか。UTC で組み立てて読み戻し、全部が一致するかで見る。
 * 2026-02-30・2026-04-31・T24:00・秒の 60 は繰り上がって一致しないので false。うるう年の 2/29 は true
 */
function isExistingWallClock(parts: WallClockParts): boolean {
  const probe = new Date(
    Date.UTC(parts.year, parts.month - MONTH_INDEX_OFFSET, parts.day, parts.hour, parts.minute, parts.second),
  );
  return (
    probe.getUTCFullYear() === parts.year &&
    probe.getUTCMonth() + MONTH_INDEX_OFFSET === parts.month &&
    probe.getUTCDate() === parts.day &&
    probe.getUTCHours() === parts.hour &&
    probe.getUTCMinutes() === parts.minute &&
    probe.getUTCSeconds() === parts.second
  );
}

export type AuthenticatorAssuranceLevel = 'aal1' | 'aal2';

export interface MfaEnforceFromSetting {
  /** 強制の開始日時。null = 即時に強制 (既定) */
  readonly enforceFrom: Date | null;
  /** 値が不正で無視したか (ログで知らせる用。値そのものは返さない) */
  readonly ignored: boolean;
}

/**
 * OPERATOR_MFA_ENFORCE_FROM の文字列 (未設定は undefined) から、強制の開始日時を決める。
 * 未設定・空白だけ → null (即時に強制。安全側の既定)。形が違う・日付として無効 (存在しない日時を含む) → null + ignored (打ち間違いで強制が外れないように)。
 */
export function resolveMfaEnforceFrom(raw: string | undefined): MfaEnforceFromSetting {
  const text = raw?.trim();
  if (!text) return { enforceFrom: null, ignored: false };
  const match = ENFORCE_FROM_PATTERN.exec(text);
  if (!match) return { enforceFrom: null, ignored: true };
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return { enforceFrom: null, ignored: true };
  if (!isExistingWallClock(wallClockPartsOf(match))) return { enforceFrom: null, ignored: true };
  return { enforceFrom: new Date(ms), ignored: false };
}

export function isMfaRequiredRoleSet(roles: ReadonlyArray<string>): boolean {
  return roles.some((role) => (MFA_REQUIRED_ROLES as ReadonlyArray<string>).includes(role));
}

export type OperatorAssuranceDecision =
  | 'not_required'
  | 'pass'
  | 'pass_grace'
  | 'challenge_required'
  | 'enrollment_required';

export interface DecideOperatorAssuranceInput {
  readonly roles: ReadonlyArray<string>;
  /** セッションの AAL。必須ロールでないときは読まないので null を渡してよい */
  readonly aal: AuthenticatorAssuranceLevel | null;
  /** verified な TOTP factor があるか (unverified は数えない) */
  readonly hasVerifiedTotp: boolean;
  /** 強制の開始日時 (resolveMfaEnforceFrom の結果)。null = 即時 */
  readonly enforceFrom: Date | null;
  readonly now: Date;
}

export interface OperatorAssuranceResult {
  readonly required: boolean;
  readonly decision: OperatorAssuranceDecision;
}

/**
 * 運営の入口で AAL2 を求めるかの判定。I/O を持たない (呼び出し側が claims と factors を集めて渡す)。
 *   必須ロールでない → not_required (claims を読む必要も無い)
 *   aal2 → pass (factor の有無は見ない。unenroll 直後の aal2 token は寿命まで通る。unenroll の route が refresh で aal1 に戻す)
 *   aal1 で verified TOTP あり → challenge_required
 *   aal1 で無し、猶予中 (now < enforceFrom) → pass_grace
 *   aal1 で無し、猶予なし → enrollment_required
 */
export function decideOperatorAssurance(input: DecideOperatorAssuranceInput): OperatorAssuranceResult {
  const required = isMfaRequiredRoleSet(input.roles);
  if (!required) return { required, decision: 'not_required' };
  if (input.aal === 'aal2') return { required, decision: 'pass' };
  if (input.hasVerifiedTotp) return { required, decision: 'challenge_required' };
  if (input.enforceFrom !== null && input.now.getTime() < input.enforceFrom.getTime()) {
    return { required, decision: 'pass_grace' };
  }
  return { required, decision: 'enrollment_required' };
}

/** requireRole が UserProfile.assurance に付ける要約 (画面のバナー・status API が読む) */
export interface OperatorAssuranceSummary {
  readonly required: boolean;
  readonly aal: AuthenticatorAssuranceLevel | null;
  readonly enrolled: boolean;
  readonly decision: Extract<OperatorAssuranceDecision, 'not_required' | 'pass' | 'pass_grace'>;
  /** ISO 8601 (UTC)。猶予が無ければ null */
  readonly enforce_from: string | null;
}

// policy.ts の続き (cross/12 §12.2)。process.env を名前で読むのはこのファイルだけ。値はログに出さない
let enforceFromWarned = false;
export function readMfaEnforceFromEnv(): MfaEnforceFromSetting {
  const setting = resolveMfaEnforceFrom(process.env.OPERATOR_MFA_ENFORCE_FROM);
  if (setting.ignored && !enforceFromWarned) {
    enforceFromWarned = true;
    createLogger('auth/mfa/policy').warn('環境変数の値が正しくないため、猶予なし (即時) にします', {
      ignored_env: [OPERATOR_MFA_ENFORCE_FROM_ENV_NAME],
    });
  }
  return setting;
}

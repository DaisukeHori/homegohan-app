// #1917 利用者の解散 (docs/design/family/11-self-dissolve.md §13.4)。画面 (SelfDissolveSection・退会と書き出しの枠 AccountSelfServicePanel) が使う。
// サーバー専用のもの (通知) は self-dissolve-notification.ts。
import { SERVICE_UNAVAILABLE_STATUS, serviceUnavailableMessageOfBody } from '@homegohan/shared';
import { FAMILY_DISSOLVE_API_PATH, ORG_DISSOLVE_API_PATH } from '@/lib/auth/frozen';
import { LEGAL_FACTS } from '@/lib/legal/legal-text';
import { membershipErrorMessageOfBody } from '@/lib/errors/membership-errors';
import type { MembershipScope } from '@/lib/emails/membership/scope-label';

/** 解散の確認のために入力してもらう言葉 (退会の「削除します」と同じ型) */
export const SELF_DISSOLVE_CONFIRM_KEYWORD = '解散します';

/**
 * 解散した家族グループの情報を消すまでの日数 (画面の説明に出す)。規約の文面 (プライバシーポリシー第12条) と同じ値 (LEGAL_FACTS) を読む。
 * 正は purge_dissolved_family_groups の c_retention (supabase/migrations/20261018010000_purge_dissolved_family_groups.sql)。
 * tests/self-dissolve-migration-contract.test.ts C-10 が一致を見る
 */
export const DISSOLVED_FAMILY_GROUP_RETENTION_DAYS: number = LEGAL_FACTS.dissolvedFamilyGroupRetentionDays;

/** 解散の API のパス (家族 / 組織) */
export function selfDissolveApiPath(scope: MembershipScope): string {
  return scope === 'family' ? FAMILY_DISSOLVE_API_PATH : ORG_DISSOLVE_API_PATH;
}

/** 本文の id の鍵 (家族 / 組織) */
function selfDissolveBody(scope: MembershipScope, scopeId: string): Record<string, unknown> {
  return scope === 'family' ? { family_id: scopeId, confirm: true } : { organization_id: scopeId, confirm: true };
}

/**
 * 解散の区画 (SelfDissolveSection) を出す画面。家族プランの解約の案内は、その画面の利用者が開ける画面を名指す (開けない画面を案内しない)。
 *   - settings: メンバーシップ設定 (/settings/membership)。Web の契約は「プランとお支払い」(/account/billing) から解約できる
 *   - frozen: 凍結中の画面 (/frozen/account)。middleware が /frozen と /contact 以外を /frozen へ差し戻すので /account/billing は開けない。
 *     凍結中の解約は「有料プランの解約・お支払い」(/frozen/billing。billing/01 §10.5) から
 *   - legal_consent: 同意の前の画面 (/legal-consent/account)。/account/billing は同意の画面へ回される。Web の契約はお問い合わせから
 *     依頼を受けて運営が解約する (billing/03 §0.5 Q-15・利用規約第24条)
 */
export const SELF_DISSOLVE_SURFACES = ['settings', 'frozen', 'legal_consent'] as const;
export type SelfDissolveSurface = (typeof SELF_DISSOLVE_SURFACES)[number];
/** 退会と書き出しの枠 (AccountSelfServicePanel) が出す画面 (設定画面は使わない) */
export type AccountSelfServiceSurface = Exclude<SelfDissolveSurface, 'settings'>;

/** 家族プランの契約が解散しても続くことの、文の頭 (どの画面でも同じ) */
const FAMILY_PLAN_CONTINUES_HEAD = '家族プランをご契約の場合、家族グループを解散しても契約は続きます。';

/**
 * 家族グループを解散しても、代表者の家族プランの契約 (personal_subscriptions) は続く (billing/03。解散は契約を止めない)。
 * 解約の手段 (Web の契約は課金の画面 / お問い合わせ、App Store / Google Play の契約はストアの定期購読の管理) を、解散の確認に出す。
 * Web の契約の手段は画面ごとに違う (SelfDissolveSurface の説明)
 */
export const FAMILY_PLAN_CONTINUES_AFTER_DISSOLVE: Readonly<Record<SelfDissolveSurface, string>> = {
  settings: `${FAMILY_PLAN_CONTINUES_HEAD}解約は、Web でお申し込みの方は「プランとお支払い」の画面から、App Store / Google Play でお申し込みの方は各ストアの定期購読の管理から行ってください。`,
  frozen: `${FAMILY_PLAN_CONTINUES_HEAD}解約は、Web でお申し込みの方は「有料プランの解約・お支払い」の画面から、App Store / Google Play でお申し込みの方は各ストアの定期購読の管理から行ってください。`,
  legal_consent: `${FAMILY_PLAN_CONTINUES_HEAD}解約は、App Store / Google Play でお申し込みの方は各ストアの定期購読の管理から行ってください。Web でお申し込みの方は、お問い合わせからご依頼いただければ、当社が解約の手続を行います。`,
};

/** 画面の文 (家族 / 組織)。作りかけ・先送りを示す語 (R-12) は書かない */
export const SELF_DISSOLVE_COPY: Readonly<
  Record<
    MembershipScope,
    {
      title: string;
      effects: readonly string[];
      keywordPrompt: string;
      button: string;
      submitting: string;
      done: string;
    }
  >
> = {
  family: {
    title: '家族グループを解散する',
    effects: [
      'メンバー全員の所属が解除されます (子供のメンバーを含みます)。',
      '解散のお知らせが、アカウントを持つメンバーにメールで届きます。',
      `解散した家族グループの情報 (名前・メンバーの履歴・招待) は、解散から ${DISSOLVED_FAMILY_GROUP_RETENTION_DAYS} 日が経過すると削除されます。保護者の同意の記録があるグループは、同意の記録として残ります。`,
      '各メンバーの食事・健康・献立の記録は、それぞれのアカウントに残ります。',
      'この操作は取り消せません。',
    ],
    keywordPrompt: `確認のため「${SELF_DISSOLVE_CONFIRM_KEYWORD}」と入力してください`,
    button: '家族グループを解散する',
    submitting: '解散中…',
    done: '家族グループを解散しました。',
  },
  organization: {
    title: '組織を解散する',
    // 組織の招待 (pending) は解散で取り消さず pending のまま残る (§0.4)。承諾は解散した組織を ORG_ALREADY_DISSOLVED で断る
    // (Q-4。supabase/migrations/20261022100000_org_invite_dissolved.sql)。effects は所属・通知・記録・取り消せないことの 4 行に絞り、
    // 招待・設定などの扱いは書かない (事実と違う効果を、取り消せない操作の確認に出さない)
    effects: [
      'メンバー全員の所属が解除されます。',
      '解散のお知らせが、メンバーにメールで届きます。',
      '各メンバーの食事・健康・献立の記録は、それぞれのアカウントに残ります。',
      'この操作は取り消せません。',
    ],
    keywordPrompt: `確認のため「${SELF_DISSOLVE_CONFIRM_KEYWORD}」と入力してください`,
    button: '組織を解散する',
    submitting: '解散中…',
    done: '組織を解散しました。',
  },
};

/**
 * 解散の区画に出す効果の箇条書き。家族は、SELF_DISSOLVE_COPY.family.effects の最後の行 (取り消せないこと) の手前に、
 * 家族プランの契約が続くことの 1 行 (画面ごとの解約の手段) を入れる。組織は SELF_DISSOLVE_COPY.organization.effects のまま
 */
export function selfDissolveEffects(scope: MembershipScope, surface: SelfDissolveSurface): readonly string[] {
  const { effects } = SELF_DISSOLVE_COPY[scope];
  if (scope !== 'family') return effects;
  // 取り消せないことの行は、確認の最後に読む行として最後に残す
  return [...effects.slice(0, -1), FAMILY_PLAN_CONTINUES_AFTER_DISSOLVE[surface], ...effects.slice(-1)];
}

/** 凍結中の画面で、解散の区画の上に出す文 (サーバーの 409 の文に続ける。AccountSelfServicePanel の deleteBlockedGuidance) */
export const FROZEN_DISSOLVE_GUIDANCE = '凍結中は譲渡の操作ができません。下の「解散する」で家族グループ・組織を解散すると、退会できます。';
/** 退会と書き出しの枠 (凍結中の画面・同意の前の画面) で、解散が済んだあとに出す文 */
export const SELF_DISSOLVED_NEXT_STEP = '解散しました。「削除します」と入力して退会を続けてください。';
/** 退会と書き出しの枠で、409 の本文から立場の id と名前が読めなかった (解散の区画を出せない) ときに、サーバーの文に続けて出す文 */
export const BLOCKED_SCOPE_UNKNOWN_GUIDANCE = 'お手数ですが、サポートにお問い合わせください。';
/** 通信の失敗 (fetch が例外を投げた。応答が届かない) の文。届いた失敗の応答の本文が読めないときは membershipErrorMessageOfBody の汎用の文になる */
export const SELF_DISSOLVE_FAILED_MESSAGE = '解散に失敗しました。時間をおいてもう一度お試しください。';

const HTTP_UNAUTHORIZED = 401;

export type SelfDissolveResult =
  | { kind: 'dissolved'; dissolvedAt: string }
  | { kind: 'unauthorized' }
  /**
   * 失敗。message は画面にそのまま出す日本語の文:
   * - 503 で本文の code が serviceUnavailableMessageOfBody の知っている code (middleware のメンテナンス中の MAINTENANCE_MODE) なら、
   *   @homegohan/shared の固定の文 (MAINTENANCE_MESSAGE)
   * - それ以外の 4xx / 5xx は、本文の code から引いた文 (membershipErrorMessageOfBody。表に無い code・JSON でない本文は汎用の文)
   * - 通信の失敗は SELF_DISSOLVE_FAILED_MESSAGE
   */
  | { kind: 'failed'; message: string };

/**
 * 自分の家族グループ / 組織を解散する (取り消せない)。例外は投げず、結果の種類を返す。
 * 凍結中の画面と同意の前の画面 (AccountSelfServicePanel) からも呼ぶ (API は FROZEN_ALLOWED_API_PATHS と LEGAL_CONSENT_EXEMPT_API_PATHS にある)。
 */
export async function dissolveOwnScope(scope: MembershipScope, scopeId: string): Promise<SelfDissolveResult> {
  try {
    const res = await fetch(selfDissolveApiPath(scope), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selfDissolveBody(scope, scopeId)),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const dissolvedAt =
        typeof body === 'object' && body !== null && typeof (body as { data?: { dissolved_at?: unknown } }).data?.dissolved_at === 'string'
          ? (body as { data: { dissolved_at: string } }).data.dissolved_at
          : '';
      return { kind: 'dissolved', dissolvedAt };
    }
    if (res.status === HTTP_UNAUTHORIZED) return { kind: 'unauthorized' };
    // メンテナンス中は middleware が route の手前で 503 { error, code: 'MAINTENANCE_MODE', retryAfter } を返す (src/lib/maintenance-mode.ts)。
    // membershipErrorMessageOfBody は MAINTENANCE_MODE を知らず汎用の文 (「処理に失敗しました。…」) を返すので、その前に
    // @homegohan/shared の固定の文 (MAINTENANCE_MESSAGE) に写す (docs/design/family/11-self-dissolve.md S-24)。知らない code の 503 は下の汎用の文
    if (res.status === SERVICE_UNAVAILABLE_STATUS) {
      const unavailableMessage = serviceUnavailableMessageOfBody(body);
      if (unavailableMessage !== null) return { kind: 'failed', message: unavailableMessage };
    }
    return { kind: 'failed', message: membershipErrorMessageOfBody(body) };
  } catch (error) {
    console.error('[self dissolve]', error);
    return { kind: 'failed', message: SELF_DISSOLVE_FAILED_MESSAGE };
  }
}

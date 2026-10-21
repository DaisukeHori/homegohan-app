/**
 * 利用規約・プライバシーポリシーの同意ゲートを /api とモバイルのネイティブの画面にも掛ける (#1442)。
 * サーバー (proxy (旧 middleware)・API Route)・Web・モバイルで同じ値と判定を使うための、純粋な定数と関数だけのファイル。
 * Node / Deno / RN 固有の API は使わない。副作用は無い。
 *
 *   - LEGAL_CONSENT_EXEMPT_API_PATHS / isLegalConsentExemptApiPath: 未同意でも止めない /api (理由つき)
 *   - resolveLegalConsentApiDecision: middleware の /api の分岐が呼ぶ判定 (allow / deny)
 *   - LEGAL_CONSENT_REQUIRED_*: 止めたときの 403 (平たい { error, code }。#1154 の AI 同意と同じ形)
 *   - resolveLegalConsentStatus / isLegalConsentStatus: GET /api/legal/status の応答 (サーバーが作り、モバイルが読む)
 *
 * 同意ゲートを通れるかの判定 (isLegalConsentComplete / getLegalConsentGaps。版 + 生年月日 + 18 歳未満なら保護者の同意とのつながり。#1173) は parental-consent.ts にあり、ここはそれを呼ぶだけ。
 *
 * ⚠ 下の import は './legal-versions'・'./push-token-claim' からの相対 import にしている (packages/shared の中から自分のパッケージ名で
 *   import しない。Metro / Jest は exports の "." しか解決しない)。
 */
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_TYPES,
  getOutdatedLegalDocuments,
  type LegalDocumentType,
} from './legal-versions';
import {
  LEGAL_CONSENT_GAP_VALUES,
  getLegalConsentGaps,
  isLegalConsentComplete,
  type LegalConsentGap,
  type LegalConsentProfile,
} from './parental-consent';
import { PUSH_TOKEN_CLAIM_API_PATH } from './push-token-claim';

/** 本人の同意の状況を返す API (#1442 で新設) */
export const LEGAL_CONSENT_STATUS_API_PATH = '/api/legal/status';
/** 同意を記録する API (#1174。既存) */
export const LEGAL_CONSENT_ACCEPT_API_PATH = '/api/legal/accept';

/** 未同意で止めたときのエラーコード。Web の画面とアプリは、このコードを見て同意画面へ案内する */
export const LEGAL_CONSENT_REQUIRED_CODE = 'LEGAL_CONSENT_REQUIRED';
/** 未同意で止めたときの HTTP ステータス (403 Forbidden: 本人だが、この操作の前提 (同意) を満たしていない。AI 同意と同じ) */
export const LEGAL_CONSENT_REQUIRED_STATUS = 403;
/** 未同意で止めたときの本文 (#1172: 変数名・内部の詳細を出さない) */
export const LEGAL_CONSENT_REQUIRED_MESSAGE =
  '利用規約・プライバシーポリシーへの同意が必要です。同意の画面から内容をご確認ください。';

/** 403 の本文。キーはこの 2 つだけ */
export interface LegalConsentRequiredBody {
  error: typeof LEGAL_CONSENT_REQUIRED_MESSAGE;
  code: typeof LEGAL_CONSENT_REQUIRED_CODE;
}

export function legalConsentRequiredBody(): LegalConsentRequiredBody {
  return { error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE };
}

/** 本文の code を読む。平たい { code } を先に見て、入れ子 { error: { code } } も受ける (AI 同意の isAiConsentRequiredBody と同じ読み方) */
function codeOfBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  if (typeof code === 'string') return code;
  if (error && typeof error === 'object') {
    const nested = (error as { code?: unknown }).code;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

/** 応答の本文 (JSON を読んだもの) が「同意が必要です」(LEGAL_CONSENT_REQUIRED) か */
export function isLegalConsentRequiredBody(body: unknown): boolean {
  return codeOfBody(body) === LEGAL_CONSENT_REQUIRED_CODE;
}

/** 止めない理由の種類 (一覧の各行が必ず 1 つ持つ。テストが種類と実在する route を突き合わせる) */
export type LegalConsentExemptApiReason =
  | 'consent_itself'
  | 'auth_flow'
  | 'leave_service'
  | 'data_subject_rights'
  | 'contact'
  | 'telemetry'
  | 'client_status'
  | 'device_cleanup'
  | 'no_user_session'
  | 'test_only';

export interface LegalConsentExemptApiEntry {
  readonly path: string;
  /** exact = 完全一致 / prefix = そのものか `${path}/` 以下 (似た名前を通さない) */
  readonly match: 'exact' | 'prefix';
  readonly reason: LegalConsentExemptApiReason;
  /** 人が読む理由 (設計書 13a §6.4 と同じ文) */
  readonly note: string;
}

/**
 * 未同意でも止めない /api の一覧 (#1442)。ここに無い /api はすべて、LEGAL_CONSENT_ENFORCE=on のとき未同意なら 403。
 * 足すのは「同意そのもの・認証の途中・サービスから離れる操作・本人の権利の請求 (開示・訂正・利用停止・消去)・連絡の窓口・運用のログ・
 * 状態の窓口・端末の後片付け・利用者のセッションを持たない経路」だけ
 * (利用者のデータを読み書きする API を足さない)。一覧は tests が固定する (lib/supabase/__tests__/middleware-legal-consent-api.test.ts)。
 * 凍結中・メンテナンス中に middleware が通す /api は、すべてこの一覧にも入れる (凍結中・メンテナンス中は同意の画面に進めないので、
 * 同意ゲートで止めると、その例外が意味を失う)。これも同じテストが全 route で確かめる。
 * 逆は求めない: この一覧にあっても、凍結中は通さないものがある (例: 本人の権利の請求 /api/account/data-requests は未同意でも通すが、
 * 凍結中は FROZEN_ALLOWED_API_PATHS に入れず 403 AUTH_ACCOUNT_FROZEN のまま。凍結中の請求は /contact で受ける。cross/15 S-13)。
 */
export const LEGAL_CONSENT_EXEMPT_API_PATHS: readonly LegalConsentExemptApiEntry[] = [
  { path: LEGAL_CONSENT_ACCEPT_API_PATH, match: 'exact', reason: 'consent_itself', note: '同意の記録そのもの。止めると同意できない' },
  { path: LEGAL_CONSENT_STATUS_API_PATH, match: 'exact', reason: 'consent_itself', note: '同意の状況。止めるとアプリが状態を知れない' },
  { path: '/api/auth', match: 'prefix', reason: 'auth_flow', note: 'ログイン・Cookie の同期・ネイティブ認証ブリッジのコード。認証の途中' },
  { path: '/api/account/delete', match: 'exact', reason: 'leave_service', note: '退会。同意を取り下げる権利。同意の前でも本人が自分で行える (同意画面の下の退会と書き出しの画面。#1901 cross/20 Q-23。凍結中も通す API と同じ)' },
  { path: '/api/account/export', match: 'exact', reason: 'leave_service', note: '個人データの書き出し。同上 (同意の前でも本人が自分で行える)' },
  // billing/01 §9.8: 凍結中も通す有料プランの解約の 3 本 (凍結中は同意の画面に進めないので、ここにも入れる。解約の予約は新しい版への同意を求めない)
  { path: '/api/billing/subscription', match: 'exact', reason: 'leave_service', note: '有料プランの契約の要約。解約できる契約か・解約の予約の日付を読む (凍結中も通す)' },
  { path: '/api/billing/subscription/cancel', match: 'exact', reason: 'leave_service', note: '有料プランの解約の予約 (期間末)。サービスから離れる操作 (凍結中も通す)' },
  { path: '/api/billing/portal', match: 'exact', reason: 'leave_service', note: 'Stripe の Billing Portal (支払い方法・請求書・解約)。解約の前提 (凍結中も通す)' },
  // #1917 (docs/design/family/11-self-dissolve.md §13.5): 代表者・オーナーが自分の家族グループ・組織を解散する 2 本。退会の前提 (譲渡か解散をしないと退会できない) で、
  // 凍結中も通す API (FROZEN_ALLOWED_API_PATHS) にあるので、この一覧にも入れる。同意の前の画面 (/legal-consent/account) の退会の 409 の分岐が呼ぶ
  { path: '/api/family/dissolve', match: 'exact', reason: 'leave_service', note: '家族グループの解散 (代表者本人)。退会の前提 (凍結中も通す)' },
  { path: '/api/org/dissolve', match: 'exact', reason: 'leave_service', note: '組織の解散 (オーナー本人)。退会の前提 (凍結中も通す)' },
  {
    path: '/api/account/data-requests',
    match: 'prefix',
    reason: 'data_subject_rights',
    note: '開示・訂正・利用停止・消去の請求 (#1702)。規約への同意を条件にできない本人の権利。凍結中は通さない (cross/15 S-13)',
  },
  {
    path: PUSH_TOKEN_CLAIM_API_PATH,
    match: 'exact',
    reason: 'device_cleanup',
    note: '通知のトークンの claim。利用者のデータの読み書きではなく端末の後片付け (同じ端末の前の利用者の行を外す)。止めると前の利用者宛ての通知がこの端末に届き続ける (凍結中・メンテナンス中も通すのと同じ理由)',
  },
  { path: '/api/contact', match: 'exact', reason: 'contact', note: '同意しない人の連絡の窓口' },
  { path: '/api/log', match: 'exact', reason: 'telemetry', note: '画面・端末の失敗の報告の受け口。運用のログ' },
  { path: '/api/csp-report', match: 'exact', reason: 'telemetry', note: 'ブラウザが送る CSP の違反の報告の受け口。利用者のデータではなく運用のログ。未同意の人の画面の違反も残す' },
  { path: '/api/feature-flags', match: 'exact', reason: 'client_status', note: '画面が前もって状態を知る窓口 (メンテナンス中も通す)' },
  { path: '/api/health', match: 'exact', reason: 'no_user_session', note: '死活監視。matcher の外で判定に来ないことを固定する' },
  { path: '/api/cron', match: 'prefix', reason: 'no_user_session', note: 'CRON_SECRET。利用者のセッションを持たない' },
  { path: '/api/webhooks', match: 'prefix', reason: 'no_user_session', note: '外部からの通知 (署名で認証)。利用者のセッションを持たない' },
  { path: '/api/e2e', match: 'prefix', reason: 'test_only', note: 'テスト基盤 (本番は NODE_ENV で 403)' },
];

function matchesExemptEntry(pathname: string, entry: LegalConsentExemptApiEntry): boolean {
  if (pathname === entry.path) return true;
  return entry.match === 'prefix' && pathname.startsWith(`${entry.path}/`);
}

/** 未同意でも止めない /api のパスか。pathname は URL の path の部分 (クエリを含まない) */
export function isLegalConsentExemptApiPath(pathname: string): boolean {
  return LEGAL_CONSENT_EXEMPT_API_PATHS.some((entry) => matchesExemptEntry(pathname, entry));
}

export type LegalConsentApiDecision = 'allow' | 'deny';

export interface ResolveLegalConsentApiInput {
  /** リクエストの path (クエリを含まない) */
  pathname: string;
  /**
   * user_profiles の行の同意済みの版と生年月日。18 歳未満なら withMinorGuardianStatus が入れた minor_guardian_ok を含む。
   * 行が無いときは null / undefined (= 未同意)
   */
  accepted: LegalConsentProfile | null | undefined;
  /** LEGAL_CONSENT_ENFORCE=on か (lib/legal-consent.ts の isLegalConsentEnforced の結果) */
  enforce: boolean;
  /** JST の今日 (YYYY-MM-DD)。省くと todayLocal()。テストが日を固定するため */
  today?: string;
}

/**
 * middleware の /api の分岐が呼ぶ判定。凍結・メンテナンスの判定の後に呼ぶ (順は middleware が決める)。
 *   - 強制していない (enforce = false) → allow (既存の挙動のまま)
 *   - 許可リストのパス → allow
 *   - それ以外で、同意ゲートを満たしていない (未同意・旧版・行なし・生年月日なし・保護者の同意とのつながりの無い 18 歳未満) → deny (403 LEGAL_CONSENT_REQUIRED)
 * 役割 (admin / super_admin) による例外は作らない (規約はスタッフにも適用される)。
 */
export function resolveLegalConsentApiDecision(input: ResolveLegalConsentApiInput): LegalConsentApiDecision {
  if (!input.enforce) return 'allow';
  if (isLegalConsentExemptApiPath(input.pathname)) return 'allow';
  return isLegalConsentComplete(input.accepted, input.today) ? 'allow' : 'deny';
}

/** いま有効な文書の版と施行日 (status の応答。snake_case) */
export interface LegalConsentCurrentDocument {
  version: string;
  /** 施行日 (日本時間) YYYY-MM-DD。画面は formatLegalEffectiveDate で「2025年1月1日」の形にする */
  effective_date: string;
}

export interface LegalConsentAcceptedVersions {
  terms_version: string | null;
  privacy_version: string | null;
}

/** GET /api/legal/status の応答 */
export interface LegalConsentStatus {
  /** LEGAL_CONSENT_ENFORCE=on か */
  enforced: boolean;
  /** 同意ゲートを満たしているか (= gaps が空。#1173 から版だけでなく生年月日と、18 歳未満なら保護者の同意とのつながりも含む) */
  accepted: boolean;
  /** 同意画面を出す必要があるか = enforced && !accepted。アプリのゲートはこの値だけを見る */
  required: boolean;
  /** いま有効な版に同意していない文書 (未同意・旧版) */
  outdated: LegalDocumentType[];
  /**
   * 同意画面で埋めるもの (getLegalConsentGaps の答え。順は 文書 → 'birth_date' → 'guardian_consent')。
   * アプリは 'birth_date' で生年月日の欄を、'guardian_consent' で退会の案内を出す
   */
  gaps: LegalConsentGap[];
  /** いま有効な版と施行日。同意画面はこの値を表示し、同意の記録 (POST /api/legal/accept) にもこの版を送る (端末のバンドルの定数は使わない) */
  current: Record<LegalDocumentType, LegalConsentCurrentDocument>;
  /** 本人の同意済みの版 (NULL = 未同意) */
  accepted_versions: LegalConsentAcceptedVersions;
}

export interface ResolveLegalConsentStatusInput {
  accepted: LegalConsentProfile | null | undefined;
  enforced: boolean;
  /** JST の今日 (YYYY-MM-DD)。省くと todayLocal()。テストが日を固定するため */
  today?: string;
}

/** status route が呼ぶ。判定は resolveLegalConsentApiDecision と同じ述語 (isLegalConsentComplete = gaps が空) に基づく */
export function resolveLegalConsentStatus(input: ResolveLegalConsentStatusInput): LegalConsentStatus {
  const outdated = getOutdatedLegalDocuments(input.accepted);
  const gaps = getLegalConsentGaps(input.accepted, input.today);
  const accepted = gaps.length === 0;
  return {
    enforced: input.enforced,
    accepted,
    required: input.enforced && !accepted,
    outdated,
    gaps,
    current: {
      terms_of_service: {
        version: LEGAL_DOCUMENTS.terms_of_service.version,
        effective_date: LEGAL_DOCUMENTS.terms_of_service.effectiveDate,
      },
      privacy_policy: {
        version: LEGAL_DOCUMENTS.privacy_policy.version,
        effective_date: LEGAL_DOCUMENTS.privacy_policy.effectiveDate,
      },
    },
    accepted_versions: {
      terms_version: input.accepted?.terms_version_accepted ?? null,
      privacy_version: input.accepted?.privacy_version_accepted ?? null,
    },
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCurrentDocument(value: unknown): value is LegalConsentCurrentDocument {
  if (!value || typeof value !== 'object') return false;
  const { version, effective_date } = value as { version?: unknown; effective_date?: unknown };
  return typeof version === 'string' && version !== '' && typeof effective_date === 'string';
}

/** アプリが status の応答の形を確かめる (zod を packages/shared に持ち込まないための手書きの検査) */
export function isLegalConsentStatus(body: unknown): body is LegalConsentStatus {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (typeof b.enforced !== 'boolean' || typeof b.accepted !== 'boolean' || typeof b.required !== 'boolean') return false;
  const documentTypes: readonly string[] = LEGAL_DOCUMENT_TYPES;
  if (!Array.isArray(b.outdated) || !b.outdated.every((v) => typeof v === 'string' && documentTypes.includes(v))) return false;
  const gapValues: readonly string[] = LEGAL_CONSENT_GAP_VALUES;
  if (!Array.isArray(b.gaps) || !b.gaps.every((v) => typeof v === 'string' && gapValues.includes(v))) return false;
  const current = b.current;
  if (!current || typeof current !== 'object') return false;
  if (!LEGAL_DOCUMENT_TYPES.every((type) => isCurrentDocument((current as Record<string, unknown>)[type]))) return false;
  const versions = b.accepted_versions;
  if (!versions || typeof versions !== 'object') return false;
  const { terms_version, privacy_version } = versions as { terms_version?: unknown; privacy_version?: unknown };
  return isNullableString(terms_version) && isNullableString(privacy_version);
}

// src/lib/errors/membership-errors.ts
// (設計書 01-data-model.md §1.2)

export enum MembershipErrorCode {
  // org
  ORG_NOT_FOUND = 'ORG_NOT_FOUND',
  NOT_IN_ORG = 'NOT_IN_ORG',
  ALREADY_IN_ORG = 'ALREADY_IN_ORG',
  SEAT_LIMIT_EXCEEDED = 'SEAT_LIMIT_EXCEEDED',
  OWNER_CANNOT_LEAVE = 'OWNER_CANNOT_LEAVE',
  INSUFFICIENT_PERMISSION = 'INSUFFICIENT_PERMISSION',
  USER_NOT_IN_ORG = 'USER_NOT_IN_ORG',
  // #1062: 未登録だった org 系 RAISE EXCEPTION コード
  NOT_ORG_ADMIN = 'NOT_ORG_ADMIN',
  NOT_ORG_OWNER = 'NOT_ORG_OWNER',
  IS_ORG_OWNER = 'IS_ORG_OWNER',
  CANNOT_REMOVE_OWNER = 'CANNOT_REMOVE_OWNER',
  TARGET_NOT_IN_ORG = 'TARGET_NOT_IN_ORG',
  // family
  FAMILY_NOT_FOUND = 'FAMILY_NOT_FOUND',
  NOT_IN_FAMILY = 'NOT_IN_FAMILY',
  ALREADY_IN_FAMILY = 'ALREADY_IN_FAMILY',
  ALREADY_PROMOTED = 'ALREADY_PROMOTED',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_NOT_IN_FAMILY = 'USER_NOT_IN_FAMILY',
  NOT_FAMILY_ADULT = 'NOT_FAMILY_ADULT',
  MEMBER_LIMIT_EXCEEDED = 'MEMBER_LIMIT_EXCEEDED',
  // #1101: 運営が隠した食事は、家族への貼り付け (paste_meal_to_family) の元にできない
  MEAL_HIDDEN = 'MEAL_HIDDEN',
  // #1627: ハンズオンのお試しの記録 (meals.is_sandbox = true) は、家族への貼り付け (paste_meal_to_family) の元にできない
  MEAL_SANDBOX = 'MEAL_SANDBOX',
  // #1062: 未登録だった family 系 RAISE EXCEPTION コード
  MEMBER_NOT_FOUND = 'MEMBER_NOT_FOUND',
  IS_FAMILY_REPRESENTATIVE = 'IS_FAMILY_REPRESENTATIVE',
  NOT_FAMILY_REPRESENTATIVE = 'NOT_FAMILY_REPRESENTATIVE',
  // #1917: 利用者の解散 (dissolve_family_by_representative / dissolve_org_by_owner) が RAISE する。ORG_ALREADY_DISSOLVED は
  // operator_force_dissolve_org も前から RAISE している (運営の強制解散の route もこの表の status と文で返す。operator-rpc-errors.ts)。
  // ORG_ALREADY_DISSOLVED は accept_org_invite (20261022100000_org_invite_dissolved.sql) と
  // accept_org_owner_transfer (20261022140000_org_transfer_toctou.sql) も RAISE する
  FAMILY_ALREADY_DISSOLVED = 'FAMILY_ALREADY_DISSOLVED',
  ORG_ALREADY_DISSOLVED = 'ORG_ALREADY_DISSOLVED',
  CANNOT_TRANSFER_TO_CHILD = 'CANNOT_TRANSFER_TO_CHILD',
  // #1576: /api/family/members/[member_id]/remove が、RPC のエラー文にこのコードが含まれるときにだけ返す古い守り。
  // remove_family_member は代表者を外そうとすると IS_FAMILY_REPRESENTATIVE を RAISE する (このコードを RAISE する SQL は無い)。
  // 代表者の除名の 409 の本文の code は IS_FAMILY_REPRESENTATIVE になる
  CANNOT_REMOVE_REPRESENTATIVE = 'CANNOT_REMOVE_REPRESENTATIVE',
  // #1232: 子供メンバー昇格の本人同意フロー
  PROMOTION_REQUEST_NOT_FOUND = 'PROMOTION_REQUEST_NOT_FOUND',
  PROMOTION_REQUEST_EXPIRED = 'PROMOTION_REQUEST_EXPIRED',
  PROMOTION_REQUEST_ALREADY_USED = 'PROMOTION_REQUEST_ALREADY_USED',
  PROMOTION_EMAIL_MISMATCH = 'PROMOTION_EMAIL_MISMATCH',
  PROMOTION_MEMBER_UNAVAILABLE = 'PROMOTION_MEMBER_UNAVAILABLE',
  PROMOTION_DIRECT_DISABLED = 'PROMOTION_DIRECT_DISABLED',
  // #1173: 子供の生年月日と保護者の同意
  CHILD_BIRTH_DATE_REQUIRED = 'CHILD_BIRTH_DATE_REQUIRED',
  CHILD_BIRTH_DATE_INVALID = 'CHILD_BIRTH_DATE_INVALID',
  PARENTAL_CONSENT_REQUIRED = 'PARENTAL_CONSENT_REQUIRED',
  PARENTAL_CONSENT_VERSION_MISMATCH = 'PARENTAL_CONSENT_VERSION_MISMATCH', // route だけが返す (RPC は RAISE しない)
  PARENTAL_CONSENT_SIGNER_NOT_ADULT = 'PARENTAL_CONSENT_SIGNER_NOT_ADULT', // add_family_child だけが RAISE する
  PROMOTION_UNDER_COPPA_AGE = 'PROMOTION_UNDER_COPPA_AGE', // request_child_promotion / accept_child_promotion だけが RAISE する
  // create_family_group / accept_family_invite / accept_family_representative_transfer / accept_org_owner_transfer だけが RAISE する
  MINOR_ACCOUNT_NOT_ALLOWED = 'MINOR_ACCOUNT_NOT_ALLOWED',
  // billing/03 §6.6・§9.5: create_family_group と family_members のトリガー (family_members_billing_plan_gate) が RAISE する。
  // 家族グループの作成とメンバーの追加は、家族プランの契約がある代表者のグループだけ
  FAMILY_PLAN_REQUIRED = 'FAMILY_PLAN_REQUIRED',
  // #1917 の続き: family_groups のトリガー trg_representative_not_deleting (関数 family_groups_representative_not_deleting)
  // (supabase/migrations/20261023150000_account_deletion_family_representative_guard.sql) が、退会の手続き中 (新しい退会の印がある) の人を
  // 代表者にする作成・譲渡の承諾・運営の強制譲渡を止めるときに RAISE する
  REPRESENTATIVE_ACCOUNT_DELETING = 'REPRESENTATIVE_ACCOUNT_DELETING',
  // invite
  INVITE_NOT_FOUND = 'INVITE_NOT_FOUND',
  INVITE_EXPIRED = 'INVITE_EXPIRED',
  INVITE_ALREADY_USED = 'INVITE_ALREADY_USED',
  INVITE_REVOKED = 'INVITE_REVOKED',
  EMAIL_MISMATCH = 'EMAIL_MISMATCH',
  INVITE_EMAIL_MISMATCH = 'INVITE_EMAIL_MISMATCH',
  // transfer
  TRANSFER_NOT_FOUND = 'TRANSFER_NOT_FOUND',
  TRANSFER_NOT_PENDING = 'TRANSFER_NOT_PENDING',
  // #1062: propose/accept_*_transfer RPC (org/family 共通, ownership_transfer_proposals 経由)
  // が実際に RAISE するコード。TRANSFER_NOT_FOUND/TRANSFER_NOT_PENDING とは別の文字列。
  TRANSFER_PROPOSAL_NOT_FOUND = 'TRANSFER_PROPOSAL_NOT_FOUND',
  TRANSFER_PROPOSAL_EXPIRED = 'TRANSFER_PROPOSAL_EXPIRED',
  // #1236 / #1237: accept_*_transfer が承諾時点の当事者性再検証で RAISE するコード
  TRANSFER_ACCEPTOR_NOT_IN_ORG = 'TRANSFER_ACCEPTOR_NOT_IN_ORG',
  TRANSFER_ACCEPTOR_NOT_IN_FAMILY = 'TRANSFER_ACCEPTOR_NOT_IN_FAMILY',
  // misc
  NOT_AUTHENTICATED = 'NOT_AUTHENTICATED',
  RATE_LIMITED = 'RATE_LIMITED',
  RPC_FAILED = 'RPC_FAILED',
  EMAIL_SEND_FAILED = 'EMAIL_SEND_FAILED',
  // #1232 v3 (G10): 行ロック競合 (SQLSTATE 40P01 deadlock 等) の再試行可能エラー。
  // DB 側 (promotion RPC の deadlock_detected ハンドラ) と route 側 (pgCode='40P01')
  // の両経路からこのコードに正規化される。クライアントは同一操作をそのまま再試行してよい。
  CONFLICT_RETRY = 'CONFLICT_RETRY',
  // #1576: 家族の API (/api/family/members/[member_id]/remove など) が本文の検証で返すコード
  INVALID_REQUEST = 'INVALID_REQUEST',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}

export const ErrorStatusMap: Record<MembershipErrorCode, number> = {
  [MembershipErrorCode.ORG_NOT_FOUND]: 404,
  [MembershipErrorCode.NOT_IN_ORG]: 403,
  [MembershipErrorCode.ALREADY_IN_ORG]: 409,
  [MembershipErrorCode.SEAT_LIMIT_EXCEEDED]: 409,
  [MembershipErrorCode.OWNER_CANNOT_LEAVE]: 409,
  [MembershipErrorCode.INSUFFICIENT_PERMISSION]: 403,
  [MembershipErrorCode.USER_NOT_IN_ORG]: 404,
  [MembershipErrorCode.NOT_ORG_ADMIN]: 403,
  [MembershipErrorCode.NOT_ORG_OWNER]: 403,
  [MembershipErrorCode.IS_ORG_OWNER]: 409,
  [MembershipErrorCode.CANNOT_REMOVE_OWNER]: 409,
  [MembershipErrorCode.TARGET_NOT_IN_ORG]: 404,
  [MembershipErrorCode.FAMILY_NOT_FOUND]: 404,
  [MembershipErrorCode.NOT_IN_FAMILY]: 403,
  [MembershipErrorCode.ALREADY_IN_FAMILY]: 409,
  [MembershipErrorCode.ALREADY_PROMOTED]: 409,
  [MembershipErrorCode.USER_NOT_FOUND]: 404,
  [MembershipErrorCode.USER_NOT_IN_FAMILY]: 404,
  [MembershipErrorCode.NOT_FAMILY_ADULT]: 403,
  [MembershipErrorCode.MEMBER_LIMIT_EXCEEDED]: 409,
  [MembershipErrorCode.MEAL_HIDDEN]: 403,
  [MembershipErrorCode.MEAL_SANDBOX]: 403,
  [MembershipErrorCode.MEMBER_NOT_FOUND]: 404,
  [MembershipErrorCode.IS_FAMILY_REPRESENTATIVE]: 409,
  [MembershipErrorCode.NOT_FAMILY_REPRESENTATIVE]: 403,
  [MembershipErrorCode.FAMILY_ALREADY_DISSOLVED]: 409,
  [MembershipErrorCode.ORG_ALREADY_DISSOLVED]: 409,
  [MembershipErrorCode.CANNOT_TRANSFER_TO_CHILD]: 409,
  [MembershipErrorCode.CANNOT_REMOVE_REPRESENTATIVE]: 409,
  [MembershipErrorCode.PROMOTION_REQUEST_NOT_FOUND]: 404,
  [MembershipErrorCode.PROMOTION_REQUEST_EXPIRED]: 410,
  [MembershipErrorCode.PROMOTION_REQUEST_ALREADY_USED]: 409,
  [MembershipErrorCode.PROMOTION_EMAIL_MISMATCH]: 403,
  [MembershipErrorCode.PROMOTION_MEMBER_UNAVAILABLE]: 409,
  [MembershipErrorCode.PROMOTION_DIRECT_DISABLED]: 403,
  [MembershipErrorCode.CHILD_BIRTH_DATE_REQUIRED]: 400,
  [MembershipErrorCode.CHILD_BIRTH_DATE_INVALID]: 400,
  [MembershipErrorCode.PARENTAL_CONSENT_REQUIRED]: 403,
  [MembershipErrorCode.PARENTAL_CONSENT_VERSION_MISMATCH]: 409,
  [MembershipErrorCode.PARENTAL_CONSENT_SIGNER_NOT_ADULT]: 403,
  [MembershipErrorCode.PROMOTION_UNDER_COPPA_AGE]: 403,
  [MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED]: 403,
  [MembershipErrorCode.FAMILY_PLAN_REQUIRED]: 402,
  [MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING]: 409,
  [MembershipErrorCode.INVITE_NOT_FOUND]: 404,
  [MembershipErrorCode.INVITE_EXPIRED]: 410,
  [MembershipErrorCode.INVITE_ALREADY_USED]: 409,
  [MembershipErrorCode.INVITE_REVOKED]: 409,
  [MembershipErrorCode.EMAIL_MISMATCH]: 403,
  [MembershipErrorCode.INVITE_EMAIL_MISMATCH]: 403,
  [MembershipErrorCode.TRANSFER_NOT_FOUND]: 404,
  [MembershipErrorCode.TRANSFER_NOT_PENDING]: 409,
  [MembershipErrorCode.TRANSFER_PROPOSAL_NOT_FOUND]: 404,
  [MembershipErrorCode.TRANSFER_PROPOSAL_EXPIRED]: 410,
  [MembershipErrorCode.TRANSFER_ACCEPTOR_NOT_IN_ORG]: 403,
  [MembershipErrorCode.TRANSFER_ACCEPTOR_NOT_IN_FAMILY]: 403,
  [MembershipErrorCode.NOT_AUTHENTICATED]: 401,
  [MembershipErrorCode.RATE_LIMITED]: 429,
  [MembershipErrorCode.RPC_FAILED]: 500,
  [MembershipErrorCode.EMAIL_SEND_FAILED]: 500,
  [MembershipErrorCode.CONFLICT_RETRY]: 409,
  [MembershipErrorCode.INVALID_REQUEST]: 400,
  [MembershipErrorCode.VALIDATION_ERROR]: 400,
};

export function mapPgErrorToHttp(
  message: string,
  pgCode?: string,
): { code: MembershipErrorCode | 'UNKNOWN'; status: number } {
  // #1232 v3 (G10): SQLSTATE 40P01 (deadlock_detected) は再試行可能なロック競合。
  // メッセージは 'deadlock detected' でコード語彙と一致しないため、SQLSTATE で先に判定する。
  // (第一防衛線は RPC 内の WHEN deadlock_detected → 'CONFLICT_RETRY' 正規化。
  //  こちらはハンドラ外/他 RPC で発生した 40P01 を拾う第二防衛線)
  if (pgCode === '40P01') {
    return { code: MembershipErrorCode.CONFLICT_RETRY, status: ErrorStatusMap[MembershipErrorCode.CONFLICT_RETRY] };
  }
  // #1045 (F6-16): message.includes(code) による部分一致だと、列挙順で先に評価された
  // 短いコードが誤ってヒットしてしまう (例: 'USER_NOT_IN_ORG' というメッセージに対して
  // 'NOT_IN_ORG' が部分文字列として先にマッチし、本来の 404/USER_NOT_IN_ORG ではなく
  // 403/NOT_IN_ORG に化けてしまっていた)。
  // コードは `[A-Z0-9_]+` の単語であり、区切り文字である '_' も \w に含まれるため、
  // 単語境界 (\b) で照合すれば "NOT_IN_ORG" は "USER_NOT_IN_ORG" の内部にはマッチしない
  // (境界の両側が \w である地点では \b は成立しない)。
  for (const code of Object.values(MembershipErrorCode)) {
    const pattern = new RegExp(`\\b${code}\\b`);
    if (pattern.test(message)) {
      return { code, status: ErrorStatusMap[code] };
    }
  }
  return { code: 'UNKNOWN', status: 500 };
}

/**
 * 応答の本文の code (MembershipErrorCode) から、画面に出す日本語の文を引く表 (#1478)。
 *
 * 組織・家族の API は 4xx の本文を { error: { code, message } } で返し、message は操作ごとの固定の文
 * (例: 「組織からの脱退に失敗しました」) なので、理由が画面で読めない。画面は code からこの表で理由の文を引く。
 * Record<MembershipErrorCode, string> なので、enum に値を足したら、ここにも文を足さないと型検査で落ちる
 * (tests/membership-errors.test.ts も全値に空でない文があることを確かめる)。
 */
export const MEMBERSHIP_ERROR_MESSAGES: Record<MembershipErrorCode, string> = {
  [MembershipErrorCode.ORG_NOT_FOUND]: '組織が見つかりません。',
  [MembershipErrorCode.NOT_IN_ORG]: '組織に所属していません。',
  [MembershipErrorCode.ALREADY_IN_ORG]: 'すでに組織に所属しています。',
  [MembershipErrorCode.SEAT_LIMIT_EXCEEDED]: '組織の席数の上限に達しています。',
  [MembershipErrorCode.OWNER_CANNOT_LEAVE]: 'オーナーは組織から脱退できません。先にオーナーを譲ってください。',
  [MembershipErrorCode.INSUFFICIENT_PERMISSION]: 'この操作をする権限がありません。',
  [MembershipErrorCode.USER_NOT_IN_ORG]: '対象のユーザーはこの組織に所属していません。',
  [MembershipErrorCode.NOT_ORG_ADMIN]: '組織の管理者だけが操作できます。',
  [MembershipErrorCode.NOT_ORG_OWNER]: '組織のオーナーだけが操作できます。',
  [MembershipErrorCode.IS_ORG_OWNER]: 'オーナーはこの操作をできません。先にオーナーを譲ってください。',
  [MembershipErrorCode.CANNOT_REMOVE_OWNER]: 'オーナーは除名できません。',
  [MembershipErrorCode.TARGET_NOT_IN_ORG]: '対象のメンバーはこの組織に所属していません。',
  [MembershipErrorCode.FAMILY_NOT_FOUND]: '家族が見つかりません。',
  [MembershipErrorCode.NOT_IN_FAMILY]: '家族に参加していません。',
  [MembershipErrorCode.ALREADY_IN_FAMILY]: 'すでに家族に参加しています。',
  [MembershipErrorCode.ALREADY_PROMOTED]: 'このメンバーはすでに自分のアカウントを持っています。',
  [MembershipErrorCode.USER_NOT_FOUND]: 'ユーザーが見つかりません。',
  [MembershipErrorCode.USER_NOT_IN_FAMILY]: '対象のユーザーはこの家族に参加していません。',
  [MembershipErrorCode.NOT_FAMILY_ADULT]: '家族の大人のメンバーだけが操作できます。',
  [MembershipErrorCode.MEMBER_LIMIT_EXCEEDED]: '家族の人数の上限に達しています。',
  [MembershipErrorCode.MEAL_HIDDEN]: 'この食事は表示が止められているため、使えません。',
  [MembershipErrorCode.MEAL_SANDBOX]: 'この食事はお試しの記録のため、家族に共有できません。',
  [MembershipErrorCode.MEMBER_NOT_FOUND]: 'メンバーが見つかりません。',
  [MembershipErrorCode.IS_FAMILY_REPRESENTATIVE]: '代表者はこの操作をできません。先に代表者を譲ってください。',
  [MembershipErrorCode.NOT_FAMILY_REPRESENTATIVE]: '家族の代表者だけが操作できます。',
  [MembershipErrorCode.FAMILY_ALREADY_DISSOLVED]: 'この家族グループはすでに解散しています。',
  [MembershipErrorCode.ORG_ALREADY_DISSOLVED]: 'この組織はすでに解散しています。',
  [MembershipErrorCode.CANNOT_TRANSFER_TO_CHILD]: '子どものメンバーには代表者を譲れません。',
  [MembershipErrorCode.CANNOT_REMOVE_REPRESENTATIVE]: '代表者は家族から外せません。先に代表者を譲ってください。',
  [MembershipErrorCode.PROMOTION_REQUEST_NOT_FOUND]: '昇格の依頼が見つかりません。',
  [MembershipErrorCode.PROMOTION_REQUEST_EXPIRED]: '昇格の依頼の期限が切れています。',
  [MembershipErrorCode.PROMOTION_REQUEST_ALREADY_USED]: 'この昇格の依頼はすでに使われています。',
  [MembershipErrorCode.PROMOTION_EMAIL_MISMATCH]: '昇格の依頼の宛先とログイン中のメールアドレスが一致しません。',
  [MembershipErrorCode.PROMOTION_MEMBER_UNAVAILABLE]: '昇格の対象のメンバーは、いまは昇格できません。',
  [MembershipErrorCode.PROMOTION_DIRECT_DISABLED]: 'この方法では昇格できません。本人の同意の手続きを使ってください。',
  [MembershipErrorCode.CHILD_BIRTH_DATE_REQUIRED]: '生年月日を入力してください。',
  [MembershipErrorCode.CHILD_BIRTH_DATE_INVALID]:
    '生年月日を正しく入力してください（未来の日付、120年より前の日付は登録できません）。',
  [MembershipErrorCode.PARENTAL_CONSENT_REQUIRED]:
    '18歳未満のお子さまを追加するには、保護者の同意（確認・同意・署名）が必要です。',
  [MembershipErrorCode.PARENTAL_CONSENT_VERSION_MISMATCH]:
    '保護者の同意書が更新されました。画面を読み込み直して、内容をご確認ください。',
  [MembershipErrorCode.PARENTAL_CONSENT_SIGNER_NOT_ADULT]:
    '保護者の同意は、生年月日を登録した18歳以上の方だけが記録できます。',
  [MembershipErrorCode.PROMOTION_UNDER_COPPA_AGE]: '13歳未満のお子さまは、ご本人のアカウントとつなげません。',
  [MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED]:
    '18歳未満の方は、家族グループの作成・家族の招待からの参加・家族の代表者や組織のオーナーの引き受けはできません。保護者の方の家族には、保護者から届く「アカウントをつなぐ」案内から参加できます。',
  [MembershipErrorCode.FAMILY_PLAN_REQUIRED]: '家族プランのご契約が必要です。',
  [MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING]:
    '退会の手続き中のため、家族グループの作成や家族の代表者の引き受けはできません。',
  [MembershipErrorCode.INVITE_NOT_FOUND]: '招待が見つかりません。',
  [MembershipErrorCode.INVITE_EXPIRED]: '招待の期限が切れています。',
  [MembershipErrorCode.INVITE_ALREADY_USED]: 'この招待はすでに使われています。',
  [MembershipErrorCode.INVITE_REVOKED]: 'この招待は取り消されています。',
  [MembershipErrorCode.EMAIL_MISMATCH]: '宛先とログイン中のメールアドレスが一致しません。',
  [MembershipErrorCode.INVITE_EMAIL_MISMATCH]: '招待の宛先とログイン中のメールアドレスが一致しません。',
  [MembershipErrorCode.TRANSFER_NOT_FOUND]: '譲渡の依頼が見つかりません。',
  [MembershipErrorCode.TRANSFER_NOT_PENDING]: 'この譲渡の依頼はすでに処理されています。',
  [MembershipErrorCode.TRANSFER_PROPOSAL_NOT_FOUND]: '譲渡の依頼が見つかりません。',
  [MembershipErrorCode.TRANSFER_PROPOSAL_EXPIRED]: '譲渡の依頼の期限が切れています。',
  [MembershipErrorCode.TRANSFER_ACCEPTOR_NOT_IN_ORG]: '譲渡を受ける人がこの組織に所属していません。',
  [MembershipErrorCode.TRANSFER_ACCEPTOR_NOT_IN_FAMILY]: '譲渡を受ける人がこの家族に参加していません。',
  [MembershipErrorCode.NOT_AUTHENTICATED]: 'ログインが必要です。',
  [MembershipErrorCode.RATE_LIMITED]: '操作が多すぎます。しばらく待ってからもう一度お試しください。',
  [MembershipErrorCode.RPC_FAILED]: '処理に失敗しました。時間をおいてもう一度お試しください。',
  [MembershipErrorCode.EMAIL_SEND_FAILED]: 'メールを送れませんでした。時間をおいてもう一度お試しください。',
  [MembershipErrorCode.CONFLICT_RETRY]: 'ほかの操作と重なりました。もう一度お試しください。',
  [MembershipErrorCode.INVALID_REQUEST]: '送った内容を読み取れませんでした。画面を開き直して、もう一度お試しください。',
  [MembershipErrorCode.VALIDATION_ERROR]: '入力の内容が正しくありません。確かめて、もう一度お試しください。',
};

/** 表に無い code (INVALID_BODY・INTERNAL_ERROR・UNKNOWN など) や、code が無いときの汎用の文 */
export const MEMBERSHIP_ERROR_FALLBACK_MESSAGE = '処理に失敗しました。時間をおいてもう一度お試しください。';

const MEMBERSHIP_ERROR_CODE_VALUES: ReadonlySet<string> = new Set(Object.values(MembershipErrorCode));

function isMembershipErrorCode(value: unknown): value is MembershipErrorCode {
  return typeof value === 'string' && MEMBERSHIP_ERROR_CODE_VALUES.has(value);
}

/**
 * 応答の本文の code から、画面に出す文を引く (#1478)。表に無い code・文字列でない値は MEMBERSHIP_ERROR_FALLBACK_MESSAGE。
 * 本文の message (サーバーの文) はそのまま出さない
 */
export function membershipErrorMessage(code: unknown): string {
  return isMembershipErrorCode(code) ? MEMBERSHIP_ERROR_MESSAGES[code] : MEMBERSHIP_ERROR_FALLBACK_MESSAGE;
}

/**
 * 組織・家族の API の失敗の本文 ({ error: { code, message } }。flat の { error, code } も受け付ける) から、画面に出す文を引く。
 * 本文が JSON でない・形が違うときは汎用の文
 */
export function membershipErrorMessageOfBody(body: unknown): string {
  if (!body || typeof body !== 'object') return MEMBERSHIP_ERROR_FALLBACK_MESSAGE;
  const { error, code } = body as { error?: unknown; code?: unknown };
  const nestedCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return membershipErrorMessage(nestedCode ?? code);
}

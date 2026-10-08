// src/lib/emails/membership/scope-label.ts
// 除名・脱退の通知メール (member-removed / member-left) で共通の、所属先の呼び方と件名の整形 (#1160)。

export type MembershipScope = 'family' | 'organization';

/**
 * 件名に入れる所属先の名前の最大文字数 (コードポイント数)。
 * 件名全体は EmailEnvelopeSchema で 100 文字 (UTF-16) 以内。サロゲートペアの文字 (絵文字など) だけの名前でも
 * 収まるよう、この数を 2 倍にしても件名の枠 (固定部分は約 30 文字) に入る値にしている。
 */
const MAX_SUBJECT_NAME_CODE_POINTS = 30;

/** 件名に入れた名前の末尾に付ける印 (切り詰めたとき) */
const SUBJECT_ELLIPSIS = '…';

/** 改行・タブなどの制御文字 (件名を 1 行に保つため、空白 1 つに置き換える) */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

export function membershipScopeLabel(scope: MembershipScope): string {
  return scope === 'organization' ? '組織' : '家族グループ';
}

/** 前後の空白を除く。空なら null (名前を読めなかったときと同じ扱い) */
function normalizeName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 本文用の所属先の呼び方。「家族グループ「山田家」」「組織「株式会社ほめゴハン」」。
 * 名前を読めなかったとき (null・空) は、名前を省いて「家族グループ」「組織」だけにする。
 */
export function describeScope(scope: MembershipScope, name: string | null | undefined): string {
  const label = membershipScopeLabel(scope);
  const normalized = normalizeName(name);
  return normalized ? `${label}「${normalized}」` : label;
}

/**
 * 件名用の所属先の呼び方。本文用 (describeScope) との違い:
 * - 改行・タブなどの制御文字は空白 1 つにする (件名を 1 行に保つ)。
 * - 長い名前は MAX_SUBJECT_NAME_CODE_POINTS 文字で切り、「…」を付ける (件名が 100 文字を超えると送信時の検証で落ちるため)。
 *   組織名には文字数の上限が無い。切るのは件名だけで、本文には名前をそのまま載せる。
 */
export function describeScopeForSubject(scope: MembershipScope, name: string | null | undefined): string {
  const flattened = normalizeName(typeof name === 'string' ? name.replace(CONTROL_CHARS, ' ') : name);
  if (!flattened) return membershipScopeLabel(scope);

  const codePoints = Array.from(flattened);
  const shown =
    codePoints.length > MAX_SUBJECT_NAME_CODE_POINTS
      ? `${codePoints.slice(0, MAX_SUBJECT_NAME_CODE_POINTS).join('')}${SUBJECT_ELLIPSIS}`
      : flattened;
  return `${membershipScopeLabel(scope)}「${shown}」`;
}

/**
 * 利用規約・プライバシーポリシーへの再同意ゲート (#1174) の判定ロジック
 *
 * lib/supabase/middleware.ts が、サインイン中の利用者のプロフィール (すでに毎回読んでいる user_profiles の行) の
 * 「同意済みの版」を、packages/shared の LEGAL_DOCUMENTS (いま有効な版) と突き合わせて、次のどれにするかを決める。
 *
 *   none     何もしない (同意済み / ゲートの対象外のパス)
 *   banner   通す。ただし画面の上に「同意のお願い」のお知らせを出す (非ブロッキング)
 *   redirect 同意画面 /legal-consent へ回す (next に元のパスを付ける)
 *
 * redirect になるのは、環境変数 LEGAL_CONSENT_ENFORCE=on のときだけ。未設定・それ以外のときは、未同意の人にも
 * banner を出すだけで、誰も止めない (強制を始める日はオーナーが決める。それまでは同意の記録を集めるだけ)。
 *
 * ここは副作用のない関数だけを置く (Edge ランタイムの middleware から import されるので、Node 専用の API は使わない)。
 */
import { hasAcceptedCurrentLegalDocuments, type AcceptedLegalVersions } from '@homegohan/shared';
import { getSafeRedirectPath } from '@/lib/auth/safe-redirect';
import { LEGAL_CONSENT_PATH, isAuthFlowPath, isLegalConsentPath, isPolicyPath } from './onboarding-routing';

/**
 * 同意画面のパス。定義は onboarding-routing.ts にある: 初期設定の差し戻しからも、この画面を除外するため
 * (差し戻すと、初期設定が済んでいない新規登録者が、同意画面との間で無限にリダイレクトする)。
 */
export { LEGAL_CONSENT_PATH };

/**
 * middleware が、未同意 (かつ強制していない) のときに、サーバー側の画面 (layout) へ渡すリクエストヘッダー。
 * 値が '1' のときだけ「同意のお願い」のお知らせを出す。クライアントから送られてきた同名のヘッダーは
 * middleware が毎回捨ててから、必要なときだけ付け直す (利用者が自分の画面に出すお知らせを偽装できても害は無いが、
 * 「出ているかどうか」の根拠を middleware の判定だけにしておく)。
 */
export const LEGAL_CONSENT_PENDING_HEADER = 'x-legal-consent-pending';

export type LegalConsentDecision = 'none' | 'banner' | 'redirect';

/**
 * 強制 (同意画面へ回す) を有効にするか。環境変数 LEGAL_CONSENT_ENFORCE が on のときだけ true。
 * 未設定・off・空・その他の値はすべて false (誤って全員を止めないよう、明示的に on と書いたときだけ有効にする)。
 * 大文字小文字と前後の空白は区別しない (Vercel の画面で ON と入れても効くように)。
 */
export function isLegalConsentEnforced(value: string | undefined = process.env.LEGAL_CONSENT_ENFORCE): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'on';
}

/** パスが prefix そのもの、または prefix/ 以下か ('/legal' が '/legal-consent' や '/legalx' に当たらないように) */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * ゲートの対象外にする、画面のパスの先頭 (このほかに、/terms・/privacy と /auth/* と同意画面 /legal-consent は
 * onboarding-routing の isPolicyPath / isAuthFlowPath / isLegalConsentPath で対象外にする。
 * 初期設定の差し戻しの除外と 1 か所の定義に揃えるため)。
 */
const EXEMPT_PREFIXES = [
  // 特定商取引法に基づく表記。同意の根拠になる文面 (/terms・/privacy) と同じく、読めないと困る公開の文面
  '/legal',
  // 同意しない人が運営に連絡する窓口 (データの削除の依頼もここから)。凍結中の人も同じ扱い
  '/contact',
  '/frozen',
  // API は画面ではない。各 route が自分で認可する (middleware の /api/* の分岐はそもそもここへ来ないが、念のため)
  '/api',
  // ハンズオンツアー。ツアーの途中で同意画面へ飛ばして流れを切らない
  '/handson-tour',
  // Next.js の配信物
  '/_next',
];

/** 画面ではない静的ファイル (middleware の matcher が外しきれなかった拡張子) */
const STATIC_FILE_PATTERN = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|map|json|txt|xml|woff2?|ttf|otf|mp4|webm|pdf)$/i;

/**
 * 同意ゲートの対象外のパスか。
 * 認証の途中の画面 (/auth/*。OAuth コールバック・ネイティブ認証ブリッジ・パスワード再設定など) は、ここで差し戻すと
 * セッションの切り替えが完了せず、WebView が古いアカウントのまま残るので、必ず対象外にする (S-7b と同じ理由)。
 */
export function isLegalConsentExemptPath(pathname: string): boolean {
  // 同意画面そのものは、必ず対象外にする。ここを対象にすると、同意画面が自分自身へ無限に回る
  if (isAuthFlowPath(pathname) || isPolicyPath(pathname) || isLegalConsentPath(pathname)) return true;
  if (EXEMPT_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) return true;
  return STATIC_FILE_PATTERN.test(pathname);
}

export interface ResolveLegalConsentInput {
  pathname: string;
  /** プロフィールの同意済みの版。行が無い (新規登録したばかり) ときは null / undefined */
  accepted: AcceptedLegalVersions | null | undefined;
  /** LEGAL_CONSENT_ENFORCE=on か (isLegalConsentEnforced の結果) */
  enforce: boolean;
}

export function resolveLegalConsent(input: ResolveLegalConsentInput): LegalConsentDecision {
  if (hasAcceptedCurrentLegalDocuments(input.accepted)) return 'none';
  if (isLegalConsentExemptPath(input.pathname)) return 'none';
  return input.enforce ? 'redirect' : 'banner';
}

/**
 * 同意画面へ回すときの next (同意後に戻る先) を作る。パス + クエリ。
 * RSC の取得 (_rsc) と、Next.js が内部で付けるクエリは、戻り先に残さない。
 */
export function buildLegalConsentNext(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete('_rsc');
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** 同意画面のパス (?next=...)。next は元のパス + クエリ */
export function buildLegalConsentPath(pathname: string, search: string): string {
  return `${LEGAL_CONSENT_PATH}?next=${encodeURIComponent(buildLegalConsentNext(pathname, search))}`;
}

/**
 * 同意画面の next パラメータを、安全な戻り先にする。
 * - 同一オリジンの相対パスだけ (open redirect 対策。getSafeRedirectPath)
 * - 同意画面自身 (戻っても同じ画面に着くだけ) と API (画面ではない) は /home にする
 * - 無い・不正なら /home
 */
export function resolveLegalConsentNext(raw: string | null | undefined): string {
  const safe = getSafeRedirectPath(raw);
  if (!safe) return '/home';
  const pathname = safe.split(/[?#]/)[0];
  if (isLegalConsentPath(pathname) || matchesPrefix(pathname, '/api')) return '/home';
  return safe;
}

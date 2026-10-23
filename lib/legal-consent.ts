/**
 * 利用規約・プライバシーポリシーへの再同意ゲート (#1174) の判定ロジック
 *
 * lib/supabase/middleware.ts が、サインイン中の利用者のプロフィール (すでに毎回読んでいる user_profiles の行) の
 * 「同意済みの版」を、packages/shared の LEGAL_DOCUMENTS (いま有効な版) と突き合わせて、次のどれにするかを決める。
 *
 *   none     何もしない (同意済み / ゲートの対象外のパス / どちらのフラグも on でない)
 *   banner   通す。ただし画面の上に「同意のお願い」のお知らせを出す (非ブロッキング)
 *   redirect 同意画面 /legal-consent へ回す (next に元のパスを付ける)
 *
 * 2 つの環境変数で決まる (どちらも既定は off。明示的に on と書いたときだけ有効):
 *   LEGAL_CONSENT_ENFORCE=on  未同意の人を redirect する (お知らせより優先)
 *   LEGAL_CONSENT_NOTICE=on   強制していない間、未同意の人に banner を出す
 * どちらも on でない既定では、未同意の人にも何も出さず、誰も止めない。同意の記録は、同意画面 /legal-consent を
 * 開いて同意したときだけ残る (強制やお知らせを始める日はオーナーが決める)。
 *
 * 生年月日の未入力と、保護者の同意とのつながりが無い 18 歳未満も同意画面へ回す (#1173。判定は packages/shared の
 * isLegalConsentComplete。つながりは呼ぶ側が lib/legal-consent-minor.ts の withMinorGuardianStatus で DB に聞いて入れる)。
 *
 * ここは副作用のない関数だけを置く。ブラウザで動くコンポーネント (LegalConsentForm・LegalConsentBanner) も import するので、
 * Node 専用の API は使わない (全リクエストの前に動く proxy (src/proxy.ts) も lib/supabase/middleware.ts 経由で読む)。
 */
import { isLegalConsentComplete, type LegalConsentProfile } from '@homegohan/shared';
import { getSafeRedirectPath } from '@/lib/auth/safe-redirect';
import {
  LEGAL_CONSENT_PATH,
  isAuthFlowPath,
  isDataSubjectRequestsPath,
  isLegalConsentPath,
  isPolicyPath,
} from './onboarding-routing';

/**
 * 同意画面のパス。定義は onboarding-routing.ts にある: 初期設定の差し戻しからも、この画面を除外するため
 * (差し戻すと、初期設定が済んでいない新規登録者が、同意画面との間で無限にリダイレクトする)。
 */
export { LEGAL_CONSENT_PATH };

/**
 * 同意の前の退会とデータの書き出しの画面 (#1901 cross/20 Q-23: 規約に同意しなくても、本人が退会と書き出しをできるようにする)。
 * 同意画面の下のパスに置くので、同意ゲート (isLegalConsentPath) と初期設定の差し戻しの両方の対象外になる。
 * 凍結中は凍結の差し戻し (/frozen) が先に効くので開けない (凍結中の人は /frozen/account を使う)。
 * 呼ぶ API (/api/account/delete・/api/account/export と、409 のときの /api/family/dissolve・/api/org/dissolve) は同意の許可リスト (LEGAL_CONSENT_EXEMPT_API_PATHS) にある。
 */
export const LEGAL_CONSENT_ACCOUNT_PATH = `${LEGAL_CONSENT_PATH}/account`;

/**
 * middleware が、未同意 (かつ強制しておらず、お知らせを有効にしている) のときに、サーバー側の画面 (layout) へ渡すリクエストヘッダー。
 * 値が '1' のときだけ「同意のお願い」のお知らせを出す。クライアントから送られてきた同名のヘッダーは
 * middleware が毎回捨ててから、必要なときだけ付け直す (利用者が自分の画面に出すお知らせを偽装できても害は無いが、
 * 「出ているかどうか」の根拠を middleware の判定だけにしておく)。
 */
export const LEGAL_CONSENT_PENDING_HEADER = 'x-legal-consent-pending';

export type LegalConsentDecision = 'none' | 'banner' | 'redirect';

/** 同意ゲートの環境変数 (LEGAL_CONSENT_ENFORCE / LEGAL_CONSENT_NOTICE) を有効とみなす、ただ 1 つの値 */
const LEGAL_CONSENT_FLAG_ON = 'on';

/**
 * 同意ゲートの環境変数の値を読む (2 つのフラグで共有する。読み方を別々に実装しない)。
 * on のときだけ true。未設定・off・空・その他の値 (true / 1 / yes など) はすべて false
 * (誤って全員を止めたり、全員にお知らせを出したりしないよう、明示的に on と書いたときだけ有効にする)。
 * 大文字小文字と前後の空白は区別しない (Vercel の画面で ON と入れても効くように)。
 */
export function isLegalConsentFlagOn(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === LEGAL_CONSENT_FLAG_ON;
}

/**
 * 強制 (同意画面へ回す) を有効にするか。環境変数 LEGAL_CONSENT_ENFORCE が on のときだけ true (既定は off)。
 */
export function isLegalConsentEnforced(value: string | undefined = process.env.LEGAL_CONSENT_ENFORCE): boolean {
  return isLegalConsentFlagOn(value);
}

/**
 * 強制していない間に、未同意の人へ「同意のお願い」のお知らせを出すか。
 * 環境変数 LEGAL_CONSENT_NOTICE が on のときだけ true (既定は off = お知らせを出さない)。
 * サーバー側 (middleware) だけで読む。クライアントの部品へは、layout から props で渡す (NEXT_PUBLIC_ にしない)。
 */
export function isLegalConsentNoticeEnabled(value: string | undefined = process.env.LEGAL_CONSENT_NOTICE): boolean {
  return isLegalConsentFlagOn(value);
}

/** パスが prefix そのもの、または prefix/ 以下か ('/legal' が '/legal-consent' や '/legalx' に当たらないように) */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * ゲートの対象外にする、画面のパスの先頭 (このほかに、/terms・/privacy と /auth/* と同意画面 /legal-consent と
 * 本人の権利の請求の画面 /settings/data-requests (本人確認のメールのリンクの着地 /settings/data-requests/verify を含む。#1751) は
 * onboarding-routing の isPolicyPath / isAuthFlowPath / isLegalConsentPath / isDataSubjectRequestsPath で対象外にする。
 * 初期設定の差し戻しの除外と 1 か所の定義に揃えるため)。
 * 請求の画面は、規約への同意を条件にできない本人の権利なので、未同意でも開ける (呼ぶ API /api/account/data-requests も、
 * API の同意ゲートの許可リスト LEGAL_CONSENT_EXEMPT_API_PATHS にある)。設定画面 (/settings) そのものは対象のまま。
 */
const EXEMPT_PREFIXES = [
  // 特定商取引法に基づく表記。同意の根拠になる文面 (/terms・/privacy) と同じく、読めないと困る公開の文面
  '/legal',
  // 同意しない人が運営に連絡する窓口。凍結中の人も同じ扱い (同意の前の退会と書き出しは LEGAL_CONSENT_ACCOUNT_PATH の画面で本人が行う)
  '/contact',
  '/frozen',
  // API は画面ではない。API の同意ゲートは middleware の /api の分岐 (判定は packages/shared の resolveLegalConsentApiDecision。#1442)
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
  if (
    isAuthFlowPath(pathname) ||
    isPolicyPath(pathname) ||
    isLegalConsentPath(pathname) ||
    isDataSubjectRequestsPath(pathname)
  ) {
    return true;
  }
  if (EXEMPT_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) return true;
  return STATIC_FILE_PATTERN.test(pathname);
}

export interface ResolveLegalConsentInput {
  pathname: string;
  /**
   * プロフィールの同意済みの版と生年月日 (18 歳未満なら withMinorGuardianStatus が入れた minor_guardian_ok を含む)。
   * 行が無い (新規登録したばかり) ときは null / undefined
   */
  accepted: LegalConsentProfile | null | undefined;
  /** LEGAL_CONSENT_ENFORCE=on か (isLegalConsentEnforced の結果) */
  enforce: boolean;
  /** LEGAL_CONSENT_NOTICE=on か (isLegalConsentNoticeEnabled の結果)。強制しているときは見ない */
  notice: boolean;
}

export function resolveLegalConsent(input: ResolveLegalConsentInput): LegalConsentDecision {
  if (isLegalConsentComplete(input.accepted)) return 'none';
  if (isLegalConsentExemptPath(input.pathname)) return 'none';
  if (input.enforce) return 'redirect';
  return input.notice ? 'banner' : 'none';
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
 * 初めてサインインした (アカウントを作ったばかりの) 人を、同意画面へ通すかどうかの入力 (#1435)。
 * /auth/callback が、すでに読んでいる user_profiles の行 (無ければ null) と、決めた遷移先を渡す。
 */
export interface FirstSignInLegalConsentInput {
  /** /auth/callback が決めた遷移先 (同一オリジンの相対パス。クエリを含むことがある) */
  next: string;
  /** user_profiles の行。新規登録の直後は行が無い (null) */
  profile:
    | (LegalConsentProfile & {
        onboarding_started_at?: string | null;
        onboarding_completed_at?: string | null;
      })
    | null
    | undefined;
}

/**
 * 初回の作成 (新規登録・ログイン画面の「Googleで続ける」「Appleで続ける」で初めて入った人) を、必ず同意画面に通す (#1435)。
 *
 * サインアップ画面の同意のチェックは登録のボタンを押せるようにするだけで、同意の記録は同意画面 /legal-consent で
 * 同意したときだけ残る。ログイン画面の「Googleで続ける」「Appleで続ける」は、初めての人には新しいアカウントを作るが、そのチェックを通らない。
 * そこで /auth/callback で「初期設定をまだ始めていない (新しいアカウント) のに、いま有効な版に同意していない」と
 * 分かった人は、LEGAL_CONSENT_ENFORCE の値に関わらず同意画面へ回す (戻り先 = 本来の遷移先)。
 * 「続けると同意したものとみなします」というみなし同意は #1174 でやめたので、ログイン画面には出さない。
 *
 * 初期設定を始めた (または終えた) 人は対象外 (既存の利用者を止めるかは、これまでどおり LEGAL_CONSENT_ENFORCE が決める)。
 * 遷移先が同意ゲートの対象外のパス (/auth/* ・/terms など。isLegalConsentExemptPath) なら回さない。
 * 同意画面へ回すときは同意画面のパス (?next=<遷移先>) を、回さないときは next をそのまま返す。
 */
export function resolveFirstSignInDestination(input: FirstSignInLegalConsentInput): string {
  const { next, profile } = input;
  const isNewAccount = !profile?.onboarding_started_at && !profile?.onboarding_completed_at;
  if (!isNewAccount) return next;
  const pathname = next.split(/[?#]/)[0];
  // 強制したときと同じ判定 (同意済み・対象外のパスなら none) を使う。お知らせのフラグはここでは見ない
  const decision = resolveLegalConsent({ pathname, accepted: profile, enforce: true, notice: false });
  if (decision !== 'redirect') return next;
  return `${LEGAL_CONSENT_PATH}?next=${encodeURIComponent(next)}`;
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

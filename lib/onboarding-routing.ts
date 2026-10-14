type OnboardingStatus = "not_started" | "in_progress" | "completed";

type OnboardingRedirectInput = {
  pathname: string;
  roles?: string[] | null;
  onboardingStartedAt?: string | null;
  onboardingCompletedAt?: string | null;
};

function getOnboardingStatus(input: OnboardingRedirectInput): OnboardingStatus {
  if (input.onboardingCompletedAt) return "completed";
  if (input.onboardingStartedAt) return "in_progress";
  return "not_started";
}

function isOnboardingPath(pathname: string): boolean {
  return pathname === "/onboarding" || pathname.startsWith("/onboarding/");
}

// #1057 (round-2 Critical fix): middleware の publicPaths による '/invite' 除外は
// 未認証ユーザーの分岐にしか効かない。認証済みだがオンボーディング未完了のユーザーが
// 招待リンク(サインアップ/ログイン後に /invite/[token] へ戻ってくる遷移)を踏むと、
// 以下の not_started/in_progress 分岐で強制的に /onboarding/welcome (or /resume) へ
// 差し戻され、招待コンテキストが失われていた。/invite・/invite/[token] は
// オンボーディング状態に関わらず素通りさせる。
function isInvitePath(pathname: string): boolean {
  return pathname === "/invite" || pathname.startsWith("/invite/");
}

// #1232: /invite と同趣旨 (#1057 round-2 の教訓の適用)。家族参加の本人同意ページ
// (メールリンク着地) は、認証済みだがオンボーディング未完了のユーザーが踏んでも
// /onboarding/welcome (or /resume) へ差し戻さず素通りさせる。
// サインアップ → オンボーディング前に承認ページへ戻る導線を守る。
function isFamilyPromotionPath(pathname: string): boolean {
  return pathname === "/family/promotions" || pathname.startsWith("/family/promotions/");
}

// S-7b (#1036 のレビュー): /auth/* (OAuth コールバック・ネイティブ認証ブリッジ・パスワード再設定など) は、
// セッションを確立・切り替える途中の画面。WebView にオンボーディング未完了の別アカウントのセッションが
// 残っている状態でネイティブ認証ブリッジ (/auth/native-bridge?code=...) を開いたときに差し戻すと、
// ワンタイムコードが引き換えられず、WebView が古いアカウントのまま残る。オンボーディング状態に関わらず素通りさせる
// (これらは未認証でも開ける画面なので、素通りさせても見せる範囲は広がらない)。
export function isAuthFlowPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}

// #1174 (同意の前提): 利用規約 (/terms) とプライバシーポリシー (/privacy)。
// サインアップ画面の同意リンク・LP のフッター・ストア審査に出す URL の着地点なので、
// 未ログインでも読めるだけでなく (middleware の publicPaths)、ログイン済みでオンボーディング未完了・
// 凍結中のユーザーが踏んでも差し戻さず、文面をそのまま読ませる。
// 見せるのは未ログインでも読める公開の文面だけなので、素通りさせても見せる範囲は広がらない。
export function isPolicyPath(pathname: string): boolean {
  return (
    pathname === "/terms" ||
    pathname.startsWith("/terms/") ||
    pathname === "/privacy" ||
    pathname.startsWith("/privacy/")
  );
}

// #1174: 規約・プライバシーポリシーへの同意画面。同意ゲート (lib/legal-consent.ts。LEGAL_CONSENT_ENFORCE=on のとき) が、
// 同意していないサインイン中の人をここへ回す。
// 初期設定の差し戻しをここにも掛けると、初期設定が済んでいない人 (= 新規登録した人) は
//   保護ページ -> /legal-consent (同意ゲート) -> /onboarding/welcome (差し戻し) -> /legal-consent (同意ゲート) -> ...
// と無限にリダイレクトして、同意画面に着けない。初期設定の状態に関わらず素通りさせる
// (見せるのは同意のチェックだけで、素通りさせても見せる範囲は広がらない)。
export const LEGAL_CONSENT_PATH = "/legal-consent";

export function isLegalConsentPath(pathname: string): boolean {
  return pathname === LEGAL_CONSENT_PATH || pathname.startsWith(`${LEGAL_CONSENT_PATH}/`);
}

export function resolveOnboardingRedirect(input: OnboardingRedirectInput): string | null {
  const pathname = input.pathname;
  const roles = input.roles ?? [];
  const onboardingPath = isOnboardingPath(pathname);

  if (roles.includes("admin") || roles.includes("super_admin")) {
    if (pathname === "/" || pathname === "/home" || onboardingPath) {
      return "/admin";
    }
    return null;
  }

  const status = getOnboardingStatus(input);

  if (status === "completed") {
    if (pathname === "/") return "/home";
    if (onboardingPath && pathname !== "/onboarding/complete") {
      return "/home";
    }
    return null;
  }

  const target = status === "in_progress" ? "/onboarding/resume" : "/onboarding/welcome";

  if (pathname === "/" || pathname === "/home") {
    return target;
  }

  if (
    isInvitePath(pathname) ||
    isFamilyPromotionPath(pathname) ||
    isAuthFlowPath(pathname) ||
    isPolicyPath(pathname) ||
    isLegalConsentPath(pathname)
  ) {
    return null;
  }

  if (!onboardingPath) {
    return target;
  }

  if (status === "in_progress") {
    if (pathname === "/onboarding" || pathname === "/onboarding/welcome") {
      return "/onboarding/resume";
    }
    return null;
  }

  // #268: not_started ユーザーは resume/complete には直アクセス不可
  // /onboarding/questions は welcome → questions のフローで必要なため許可する
  if (
    pathname === "/onboarding" ||
    pathname === "/onboarding/resume" ||
    pathname === "/onboarding/complete"
  ) {
    return "/onboarding/welcome";
  }

  return null;
}

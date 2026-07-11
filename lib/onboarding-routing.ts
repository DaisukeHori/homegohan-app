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

  if (isInvitePath(pathname)) {
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

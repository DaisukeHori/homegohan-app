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

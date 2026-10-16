import { describe, expect, it } from "vitest";

import { DSR_SETTINGS_PATH, DSR_VERIFY_PATH } from "@/lib/data-subject-requests/core";
import {
  DATA_SUBJECT_REQUESTS_PATH,
  LEGAL_CONSENT_PATH,
  isDataSubjectRequestsPath,
  isLegalConsentPath,
  isPolicyPath,
  resolveOnboardingRedirect,
} from "../lib/onboarding-routing";

describe("resolveOnboardingRedirect", () => {

  // S-7b (#1036 のレビュー): /auth/* はセッションを確立・切り替える途中の画面。
  // オンボーディング未完了のセッションが残った WebView でネイティブ認証ブリッジを開いても、
  // ワンタイムコードの引き換え前に差し戻さない。
  it.each([
    ["/auth/native-bridge", "not_started", null],
    ["/auth/native-bridge", "in_progress", "2026-03-01T00:00:00Z"],
    ["/auth/callback", "not_started", null],
    ["/auth/reset-password", "in_progress", "2026-03-01T00:00:00Z"],
    ["/auth", "not_started", null],
  ])("does not redirect %s for %s users", (pathname, _status, startedAt) => {
    expect(
      resolveOnboardingRedirect({
        pathname,
        roles: [],
        onboardingStartedAt: startedAt,
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("still redirects look-alike paths such as /authx (prefix boundary)", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/authx",
        roles: [],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBe("/onboarding/welcome");
  });
  it("redirects unauthenticated onboarding-incomplete users from app pages to welcome", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/profile",
        roles: [],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBe("/onboarding/welcome");
  });

  it("redirects in-progress users from app pages to resume", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/meals/new",
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: null,
      }),
    ).toBe("/onboarding/resume");
  });

  it("keeps in-progress users on question pages", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/onboarding/questions",
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("redirects completed users away from onboarding welcome", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/onboarding/welcome",
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: "2026-03-01T01:00:00Z",
      }),
    ).toBe("/home");
  });

  it("allows completed users to view onboarding complete page", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/onboarding/complete",
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: "2026-03-01T01:00:00Z",
      }),
    ).toBeNull();
  });

  it("allows in-progress users to reach /onboarding/complete (does not redirect to resume)", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/onboarding/complete",
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("#349: not_started users can access /onboarding/questions (welcome → questions flow)", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/onboarding/questions",
        roles: [],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("redirects admins to admin for onboarding routes", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/onboarding/welcome",
        roles: ["admin"],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBe("/admin");
  });

  // #1057 (round-2 Critical fix): 認証済み・オンボーディング未完了ユーザーが
  // 招待リンク (/invite/[token]) を踏んでも強制オンボーディングリダイレクトで
  // 招待コンテキストを失わないことを保証する
  it("#1057: allows not_started users to reach /invite/[token] without forcing onboarding", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/invite/abc123",
        roles: [],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("#1057: allows in-progress users to reach /invite/[token] without forcing resume", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/invite/abc123",
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("#1057: allows not_started users to reach bare /invite without forcing onboarding", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/invite",
        roles: [],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  // #1232: 家族参加の本人同意ページ (/family/promotions/[token]) はメールリンクの着地点。
  // /invite と同趣旨で、認証済み・オンボーディング未完了のユーザーが踏んでも
  // 強制オンボーディングリダイレクトで承認ページから弾かれないことを保証する
  it("#1232: allows not_started users to reach /family/promotions/[token] without forcing onboarding", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: `/family/promotions/${"a".repeat(64)}`,
        roles: [],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("#1232: allows in-progress users to reach /family/promotions/[token] without forcing resume", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: `/family/promotions/${"a".repeat(64)}`,
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("#1232: allows not_started users to reach bare /family/promotions without forcing onboarding", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/family/promotions",
        roles: [],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("#1232: allows in-progress users to reach bare /family/promotions without forcing resume", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/family/promotions",
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("#1232: does not exempt look-alike paths such as /family/promotionsx (still redirected to welcome)", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/family/promotionsx",
        roles: [],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBe("/onboarding/welcome");
  });

  it("#1232: does not exempt other /family pages such as /family/dashboard (still redirected to welcome)", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/family/dashboard",
        roles: [],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBe("/onboarding/welcome");
  });

  it("#1232: still redirects in-progress users away from other /family pages to resume", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/family/dashboard",
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: null,
      }),
    ).toBe("/onboarding/resume");
  });

  // #1174 (同意の前提): 利用規約 (/terms) とプライバシーポリシー (/privacy) は、サインアップ画面の
  // 同意リンク・LP のフッター・ストア審査に出す URL の着地点。ログイン済みでもオンボーディング未完了の
  // ユーザーが踏んだときに /onboarding/welcome (or /resume) へ差し戻さず、文面をそのまま読ませる。
  it.each([
    ["/terms", "not_started", null],
    ["/terms", "in_progress", "2026-03-01T00:00:00Z"],
    ["/privacy", "not_started", null],
    ["/privacy", "in_progress", "2026-03-01T00:00:00Z"],
  ])("#1174: does not redirect %s for %s users", (pathname, _status, startedAt) => {
    expect(
      resolveOnboardingRedirect({
        pathname,
        roles: [],
        onboardingStartedAt: startedAt,
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it.each([
    ["/terms", "completed"],
    ["/privacy", "completed"],
  ])("#1174: leaves %s alone for %s users too (no behavior change)", (pathname) => {
    expect(
      resolveOnboardingRedirect({
        pathname,
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: "2026-03-01T01:00:00Z",
      }),
    ).toBeNull();
  });

  it.each(["/termsx", "/privacyx", "/terms-of-service", "/privacy-policy"])(
    "#1174: does not exempt look-alike path %s (still redirected to welcome)",
    (pathname) => {
      expect(
        resolveOnboardingRedirect({
          pathname,
          roles: [],
          onboardingStartedAt: null,
          onboardingCompletedAt: null,
        }),
      ).toBe("/onboarding/welcome");
    },
  );
});

// #1174: 規約の同意画面 (/legal-consent)。同意ゲート (LEGAL_CONSENT_ENFORCE=on) が、未同意の人をここへ回す。
// ここで初期設定の差し戻しが効くと、初期設定が済んでいない人 (= 新規登録した人) は、
// 「保護ページ -> /legal-consent (ゲート) -> /onboarding/welcome (差し戻し) -> /legal-consent (ゲート) -> ...」と
// 無限にリダイレクトして、同意画面に着けない。初期設定の状態に関わらず素通りさせる。
describe("resolveOnboardingRedirect: 同意画面 /legal-consent (#1174)", () => {
  it.each([
    ["/legal-consent", null],
    ["/legal-consent", "2026-03-01T00:00:00Z"],
    ["/legal-consent/", null],
  ])("does not redirect %s for onboarding-incomplete users (startedAt=%s)", (pathname, startedAt) => {
    expect(
      resolveOnboardingRedirect({
        pathname,
        roles: [],
        onboardingStartedAt: startedAt,
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it("leaves /legal-consent alone for completed users and admins too (no behavior change)", () => {
    expect(
      resolveOnboardingRedirect({
        pathname: "/legal-consent",
        roles: [],
        onboardingStartedAt: "2026-03-01T00:00:00Z",
        onboardingCompletedAt: "2026-03-01T01:00:00Z",
      }),
    ).toBeNull();
    expect(
      resolveOnboardingRedirect({
        pathname: "/legal-consent",
        roles: ["admin"],
        onboardingStartedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBeNull();
  });

  it.each(["/legal-consentx", "/legal-consent-x", "/legal"])(
    "does not exempt look-alike path %s (still redirected to welcome)",
    (pathname) => {
      expect(
        resolveOnboardingRedirect({
          pathname,
          roles: [],
          onboardingStartedAt: null,
          onboardingCompletedAt: null,
        }),
      ).toBe("/onboarding/welcome");
    },
  );
});

describe("isLegalConsentPath", () => {
  it("LEGAL_CONSENT_PATH is /legal-consent", () => {
    expect(LEGAL_CONSENT_PATH).toBe("/legal-consent");
  });

  it.each(["/legal-consent", "/legal-consent/", "/legal-consent/anything"])("#1174: %s is the consent page", (pathname) => {
    expect(isLegalConsentPath(pathname)).toBe(true);
  });

  it.each(["/", "/legal", "/legal-consentx", "/legal-consent-x", "/settings/legal-consent", "/terms", "/home"])(
    "#1174: %s is not the consent page",
    (pathname) => {
      expect(isLegalConsentPath(pathname)).toBe(false);
    },
  );
});

describe("isPolicyPath", () => {
  it.each(["/terms", "/privacy", "/terms/", "/privacy/", "/terms/anything", "/privacy/anything"])(
    "#1174: %s is a policy page",
    (pathname) => {
      expect(isPolicyPath(pathname)).toBe(true);
    },
  );

  it.each([
    "/",
    "/legal",
    "/termsx",
    "/privacyx",
    "/terms-of-service",
    "/privacy-policy",
    "/settings/terms",
    "/settings/privacy",
    "/home",
  ])("#1174: %s is not a policy page", (pathname) => {
    expect(isPolicyPath(pathname)).toBe(false);
  });
});

// #1751: 本人の権利の請求 (開示・訂正・利用停止・消去) の画面と、本人確認のメールのリンクの着地。
// 同意の画面に来るのは多くが新規登録の直後 (初期設定の前) の人で、同意の画面の案内から請求の画面へ進む。
// ここで初期設定の差し戻しが効くと、/onboarding/welcome (強制中はさらに同意の画面) へ戻されて請求の画面に着けない。
// 初期設定の状態に関わらず素通りさせる。設定画面 (/settings) そのものとほかの設定の画面は従来どおり差し戻す。
describe("resolveOnboardingRedirect: 本人の権利の請求の画面 /settings/data-requests (#1751)", () => {
  const DSR_PAGES = [DSR_SETTINGS_PATH, `${DSR_SETTINGS_PATH}/`, DSR_VERIFY_PATH];
  type OnboardingState = { onboardingStartedAt: string | null; onboardingCompletedAt: string | null };
  const NOT_STARTED: OnboardingState = { onboardingStartedAt: null, onboardingCompletedAt: null };
  const IN_PROGRESS: OnboardingState = { onboardingStartedAt: "2026-03-01T00:00:00Z", onboardingCompletedAt: null };
  const COMPLETED: OnboardingState = {
    onboardingStartedAt: "2026-03-01T00:00:00Z",
    onboardingCompletedAt: "2026-03-01T01:00:00Z",
  };
  const ONBOARDING_STATES: Array<[string, OnboardingState]> = [
    ["初期設定が未着手", NOT_STARTED],
    ["初期設定が途中", IN_PROGRESS],
    ["初期設定が完了", COMPLETED],
  ];
  const DSR_CASES: Array<[string, string, OnboardingState]> = DSR_PAGES.flatMap((pathname) =>
    ONBOARDING_STATES.map(([name, onboarding]): [string, string, OnboardingState] => [pathname, name, onboarding]),
  );

  it("DATA_SUBJECT_REQUESTS_PATH は core.ts の DSR_SETTINGS_PATH と同じ値で、DSR_VERIFY_PATH はその下にある", () => {
    expect(DATA_SUBJECT_REQUESTS_PATH).toBe(DSR_SETTINGS_PATH);
    expect(DSR_VERIFY_PATH.startsWith(`${DATA_SUBJECT_REQUESTS_PATH}/`)).toBe(true);
  });

  it.each(DSR_CASES)("%s は %s の人でも差し戻さない", (pathname, _name, onboarding) => {
    expect(resolveOnboardingRedirect({ pathname, roles: [], ...onboarding })).toBeNull();
  });

  it.each<[string, string, OnboardingState]>([
    ["/settings", "/onboarding/welcome", NOT_STARTED],
    ["/settings/account", "/onboarding/welcome", NOT_STARTED],
    ["/settings/data-requestsx", "/onboarding/welcome", NOT_STARTED],
    ["/settings/data-requests-x", "/onboarding/welcome", NOT_STARTED],
    ["/settings/data-request", "/onboarding/welcome", NOT_STARTED],
    ["/settings", "/onboarding/resume", IN_PROGRESS],
    ["/settings/data-requestsx", "/onboarding/resume", IN_PROGRESS],
  ])("設定画面そのもの・ほかの設定の画面・似た名前 %s は従来どおり %s へ差し戻す", (pathname, expected, onboarding) => {
    expect(resolveOnboardingRedirect({ pathname, roles: [], ...onboarding })).toBe(expected);
  });
});

describe("isDataSubjectRequestsPath (#1751)", () => {
  it.each([DSR_SETTINGS_PATH, `${DSR_SETTINGS_PATH}/`, DSR_VERIFY_PATH, `${DSR_VERIFY_PATH}/`])(
    "%s は請求の画面",
    (pathname) => {
      expect(isDataSubjectRequestsPath(pathname)).toBe(true);
    },
  );

  it.each([
    "/settings",
    "/settings/",
    "/settings/account",
    "/settings/data-requestsx",
    "/settings/data-requests-x",
    "/settings/data-request",
    "/data-requests",
    "/admin/data-requests",
    "/api/account/data-requests",
  ])("%s は請求の画面ではない", (pathname) => {
    expect(isDataSubjectRequestsPath(pathname)).toBe(false);
  });
});

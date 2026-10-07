import { describe, expect, it } from "vitest";

import { resolveOnboardingRedirect } from "../lib/onboarding-routing";

describe("resolveOnboardingRedirect", () => {
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
});

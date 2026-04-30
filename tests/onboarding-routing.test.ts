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
});

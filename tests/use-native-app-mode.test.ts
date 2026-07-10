/**
 * use-native-app-mode.test.ts
 *
 * Issue #1037 round-4 レビュー指摘の回帰防止テスト:
 * profile/settings/invite ページで `initialIsNativeApp` (server が cookies() から
 * 読んだ SSR seed 値) が `useNativeAppMode` にどう伝播するかの優先順位ロジックを検証する。
 *
 * web 側にはコンポーネントレンダリング用のテスト基盤 (@testing-library/react 等) が
 * 未整備なため、React をレンダリングせずに済む「cookie 伝播ロジック」の単体テストに
 * 留める (useState の初期化関数から切り出した purely functional な部分を直接テストする)。
 */

import { afterEach, describe, expect, it } from "vitest";

import { getCookieValue, resolveInitialNativeAppMode } from "../src/hooks/useNativeAppMode";

function clearAllCookies() {
  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    }
  });
}

describe("getCookieValue", () => {
  afterEach(() => {
    clearAllCookies();
  });

  it("目的の cookie が見つかればその値を返す", () => {
    document.cookie = "is_native_app=1";
    expect(getCookieValue("is_native_app")).toBe("1");
  });

  it("他の cookie が並んでいても目的のキーを見つける", () => {
    document.cookie = "foo=bar";
    document.cookie = "is_native_app=1";
    document.cookie = "baz=qux";
    expect(getCookieValue("is_native_app")).toBe("1");
  });

  it("目的の cookie が見つからない場合は undefined を返す", () => {
    document.cookie = "foo=bar";
    expect(getCookieValue("is_native_app")).toBeUndefined();
  });
});

describe("resolveInitialNativeAppMode (SSR seed 伝播の優先順位)", () => {
  it("initialIsNativeApp=true が指定されていれば client 側 cookie の値によらず true を返す (SSR seed 優先)", () => {
    expect(resolveInitialNativeAppMode(true, undefined)).toBe(true);
    expect(resolveInitialNativeAppMode(true, "0")).toBe(true);
  });

  it("initialIsNativeApp=false が明示的に指定されていれば cookie が '1' でも false を返す (SSR で Cookie が読めた通常 Web ユーザーのケース)", () => {
    // ここで cookie 側にフォールバックしてしまうと、SSR が「native ではない」と
    // 確定判定したはずの通常 Web ユーザーで hydration mismatch が再発する。
    expect(resolveInitialNativeAppMode(false, "1")).toBe(false);
  });

  it("initialIsNativeApp が未指定 (SSR 側で Cookie が読めなかった/渡されていないページ) の場合は client 側 cookie にフォールバックする", () => {
    expect(resolveInitialNativeAppMode(undefined, "1")).toBe(true);
    expect(resolveInitialNativeAppMode(undefined, "0")).toBe(false);
    expect(resolveInitialNativeAppMode(undefined, undefined)).toBe(false);
  });
});

/**
 * tests/membership-errors.test.ts
 *
 * Issue #1045 (F6-16): mapPgErrorToHttp の substring 判定が衝突し、
 * USER_NOT_IN_ORG が NOT_IN_ORG に化ける不具合の回帰テスト。
 */

import { describe, expect, it } from "vitest";
import { mapPgErrorToHttp, MembershipErrorCode } from "../src/lib/errors/membership-errors";

describe("mapPgErrorToHttp", () => {
  it("#1045 F6-16: USER_NOT_IN_ORG を含むメッセージが NOT_IN_ORG に化けず 404/USER_NOT_IN_ORG になる", () => {
    const result = mapPgErrorToHttp(
      "ERROR: USER_NOT_IN_ORG - the specified user is not a member of this organization",
    );
    expect(result.code).toBe(MembershipErrorCode.USER_NOT_IN_ORG);
    expect(result.status).toBe(404);
  });

  it("NOT_IN_ORG 単体のメッセージは引き続き 403/NOT_IN_ORG として検出される", () => {
    const result = mapPgErrorToHttp("ERROR: NOT_IN_ORG - caller has left the organization");
    expect(result.code).toBe(MembershipErrorCode.NOT_IN_ORG);
    expect(result.status).toBe(403);
  });

  it("USER_NOT_IN_FAMILY を含むメッセージが NOT_IN_FAMILY に化けない", () => {
    const result = mapPgErrorToHttp("ERROR: USER_NOT_IN_FAMILY detected during transfer");
    expect(result.code).toBe(MembershipErrorCode.USER_NOT_IN_FAMILY);
    expect(result.status).toBe(404);
  });

  it("一致するコードが存在しない場合 UNKNOWN/500 を返す", () => {
    const result = mapPgErrorToHttp("totally unrelated database error");
    expect(result.code).toBe("UNKNOWN");
    expect(result.status).toBe(500);
  });

  it("メッセージの先頭・末尾にコードがある場合も正しく検出する (境界条件)", () => {
    expect(mapPgErrorToHttp("ALREADY_IN_ORG").code).toBe(MembershipErrorCode.ALREADY_IN_ORG);
    expect(mapPgErrorToHttp("something INVITE_EXPIRED").code).toBe(MembershipErrorCode.INVITE_EXPIRED);
  });
});

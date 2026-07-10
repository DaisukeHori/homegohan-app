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

  // #1062: propose/accept 系 RPC で実際に RAISE される、これまで未登録だったコードの回帰テスト。
  it("#1062: accept_*_transfer 系の TRANSFER_PROPOSAL_NOT_FOUND が 404 で検出され、TRANSFER_NOT_FOUND に化けない", () => {
    const result = mapPgErrorToHttp("ERROR: TRANSFER_PROPOSAL_NOT_FOUND");
    expect(result.code).toBe(MembershipErrorCode.TRANSFER_PROPOSAL_NOT_FOUND);
    expect(result.status).toBe(404);
  });

  it("#1062: TRANSFER_PROPOSAL_EXPIRED が 410 で検出され、TRANSFER_NOT_PENDING に化けない", () => {
    const result = mapPgErrorToHttp("ERROR: TRANSFER_PROPOSAL_EXPIRED");
    expect(result.code).toBe(MembershipErrorCode.TRANSFER_PROPOSAL_EXPIRED);
    expect(result.status).toBe(410);
  });

  it("#1062: propose_family_representative_transfer 系のコードが 500/UNKNOWN に化けない", () => {
    expect(mapPgErrorToHttp("ERROR: NOT_FAMILY_REPRESENTATIVE").code).toBe(
      MembershipErrorCode.NOT_FAMILY_REPRESENTATIVE,
    );
    expect(mapPgErrorToHttp("ERROR: NOT_FAMILY_REPRESENTATIVE").status).toBe(403);
    expect(mapPgErrorToHttp("ERROR: MEMBER_NOT_FOUND").code).toBe(MembershipErrorCode.MEMBER_NOT_FOUND);
    expect(mapPgErrorToHttp("ERROR: MEMBER_NOT_FOUND").status).toBe(404);
    expect(mapPgErrorToHttp("ERROR: CANNOT_TRANSFER_TO_CHILD").code).toBe(
      MembershipErrorCode.CANNOT_TRANSFER_TO_CHILD,
    );
    expect(mapPgErrorToHttp("ERROR: CANNOT_TRANSFER_TO_CHILD").status).toBe(409);
  });

  it("#1062: remove_org_member/propose_org_owner_transfer 系のコードが 500/UNKNOWN に化けない", () => {
    expect(mapPgErrorToHttp("ERROR: CANNOT_REMOVE_OWNER").code).toBe(
      MembershipErrorCode.CANNOT_REMOVE_OWNER,
    );
    expect(mapPgErrorToHttp("ERROR: CANNOT_REMOVE_OWNER").status).toBe(409);
    expect(mapPgErrorToHttp("ERROR: NOT_ORG_OWNER").code).toBe(MembershipErrorCode.NOT_ORG_OWNER);
    expect(mapPgErrorToHttp("ERROR: NOT_ORG_OWNER").status).toBe(403);
    expect(mapPgErrorToHttp("ERROR: TARGET_NOT_IN_ORG").code).toBe(MembershipErrorCode.TARGET_NOT_IN_ORG);
    expect(mapPgErrorToHttp("ERROR: TARGET_NOT_IN_ORG").status).toBe(404);
    // TARGET_NOT_IN_ORG に NOT_IN_ORG (既存コード) が部分一致で誤爆しないことも確認
    expect(mapPgErrorToHttp("ERROR: TARGET_NOT_IN_ORG").code).not.toBe(MembershipErrorCode.NOT_IN_ORG);
  });
});

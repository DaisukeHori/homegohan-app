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

  it("#1236: TRANSFER_ACCEPTOR_NOT_IN_ORG が 403 に正しく解決し NOT_IN_ORG に化けない", () => {
    const r = mapPgErrorToHttp("ERROR:  TRANSFER_ACCEPTOR_NOT_IN_ORG");
    expect(r.code).toBe(MembershipErrorCode.TRANSFER_ACCEPTOR_NOT_IN_ORG);
    expect(r.status).toBe(403);
    expect(r.code).not.toBe(MembershipErrorCode.NOT_IN_ORG);
    expect(r.code).not.toBe(MembershipErrorCode.TARGET_NOT_IN_ORG);
  });

  it("#1237: TRANSFER_ACCEPTOR_NOT_IN_FAMILY が 403 に正しく解決し NOT_IN_FAMILY に化けない", () => {
    const r = mapPgErrorToHttp("ERROR:  TRANSFER_ACCEPTOR_NOT_IN_FAMILY");
    expect(r.code).toBe(MembershipErrorCode.TRANSFER_ACCEPTOR_NOT_IN_FAMILY);
    expect(r.status).toBe(403);
    expect(r.code).not.toBe(MembershipErrorCode.NOT_IN_FAMILY);
  });

  // #1232: 子供メンバー昇格の本人同意フロー
  it("#1232: 40P01 (deadlock_detected) は CONFLICT_RETRY/409 に正規化される", () => {
    const r = mapPgErrorToHttp("deadlock detected", "40P01");
    expect(r.code).toBe(MembershipErrorCode.CONFLICT_RETRY);
    expect(r.status).toBe(409);
  });

  it("#1232: pgCode が無いとき 'deadlock detected' というメッセージだけでは UNKNOWN/500 のまま", () => {
    // メッセージは語彙 (コード語) と一致しないため、SQLSTATE を渡さなければ拾えない
    const r = mapPgErrorToHttp("deadlock detected");
    expect(r.code).toBe("UNKNOWN");
    expect(r.status).toBe(500);
  });

  it("#1232: RPC が RAISE する 'CONFLICT_RETRY' (SQLSTATE P0001) もメッセージ照合で CONFLICT_RETRY/409 になる", () => {
    const r = mapPgErrorToHttp("ERROR: CONFLICT_RETRY", "P0001");
    expect(r.code).toBe(MembershipErrorCode.CONFLICT_RETRY);
    expect(r.status).toBe(409);
  });

  it("#1232: 40P01 はメッセージ照合より先に判定され、メッセージに他のコード語があっても CONFLICT_RETRY になる", () => {
    const r = mapPgErrorToHttp("ERROR: NOT_FAMILY_ADULT", "40P01");
    expect(r.code).toBe(MembershipErrorCode.CONFLICT_RETRY);
    expect(r.status).toBe(409);
  });

  it.each([
    ["PROMOTION_REQUEST_NOT_FOUND", 404],
    ["PROMOTION_REQUEST_EXPIRED", 410],
    ["PROMOTION_REQUEST_ALREADY_USED", 409],
    ["PROMOTION_EMAIL_MISMATCH", 403],
    ["PROMOTION_MEMBER_UNAVAILABLE", 409],
    ["PROMOTION_DIRECT_DISABLED", 403],
  ])("#1232: %s が %i で検出される", (code, status) => {
    expect(mapPgErrorToHttp(`ERROR: ${code}`)).toEqual({ code, status });
  });

  it("#1232: PROMOTION_EMAIL_MISMATCH は 403 に解決し、EMAIL_MISMATCH / INVITE_EMAIL_MISMATCH に化けない", () => {
    const r = mapPgErrorToHttp("ERROR: PROMOTION_EMAIL_MISMATCH");
    expect(r.code).toBe(MembershipErrorCode.PROMOTION_EMAIL_MISMATCH);
    expect(r.code).not.toBe(MembershipErrorCode.EMAIL_MISMATCH);
    expect(r.code).not.toBe(MembershipErrorCode.INVITE_EMAIL_MISMATCH);
    expect(r.status).toBe(403);
    // 逆方向: 既存の EMAIL_MISMATCH が PROMOTION_EMAIL_MISMATCH に化けない
    expect(mapPgErrorToHttp("ERROR: EMAIL_MISMATCH").code).toBe(MembershipErrorCode.EMAIL_MISMATCH);
  });

  // #1163: DB の 24 時間上限 (enforce_membership_daily_cap) は RAISE EXCEPTION 'RATE_LIMITED' USING ERRCODE = 'P0001' で
  // 失敗する。DETAIL (上限名) と HINT (retry_after_sec) は message に入らないので、照合には影響しない。
  it("#1163: RPC が RAISE する 'RATE_LIMITED' (SQLSTATE P0001) が 429/RATE_LIMITED になる", () => {
    expect(mapPgErrorToHttp("RATE_LIMITED", "P0001")).toEqual({
      code: MembershipErrorCode.RATE_LIMITED,
      status: 429,
    });
    expect(mapPgErrorToHttp("RATE_LIMITED")).toEqual({ code: MembershipErrorCode.RATE_LIMITED, status: 429 });
    expect(mapPgErrorToHttp("ERROR: RATE_LIMITED")).toEqual({ code: MembershipErrorCode.RATE_LIMITED, status: 429 });
  });

  it("#1163: 席数・人数の上限 (SEAT_LIMIT_EXCEEDED / MEMBER_LIMIT_EXCEEDED) は RATE_LIMITED に化けず、逆も起きない", () => {
    expect(mapPgErrorToHttp("SEAT_LIMIT_EXCEEDED").code).toBe(MembershipErrorCode.SEAT_LIMIT_EXCEEDED);
    expect(mapPgErrorToHttp("MEMBER_LIMIT_EXCEEDED").code).toBe(MembershipErrorCode.MEMBER_LIMIT_EXCEEDED);
    expect(mapPgErrorToHttp("RATE_LIMITED").code).not.toBe(MembershipErrorCode.SEAT_LIMIT_EXCEEDED);
    expect(mapPgErrorToHttp("RATE_LIMITED").code).not.toBe(MembershipErrorCode.MEMBER_LIMIT_EXCEEDED);
  });

  it("#1232: 40P01 以外の pgCode は既存のメッセージ照合の結果を変えない", () => {
    expect(mapPgErrorToHttp("ERROR: USER_NOT_IN_ORG", "P0001")).toEqual({
      code: MembershipErrorCode.USER_NOT_IN_ORG,
      status: 404,
    });
    expect(mapPgErrorToHttp("ERROR: NOT_IN_ORG", "42501")).toEqual({
      code: MembershipErrorCode.NOT_IN_ORG,
      status: 403,
    });
    expect(mapPgErrorToHttp("ERROR: ALREADY_IN_FAMILY", "23505")).toEqual({
      code: MembershipErrorCode.ALREADY_IN_FAMILY,
      status: 409,
    });
    expect(mapPgErrorToHttp("totally unrelated database error", "XX000")).toEqual({
      code: "UNKNOWN",
      status: 500,
    });
  });
});

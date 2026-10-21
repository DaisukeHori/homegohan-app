/**
 * tests/membership-errors.test.ts
 *
 * Issue #1045 (F6-16): mapPgErrorToHttp の substring 判定が衝突し、
 * USER_NOT_IN_ORG が NOT_IN_ORG に化ける不具合の回帰テスト。
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapPgErrorToHttp,
  MEMBERSHIP_ERROR_FALLBACK_MESSAGE,
  MEMBERSHIP_ERROR_MESSAGES,
  MembershipErrorCode,
  membershipErrorMessage,
  membershipErrorMessageOfBody,
} from "../src/lib/errors/membership-errors";

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

  it("#1917: FAMILY_ALREADY_DISSOLVED / ORG_ALREADY_DISSOLVED が 409 で検出され、ALREADY_IN_FAMILY / ALREADY_IN_ORG に化けない", () => {
    const family = mapPgErrorToHttp("ERROR:  FAMILY_ALREADY_DISSOLVED", "P0001");
    expect(family.code).toBe(MembershipErrorCode.FAMILY_ALREADY_DISSOLVED);
    expect(family.status).toBe(409);
    expect(family.code).not.toBe(MembershipErrorCode.ALREADY_IN_FAMILY);
    const org = mapPgErrorToHttp("ERROR:  ORG_ALREADY_DISSOLVED", "P0001");
    expect(org.code).toBe(MembershipErrorCode.ORG_ALREADY_DISSOLVED);
    expect(org.status).toBe(409);
    expect(org.code).not.toBe(MembershipErrorCode.ALREADY_IN_ORG);
    expect(MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.FAMILY_ALREADY_DISSOLVED]).toBe("この家族グループはすでに解散しています。");
    expect(MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.ORG_ALREADY_DISSOLVED]).toBe("この組織はすでに解散しています。");
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

// #1478: 組織・家族の API の 4xx は本文の message が操作ごとの固定の文なので、画面は code から理由の文を引く
describe("membershipErrorMessage / membershipErrorMessageOfBody (#1478)", () => {
  it("表 (MEMBERSHIP_ERROR_MESSAGES) は enum の全値を網羅し、どれも空でない日本語の文 (コードそのものを出さない)", () => {
    const codes = Object.values(MembershipErrorCode);
    expect(Object.keys(MEMBERSHIP_ERROR_MESSAGES).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const message = MEMBERSHIP_ERROR_MESSAGES[code];
      expect(message.trim().length).toBeGreaterThan(0);
      expect(message).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(message).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
      expect(membershipErrorMessage(code)).toBe(message);
    }
  });

  it("表に無い code (INVALID_BODY・INTERNAL_ERROR・UNKNOWN)・空・文字列でない値は汎用の文", () => {
    for (const code of ["INVALID_BODY", "INTERNAL_ERROR", "UNKNOWN", "", undefined, null, 409, { code: "NOT_IN_ORG" }]) {
      expect(membershipErrorMessage(code)).toBe(MEMBERSHIP_ERROR_FALLBACK_MESSAGE);
    }
  });

  it("本文 ({ error: { code, message } }) から code の文を引き、本文の message (サーバーの文) は出さない", () => {
    const body = { error: { code: "OWNER_CANNOT_LEAVE", message: "組織からの脱退に失敗しました" } };
    expect(membershipErrorMessageOfBody(body)).toBe(MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.OWNER_CANNOT_LEAVE]);
    expect(membershipErrorMessageOfBody({ error: { code: "IS_ORG_OWNER", message: "x" } })).toBe(
      MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.IS_ORG_OWNER],
    );
    // flat の形 ({ error, code }) も受け付ける
    expect(membershipErrorMessageOfBody({ error: "処理中にエラーが発生しました", code: "RATE_LIMITED" })).toBe(
      MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.RATE_LIMITED],
    );
  });

  it("本文が無い・形が違う・未知の code は汎用の文 (生の文を出さない)", () => {
    for (const body of [null, undefined, "raw text", 500, {}, { error: { code: "SOMETHING_NEW", message: "raw db error" } }, { error: "raw db error" }]) {
      expect(membershipErrorMessageOfBody(body)).toBe(MEMBERSHIP_ERROR_FALLBACK_MESSAGE);
    }
  });
});

// #1576: 家族の除名の API (/api/family/members/[member_id]/remove) が返す code は、すべて MembershipErrorCode の値。
// 代表者を外そうとしたときの 409 は IS_FAMILY_REPRESENTATIVE (RPC が RAISE する文)。CANNOT_REMOVE_REPRESENTATIVE は route の古い守り
describe("家族の除名の API が返す code が表にある (#1576)", () => {
  it.each([
    ["IS_FAMILY_REPRESENTATIVE", 409],
    ["CANNOT_REMOVE_REPRESENTATIVE", 409],
    ["INVALID_REQUEST", 400],
    ["VALIDATION_ERROR", 400],
  ])("%s は MembershipErrorCode の値で、状態コード %i・code そのものでない日本語の文を持つ", (code, status) => {
    expect(Object.values(MembershipErrorCode)).toContain(code);
    const body = { error: { code, message: "メンバーの除名に失敗しました" } };
    expect(membershipErrorMessageOfBody(body)).not.toBe(MEMBERSHIP_ERROR_FALLBACK_MESSAGE);
    expect(membershipErrorMessageOfBody(body)).toBe(MEMBERSHIP_ERROR_MESSAGES[code as MembershipErrorCode]);
    expect(mapPgErrorToHttp(`ERROR: ${code}`)).toEqual({ code, status });
  });

  it("remove_family_member が代表者の除名で RAISE するのは IS_FAMILY_REPRESENTATIVE で、CANNOT_REMOVE_REPRESENTATIVE を RAISE する migration は無い", () => {
    const migrationsDir = path.join(__dirname, "..", "supabase/migrations");
    const sqlFiles = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
    const raises = (sql: string, code: string) => sql.includes(`RAISE EXCEPTION '${code}'`);
    const sources = sqlFiles.map((name) => fs.readFileSync(path.join(migrationsDir, name), "utf8"));
    expect(sources.filter((sql) => raises(sql, "CANNOT_REMOVE_REPRESENTATIVE"))).toEqual([]);

    // いちばん新しい remove_family_member の定義の本体 (次の CREATE FUNCTION まで) を見る
    const definition = /CREATE (?:OR REPLACE )?FUNCTION "?public"?\."?remove_family_member"?\(/g;
    const definitions = sources.filter((sql) => sql.match(definition) !== null);
    expect(definitions.length).toBeGreaterThan(0);
    const latest = definitions[definitions.length - 1];
    const starts = [...latest.matchAll(definition)].map((match) => match.index ?? 0);
    const rest = latest.slice(starts[starts.length - 1] + 1);
    const nextFunction = rest.search(/CREATE (?:OR REPLACE )?FUNCTION /);
    const body = nextFunction === -1 ? rest : rest.slice(0, nextFunction);
    expect(body).toMatch(/v_target\.role = 'representative' THEN\s+RAISE EXCEPTION 'IS_FAMILY_REPRESENTATIVE'/);
    expect(mapPgErrorToHttp("ERROR: IS_FAMILY_REPRESENTATIVE")).toEqual({
      code: MembershipErrorCode.IS_FAMILY_REPRESENTATIVE,
      status: 409,
    });
  });

  it("古い守りの CANNOT_REMOVE_REPRESENTATIVE の文は、代表者を譲る案内を含み、IS_FAMILY_REPRESENTATIVE に化けない", () => {
    expect(mapPgErrorToHttp("ERROR: CANNOT_REMOVE_REPRESENTATIVE").code).toBe(
      MembershipErrorCode.CANNOT_REMOVE_REPRESENTATIVE,
    );
    expect(MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.CANNOT_REMOVE_REPRESENTATIVE]).toContain("代表者を譲って");
  });

  it("route のソースは code を文字列のリテラルで書かず、MembershipErrorCode の値を使う", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src/app/api/family/members/[member_id]/remove/route.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/code:\s*'[A-Z_]+'/);
    expect(source).toContain("MembershipErrorCode.CANNOT_REMOVE_REPRESENTATIVE");
    expect(source).toContain("MembershipErrorCode.INVALID_REQUEST");
    expect(source).toContain("MembershipErrorCode.VALIDATION_ERROR");
  });
});

// #1478: 組織・家族の脱退・除名の画面は、本文の message をそのまま出さず、code から文を引く (書き戻しの見張り)
// #1576: 家族の画面 (家族の一覧の除名・脱退・メンバーの詳細の除名) も同じ
describe("組織・家族の脱退・除名の画面が code から文を引く (#1478・#1576)", () => {
  const PAGES = [
    "src/app/(org)/org/members/page.tsx",
    "src/app/(main)/settings/membership/page.tsx",
    "src/app/(main)/family/members/page.tsx",
    "src/app/(main)/family/members/[id]/page.tsx",
  ];

  it.each(PAGES)("%s は本文の error.message を読まず、membershipErrorMessageOfBody を使う", (rel) => {
    const source = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    expect(source).not.toMatch(/error\??\.message/);
    expect(source).toContain("membershipErrorMessageOfBody(");
  });
});

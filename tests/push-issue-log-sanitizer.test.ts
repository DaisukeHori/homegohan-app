/**
 * tests/push-issue-log-sanitizer.test.ts
 *
 * #1413: モバイルが push token の登録・削除の異常を POST /api/log に送る本文 (apps/mobile/src/lib/push-issue-log.ts) が、
 * サーバーの sanitizeLogEntry (supabase/functions/_shared/log-sanitizer.ts。/api/log が app_logs に入れる前に通す) を
 * 通っても、送ったまま残ること。/api/log は src/lib/db-logger.ts が再輸出する同じ sanitizeLogEntry を使う。
 *
 * sanitizeLogEntry は metadata のキー名だけで秘密とみなし、値を "***" にする (キー名に password / token / secret /
 * authorization / api_key を含むもの)。以前は削除の 0 件・失敗で token_source / explicit_access_token というキーを送っており、
 * 原因を切り分ける値 (控えたアクセストークンで認可したか・取り直した値で消したか) が app_logs では必ず "***" になっていた。
 * ここでは 3 つのイベントの全 reason・全分岐の本文を本物の sanitizeLogEntry に通し、送った値と残る値が一致することを確かめる。
 * ここで見るのはマスクだけ。/api/log の認証を通るかどうかは別で、explicit_auth_header が true の行 (Web から始まったサインアウト・
 * session-expired) は、サーバー側のセッションが先に失効していて /api/log が 401 を返すので、app_logs にはほぼ載らない
 * (tests/integration/security/push-issue-log-after-session-revoked.test.ts が本物のサーバーで確かめる)。
 */

import { describe, expect, it } from "vitest";

import {
  PUSH_ISSUE_SERVER_METADATA_KEYS,
  type PushIssueEvent,
  type PushIssueLogBody,
  UNKNOWN_ERROR_IDENTIFIER,
  buildPushIssueLogBody,
  registrationFailureServerFields,
  unregisterErrorServerFields,
  unregisterNoRowsServerFields,
  unregisterUnfinishedServerFields,
} from "../apps/mobile/src/lib/push-issue-log";
import { sanitizeLogEntry } from "../supabase/functions/_shared/log-sanitizer.ts";

/** sanitizeLogEntry がマスクに使う値 (log-sanitizer.ts の MASK_VALUE と同じ) */
const MASKED = "***";

/** /api/log (src/app/api/log/route.ts) と同じ形で sanitizeLogEntry に通す */
function sanitizedAsAppLog(body: { level: string; message: string; metadata: Record<string, unknown> }) {
  return sanitizeLogEntry({
    level: body.level,
    source: "client",
    message: body.message,
    metadata: body.metadata,
    user_id: "00000000-0000-4000-8000-000000000000",
  });
}

const PLATFORMS = ["ios", "android"] as const;
const BOOLS = [true, false] as const;
const PUSH_VALUE_SOURCES = ["stored", "refetched"] as const;

/** モバイルが送りうる本文を、3 イベント・全 reason・全分岐について並べる */
function allBodies(): Array<{ name: string; body: PushIssueLogBody }> {
  const out: Array<{ name: string; body: PushIssueLogBody }> = [];
  const add = (name: string, event: PushIssueEvent, fields: Parameters<typeof buildPushIssueLogBody>[1]) =>
    out.push({ name, body: buildPushIssueLogBody(event, fields) });

  for (const platform of PLATFORMS) {
    for (const stage of ["get_token", "save_token"] as const) {
      for (const httpStatus of [undefined, 403]) {
        add(`registration_failed ${platform} ${stage} status=${httpStatus}`, "push_token_registration_failed",
          registrationFailureServerFields({
            stage,
            platform,
            errorName: stage === "get_token" ? "CodedError" : "PostgrestError",
            errorCode: stage === "get_token" ? "ERR_NOTIFICATIONS_NO_EXPERIENCE_ID" : "42501",
            httpStatus,
            projectIdSource: "expoConfig",
            rejectedProjectIdSources: "env",
          }));
      }
    }
    for (const pushValueSource of PUSH_VALUE_SOURCES) {
      for (const explicitAuthHeader of BOOLS) {
        add(`unregister_failed error ${platform} ${pushValueSource} explicit=${explicitAuthHeader}`, "push_token_unregister_failed",
          unregisterErrorServerFields({
            platform,
            errorName: "PostgrestError",
            errorCode: "PGRST301",
            httpStatus: 401,
            pushValueSource,
            explicitAuthHeader,
          }));
        add(`unregister_no_rows ${platform} ${pushValueSource} explicit=${explicitAuthHeader}`, "push_token_unregister_no_rows",
          unregisterNoRowsServerFields({ platform, pushValueSource, explicitAuthHeader }));
      }
    }
    for (const explicitAuthHeader of BOOLS) {
      add(`unregister_failed timeout ${platform} explicit=${explicitAuthHeader}`, "push_token_unregister_failed",
        unregisterUnfinishedServerFields({ platform, reason: "timeout", explicitAuthHeader }));
      add(`unregister_failed exception ${platform} explicit=${explicitAuthHeader}`, "push_token_unregister_failed",
        unregisterUnfinishedServerFields({ platform, reason: "exception", errorName: "TypeError", explicitAuthHeader }));
    }
  }
  return out;
}

describe("push token の異常のサーバーログ — sanitizeLogEntry を通しても値が残る (#1413)", () => {
  const bodies = allBodies();

  it("全イベント・全 reason の本文が揃っている", () => {
    const seen = new Set(bodies.map(({ body }) => `${body.metadata.event}:${String(body.metadata.reason ?? "-")}`));
    expect([...seen].sort()).toEqual([
      "push_token_registration_failed:-",
      "push_token_unregister_failed:error",
      "push_token_unregister_failed:exception",
      "push_token_unregister_failed:timeout",
      "push_token_unregister_no_rows:-",
    ]);
  });

  it.each(bodies.map(({ name, body }) => [name, body] as const))("%s: metadata と message が送ったまま残る", (_name, body) => {
    const sanitized = sanitizedAsAppLog(body);
    expect(sanitized.metadata).toEqual(body.metadata);
    expect(sanitized.message).toBe(body.message);
    expect(Object.values(sanitized.metadata ?? {})).not.toContain(MASKED);
  });

  // マスクされないことだけを見る。explicit_auth_header が true の行が実際に /api/log の認証を通るのは、Web の signOut() による
  // セッションの失効より先に送れたときだけ (apps/mobile/src/lib/push-issue-log.ts の explicit_auth_header の説明)
  it("削除の 0 件・失敗で、原因を切り分ける 2 つの値 (push の値の出どころ・Authorization の明示) が sanitizeLogEntry を通ってもマスクされない", () => {
    const body = buildPushIssueLogBody(
      "push_token_unregister_no_rows",
      unregisterNoRowsServerFields({ platform: "ios", pushValueSource: "refetched", explicitAuthHeader: true }),
    );
    expect(sanitizedAsAppLog(body).metadata).toMatchObject({ push_value_source: "refetched", explicit_auth_header: true });
  });

  it("送ってよいキーの一覧のどのキーも、sanitizeLogEntry にマスクされない", () => {
    for (const key of PUSH_ISSUE_SERVER_METADATA_KEYS) {
      const metadata = { [key]: "value" };
      expect({ key, metadata: sanitizedAsAppLog({ level: "warn", message: "m", metadata }).metadata })
        .toEqual({ key, metadata });
    }
  });

  it("一覧に無いキーで、キー名に token を含むものはマスクされる (この検査が空振りしていないことの確認)", () => {
    const metadata = { token_source: "stored", explicit_access_token: true };
    expect(sanitizedAsAppLog({ level: "warn", message: "m", metadata }).metadata).toEqual({
      token_source: MASKED,
      explicit_access_token: MASKED,
    });
  });

  it("エラーの名前・コードが決まった形でなければ unknown を送る (エラーの本文は送らない)", () => {
    const fields = registrationFailureServerFields({
      stage: "get_token",
      platform: "ios",
      errorName: "Error: permission denied for ExponentPushToken[x]",
      errorCode: { nested: "x" },
      projectIdSource: "none",
      rejectedProjectIdSources: "none",
    });
    expect(fields).toMatchObject({ error_name: UNKNOWN_ERROR_IDENTIFIER, error_code: UNKNOWN_ERROR_IDENTIFIER });
    expect(fields).not.toHaveProperty("http_status");
  });
});

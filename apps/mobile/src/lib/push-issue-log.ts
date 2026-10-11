// #1413: push token の登録・削除の異常を、サーバーログ (POST /api/log → app_logs) に送るときの本文を組み立てる純粋関数。
//
// 端末の機能 (react-native / expo) を import しないので、mobile の jest からも、ルートの vitest からも読める。
// 送る本文は /api/log の中で sanitizeLogEntry (supabase/functions/_shared/log-sanitizer.ts) を通ってから app_logs に入る。
// sanitizeLogEntry は metadata のキー名だけで秘密とみなして値を "***" にする (キー名に password / token / secret /
// authorization / api_key を含むもの)。だから、ここで使うキー名には、それらの語を入れない
// (入れると、原因を切り分けるための値が app_logs から消え、秘密の値が入っていたようにも見える)。
// 送ってよいキーは PUSH_ISSUE_SERVER_METADATA_KEYS だけ。どのキーも sanitizeLogEntry を通しても値が変わらないことは
// tests/push-issue-log-sanitizer.test.ts が、本物の sanitizeLogEntry で確かめる。

/** サーバーログ (app_logs) にも残す、push token の登録・削除の異常 */
export type PushIssueEvent =
  | "push_token_registration_failed"
  | "push_token_unregister_failed"
  | "push_token_unregister_no_rows";

/**
 * サーバーログの metadata に入れてよいキー (これ以外は型で弾く)。
 * キー名に password / token / secret / authorization / api_key を含めない (上の説明を参照)。
 */
export const PUSH_ISSUE_SERVER_METADATA_KEYS = [
  /** 送り元 (常に mobile) */
  "app",
  /** イベント名 (PushIssueEvent) */
  "event",
  /** 端末の OS (Platform.OS) */
  "platform",
  /** 登録の失敗の段 (get_token / save_token) */
  "stage",
  /** EAS の project ID をどこから取ったか */
  "project_id_source",
  /** 形が違って読み飛ばした project ID の出どころ (カンマ区切り。無ければ none) */
  "rejected_project_id_sources",
  /** 削除の失敗の種類 (error / timeout / exception) */
  "reason",
  /** エラーの class 名 (決まった形のものだけ。外れたら unknown) */
  "error_name",
  /** エラーのコード (SQLSTATE・PGRST・ERR_... など。決まった形のものだけ。外れたら unknown) */
  "error_code",
  /** HTTP の状態の数字 */
  "http_status",
  /** 削除に使った push の値を、端末に控えた値から取ったか (stored)、取り直したか (refetched) */
  "push_value_source",
  /**
   * 削除の DB 呼び出しを、控えたアクセストークン (Authorization の明示) で認可したか。
   * true になるのは Web から始まったサインアウト・session-expired だけで、そのときはサーバー側のセッションがふつうは先に失効している。
   * /api/log はサーバーの getUser() でセッションの存在まで確かめて 401 を返すので、true の行は app_logs にはほぼ載らない
   * (Web の signOut() による失効より先に送れたときだけ残りうる)。app_logs で見えるのは、ほぼ端末からのサインアウトの false の行
   * (詳しくは pushNotifications.ts の unregisterExpoPushToken の説明)
   */
  "explicit_auth_header",
  /** 消えた行の件数 */
  "deleted_count",
] as const;

export type PushIssueServerMetadataKey = (typeof PUSH_ISSUE_SERVER_METADATA_KEYS)[number];

/** サーバーログに送る値。どれも決まった値 (列挙・コード・数・真偽) だけにする。トークンの値やエラーの本文は入れない */
export type PushIssueServerFields = Partial<
  Record<Exclude<PushIssueServerMetadataKey, "app" | "event">, string | number | boolean>
>;

/** POST /api/log に送る本文 */
export type PushIssueLogBody = {
  level: typeof PUSH_ISSUE_LOG_LEVEL;
  message: string;
  metadata: { app: typeof PUSH_ISSUE_LOG_APP; event: PushIssueEvent } & PushIssueServerFields;
};

/** サーバーログに送る level。どれも利用者の操作は止めていない (握りつぶしている) 異常なので warn */
export const PUSH_ISSUE_LOG_LEVEL = "warn";

/** metadata.app の値 (送り元) */
export const PUSH_ISSUE_LOG_APP = "mobile";

/**
 * エラーの名前・コードとして送ってよい形 (英数字と . _ : - だけ、短いもの)。
 * PostgrestError の code (SQLSTATE '42501' や 'PGRST301') や、Expo の CodedError の code ('ERR_...')、
 * エラーの class 名 ('PostgrestError') はこの形に収まる。収まらない値 (文が入った値など) は送らない。
 */
const ERROR_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** この形に収まらない名前・コードの代わりに送る値 */
export const UNKNOWN_ERROR_IDENTIFIER = "unknown";

/** エラーの名前・コードを、送ってよい形に絞る (形が違えば unknown) */
export function errorIdentifierOf(value: unknown): string {
  return typeof value === "string" && ERROR_IDENTIFIER_PATTERN.test(value) ? value : UNKNOWN_ERROR_IDENTIFIER;
}

/** HTTP の状態の数字 (整数) なら返す。それ以外は undefined (送らない) */
export function httpStatusOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** POST /api/log に送る本文を組み立てる */
export function buildPushIssueLogBody(event: PushIssueEvent, fields: PushIssueServerFields): PushIssueLogBody {
  return {
    level: PUSH_ISSUE_LOG_LEVEL,
    message: `push token issue: ${event}`,
    metadata: { app: PUSH_ISSUE_LOG_APP, event, ...fields },
  };
}

/** 削除に使った push の値の出どころ */
export type PushValueSource = "stored" | "refetched";

/** push_token_registration_failed で送る値 */
export function registrationFailureServerFields(input: {
  stage: "get_token" | "save_token";
  platform: string;
  errorName: unknown;
  errorCode: unknown;
  httpStatus?: unknown;
  projectIdSource: string;
  rejectedProjectIdSources: string;
}): PushIssueServerFields {
  const status = httpStatusOf(input.httpStatus);
  return {
    stage: input.stage,
    platform: input.platform,
    error_name: errorIdentifierOf(input.errorName),
    error_code: errorIdentifierOf(input.errorCode),
    ...(status === undefined ? {} : { http_status: status }),
    project_id_source: input.projectIdSource,
    rejected_project_id_sources: input.rejectedProjectIdSources,
  };
}

/** push_token_unregister_failed (reason: error = DB がエラーを返した) で送る値 */
export function unregisterErrorServerFields(input: {
  platform: string;
  errorName: unknown;
  errorCode: unknown;
  httpStatus?: unknown;
  pushValueSource: PushValueSource;
  explicitAuthHeader: boolean;
}): PushIssueServerFields {
  const status = httpStatusOf(input.httpStatus);
  return {
    platform: input.platform,
    reason: "error",
    error_name: errorIdentifierOf(input.errorName),
    error_code: errorIdentifierOf(input.errorCode),
    ...(status === undefined ? {} : { http_status: status }),
    push_value_source: input.pushValueSource,
    explicit_auth_header: input.explicitAuthHeader,
  };
}

/** push_token_unregister_no_rows (消えた行が 0 件) で送る値 */
export function unregisterNoRowsServerFields(input: {
  platform: string;
  pushValueSource: PushValueSource;
  explicitAuthHeader: boolean;
}): PushIssueServerFields {
  return {
    platform: input.platform,
    push_value_source: input.pushValueSource,
    explicit_auth_header: input.explicitAuthHeader,
    deleted_count: 0,
  };
}

/**
 * push_token_unregister_failed (reason: timeout = 待ち時間の上限を過ぎた / exception = 途中で例外が起きた) で送る値。
 * 削除できたかどうかは分からない。exception のときだけエラーの名前を付ける
 */
export function unregisterUnfinishedServerFields(input: {
  platform: string;
  reason: "timeout" | "exception";
  errorName?: unknown;
  explicitAuthHeader: boolean;
}): PushIssueServerFields {
  return {
    platform: input.platform,
    reason: input.reason,
    ...(input.reason === "exception" ? { error_name: errorIdentifierOf(input.errorName) } : {}),
    explicit_auth_header: input.explicitAuthHeader,
  };
}

/**
 * cron の共有シークレットのずれの自動・定期の検知 (#1560 の項目 8) — 純粋な関数と定数だけ (DB・メール送信・環境変数は読まない)。
 * 呼ぶのは GET /api/cron/app-log-alerts の checkCronSecretDrift (設計 docs/design/operator/12-cron-secret-drift-monitor.md §4):
 * 前の回の確認の結果 (cron_secret_probe_results) から最新の「決まった確認」を選んで所見にし、fail はキー cron_secret_drift、
 * warn はキー cron_secret_rotation で、それぞれ権利を取れた回だけ 1 通送る (info は送らない)。そのあと次の回のための確認を送る。
 * 値もダイジェストも扱わない (秘密の値に触れる型を持たず、ダイジェストも計算しない)。メールに載せるのは所見の題と対処 (定数の表) だけ。
 */

/** 運用アラートのキー (ops_alert_state.alert_key)。ずれ (fail) と、入れ替えの途中・残り (warn) で分ける (抑止の長さが違う) */
export const CRON_SECRET_DRIFT_ALERT_KEY = 'cron_secret_drift';
export const CRON_SECRET_ROTATION_ALERT_KEY = 'cron_secret_rotation';
/** しきい値 (所見の件数)。0 = 1 件から知らせる */
export const CRON_SECRET_ALERT_THRESHOLD = 0;

/** DB の関数 (migration <番号>_cron_secret_drift_monitor.sql) */
export const CRON_SECRET_PROBE_RESULTS_RPC = 'cron_secret_probe_results';
export const CRON_SECRET_PROBE_SEND_RPC = 'send_cron_secret_probe';

/**
 * 確認の結果を見る範囲 (分)。app-log-alerts の間隔 (15 分) の 4 回分で、前の回の確認が必ず入り、
 * pg_net の応答の保持 (既定 6 時間) より短い。DB の cron_secret_probe_results の c_lookback_min (15) 〜 c_lookback_max (360) の範囲 (契約テストが突き合わせる)
 */
export const CRON_SECRET_PROBE_LOOKBACK_MINUTES = 60;
/** 読む行数の上限。15 分おきの 60 分で 4 行 + Vercel Cron の二重の発火の分 (DB の c_limit_max = 50 以下) */
export const CRON_SECRET_PROBE_RESULT_LIMIT = 8;
/**
 * 送った確認に応答が無いとき、「pg_net が送っていない」と判定するまでの猶予 (分)。DB の c_timeout_ms (15 秒) と pg_net の worker の遅れより長く、
 * app-log-alerts の間隔 (15 分) より短い (前の回の確認は、次の回には必ず決まっている)
 */
export const CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES = 5;

/** 入れ替えの途中・残り (warn) の通知の抑止 (分) の既定値 = 24 時間 (設計 §0.4 の Q-2: 注意はメールで 1 日 1 通まで) */
export const CRON_SECRET_ROTATION_COOLDOWN_MINUTES = 1440;
/** OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES で受け付ける最小値 (分)。1 日 1 通までを守るため、既定値より短くはできない */
export const CRON_SECRET_ROTATION_COOLDOWN_MINUTES_MIN = CRON_SECRET_ROTATION_COOLDOWN_MINUTES;
/** 同じく最大値 (分)。DB の claim_ops_alert が受け付ける上限 (7 日) に合わせる */
export const CRON_SECRET_ROTATION_COOLDOWN_MINUTES_MAX = 7 * 24 * 60;

/** DB の cron_secret_probes.send_state の CHECK と同じ 6 値 */
export const CRON_SECRET_PROBE_SEND_STATES = ['sent', 'vault_missing', 'vault_empty', 'vault_unreadable', 'vault_unavailable', 'net_unavailable'] as const;
export type CronSecretProbeSendState = (typeof CRON_SECRET_PROBE_SEND_STATES)[number];

/** Edge Function cron-secret-probe の 200 の本文の matched (supabase/functions/_shared/auth.ts の ServiceRoleAuthDescription と同じ 3 値) */
export const CRON_SECRET_PROBE_MATCHES = ['current', 'previous', 'service_role_key'] as const;
export type CronSecretProbeMatch = (typeof CRON_SECRET_PROBE_MATCHES)[number];

/** requireServiceRole の 401 / 503 の本文の error (supabase/functions/_shared/auth.ts と同じ文。契約テストが突き合わせる) */
export const EDGE_UNAUTHORIZED_BODY_ERROR = 'Unauthorized';
export const EDGE_NOT_CONFIGURED_BODY_ERROR = 'Service not configured';

/** HTTP の状態コード (判定に使うもの) と 1 分のミリ秒 */
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MS_PER_MINUTE = 60_000;

export type CronSecretFindingLevel = 'fail' | 'warn' | 'info';

/** 所見の題と対処 (固定の文。実行時の値は埋め込まない) */
export interface CronSecretFindingText {
  readonly level: CronSecretFindingLevel;
  readonly title: string;
  readonly action: string;
}

/**
 * 所見の表 (設計 §8.1.1)。id は固定の名前 (ログと応答にはこの id だけを出す)。title は何が起きているか、action はどうするか (ENV_SETUP.md の節の名前で案内する)。
 * fail = pg_cron からの呼び出しが止まる / 確かめられない。warn = いまは通るが片づける。info = 知っておくだけ (メールは送らない)
 */
export const CRON_SECRET_FINDING_CATALOG = {
  'edge-vault-mismatch': { level: 'fail', title: 'Edge Function secrets の CRON_SECRET と Vault の app_cron_secret が食い違っています (確認の呼び出しが HTTP 401)',
    action: 'pg_cron からの Edge Function の呼び出しが 401 で止まっています。Vault の app_cron_secret を正として、Edge Function secrets の CRON_SECRET をそれに合わせてください (ENV_SETUP.md「値のずれの確かめ方」「Edge Function secrets の設定手順」)。入れ替えが目的のときだけ「ローテーション手順」に従います' },
  'edge-not-configured': { level: 'fail', title: 'Edge Function secrets に現行の値 (CRON_SECRET。別名 SERVICE_ROLE_SECRET) がありません (確認の呼び出しが HTTP 503)',
    action: 'Edge Function は Service not configured を返し、pg_cron からの呼び出しがすべて止まります。Vault の app_cron_secret と同じ値を CRON_SECRET に入れてください (ENV_SETUP.md「Edge Function secrets の設定手順」)' },
  'vault-missing': { level: 'fail', title: 'Vault に app_cron_secret がありません',
    action: 'pg_cron の関数 (invoke_calculate_segment_stats など) が例外で止まります。ENV_SETUP.md「Catalog cron secret (Supabase Vault)」の手順で作り、Edge Function secrets の CRON_SECRET と同じ値にしてください' },
  'vault-empty': { level: 'fail', title: 'Vault の app_cron_secret が空の値です',
    action: 'Edge Function secrets の CRON_SECRET と同じ値を入れてください (ENV_SETUP.md「ローテーション手順」の 3 の SQL)' },
  'vault-unreadable': { level: 'fail', title: 'Vault の app_cron_secret を復号できません',
    action: 'Vault の鍵の問題です。Supabase のサポートに相談し、必要なら app_cron_secret を作り直してください (ENV_SETUP.md「ローテーション手順」)' },
  'vault-unavailable': { level: 'fail', title: 'この DB に Vault (vault.decrypted_secrets) がありません',
    action: '本番では起きません。ローカル・CI の DB なら想定どおりです' },
  'pg-net-unavailable': { level: 'fail', title: 'この DB に pg_net (net._http_response) がありません',
    action: '本番では起きません。ローカル・CI の DB なら想定どおりです' },
  'gateway-jwt': { level: 'fail', title: 'Supabase のゲートウェイの JWT 検証で止まっています (HTTP 401 に code がある)',
    action: 'supabase/config.toml の [functions.cron-secret-probe] verify_jwt = false がデプロイされていません。GitHub Actions「Deploy Supabase Functions」が成功しているかを確かめ、必要なら手動で実行してください (ENV_SETUP.md「値が合っていないとどうなるか」)' },
  'probe-not-deployed': { level: 'fail', title: '確認の Edge Function (cron-secret-probe) が見つかりません (HTTP 404)',
    action: 'デプロイされていません。GitHub Actions「Deploy Supabase Functions」を確かめてください' },
  'probe-timeout': { level: 'fail', title: '確認の Edge Function が時間内に応答しませんでした',
    action: 'Supabase の Edge Functions の状態を確かめてください。続くなら Supabase Dashboard の Edge Functions → cron-secret-probe → Logs を見てください' },
  'probe-error': { level: 'fail', title: 'pg_net が確認の要求を送れませんでした (接続のエラー)',
    action: 'Supabase の状態 (ネットワーク・Edge Functions) を確かめてください。pg_cron からの呼び出しも同じく届いていません' },
  'probe-unanswered': { level: 'fail', title: 'pg_net が確認の要求を送っていません (応答が記録されない)',
    action: 'pg_net の worker が止まっている可能性があります。SQL エディタで net.http_request_queue に残っている要求と net._http_response を確かめてください (ENV_SETUP.md「値が合っていないとどうなるか」)。pg_cron からの呼び出しも同じく届いていません' },
  'probe-unexpected-response': { level: 'fail', title: '確認の Edge Function の応答が想定外です',
    action: '呼び先が差し替わった・Supabase 側の障害などが考えられます。Supabase Dashboard の Edge Functions → cron-secret-probe → Logs と、ENV_SETUP.md「値が合っていないとどうなるか」の SQL で応答を確かめてください' },
  'edge-previous-in-use': { level: 'warn', title: 'Vault の app_cron_secret は、Edge Function secrets の旧い値 (CRON_SECRET_PREVIOUS) と一致しています (入れ替えの途中)',
    action: 'いまは通ります。Vault の app_cron_secret を新しい値に更新してください (ENV_SETUP.md「ローテーション手順」の 3)' },
  'edge-previous-leftover': { level: 'warn', title: 'Edge Function secrets に CRON_SECRET_PREVIOUS が残っています (Vault はもう新しい値)',
    action: '外すまでは旧い値でも通ります。旧い値で認証された記録 (この確認の分を除く) が Edge Function のログに無いことを確かめて、CRON_SECRET_PREVIOUS を削除してください (ENV_SETUP.md「ローテーション手順」の 5)' },
  'vault-holds-service-role-key': { level: 'warn', title: 'Vault の app_cron_secret が service role key と同じ値です',
    action: 'service role key は DB を全権で操作できる鍵です。cron 専用のランダムな値に入れ替えてください (ENV_SETUP.md「ローテーション手順」)' },
  'vercel-previous-same': { level: 'warn', title: 'Vercel の CRON_SECRET_PREVIOUS が現行の CRON_SECRET と同じです',
    action: '入れ替えの意味がありません。旧い値を入れるか、削除して再デプロイしてください (ENV_SETUP.md「Vercel の CRON_SECRET を入れ替えるとき」)' },
  'vercel-previous-set': { level: 'warn', title: 'Vercel に CRON_SECRET_PREVIOUS があります (入れ替えの途中、または消し忘れ)',
    action: 'あるあいだは旧い値でも cron の API を呼べます。入れ替えが終わったら削除して再デプロイしてください (ENV_SETUP.md「Vercel の CRON_SECRET を入れ替えるとき」)' },
  'edge-alias-used': { level: 'info', title: 'Edge Function secrets に CRON_SECRET が無く、別名の SERVICE_ROLE_SECRET が使われています',
    action: 'CRON_SECRET に移すと分かりやすくなります' },
  'no-probe-yet': { level: 'info', title: '確認をまだ送っていません (最初の回)',
    action: 'この回で送り、次の回 (15 分後) に結果を見ます' },
  'probe-pending': { level: 'info', title: '確認の応答を待っています',
    action: '次の回に結果を見ます' },
} as const satisfies Readonly<Record<string, CronSecretFindingText>>;

export type CronSecretFindingId = keyof typeof CRON_SECRET_FINDING_CATALOG;

export interface CronSecretFinding extends CronSecretFindingText {
  readonly id: CronSecretFindingId;
}

/** 表から所見を 1 つ作る */
export function cronSecretFinding(id: CronSecretFindingId): CronSecretFinding {
  const text: CronSecretFindingText = CRON_SECRET_FINDING_CATALOG[id];
  return { id, level: text.level, title: text.title, action: text.action };
}

/** 送れなかった確認 (send_state ≠ sent) の所見 */
const SEND_STATE_FINDING: Readonly<Record<Exclude<CronSecretProbeSendState, 'sent'>, CronSecretFindingId>> = {
  vault_missing: 'vault-missing',
  vault_empty: 'vault-empty',
  vault_unreadable: 'vault-unreadable',
  vault_unavailable: 'vault-unavailable',
  net_unavailable: 'pg-net-unavailable',
};

/** cron_secret_probe_results (DB の関数) が返す 1 行 */
export interface CronSecretProbeResultRow {
  readonly probe_id: number;
  /** 確認を送った時刻 (ISO 8601) */
  readonly requested_at: string;
  readonly send_state: CronSecretProbeSendState;
  /** pg_net の応答が記録されているか */
  readonly answered: boolean;
  readonly http_status: number | null;
  readonly timed_out: boolean | null;
  readonly has_error: boolean | null;
  /** 200 の本文の matched (想定は CRON_SECRET_PROBE_MATCHES。それ以外の文字列も来うる) */
  readonly matched: string | null;
  readonly previous_configured: boolean | null;
  readonly alias_used: boolean | null;
  /** 401 / 503 の本文の error (requireServiceRole のもの) */
  readonly body_error: string | null;
  /** ゲートウェイの 401 / 404 の本文の code */
  readonly body_code: string | null;
}

/** send_cron_secret_probe (DB の関数) が返す 1 行 */
export interface CronSecretProbeSendRow {
  readonly probe_id: number;
  readonly send_state: CronSecretProbeSendState;
  readonly request_id: number | null;
}

function isSendState(value: unknown): value is CronSecretProbeSendState {
  return typeof value === 'string' && (CRON_SECRET_PROBE_SEND_STATES as readonly string[]).includes(value);
}

/** 0 以上の整数 (PostgREST は bigint を数値で返すが、設定によっては文字列で来る) */
function toNonNegativeInteger(value: unknown, field: string, rpcName: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${rpcName} の応答の ${field} が 0 以上の整数ではありません`);
  }
  return n;
}

function toOptionalInteger(value: unknown, field: string, rpcName: string): number | null {
  return value === null || value === undefined ? null : toNonNegativeInteger(value, field, rpcName);
}

function toOptionalBoolean(value: unknown, field: string, rpcName: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error(`${rpcName} の応答の ${field} が真偽値ではありません`);
  return value;
}

function toOptionalString(value: unknown, field: string, rpcName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${rpcName} の応答の ${field} が文字列ではありません`);
  return value;
}

/**
 * cron_secret_probe_results の応答 (配列) を検証して型付きにする。形が想定と違うときは例外にする
 * (黙って「所見なし」と扱うと、検知が静かに止まる)
 */
export function parseCronSecretProbeRows(data: unknown, rpcName: string = CRON_SECRET_PROBE_RESULTS_RPC): CronSecretProbeResultRow[] {
  if (!Array.isArray(data)) throw new Error(`${rpcName} の応答が配列ではありません`);
  return data.map((row): CronSecretProbeResultRow => {
    if (row === null || typeof row !== 'object') throw new Error(`${rpcName} の応答の行がオブジェクトではありません`);
    const r = row as Record<string, unknown>;
    if (typeof r.requested_at !== 'string' || Number.isNaN(Date.parse(r.requested_at))) {
      throw new Error(`${rpcName} の応答の requested_at が日時ではありません`);
    }
    if (!isSendState(r.send_state)) throw new Error(`${rpcName} の応答の send_state が想定外です`);
    if (typeof r.answered !== 'boolean') throw new Error(`${rpcName} の応答の answered が真偽値ではありません`);
    return {
      probe_id: toNonNegativeInteger(r.probe_id, 'probe_id', rpcName),
      requested_at: r.requested_at,
      send_state: r.send_state,
      answered: r.answered,
      http_status: toOptionalInteger(r.http_status, 'http_status', rpcName),
      timed_out: toOptionalBoolean(r.timed_out, 'timed_out', rpcName),
      has_error: toOptionalBoolean(r.has_error, 'has_error', rpcName),
      matched: toOptionalString(r.matched, 'matched', rpcName),
      previous_configured: toOptionalBoolean(r.previous_configured, 'previous_configured', rpcName),
      alias_used: toOptionalBoolean(r.alias_used, 'alias_used', rpcName),
      body_error: toOptionalString(r.body_error, 'body_error', rpcName),
      body_code: toOptionalString(r.body_code, 'body_code', rpcName),
    };
  });
}

/** send_cron_secret_probe の応答 (RETURNS TABLE なので配列 1 行) を検証して型付きにする */
export function parseCronSecretProbeSendResult(data: unknown, rpcName: string = CRON_SECRET_PROBE_SEND_RPC): CronSecretProbeSendRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (row === null || row === undefined || typeof row !== 'object') throw new Error(`${rpcName} の応答が行ではありません`);
  const r = row as Record<string, unknown>;
  if (!isSendState(r.send_state)) throw new Error(`${rpcName} の応答の send_state が想定外です`);
  const requestId = toOptionalInteger(r.request_id, 'request_id', rpcName);
  if (r.send_state === 'sent' && requestId === null) throw new Error(`${rpcName} の応答に request_id がありません`);
  return { probe_id: toNonNegativeInteger(r.probe_id, 'probe_id', rpcName), send_state: r.send_state, request_id: requestId };
}

/** 確認が「決まっている」か: 送れなかった・応答がある・応答が無いまま猶予を過ぎた */
export function isDecidedProbe(row: CronSecretProbeResultRow, now: Date, graceMinutes: number = CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES): boolean {
  if (row.send_state !== 'sent') return true;
  if (row.answered) return true;
  return now.getTime() - Date.parse(row.requested_at) > graceMinutes * MS_PER_MINUTE;
}

/** 見る範囲の中で最新の「決まった確認」(行は新しい順に並んでいる前提だが、ここでも requested_at で並べ直す) */
export function selectDecidedProbe(
  rows: readonly CronSecretProbeResultRow[],
  now: Date,
  graceMinutes: number = CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES,
): CronSecretProbeResultRow | null {
  const sorted = [...rows].sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at) || b.probe_id - a.probe_id);
  return sorted.find((row) => isDecidedProbe(row, now, graceMinutes)) ?? null;
}

/** 応答のある確認 (answered = true) の所見 */
function judgeAnsweredProbe(row: CronSecretProbeResultRow): CronSecretFinding[] {
  if (row.timed_out === true) return [cronSecretFinding('probe-timeout')];
  if (row.has_error === true || row.http_status === null) return [cronSecretFinding('probe-error')];
  if (row.http_status === HTTP_OK) {
    const findings: CronSecretFinding[] = [];
    if (row.matched === 'current') {
      if (row.previous_configured === true) findings.push(cronSecretFinding('edge-previous-leftover'));
    } else if (row.matched === 'previous') {
      findings.push(cronSecretFinding('edge-previous-in-use'));
    } else if (row.matched === 'service_role_key') {
      findings.push(cronSecretFinding('vault-holds-service-role-key'));
    } else {
      return [cronSecretFinding('probe-unexpected-response')];
    }
    if (row.alias_used === true) findings.push(cronSecretFinding('edge-alias-used'));
    return findings;
  }
  if (row.http_status === HTTP_UNAUTHORIZED) {
    if (row.body_code !== null) return [cronSecretFinding('gateway-jwt')];
    if (row.body_error === EDGE_UNAUTHORIZED_BODY_ERROR) return [cronSecretFinding('edge-vault-mismatch')];
    return [cronSecretFinding('probe-unexpected-response')];
  }
  if (row.http_status === HTTP_SERVICE_UNAVAILABLE) {
    if (row.body_error === EDGE_NOT_CONFIGURED_BODY_ERROR) return [cronSecretFinding('edge-not-configured')];
    return [cronSecretFinding('probe-unexpected-response')];
  }
  if (row.http_status === HTTP_NOT_FOUND) return [cronSecretFinding('probe-not-deployed')];
  return [cronSecretFinding('probe-unexpected-response')];
}

/** 決まった確認 1 つの所見 */
export function judgeProbeRow(row: CronSecretProbeResultRow): CronSecretFinding[] {
  if (row.send_state !== 'sent') return [cronSecretFinding(SEND_STATE_FINDING[row.send_state])];
  if (!row.answered) return [cronSecretFinding('probe-unanswered')];
  return judgeAnsweredProbe(row);
}

export interface CronSecretProbeJudgement {
  /** 判定に使った確認 (無ければ null) */
  readonly decided: CronSecretProbeResultRow | null;
  readonly findings: readonly CronSecretFinding[];
}

/** 見る範囲の確認の結果から、最新の決まった確認を選んで判定する。確認が無ければ no-probe-yet、決まった確認が無ければ probe-pending (どちらも info) */
export function judgeCronSecretProbe(
  rows: readonly CronSecretProbeResultRow[],
  now: Date,
  graceMinutes: number = CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES,
): CronSecretProbeJudgement {
  if (rows.length === 0) return { decided: null, findings: [cronSecretFinding('no-probe-yet')] };
  const decided = selectDecidedProbe(rows, now, graceMinutes);
  if (decided === null) return { decided: null, findings: [cronSecretFinding('probe-pending')] };
  return { decided, findings: judgeProbeRow(decided) };
}

/** Vercel 側 (src/lib/cron-auth.ts の describeCronSecretRotationState) の状態。値は含まない */
export interface CronSecretRotationState {
  readonly previous_configured: boolean;
  readonly previous_same_as_current: boolean;
}

/** Vercel の CRON_SECRET_PREVIOUS の所見 (Supabase 側との一致は比べない: 設計 §0.4 Q-1) */
export function judgeVercelRotation(state: CronSecretRotationState): CronSecretFinding[] {
  if (!state.previous_configured) return [];
  if (state.previous_same_as_current) return [cronSecretFinding('vercel-previous-same')];
  return [cronSecretFinding('vercel-previous-set')];
}

export interface CronSecretFindingPartition {
  readonly fails: readonly CronSecretFinding[];
  readonly warns: readonly CronSecretFinding[];
  readonly infos: readonly CronSecretFinding[];
}

/** 所見を level で分ける (順は保つ) */
export function partitionCronSecretFindings(findings: readonly CronSecretFinding[]): CronSecretFindingPartition {
  return {
    fails: findings.filter((f) => f.level === 'fail'),
    warns: findings.filter((f) => f.level === 'warn'),
    infos: findings.filter((f) => f.level === 'info'),
  };
}

/** ログと応答に出す形 (id だけ) */
export function cronSecretFindingIds(findings: readonly CronSecretFinding[]): CronSecretFindingId[] {
  return findings.map((f) => f.id);
}

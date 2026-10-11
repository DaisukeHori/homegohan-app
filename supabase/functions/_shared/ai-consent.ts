/**
 * 外国の AI 事業者への提供の同意: 判定の本体 - Next.js (API Routes / Edge Runtime) / Supabase Edge Functions 共用 (T15 / #1154)
 *
 * 利用者のデータを外国の AI 事業者へ送る処理は、送る手前でかならず runAiConsentCheck() を通し、
 * allowed: false なら送らない。判定はこのファイルの 1 か所だけで行う
 * (Next.js 側は src/lib/ai/consent-guard.ts、Edge Functions 側は _shared/ai-consent-guard.ts が、ここを呼んで応答を作る)。
 *
 * 判定の規則:
 *   - external_data_consents の有効な行 (revoked_at IS NULL) を本人の user_id で読む。
 *   - AI_CONSENT_PROVIDERS のすべての事業者について、consented = true かつ policy_version = AI_CONSENT_VERSION の行があれば許可。
 *     1 社でも欠けていれば (一度も同意していない・撤回した・古い版の文面に同意した) 不許可 (not_consented)。
 *   - 読み取りに失敗した / 応答の形が想定と違う / userId が空 / 例外が出た場合も不許可 (check_failed)。送らない (fail-closed)。
 *
 * このファイルが守る制約 (崩すと Edge Functions か Next.js のどちらかが動かなくなる):
 *   - 純粋な TypeScript。import なし、Deno / Node 固有の API なし (log-sanitizer.ts / cron-secret.ts と同じ前例)。
 *     ブラウザのコード (同意画面) も src/lib/ai/consent-config.ts 経由でここの定数と型を読む。
 *   - DB を読むクエリは呼び出し側が渡す (Node と Deno で Supabase のクライアントの型が違うため)。読む表・列・条件は
 *     AI_CONSENT_TABLE / AI_CONSENT_DECISION_COLUMNS と runAiConsentCheck のコメントのとおりで、両側の部品が同じ形で書く。
 */

/**
 * 同意を取る外国の AI 事業者 (external_data_consents.provider の値)。
 * 利用者のデータを実際に送っている事業者を、コードの送信先から列挙したもの (2026-10 時点):
 *   - xai       : api.x.ai (src/lib/ai/fast-llm.ts, _shared/fast-llm.ts, _shared/v4-fast-llm.ts, _shared/nutrition-calculator.ts)
 *   - google    : generativelanguage.googleapis.com / @google/genai (src/lib/ai/gemini-json.ts, _shared/gemini-json.ts,
 *                 src/app/api/ai/image/generate, process-meal-image-jobs)
 *   - openai    : api.openai.com (src/app/api/ai/nutrition/feedback, _shared/v4-fast-llm.ts)
 *   - perplexity: api.perplexity.ai (_shared/perplexity-nutrition.ts。食事の写真の解析の栄養推定)
 *   - aimlapi   : api.aimlapi.com (shared/dataset-embedding.mjs。文章の検索用の数値化。AI 相談・献立の作成で使う)
 * 送り先を足したら、ここと DB の CHECK (external_data_consents_provider_check) と同意画面の表示内容に足し、
 * AI_CONSENT_VERSION を上げる (tests/ai-consent-provider-inventory.test.ts が送信先との食い違いを検査する)。
 */
export const AI_CONSENT_PROVIDERS = ['xai', 'google', 'openai', 'perplexity', 'aimlapi'] as const;

export type AiConsentProvider = (typeof AI_CONSENT_PROVIDERS)[number];

/**
 * 同意の文面の版。文面 (src/lib/ai/consent-config.ts の AI_CONSENT_COPY) や事業者の一覧を変えたら、必ずこの値も変える。
 * 版を変えると、古い版に同意した人は「未同意」に戻り、AI 機能を使う前にもう一度同意画面が出る。
 * 'draft-' で始まる版は、弁護士の確認前の仮の文面への同意であることを表す。
 */
export const AI_CONSENT_VERSION = 'draft-2026-10-10';

/** 同意を記録するテーブル */
export const AI_CONSENT_TABLE = 'external_data_consents';

/** 判定に読む列 */
export const AI_CONSENT_DECISION_COLUMNS = 'provider, consented, policy_version';

/** 未同意で止めたときのエラーコード。画面はこのコードを見て同意画面へ案内する */
export const AI_CONSENT_REQUIRED_CODE = 'AI_CONSENT_REQUIRED';
/** 未同意で止めたときの HTTP ステータス (403 Forbidden: 本人だが、この操作の前提 (同意) を満たしていない) */
export const AI_CONSENT_REQUIRED_STATUS = 403;
/** 未同意で止めたときの本文 (#1172: 変数名・内部の詳細を出さない) */
export const AI_CONSENT_REQUIRED_MESSAGE =
  'AI 機能を使うには、日本国外の AI 事業者へのデータ提供への同意が必要です。同意の画面から内容をご確認ください。';

/** 同意の状況を読めなかったとき (送らずに止めた) のエラーコード */
export const AI_CONSENT_CHECK_FAILED_CODE = 'AI_CONSENT_CHECK_FAILED';
/** 同意の状況を読めなかったときの HTTP ステータス (503 Service Unavailable: 時間をおけば通る見込みがある) */
export const AI_CONSENT_CHECK_FAILED_STATUS = 503;
/** 同意の状況を読めなかったときの本文 (#1172: DB のエラー文は出さない) */
export const AI_CONSENT_CHECK_FAILED_MESSAGE =
  'AI 機能を一時的に使えません。時間をおいて再度お試しください。';

/**
 * 事業者ごとの状態 (GET /api/ai/consent の応答の形)。
 *   - granted : 現行の版 (AI_CONSENT_VERSION) に同意している
 *   - outdated: 古い版 (または版を記録する前) に同意している。もう一度同意が要る
 *   - none    : 有効な同意が無い (一度も同意していない / 撤回した)
 */
export type AiConsentProviderState = 'granted' | 'outdated' | 'none';

export interface AiConsentProviderStatus {
  provider: AiConsentProvider;
  state: AiConsentProviderState;
  /** 有効な同意の日時 (state が granted / outdated のとき) */
  consentedAt: string | null;
  /** 有効な同意の版 (state が granted / outdated のとき。版を記録する前の行は null) */
  policyVersion: string | null;
  /** 直近の撤回 (または新しい版への置き換え) の日時 (state が none のとき) */
  revokedAt: string | null;
}

export interface AiConsentStatus {
  /** 現行の文面の版 */
  version: string;
  /** すべての事業者について、現行の版に同意している (= AI 機能を使える) */
  consented: boolean;
  providers: AiConsentProviderStatus[];
  /** 同意の日時 (consented のとき。事業者のうち最も新しいもの) */
  consentedAt: string | null;
  /** 直近の撤回の日時 (有効な同意が 1 つも無いとき) */
  revokedAt: string | null;
}

/** external_data_consents の行のうち、状況の判定に使う列 */
export interface AiConsentRow {
  id?: string;
  provider: string;
  consented: boolean;
  consented_at?: string | null;
  revoked_at?: string | null;
  policy_version: string | null;
}

function toTime(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function latest(values: Array<string | null>): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value && (best === null || toTime(value) > toTime(best))) best = value;
  }
  return best;
}

/** 行の一覧から、同意の状況を求める (DB には触れない) */
export function summarizeAiConsent(
  rows: readonly AiConsentRow[],
  version: string = AI_CONSENT_VERSION,
): AiConsentStatus {
  const providers: AiConsentProviderStatus[] = AI_CONSENT_PROVIDERS.map((provider) => {
    const mine = rows.filter((row) => row.provider === provider);
    // 拒否の行 (consented = false) は同意として数えない。revoked_at を読まなかった行 (undefined) は有効な行として扱う
    const active = mine.find((row) => (row.revoked_at ?? null) === null && row.consented === true);
    if (active) {
      return {
        provider,
        state: active.policy_version === version ? 'granted' : 'outdated',
        consentedAt: active.consented_at ?? null,
        policyVersion: active.policy_version ?? null,
        revokedAt: null,
      };
    }
    return {
      provider,
      state: 'none',
      consentedAt: null,
      policyVersion: null,
      revokedAt: latest(mine.map((row) => row.revoked_at ?? null)),
    };
  });

  const consented = providers.every((p) => p.state === 'granted');
  return {
    version,
    consented,
    providers,
    consentedAt: consented ? latest(providers.map((p) => p.consentedAt)) : null,
    revokedAt: providers.some((p) => p.state !== 'none') ? null : latest(providers.map((p) => p.revokedAt)),
  };
}

/** 判定の結果 */
export type AiConsentDecision =
  | { allowed: true }
  | { allowed: false; reason: 'not_consented' | 'check_failed' };

/** Supabase のクエリの結果のうち、判定に使う部分 */
export interface AiConsentQueryResult {
  data: unknown;
  error: unknown;
}

function isDecisionRow(value: unknown): value is AiConsentRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.provider === 'string' &&
    typeof row.consented === 'boolean' &&
    (row.policy_version === null || typeof row.policy_version === 'string')
  );
}

/**
 * 有効な行 (revoked_at IS NULL) を読んだ結果から判定する。
 * エラーがある / data が配列でない / 行の形が違う場合は check_failed (送らない)。
 */
export function decideAiConsent(result: AiConsentQueryResult, version: string = AI_CONSENT_VERSION): AiConsentDecision {
  if (result.error) return { allowed: false, reason: 'check_failed' };
  if (!Array.isArray(result.data)) return { allowed: false, reason: 'check_failed' };
  const rows: AiConsentRow[] = [];
  for (const value of result.data) {
    if (!isDecisionRow(value)) return { allowed: false, reason: 'check_failed' };
    rows.push(value);
  }
  return summarizeAiConsent(rows, version).consented
    ? { allowed: true }
    : { allowed: false, reason: 'not_consented' };
}

/**
 * 利用者のデータを AI 事業者へ送ってよいかを判定する (送る経路はすべてこれを通す)。
 * read は、有効な行 (revoked_at IS NULL) を本人の user_id で読むクエリ
 * (AI_CONSENT_TABLE から AI_CONSENT_DECISION_COLUMNS を .eq('user_id', userId).is('revoked_at', null) で読む)。
 * userId は、認証で確定した本人の ID (または cron / キューの行の user_id) を渡す。
 * 例外は投げない。失敗はすべて { allowed: false, reason: 'check_failed' } にする (fail-closed)。
 */
export async function runAiConsentCheck(
  userId: string | null | undefined,
  read: (userId: string) => PromiseLike<AiConsentQueryResult>,
): Promise<AiConsentDecision> {
  if (typeof userId !== 'string' || userId.trim() === '') return { allowed: false, reason: 'check_failed' };
  try {
    return decideAiConsent(await read(userId));
  } catch {
    return { allowed: false, reason: 'check_failed' };
  }
}

/** 止めたときの応答の中身 (HTTP ステータスと本文)。応答を作るのは呼び出し側 (NextResponse / Response) */
export function aiConsentDeniedPayload(
  decision: Extract<AiConsentDecision, { allowed: false }>,
): { status: number; body: { error: string; code: string } } {
  if (decision.reason === 'not_consented') {
    return {
      status: AI_CONSENT_REQUIRED_STATUS,
      body: { error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE },
    };
  }
  return {
    status: AI_CONSENT_CHECK_FAILED_STATUS,
    body: { error: AI_CONSENT_CHECK_FAILED_MESSAGE, code: AI_CONSENT_CHECK_FAILED_CODE },
  };
}

/**
 * 非同期の処理 (キューの献立生成・献立生成の続きの工程・買い物リストの作り直し) が、同意の判定で止めたときに
 * リクエストの行の失敗の欄 (weekly_menu_requests.error_message / shopping_list_requests.result.error) に書く文。
 * 画面はこの欄をそのまま表示する (Web とアプリの週の献立の画面・買い物リストなど) ので、
 * コード (AI_CONSENT_REQUIRED) ではなく、応答の本文と同じ人向けの文を書く (#1172: 内部の詳細を出さない)。
 * 画面は aiConsentReasonOfStoredError でこの文を見分け、同意が必要なら同意画面へ案内する。
 */
export function aiConsentDeniedStoredMessage(decision: Extract<AiConsentDecision, { allowed: false }>): string {
  return aiConsentDeniedPayload(decision).body.error;
}

/**
 * リクエストの行に保存された失敗の文 (aiConsentDeniedStoredMessage が書いたもの) が、同意の判定で止めたものか。
 *   - consent_required: 同意が無くて止めた。画面は同意画面へ案内し、自分のエラー表示は出さない
 *   - check_failed    : 同意の状況を読めなくて止めた。保存された文 (一時的に使えません) は人向けなので、そのまま出してよい
 *   - null            : それ以外の失敗
 */
export function aiConsentReasonOfStoredError(stored: unknown): AiSkippedReason | null {
  if (stored === AI_CONSENT_REQUIRED_MESSAGE) return 'consent_required';
  if (stored === AI_CONSENT_CHECK_FAILED_MESSAGE) return 'check_failed';
  return null;
}

/**
 * 応答 (状態コードと本文) が、同意の判定で止めたとき (aiConsentDeniedPayload の 403 AI_CONSENT_REQUIRED /
 * 503 AI_CONSENT_CHECK_FAILED) のものなら、リクエストの行に書く文 (aiConsentDeniedStoredMessage と同じ) を返す。それ以外は null。
 * 献立生成の Edge Function を呼ぶ側 (Next.js の API Route・続きの工程を呼ぶ Edge Function) が、呼んだ先に止められたかを
 * 見分けるのに使う (呼んだ先はリクエストの行をもう失敗にし、この文を書いている。呼ぶ側は再試行せず、内部の文で上書きしない)。
 */
export function aiConsentDeniedStoredMessageOfResponse(status: number | null | undefined, bodyText: unknown): string | null {
  if (typeof bodyText !== 'string' || bodyText === '') return null;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const code = (body as { code?: unknown }).code;
  if (status === AI_CONSENT_REQUIRED_STATUS && code === AI_CONSENT_REQUIRED_CODE) return AI_CONSENT_REQUIRED_MESSAGE;
  if (status === AI_CONSENT_CHECK_FAILED_STATUS && code === AI_CONSENT_CHECK_FAILED_CODE) return AI_CONSENT_CHECK_FAILED_MESSAGE;
  return null;
}

/**
 * AI を使わない部分も返す API (例: 栄養の集計 + AI のアドバイス) が、AI の部分だけを省いたときに応答へ足す欄。
 * 画面は aiSkipped を見て「AI のコメントは同意が必要」などと出し分ける。送ってよい (allowed) なら何も足さない。
 */
export function aiConsentSkippedField(decision: AiConsentDecision | null): { aiSkipped?: string } {
  if (!decision || decision.allowed) return {};
  return { aiSkipped: aiConsentDeniedPayload(decision).body.code };
}

/**
 * AI の利用回数の上限 (#1149) に達して AI の部分を省いたときの aiSkipped の値。
 * _shared/ai-usage-core.ts の AI_DAILY_LIMIT_CODE と同じ値 (このファイルは import を持たないので、ここにも置く。
 * tests/ai-daily-limit-core.test.ts が一致を確かめる)
 */
export const AI_SKIPPED_DAILY_LIMIT_CODE = 'AI_DAILY_LIMIT';

/**
 * 応答の aiSkipped (aiConsentSkippedField / aiDailyLimitSkippedField が足す欄) を、画面の出し分けの理由に直す (Web・モバイル共用)。
 *   - consent_required: 同意が無いので AI の部分を省いた。画面は同意の画面へ案内する
 *   - check_failed    : 同意の状況を読めなかったので AI の部分を省いた。画面は「一時的に」と出す
 *   - daily_limit     : 今日の AI の利用回数の上限 (#1149) に達したので AI の部分を省いた。画面は「明日 0 時から」と出す
 *   - null            : 省いていない (aiSkipped が無い・知らない値)
 */
export type AiSkippedReason = 'consent_required' | 'check_failed' | 'daily_limit';

export function aiSkippedReasonOf(body: unknown): AiSkippedReason | null {
  if (!body || typeof body !== 'object') return null;
  const skipped = (body as { aiSkipped?: unknown }).aiSkipped;
  if (skipped === AI_CONSENT_REQUIRED_CODE) return 'consent_required';
  if (skipped === AI_CONSENT_CHECK_FAILED_CODE) return 'check_failed';
  if (skipped === AI_SKIPPED_DAILY_LIMIT_CODE) return 'daily_limit';
  return null;
}

/**
 * 同意の確認・撤回の画面の名前。Web の設定 (/settings) とアプリの設定タブの項目の名前で、
 * 下の案内の一文が「設定の「…」から」と指す先 (tests/ai-consent-settings-entry.test.ts が、両方の設定に項目があることを検査する)。
 */
export const AI_CONSENT_SETTINGS_ENTRY_TITLE = 'AI へのデータ提供の同意';

/** 画面を開くと自動で作る AI のコメントを、同意が無くて作らなかったときに出す一文 (同意画面は出さない) */
export const AI_CONSENT_AUTOMATIC_LOCKED_NOTE =
  `AI のコメントは、AI へのデータ提供に同意すると表示されます（設定の「${AI_CONSENT_SETTINGS_ENTRY_TITLE}」から同意できます）。`;

/** 記録の保存と AI の分析を一緒にする画面 (健康診断・血液検査) で、同意が無くて AI の分析を省いたときに出す一文 */
export const AI_CONSENT_SKIPPED_NOTE =
  `記録は保存しました。AI の分析は、AI へのデータ提供に同意すると行えます（設定の「${AI_CONSENT_SETTINGS_ENTRY_TITLE}」から同意できます）。`;

/** 同上で、同意の状況を読めなくて AI の分析を省いたときに出す一文 */
export const AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE =
  '記録は保存しました。AI の分析は一時的に行えませんでした。時間をおいて再度お試しください。';

/** AI 相談を閉じたとき、同意が無くて要約 (AI) を省いたことを相談の画面に出す一文 */
export const AI_CONSENT_SUMMARY_SKIPPED_NOTE =
  `相談を終了しました。要約は、AI へのデータ提供に同意すると作られます（設定の「${AI_CONSENT_SETTINGS_ENTRY_TITLE}」から同意できます）。`;

/** 同上で、同意の状況を読めなくて要約を省いたときの一文 */
export const AI_CONSENT_SUMMARY_CHECK_FAILED_NOTE = '相談を終了しました。要約は一時的に作れませんでした。';

/** 記録の保存と AI の分析を一緒にする画面で、AI の利用回数の上限 (#1149) に達して AI の分析を省いたときに出す一文 */
export const AI_DAILY_LIMIT_SKIPPED_NOTE =
  '記録は保存しました。今日の AI の利用回数の上限に達したため、AI の分析は行いませんでした。明日 0 時から使えます。';

/** 画面を開くと自動で作る AI のコメントを、上限に達して作らなかったときに出す一文 */
export const AI_DAILY_LIMIT_AUTOMATIC_NOTE = '今日の AI の利用回数の上限に達しました。AI のコメントは明日 0 時から表示されます。';

/** AI 相談を閉じたとき、上限に達して要約を省いたことを相談の画面に出す一文 */
export const AI_DAILY_LIMIT_SUMMARY_SKIPPED_NOTE =
  '相談を終了しました。今日の AI の利用回数の上限に達したため、要約は作りませんでした。明日 0 時から使えます。';

/** AI 相談を閉じた応答の aiSkipped から、相談の画面に出す一文を選ぶ (省いていなければ null) */
export function aiSummarySkippedNote(body: unknown): string | null {
  const reason = aiSkippedReasonOf(body);
  if (reason === 'consent_required') return AI_CONSENT_SUMMARY_SKIPPED_NOTE;
  if (reason === 'check_failed') return AI_CONSENT_SUMMARY_CHECK_FAILED_NOTE;
  if (reason === 'daily_limit') return AI_DAILY_LIMIT_SUMMARY_SKIPPED_NOTE;
  return null;
}

/** 応答の本文が「未同意で止めた」ことを表すか (画面・モバイルの判定用) */
export function isAiConsentRequiredBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const { code, error } = body as { code?: unknown; error?: unknown };
  if (code === AI_CONSENT_REQUIRED_CODE) return true;
  // { error: { code } } の形 (運営 API などの入れ子の形) も受け付ける
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === AI_CONSENT_REQUIRED_CODE);
}

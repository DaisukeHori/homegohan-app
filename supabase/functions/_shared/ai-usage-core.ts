/**
 * AI 利用回数の記録 (#1177 / T26) と 1 日の上限 (#1149 / T40) の共通部分 - Next.js API Routes / Supabase Edge Functions / モバイル共用
 *
 * 使うのは次の 3 か所で、どれもこのファイルの定義を読む (分かれて食い違わないようにするため)。
 *  - Next.js:        src/lib/plan/entitlements.ts (API ルートが consumeAiUsage を呼ぶ)
 *  - Edge Functions: supabase/functions/_shared/ai-usage.ts (ユーザーの JWT で直接呼ばれたときに consumeEdgeAiUsage で数える)
 *  - 画面:           Web (src/lib/ai/daily-limit-client.ts) とモバイル (apps/mobile/src/lib/ai-daily-limit.ts) は _shared/ai-daily-limit.ts を読む
 *
 * ここにあるのは次のもの。
 *  1. 記録する機能の一覧 (AI_FEATURES) と、上限に数えない機能 (AI_UNMETERED_FEATURES)。DB の ai_usage_counters.feature に入る名前
 *  2. DB 関数 (consume_ai_usage / refund_ai_usage) の応答を待つ上限 (AI_USAGE_TIMEOUT_MS)
 *  3. 「Next.js が記録済み」であることを示す署名つきの印 (signAiUsageRecorded / verifyAiUsageRecorded)
 *  4. 上限に数えない機能の安全弁の既定の回数 (AI_UNMETERED_DAILY_CAP_DEFAULTS)
 *  5. 写真の判別が数えたあとに返す「数え済みの印」(signAiUsageGrant / verifyAiUsageGrant。続く解析を数えないため)
 * 上限の判定の結果の読み取りと、上限に達したときの応答 (429 AI_DAILY_LIMIT) の形・文面は _shared/ai-daily-limit.ts
 * (モバイルのアプリも読むので、署名の部品 (crypto.subtle・TextEncoder) を持たない別のファイルに分けた)。
 *
 * 【上限】 (#1149。値は DB の ai_daily_limits (プランごと)。機能ごとの上限は ai_plan_feature_caps。billing/03 §6.5)
 *  - 1 日 (JST の暦日) の、上限に数える機能の合計の回数で数える。ユーザーの 1 回の操作を 1 回と数える (究極モードも 1 回)。
 *  - 判定と記録は DB の consume_ai_usage が 1 回の呼び出しで行う (同じ利用者・同じ日は 1 本ずつ判定するので、同時に来ても上限を超えない)。
 *  - 上限に達していれば、記録せずに止める。止め方は入口ごとに決める (tests/helpers/ai-consent-enforced-paths.ts の usage の列):
 *      利用者が押した操作は 429 AI_DAILY_LIMIT (固定の文・retryAfter = 次の JST 0 時までの秒数)、
 *      保存と AI の分析を一緒にする操作は保存だけして AI の部分を省く (aiSkipped: AI_DAILY_LIMIT)、
 *      料理画像を付ける副作用は画像だけ見送る。
 *  - 上限に数えない機能 (AI_UNMETERED_FEATURES) は上限の合計に入れず、機能ごとの 1 日の安全弁 (DB の ai_unmetered_daily_caps) で止める。
 *  - 写真の「オート」は、判別 (classify-photo) で 1 回数え、続く解析 (analyze-*) は判別が返した数え済みの印で数えない (1 回の操作を 1 回)。
 *  - DB の関数が失敗したとき (DB エラー・未適用・応答が遅い) は、ログに残して許可する (#1177 と同じく、記録の失敗で AI を止めない)。
 *
 * 【記録済みの印】
 * Next.js の API ルートが 1 回と記録したあとに、Edge Function をユーザー自身の JWT で呼ぶ処理がある
 * (写真解析・AI 相談の献立生成)。Edge Function 側も「ユーザーの JWT で直接呼ばれたとき」に記録するので、
 * 何もしないと同じ操作を 2 回記録してしまう。それを避けるため、Next.js は Edge Function を呼ぶときに、
 * 記録済みであることを示す署名つきのヘッダーを付ける。
 *   x-hg-ai-usage-recorded: v1.<UNIX 秒>.<HMAC-SHA256 (hex)>
 *   署名の対象は `v1.<ユーザー ID>.<UNIX 秒>`。鍵は service role key (Next.js と Edge Function だけが持つ)。
 * Edge Function は同じ鍵で署名を確かめ (5 分以内・ユーザー ID が JWT のものと一致)、合えば記録しない。
 * ブラウザやモバイルアプリはこの鍵を持たないので、自分でこのヘッダーを付けて記録を逃れることはできない
 * (付けても署名が合わず、記録される)。署名を確かめられなかった場合は記録する側に倒す (二重に記録するだけで、AI の利用は止まらない)。
 * service role key で Edge Function を呼ぶ処理 (献立生成のキュー・AI 相談・買い物リスト) は、
 * Edge Function 側がそもそも記録しない (ユーザーの JWT のときだけ記録する) ので、印は要らない。
 *
 * このファイルが守る制約 (崩すと Edge Functions か Next.js のどちらかが動かなくなる):
 *  - 純粋な TypeScript。import なし、Deno / Node 固有の API なし (環境変数は呼び出し側が読んで渡す)。
 *    使うのは Web 標準の crypto.subtle と TextEncoder だけ (cron-secret.ts と同じ)。
 *    Next.js 側は src/lib/plan/entitlements.ts が相対パスで import する。
 */

/**
 * 記録する機能 (ai_usage_counters.feature)。内訳の集計用。
 * 名前は DB の CHECK (小文字の英字で始まり、小文字・数字・アンダースコアだけ、64 文字まで) に合わせる。
 */
export const AI_FEATURES = [
  /** 献立生成 (週間・1 日・1 食・作り直し・キュー・栄養分析からの献立変更)。究極モードの生成は menu_generation_ultimate で数える */
  "menu_generation",
  /**
   * 献立生成の究極モード (#1142。AI が作った献立をもう一度見直す。AI を通常の倍の 6 段階呼ぶ)。
   * 上限に数える機能 (1 日の上限の合計に 1 回入る) で、そのうえ機能ごとの 1 日の上限 (AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT = 1 回) がある。
   * 究極モードの生成 1 回を、menu_generation ではなくこの機能名で 1 回だけ数える (両方の上限に 1 回ずつ入る)
   */
  "menu_generation_ultimate",
  /** AI 相談 (チャット・要約・アクションの実行) */
  "consultation",
  /** 写真の解析 (冷蔵庫・食事・健診・体重計・写真の判別・栄養の画像解析) */
  "photo_analysis",
  /** 栄養のアドバイス・フィードバック・ヒント */
  "nutrition_advice",
  /** 健康診断・血液検査のレビュー、健康インサイト */
  "health_review",
  /** 買い物リストの AI による再生成・正規化 */
  "shopping_list",
  /** 画像の生成 (料理画像を含む) */
  "image_generation",
  /**
   * 画面を開くと自動で呼ばれる AI (ホームの栄養のアドバイス・栄養の詳細を開いたときの栄養士のコメント)。
   * 利用者が押した操作ではないので、1 日の上限の回数に数えない (AI_UNMETERED_FEATURES)。記録は残し、
   * 自動の分だけの安全弁 (AI_UNMETERED_DAILY_CAP_DEFAULTS) で止める (API を直接呼んで上限と無関係に使えないように)
   */
  "nutrition_advice_auto",
  /**
   * 料理を保存・更新したときに自動で付ける料理画像 (献立・食事の保存の副作用。AI 相談の update_meal も同じ)。
   * 利用者が「画像を作る」を押した操作ではないので、1 日の上限の回数に数えない (食事を記録するだけで、AI 相談や写真の解析が
   * 止まらないように)。記録は残し、自動の分だけの安全弁 (AI_UNMETERED_DAILY_CAP_DEFAULTS) で止める (画像だけ見送る)。
   * 利用者が押して画像を作る操作 (POST /api/ai/image/generate) は image_generation (上限に数える)
   */
  "meal_image_auto",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * 上限に数えない機能 (#1149)。記録はするが、1 日の回数 (プランごとの明示の上限) の合計に入れず、その上限に達していても止めない。
 * そのかわり、機能ごとの 1 日の安全弁 (AI_UNMETERED_DAILY_CAP_DEFAULTS) を超えたら止める。
 * DB の consume_ai_usage_at の c_unmetered と同じ一覧 (tests/ai-usage-contract.test.ts が migration と突き合わせる)。
 * 足すのは「利用者が押さなくても、画面を開く・保存するだけで呼ばれる AI」だけ (押した操作を足すと、上限をすり抜ける)。
 */
export const AI_UNMETERED_FEATURES: readonly AiFeature[] = ["nutrition_advice_auto", "meal_image_auto"];

/** 上限に数えない機能の名前 */
export type AiUnmeteredFeature = "nutrition_advice_auto" | "meal_image_auto";

/**
 * 上限に数えない機能の、利用者ごと・1 日 (JST の暦日) の安全弁の既定の回数 (#1149)。
 * 値は DB の ai_unmetered_daily_caps (機能ごとに 1 行) が正で、ここは migration が入れる既定の行と同じ値
 * (tests/ai-usage-contract.test.ts が migration の既定の行と突き合わせる)。運用で変えるときは DB の行を更新する。
 * DB の行が無いときは、DB の関数が c_unmetered_fallback_cap (AI_UNMETERED_DAILY_CAP_FALLBACK) を使う (無制限にはしない)。
 *  - nutrition_advice_auto = 30: ホームを開く・栄養の詳細を開くたびに 1 回。ふつうの使い方 (1 日に数回〜十数回開く) では当たらず、
 *    API を直接呼び続けたときだけ止まる値
 *  - meal_image_auto = 20: 料理を保存・更新するたびに 1 回 (1 回の保存で何品あっても 1 回)。1 日 3 食 + 間食を何度か直しても当たらない値
 */
export const AI_UNMETERED_DAILY_CAP_DEFAULTS: Readonly<Record<AiUnmeteredFeature, number>> = Object.freeze({
  nutrition_advice_auto: 30,
  meal_image_auto: 20,
});

/**
 * DB の ai_unmetered_daily_caps に行が無い (消された) ときの安全弁の回数。DB の関数の c_unmetered_fallback_cap と同じ。
 * 既定の値のうち小さいほう (行が無くても無制限にしない)
 */
export const AI_UNMETERED_DAILY_CAP_FALLBACK = 20;

/** 上限に数える機能か */
export function isMeteredAiFeature(feature: AiFeature): boolean {
  return !AI_UNMETERED_FEATURES.includes(feature);
}

// ---------------------------------------------------------------
// 機能ごとの 1 日の上限 (#1142 で究極モードを 1 人 1 日 1 回までにした。billing/03 §6.5 の後は、回数はプランで決まる)
// ---------------------------------------------------------------
//
// 1 日の AI の上限 (DB の ai_daily_limits。上限に数える機能の合計) とは別に、機能ごとに 1 日 (JST の暦日) の上限を持つ機能。
// いまは究極モード (menu_generation_ultimate) だけ。判定と記録は DB の consume_ai_usage_capped が 1 回の呼び出しで行う
// (機能ごとの上限 → 1 日の上限の順に判定し、どちらかに達していれば記録せずに止める。同じ利用者・同じ日は 1 本ずつ判定する)。
// 上限の値は、DB の ai_plan_feature_caps に行のあるプラン (free 0 / pro 2 / family_basic 2 / family_pro 3。0 = そのプランでは使えず 403 AI_FEATURE_NOT_IN_PLAN)
// では行の値 (consume_ai_usage_capped が引数の上限を使わず consume_ai_usage_at に任せる。migration 20261021100000_billing_paid_plans_iap.sql)。
// 行の無いプラン (組織のプランなど) にだけ、ここの既定の値 (環境変数で上書きできる) を呼び出し側が DB の関数に引数で渡したものが効く。
// 呼び出し側 (src/lib/plan/entitlements.ts の consumeAiUsage / _shared/ai-usage.ts の consumeEdgeAiUsage) は、
// 機能名が上限を持つ機能なら consume_ai_usage_capped を、そうでなければ consume_ai_usage を呼ぶ (aiFeatureDailyCap で決める)。

/** 究極モードの機能名。_shared/ai-daily-limit.ts の AI_DAILY_CAPPED_FEATURES と同じ (tests/ai-usage-contract.test.ts が突き合わせる) */
export const AI_ULTIMATE_MODE_FEATURE = "menu_generation_ultimate" satisfies AiFeature;

/** 機能ごとの 1 日の上限がある機能 */
export const AI_CAPPED_FEATURES: readonly AiFeature[] = [AI_ULTIMATE_MODE_FEATURE];

/**
 * 究極モードの、利用者ごと・1 日 (JST の暦日) の上限の既定の回数 (#1142)。billing/03 §6.5 の後は、ai_plan_feature_caps に行の無いプランにだけ効く。
 * オーナーの選択 (2026-10-14): 「究極モードを全員に開放する。ただし、1 日の AI の上限 (#1480・#1149) とは別に、究極モードだけ
 * 1 人 1 日 1 回 (JST の暦日) までにする。」
 * 運用で変えるときは環境変数 AI_ULTIMATE_MODE_DAILY_LIMIT (0 以上の整数。0 はその日は 1 回も使えない) を、
 * Next.js (Vercel) と Edge Functions (Supabase の secrets) の両方に同じ値で入れる (片方だけだと、入口によって上限が変わる)
 */
export const AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT = 1;

/** 究極モードの 1 日の上限を上書きする環境変数の名前 */
export const AI_ULTIMATE_MODE_DAILY_LIMIT_ENV = "AI_ULTIMATE_MODE_DAILY_LIMIT";

/** 環境変数の値として受け付ける形 (0 以上の整数。桁数は DB の INTEGER に収まる範囲) */
const DAILY_LIMIT_ENV_PATTERN = /^\d{1,9}$/;

/**
 * 究極モードの 1 日の上限 (回数)。環境変数の値 (呼び出し側が読んで渡す) が 0 以上の整数ならその値、
 * 無い・空・形が違う (負・小数・文字) ときは既定の値 (AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT)。
 * 形が違う値で無制限にならないよう、既定の値に倒す
 */
export function resolveAiUltimateModeDailyLimit(raw: string | null | undefined): number {
  const value = raw?.trim();
  if (!value || !DAILY_LIMIT_ENV_PATTERN.test(value)) return AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT;
  return Number(value);
}

/**
 * その機能の、機能ごとの 1 日の上限 (回数)。機能ごとの上限が無い機能は null (1 日の上限の合計だけで判定する)。
 * readEnv は環境変数を読む関数 (Next.js は src/lib/plan/entitlements.ts の readFeatureDailyCapEnv が名前を書いて process.env から、
 * Edge Functions は Deno.env.get。このファイルは環境変数を直接読まない)。上書きの変数を足したら、Next.js 側の読む関数と
 * src/lib/env.ts の一覧・.env.example にも足す (src/__tests__/lib/plan/entitlements.test.ts が突き合わせる)
 */
export function aiFeatureDailyCap(feature: AiFeature, readEnv: (name: string) => string | undefined): number | null {
  if (feature === AI_ULTIMATE_MODE_FEATURE) return resolveAiUltimateModeDailyLimit(readEnv(AI_ULTIMATE_MODE_DAILY_LIMIT_ENV));
  return null;
}

/**
 * 献立生成の依頼が究極モードか (#1142)。本文の ultimateMode が真偽値の true のときだけ究極モード。
 * 数える機能名 (menu_generation_ultimate / menu_generation) と、生成の処理 (Edge Function) に渡す値は、どちらもこの関数の結果で決める
 * (文字列の "true" などを、数えるときは通常・生成は究極モード、と食い違って扱わないように)
 */
export function isUltimateModeRequested(value: unknown): boolean {
  return value === true;
}

/**
 * consume_ai_usage / refund_ai_usage の応答を待つ上限 (ミリ秒)。超えたら判定と記録をあきらめて先へ進む (許可する。止めない)。
 * AI の応答 (数秒〜数十秒) より十分短く、DB の通常の応答 (数十ミリ秒) より十分長い値。
 */
export const AI_USAGE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------
// 記録済みの印
// ---------------------------------------------------------------

export const AI_USAGE_RECORDED_HEADER = "x-hg-ai-usage-recorded";
export const AI_USAGE_MARKER_VERSION = "v1";
/** 印が有効な秒数 (これより古い印は受け付けない) */
export const AI_USAGE_MARKER_MAX_AGE_SEC = 300;
/** サーバー間の時計のずれを許す秒数 (これより未来の印は受け付けない) */
export const AI_USAGE_MARKER_MAX_FUTURE_SEC = 60;

const encoder = new TextEncoder();

/** 署名する文字列 */
function markerPayload(userId: string, issuedAtSec: number): string {
  return `${AI_USAGE_MARKER_VERSION}.${userId}.${issuedAtSec}`;
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** 印の値 (ヘッダーの値) を作る。呼び出し側 (Next.js) が、記録し終えた直後に作る */
export async function signAiUsageRecorded(secret: string, userId: string, nowMs: number = Date.now()): Promise<string> {
  const issuedAtSec = Math.floor(nowMs / 1000);
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(markerPayload(userId, issuedAtSec)));
  return `${AI_USAGE_MARKER_VERSION}.${issuedAtSec}.${toHex(signature)}`;
}

/**
 * 印を確かめる。次をすべて満たしたときだけ true。
 *  - 形式が `v1.<UNIX 秒>.<64 桁の hex>`
 *  - 発行から 5 分以内 (未来すぎる印も不可)
 *  - secrets のどれかの鍵で、`v1.<userId>.<UNIX 秒>` の署名が合う (userId は、呼び出し側が JWT から確定したもの)
 * 署名の比較は crypto.subtle.verify (定数時間) で行う。
 */
export async function verifyAiUsageRecorded(
  headerValue: string | null | undefined,
  userId: string,
  secrets: ReadonlyArray<string | null | undefined>,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!headerValue || !userId) return false;
  const parts = headerValue.split(".");
  if (parts.length !== 3 || parts[0] !== AI_USAGE_MARKER_VERSION) return false;
  if (!/^\d{1,12}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return false;

  const issuedAtSec = Number(parts[1]);
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec - issuedAtSec > AI_USAGE_MARKER_MAX_AGE_SEC) return false;
  if (issuedAtSec - nowSec > AI_USAGE_MARKER_MAX_FUTURE_SEC) return false;

  const signature = fromHex(parts[2]);
  const payload = encoder.encode(markerPayload(userId, issuedAtSec));
  for (const secret of secrets) {
    if (!secret) continue;
    if (await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, payload)) return true;
  }
  return false;
}

// ---------------------------------------------------------------
// 数え済みの印 (写真の「オート」の判別 → 解析を 1 回に数える。#1149)
// ---------------------------------------------------------------
//
// 写真の「オート」は、1 回押すと判別 (POST /api/ai/classify-photo) と、続く解析 (analyze-meal-photo / analyze-fridge /
// analyze-health-checkup / analyze-weight-scale) の 2 つの API を呼ぶ。判別で 1 回数えるので、続く解析は数えない
// (利用者の 1 回の操作を 1 回と数える)。そのため判別は、数えたあとに「数え済みの印」を応答の aiUsageGrant で返し、
// 画面は続く解析の本文の aiUsageGrant にそのまま入れて送る。解析は印を確かめ、使えたら数えない。
//   g1.<UNIX 秒>.<印の ID (UUID)>.<HMAC-SHA256 (hex)>
//   署名の対象は `g1.<機能名>.<ユーザー ID>.<UNIX 秒>.<印の ID>`。鍵は service role key (サーバーだけが持つ)。
// 画面はこの鍵を持たないので、印を作れない (作っても署名が合わず、数える)。
// 印は 1 回だけ使える。解析は署名を確かめたあと、DB の claim_ai_usage_grant で印の ID を使用済みにし、
// 使用済みにできたときだけ数えない (同じ印を何度送っても、数えずに済むのは最初の 1 回だけ)。
// 印の ID はサーバーが作る乱数で、使用済みの記録は ai_usage_grant_claims (service_role だけが読み書きする)。

export const AI_USAGE_GRANT_VERSION = "g1";
/**
 * 数え済みの印が有効な秒数。判別のあと、画面が続けて解析を呼ぶまでの時間 (ふつうは数秒。判別できずに種類を手で選ぶ画面で
 * 迷っても足りる長さ) を見込んだ値。これより古い印は数える。
 */
export const AI_USAGE_GRANT_MAX_AGE_SEC = 600;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function grantPayload(feature: AiFeature, userId: string, issuedAtSec: number, grantId: string): string {
  return `${AI_USAGE_GRANT_VERSION}.${feature}.${userId}.${issuedAtSec}.${grantId}`;
}

/**
 * 数え済みの印を作る。数えた (consume_ai_usage が上限に数えて許可した) 直後に、サーバーが作る。
 * grantId は呼び出し側が crypto.randomUUID() で作る (小文字の UUID)。
 */
export async function signAiUsageGrant(
  secret: string,
  feature: AiFeature,
  userId: string,
  grantId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const issuedAtSec = Math.floor(nowMs / 1000);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(grantPayload(feature, userId, issuedAtSec, grantId)),
  );
  return `${AI_USAGE_GRANT_VERSION}.${issuedAtSec}.${grantId}.${toHex(signature)}`;
}

/**
 * 数え済みの印を確かめる。次をすべて満たしたときだけ、印の ID を返す (満たさなければ null。呼び出し側は数える)。
 *  - 形式が `g1.<UNIX 秒>.<UUID>.<64 桁の hex>`
 *  - 発行から AI_USAGE_GRANT_MAX_AGE_SEC 秒以内 (未来すぎる印も不可)
 *  - secrets のどれかの鍵で、`g1.<feature>.<userId>.<UNIX 秒>.<UUID>` の署名が合う (userId は、呼び出し側が認証で確定したもの)
 * 使用済みかどうかは見ない (呼び出し側が DB で 1 回だけ使えるようにする)。
 */
export async function verifyAiUsageGrant(
  value: unknown,
  feature: AiFeature,
  userId: string,
  secrets: ReadonlyArray<string | null | undefined>,
  nowMs: number = Date.now(),
): Promise<{ grantId: string } | null> {
  if (typeof value !== "string" || !userId) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== AI_USAGE_GRANT_VERSION) return null;
  const [, issuedAtText, grantId, signatureHex] = parts;
  if (!/^\d{1,12}$/.test(issuedAtText) || !UUID_PATTERN.test(grantId) || !/^[0-9a-f]{64}$/.test(signatureHex)) return null;

  const issuedAtSec = Number(issuedAtText);
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec - issuedAtSec > AI_USAGE_GRANT_MAX_AGE_SEC) return null;
  if (issuedAtSec - nowSec > AI_USAGE_MARKER_MAX_FUTURE_SEC) return null;

  const signature = fromHex(signatureHex);
  const payload = encoder.encode(grantPayload(feature, userId, issuedAtSec, grantId));
  for (const secret of secrets) {
    if (!secret) continue;
    if (await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, payload)) return { grantId };
  }
  return null;
}

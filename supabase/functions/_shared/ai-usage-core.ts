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
 * 上限の判定の結果の読み取りと、上限に達したときの応答 (429 AI_DAILY_LIMIT) の形・文面は _shared/ai-daily-limit.ts
 * (モバイルのアプリも読むので、署名の部品 (crypto.subtle・TextEncoder) を持たない別のファイルに分けた)。
 *
 * 【上限】 (#1149。値は DB の ai_daily_limits。既定は free = 1 日 10 回)
 *  - 1 日 (JST の暦日) の、上限に数える機能の合計の回数で数える。ユーザーの 1 回の操作を 1 回と数える (究極モードも 1 回)。
 *  - 判定と記録は DB の consume_ai_usage が 1 回の呼び出しで行う (同じ利用者・同じ日は 1 本ずつ判定するので、同時に来ても上限を超えない)。
 *  - 上限に達していれば、記録せずに止める。止め方は入口ごとに決める (tests/helpers/ai-consent-enforced-paths.ts の usage の列):
 *      利用者が押した操作は 429 AI_DAILY_LIMIT (固定の文・retryAfter = 次の JST 0 時までの秒数)、
 *      保存と AI の分析を一緒にする操作は保存だけして AI の部分を省く (aiSkipped: AI_DAILY_LIMIT)、
 *      料理画像を付ける副作用は画像だけ見送る。
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
  /** 献立生成 (週間・1 日・1 食・作り直し・キュー・栄養分析からの献立変更) */
  "menu_generation",
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
   * 利用者が押した操作ではないので、上限に数えない (AI_UNMETERED_FEATURES)。記録は残す (計測のため)
   */
  "nutrition_advice_auto",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * 上限に数えない機能 (#1149)。記録はするが、1 日の回数の合計に入れず、上限に達していても止めない。
 * DB の consume_ai_usage_at の c_unmetered と同じ一覧 (tests/ai-usage-contract.test.ts が migration と突き合わせる)。
 * 足すのは「利用者が押さなくても、画面を開くだけで呼ばれる AI」だけ (押した操作を足すと、上限をすり抜ける)。
 */
export const AI_UNMETERED_FEATURES: readonly AiFeature[] = ["nutrition_advice_auto"];

/** 上限に数える機能か */
export function isMeteredAiFeature(feature: AiFeature): boolean {
  return !AI_UNMETERED_FEATURES.includes(feature);
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

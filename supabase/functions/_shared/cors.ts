/**
 * Edge Function 用の CORS ヘルパー (#1167)
 *
 * 以前は Access-Control-Allow-Origin: '*' を返していたため、Authorization ヘッダー (Bearer トークン) を
 * 受け付ける関数を、どのサイトのページからでもブラウザ経由で呼べる状態だった。
 * 許可するオリジンを自社のものだけに絞る。
 *
 * - 許可するオリジンは環境変数 ALLOWED_ORIGINS (カンマ区切り) で決める。
 *     例: ALLOWED_ORIGINS=https://homegohan.app,https://homegohan-app.vercel.app
 *   未設定 (空文字を含む) のときは DEFAULT_ALLOWED_ORIGINS を使う。設定したときは既定値を置き換える。
 *   スキーム付き・末尾スラッシュなしで書く。'*' と 'null' は無視する (ワイルドカードにも、出所が分からないページにもできない)。
 * - リクエストの Origin が許可リストに完全一致したときだけ、Access-Control-Allow-* を返す。
 *   Origin が無い (サーバー間の呼び出し・curl など) / 一致しない / 'null' (サンドボックス化された iframe など) のときは返さない。
 *   CORS を強制するのはブラウザだけなので、Next.js の API ルートなどサーバーからの呼び出しには影響しない。
 *   モバイルアプリの WebView が読み込むのは Web アプリ自身 (EXPO_PUBLIC_WEB_URL) のページなので、
 *   そこからの呼び出しの Origin も Web アプリのオリジンになる。ネイティブ側の fetch は Origin を付けない。
 * - 応答が Origin によって変わるので、どの場合にも Vary: Origin を付ける
 *   (許可しないオリジン向けの応答が、キャッシュ経由で許可したオリジンに返らないように)。
 *
 * バッチ専用 (service role / CRON_SECRET) の関数はブラウザから呼ばれないので、このヘルパーも使わず CORS 自体を付けない。
 *
 * 使い方 (Origin はリクエストごとに違うので、ハンドラの先頭で作る):
 *   Deno.serve(async (req) => {
 *     const corsHeaders = getCorsHeaders(req);
 *     if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
 *     ...
 *     return new Response(body, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
 *   });
 */

/** ALLOWED_ORIGINS が未設定のときに許可する、自社の Web アプリのオリジン */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "https://homegohan.app",
  "https://homegohan-app.vercel.app",
];

const ALLOW_HEADERS = "authorization, x-client-info, apikey, content-type";
const ALLOW_METHODS = "POST, OPTIONS";

/** 設定値の揺れ (前後の空白・末尾のスラッシュ・大文字) をならす。ブラウザの Origin は常に小文字・末尾スラッシュなし */
function normalizeConfiguredOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function readAllowedOriginsEnv(): string | undefined {
  try {
    return typeof Deno !== "undefined" ? Deno.env.get("ALLOWED_ORIGINS") : undefined;
  } catch {
    // 環境変数を読む権限が無い実行環境でも、既定の (自社オリジンだけの) 許可リストで動かす
    return undefined;
  }
}

/** 現在有効な、許可するオリジンの一覧 (正規化済み) */
export function getAllowedOrigins(): string[] {
  const configured = (readAllowedOriginsEnv() ?? "")
    .split(",")
    .map(normalizeConfiguredOrigin)
    // '*' はワイルドカードとして扱わず、'null' (サンドボックス化された iframe・file:// などの Origin) も許可しない
    .filter((origin) => origin !== "" && origin !== "*" && origin !== "null");
  return configured.length > 0 ? configured : [...DEFAULT_ALLOWED_ORIGINS];
}

/**
 * リクエストの Origin に応じた CORS ヘッダーを返す。
 * 許可するオリジンのときだけ Access-Control-Allow-* を含む。Vary: Origin は常に含む。
 * 比較は完全一致なので、返す Access-Control-Allow-Origin は必ず設定済みの許可リストのいずれかの値と同じになる
 * (部分一致・前方一致・サブドメインのワイルドカードは認めない)。
 */
export function getCorsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  const origin = req.headers.get("origin");
  if (origin && getAllowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = ALLOW_HEADERS;
    headers["Access-Control-Allow-Methods"] = ALLOW_METHODS;
  }
  return headers;
}

/**
 * 認証ヘルパー (_shared/auth.ts) が返す 401 などの既存の Response に、要求元に応じた CORS ヘッダーを付け直す。
 * 付けないと、ブラウザからの呼び出しでは 401 の中身が読めず、CORS エラーとして見えてしまう。
 */
export function withCors(res: Response, req: Request): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(getCorsHeaders(req))) {
    if (key === "Vary") {
      // 既存の Vary (Accept-Encoding など) を消さずに Origin を足す
      const existing = headers.get("Vary");
      if (!existing) headers.set("Vary", value);
      else if (!/(^|,)\s*(origin|\*)\s*(,|$)/i.test(existing)) headers.set("Vary", `${existing}, ${value}`);
    } else {
      headers.set(key, value);
    }
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

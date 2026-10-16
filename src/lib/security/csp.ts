// src/lib/security/csp.ts
// #1169 本番の CSP を nonce 方式にする正典: 方針の文字列・nonce の生成・ヘッダー名・報告先。
// 全リクエストの前に動く proxy (src/proxy.ts。Next 16 で middleware から改名し、Node.js の runtime で動く。#1744) から読むので、
// このファイルは何も import しない (zod・Node の API・@/lib/env を持ち込まない。src/lib/env-required.ts と同じ理由)。環境変数を名前で読むのは CSP_REPORT_ONLY だけ (src/lib/env.ts の一覧の readOnlyBy)。
// 方針の正本はここだけ。next.config.mjs には Content-Security-Policy を書かない (二重に付くと nonce つきのスクリプトが止まる。
// src/__tests__/config/next-config-headers.test.ts が見張る)。

/** 強制する CSP の応答ヘッダー名 */
export const CSP_HEADER = 'Content-Security-Policy';
/** 報告だけの CSP の応答ヘッダー名 (CSP_REPORT_ONLY=on のとき。違反を止めず報告だけする) */
export const CSP_REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';
/** proxy が画面 (Server Component) へ nonce を渡すリクエストヘッダー。Next 公式の x-nonce と同じ役目 */
export const CSP_NONCE_HEADER = 'x-csp-nonce';
/** 違反の報告の受け口 (POST。src/app/api/csp-report/route.ts) */
export const CSP_REPORT_PATH = '/api/csp-report';
/** nonce の乱数の長さ (バイト)。CSP3 は 128 ビット以上を求める。base64 で 24 文字になる */
export const CSP_NONCE_BYTES = 16;
/** generateCspNonce の戻り値の形 (base64)。これ以外を方針に入れない (ヘッダーへの差し込みを防ぐ) */
export const CSP_NONCE_PATTERN = /^[A-Za-z0-9+\/]+={0,2}$/;
/**
 * Cloudflare Turnstile の api.js とウィジェットの iframe のオリジン。src/lib/auth/turnstile.ts の TURNSTILE_SCRIPT_SRC と同じ
 * (src/__tests__/config/turnstile-config.test.ts が突き合わせる)。下の frame-src の行にも同じ値を文字どおりに書いてある
 * (apps/mobile の Jest が、二重引用符で始まる frame-src の方針の文字列のうち最初に現れるものを読み、WEB_VIEW_EMBED_ORIGINS と突き合わせるため。
 * Jest は最初の一致しか使わないので、このファイルで二重引用符に続けて frame-src と書くのは下の方針の行の 1 か所だけにする。
 * コメントでも二重引用符で囲んだ frame-src の例を書かない。src/__tests__/lib/security/csp.test.ts が 1 か所だけであることを見張る)
 */
export const CSP_TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
/**
 * 日本の祝日の一覧 (公開情報) を返す API のオリジン (#1769)。週間献立 (/menus/weekly) がブラウザから
 * `${HOLIDAYS_API_ORIGIN}/api/v1/<年>/date.json` を fetch するので、connect-src に足す。
 * 取得の URL は src/app/(main)/menus/weekly/_state/japaneseHolidays.ts がこの定数から組み立てる (2 か所の値がずれないように)。
 * 送るのは年だけで、利用者のデータは送らない (tests/ai-consent-provider-inventory.test.ts の NON_AI_HOSTS)
 */
export const HOLIDAYS_API_ORIGIN = 'https://holidays-jp.github.io';
/** CSP_REPORT_ONLY を有効とみなす唯一の値 (lib/legal-consent.ts の LEGAL_CONSENT_FLAG_ON と同じ読み方) */
const CSP_REPORT_ONLY_FLAG_ON = 'on';
/** Supabase のクラウド (本番) のホストの末尾。これ以外 (ローカルの Supabase) のときだけ origin を方針に足す */
const SUPABASE_CLOUD_HOST_SUFFIX = '.supabase.co';

export interface CspBuildInput {
  /** このリクエストの nonce (generateCspNonce の戻り値) */
  nonce: string;
  /** next dev か (dev では React がデバッグ情報 (サーバーのエラーのスタックをブラウザで組み立て直すなど) に eval を使うので 'unsafe-eval' が要る。本番は要らない。Next の CSP のガイド)。呼ぶ側が process.env.NODE_ENV === 'development' を渡す */
  isDev: boolean;
  /** NEXT_PUBLIC_SUPABASE_URL (src/lib/env-required.ts の getSupabaseUrl() の値。無ければ undefined) */
  supabaseUrl: string | undefined;
}

export interface SupabaseLocalOrigins {
  /** http(s) の origin (例: http://127.0.0.1:54321) */
  http: string;
  /** Realtime 用の ws(s) の origin (例: ws://127.0.0.1:54321) */
  ws: string;
}

/**
 * ローカルの Supabase (scripts/supabase-local.sh の http://127.0.0.1:54321 など) にブラウザから接続できるよう、
 * NEXT_PUBLIC_SUPABASE_URL が *.supabase.co 以外のときだけ、その origin (と Realtime 用の ws / wss) を返す。
 * 本番 (*.supabase.co)・未設定・URL でない値は null (方針は変わらない)。next.config.mjs にあった判定をそのまま移した
 */
export function supabaseLocalOrigins(supabaseUrl: string | undefined): SupabaseLocalOrigins | null {
  if (supabaseUrl === undefined) return null;
  try {
    const url = new URL(supabaseUrl);
    if (url.hostname.endsWith(SUPABASE_CLOUD_HOST_SUFFIX)) return null;
    return { http: url.origin, ws: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` };
  } catch {
    return null;
  }
}

/** 1 リクエストにつき 1 つの nonce (16 バイトの乱数を base64 にした 24 文字)。Node・Edge Runtime・ブラウザのどれでも動く Web Crypto で作る */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(CSP_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 方針の文字列。ディレクティブの順と許可先は next.config.mjs にあった CSP を引き継ぎ、script-src だけを変えた:
 *   'unsafe-inline' を外し、'nonce-<nonce>' と 'report-sample' (止めたインラインの先頭 40 文字を報告に含める) を足す。
 * style-src は据え置き (docs/design/cross/18-csp-nonce.md §6.3)。report-uri は違反の報告の受け口。
 */
export function buildContentSecurityPolicy(input: CspBuildInput): string {
  if (!CSP_NONCE_PATTERN.test(input.nonce)) {
    throw new Error('CSP nonce must be base64');
  }
  const local = supabaseLocalOrigins(input.supabaseUrl);
  const supabaseImgSrc = local ? ` ${local.http}` : '';
  const supabaseConnectSrc = local ? ` ${local.http} ${local.ws}` : '';
  return [
    "default-src 'self'",
    // #1165: Cloudflare Turnstile の api.js。#1179: Speed Insights (本番は 'self'、dev は *.vercel-scripts.com)
    `script-src 'self' 'nonce-${input.nonce}'${input.isDev ? " 'unsafe-eval'" : ''} 'report-sample' *.vercel-scripts.com ${CSP_TURNSTILE_ORIGIN}`,
    // frame-src を書くと default-src へのフォールバックが無くなるので 'self' も書く。この 1 行は apps/mobile の Jest が文字どおりに読む
    // (このファイルで二重引用符に続く frame-src はこの行だけ。csp.test.ts が見張る)
    "frame-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: *.supabase.co images.unsplash.com${supabaseImgSrc}`,
    // #1166: PostHog の送信先は許可しない。#1769: 週間献立の祝日の取得 (HOLIDAYS_API_ORIGIN)
    `connect-src 'self' *.supabase.co *.vercel.app wss://*.supabase.co ${HOLIDAYS_API_ORIGIN}${supabaseConnectSrc}`,
    "frame-ancestors 'none'",
    "font-src 'self'",
    "object-src 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join('; ');
}

/** 方針の文字列を { ディレクティブ名 → 許可先の配列 } にする (テストと e2e が使う。空の区切りは飛ばす) */
export function cspDirectivesOf(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    directives.set(tokens[0], tokens.slice(1));
  }
  return directives;
}

/**
 * 報告だけ (Content-Security-Policy-Report-Only) にするか。環境変数 CSP_REPORT_ONLY が on のときだけ true (既定は強制)。
 * この変数を名前で読むのはこの関数だけ (src/lib/env.ts の一覧の readOnlyBy)。
 */
export function isCspReportOnly(value: string | undefined = process.env.CSP_REPORT_ONLY): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === CSP_REPORT_ONLY_FLAG_ON;
}

/** この環境で返す CSP のヘッダー名 (強制か報告だけか) */
export function cspHeaderName(reportOnly: boolean): string {
  return reportOnly ? CSP_REPORT_ONLY_HEADER : CSP_HEADER;
}

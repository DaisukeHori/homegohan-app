/**
 * cron / バッチ用の共有シークレットの照合 - Next.js API Routes / Supabase Edge Functions 共用 (#1196)
 *
 * 呼び出し元 (pg_cron や Vercel Cron) が `Authorization: Bearer <secret>` で送ってくる共有シークレットを、
 * 受け取る側が同じ規則で確かめるための関数。受け取る側は次の 2 か所で、どちらもこの関数を通す。
 *  - Edge Functions: _shared/auth.ts の requireServiceRole (CRON_SECRET。CRON_SECRET が無いときだけ別名の SERVICE_ROLE_SECRET)
 *  - Next.js:        src/lib/cron-auth.ts の requireCronAuth (CRON_SECRET)
 *
 * 止めずにシークレットを入れ替えられるよう、現行の値 (current) に加えて、入れ替えの間だけ設定する
 * 旧い値 (previous = CRON_SECRET_PREVIOUS) も受け付ける。手順は ENV_SETUP.md の「Cron の共有シークレットの保管場所とローテーション」。
 *
 * 規則 (これまでの `authHeader !== \`Bearer ${secret}\`` と同じ結果になるように揃えてある):
 *  - ヘッダーは「Bearer 」(B は大文字、後ろは半角スペース 1 つ) + シークレットと完全に一致したときだけ通す。
 *    前後の空白の除去や、大文字小文字の読み替えはしない。
 *  - current が未設定・空文字なら not_configured を返す (呼び出し側が 503 にする)。previous だけが設定されていても通さない。
 *  - previous が未設定・空文字なら無視する。空の previous が、ヘッダーなしや「Bearer 」だけのヘッダーに一致することはない。
 *  - 比較は SHA-256 のダイジェスト (常に 32 バイト) 同士を、違いが見つかっても止まらずに最後まで比べる。
 *    何文字目まで合っていたかや、長さが合っていたかで、比較にかかる時間が変わらない。current と previous も、
 *    どちらかが合っても必ず両方とも比べる。
 *
 * このファイルが守る制約 (崩すと Edge Functions か Next.js のどちらかが動かなくなる):
 *  - 純粋な TypeScript。import なし、Deno / Node 固有の API なし (環境変数は呼び出し側が読んで渡す)。
 *    使うのは Web 標準の crypto.subtle と TextEncoder だけなので、Deno・Vercel の Edge Runtime・Node 20 以降のどれでも動く
 *    (process-menu-queue は runtime = 'edge' で、node:crypto の timingSafeEqual は使えない)。
 *    Next.js 側は src/lib/cron-auth.ts が相対パスで import する (log-sanitizer.ts と同じ前例)。
 *  - 例外を投げるのは crypto.subtle が使えない環境だけ。呼び出し側は例外を握りつぶさず、そのまま 500 にして構わない
 *    (照合できないまま通してしまう fail open にはならない)。
 */

const BEARER_PREFIX = "Bearer ";

const encoder = new TextEncoder();

/** 照合に使うシークレットの組。 */
export type CronSecrets = {
  /**
   * 現行のシークレット。未設定・空文字なら not_configured になる。
   * (Edge Functions は CRON_SECRET ?? SERVICE_ROLE_SECRET、Next.js は CRON_SECRET を読んで渡す)
   */
  current: string | null | undefined;
  /** 入れ替え中だけ設定する旧い値 (CRON_SECRET_PREVIOUS)。未設定・空文字なら無視する。 */
  previous?: string | null | undefined;
};

export type CronSecretCheck =
  /** matched: どちらの値と一致したか。"previous" は送信側がまだ旧い値を使っている印 (呼び出し側が警告ログを出す) */
  | { ok: true; matched: "current" | "previous" }
  /** not_configured: 現行のシークレットが未設定 (503)。unauthorized: ヘッダーなし、または一致しない (401) */
  | { ok: false; reason: "not_configured" | "unauthorized" };

/** 未設定・空文字を null にそろえる。 */
function usableSecret(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/**
 * 2 つのバイト列が同じかを、違いが見つかっても止まらずに最後まで比べて返す。
 * 長さが違うときは不一致 (SHA-256 のダイジェスト同士なら常に同じ長さ)。
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Authorization ヘッダーの値が、現行または旧いシークレットの `Bearer <secret>` と一致するかを確かめる。
 *
 * @param authorization リクエストの Authorization ヘッダーの値 (無ければ null)
 * @param secrets       現行と旧いシークレット (環境変数から読んだ値をそのまま渡してよい)
 */
export async function checkCronSecret(
  authorization: string | null | undefined,
  secrets: CronSecrets,
): Promise<CronSecretCheck> {
  const current = usableSecret(secrets.current);
  if (current === null) {
    return { ok: false, reason: "not_configured" };
  }
  // ヘッダーなし。期待値は必ず「Bearer 」で始まる非空の文字列なので、ここで落として問題ない
  if (!authorization) {
    return { ok: false, reason: "unauthorized" };
  }

  const previous = usableSecret(secrets.previous);

  const received = await sha256(authorization);
  const matchesCurrent = timingSafeEqualBytes(received, await sha256(`${BEARER_PREFIX}${current}`));
  // previous が無いときも同じだけ計算して、設定の有無が応答時間に出ないようにする (結果は previous !== null で打ち消す)
  const equalsPrevious = timingSafeEqualBytes(received, await sha256(`${BEARER_PREFIX}${previous ?? ""}`));
  const matchesPrevious = previous !== null && equalsPrevious;

  if (matchesCurrent) {
    return { ok: true, matched: "current" };
  }
  if (matchesPrevious) {
    return { ok: true, matched: "previous" };
  }
  return { ok: false, reason: "unauthorized" };
}

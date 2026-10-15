/**
 * 食事写真・冷蔵庫写真の表示を、署名付き URL (有効期限つき) に切り替えるための共通部品 (#1365 段 1)。
 * Web (src/lib/signed-photo-url-client.ts) が使う (モバイルの apps/mobile/src/lib/signed-photo-url.ts は #1598 で消した。
 * 使っていたネイティブの画面と一緒に消した。アプリの写真は WebView の Web の画面が出す)。
 *
 * 2 つのバケット (meal_photos / fridge-images) はまだ公開 (public) のまま。DB には公開 URL の文字列が
 * 保存されている (書き換えない。段 2 で扱う)。画面は、保存された URL をそのまま表示せず、
 * サーバー (POST /api/storage/signed-urls) に渡して、本人の写真であることを確かめたうえで署名した URL を表示する。
 * 段 2 でバケットを非公開にしても、表示の経路は変わらない。
 *
 * このファイルは実行環境に依存しない (React・Next.js・React Native・Node.js の API を使わない)。
 */

/** 署名付き URL で表示する (= 段 2 で非公開にする) バケット */
export const PHOTO_STORAGE_BUCKETS = ['meal_photos', 'fridge-images'] as const;
export type PhotoStorageBucket = (typeof PHOTO_STORAGE_BUCKETS)[number];

/** 署名付き URL を返す API のパス (Next.js の API。Web は Cookie、モバイルは Authorization ヘッダーで本人を確かめる) */
export const SIGNED_PHOTO_URLS_API_PATH = '/api/storage/signed-urls';

/**
 * 1 回の問い合わせで送る URL の数の上限。サーバーもこれを超える本文は 400 にする。
 * 1 画面に出る写真の数 (週の献立で 1 週 7 日 × 4 食 × 料理数) を、2〜3 回の問い合わせで送れる大きさ
 */
export const MAX_PHOTO_URLS_PER_SIGN_REQUEST = 100;

/** 1 つの URL の長さの上限 (署名付き URL の token つきでも通常は 1,000 文字に届かない。analyze-fridge の上限と同じ) */
export const MAX_PHOTO_URL_LENGTH = 2048;

/**
 * 有効期限のこれだけ前になったら、手元の署名付き URL を使わずに取り直す (ms)。
 * 画面を開いたまま期限を迎えて、まだ読み込んでいない画像 (遅延読み込み) が 400 になるのを防ぐ
 */
export const SIGNED_PHOTO_URL_REFRESH_MARGIN_MS = 60_000;

/** 手元に覚えておく URL の数の上限 (超えたら古いものから捨てる) */
export const SIGNED_PHOTO_URL_CACHE_MAX_ENTRIES = 500;

const STORAGE_OBJECT_PATH_PATTERN =
  /^\/storage\/v1\/(?:object|render\/image)\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/;

/**
 * Supabase Storage の、署名付き URL で表示する 2 つのバケットのオブジェクトを指す URL か。
 *   https://<host>/storage/v1/object/public/<bucket>/<path>
 *   https://<host>/storage/v1/object/sign/<bucket>/<path>?token=…
 *   https://<host>/storage/v1/render/image/public/<bucket>/<path>?width=…
 * 画面はこれが真の URL だけをサーバーに渡す。偽の URL (料理の見本画像・外部の画像など) はそのまま表示する。
 * 持ち主の確認はサーバーが行う (ここは振り分けだけ)。
 */
export function isPhotoStorageUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PHOTO_URL_LENGTH) return false;
  let pathname: string;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    return false;
  }
  const match = STORAGE_OBJECT_PATH_PATTERN.exec(pathname);
  if (!match) return false;
  let bucket: string;
  try {
    bucket = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  return (PHOTO_STORAGE_BUCKETS as readonly string[]).includes(bucket);
}

/** POST /api/storage/signed-urls の本文 */
export interface SignedPhotoUrlsRequest {
  urls: string[];
}

/**
 * POST /api/storage/signed-urls の応答。
 * signedUrls は、送った URL ごとに、署名付き URL か null (本人の写真でない・ファイルが無い・署名に失敗した)。
 */
export interface SignedPhotoUrlsResponse {
  signedUrls: Record<string, string | null>;
  /** 署名付き URL の有効期限 (秒) */
  expiresInSeconds: number;
}

/** 応答の本文を確かめる。形が違えば null */
export function parseSignedPhotoUrlsResponse(json: unknown): SignedPhotoUrlsResponse | null {
  if (typeof json !== 'object' || json === null) return null;
  const { signedUrls, expiresInSeconds } = json as { signedUrls?: unknown; expiresInSeconds?: unknown };
  if (typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return null;
  if (typeof signedUrls !== 'object' || signedUrls === null || Array.isArray(signedUrls)) return null;
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(signedUrls as Record<string, unknown>)) {
    if (value !== null && typeof value !== 'string') return null;
    result[key] = value;
  }
  return { signedUrls: result, expiresInSeconds };
}

/** 表示に使う URL と、その URL を取り直すべき時刻 */
export interface ResolvedPhotoUrl {
  /** 表示する URL。null なら表示しない (本人の写真でない・ファイルが無い・問い合わせに失敗した) */
  url: string | null;
  /** この時刻 (ms) を過ぎたら resolve し直す。取り直す必要が無い (署名の要らない URL・失敗) ときは null */
  refreshAt: number | null;
}

export interface SignedPhotoUrlResolver {
  /**
   * 表示に使う URL を返す。
   *   - 署名の要らない URL (isPhotoStorageUrl が偽): そのまま
   *   - 手元に期限内の署名付き URL がある: それ
   *   - それ以外: 同じ時点に頼まれた URL をまとめて (MAX_PHOTO_URLS_PER_SIGN_REQUEST ずつ) サーバーに問い合わせる
   */
  resolve(url: string): Promise<ResolvedPhotoUrl>;
  /** 手元に期限内の答えがあれば、それを同期で返す (無ければ undefined)。描画の最初のちらつきを減らすため */
  peek(url: string): ResolvedPhotoUrl | undefined;
  /** 手元の答えを全部捨てる (ログアウト・利用者の切り替えのとき) */
  clear(): void;
}

export interface SignedPhotoUrlResolverOptions {
  /** サーバーへの問い合わせ。失敗したら例外を投げる */
  fetchSigned: (urls: string[]) => Promise<SignedPhotoUrlsResponse>;
  /** 今の時刻 (ms)。テストで差し替える */
  now?: () => number;
  /** まとめて問い合わせる処理を、少し後に動かす (既定は setTimeout 0)。テストで差し替える */
  schedule?: (run: () => void) => void;
}

interface CacheEntry {
  value: string | null;
  /** この時刻 (ms) を過ぎたら使わない */
  usableUntil: number;
}

interface Waiter {
  resolve: (value: ResolvedPhotoUrl) => void;
}

/**
 * 署名付き URL の問い合わせを、まとめる・覚えておく役。画面ごとに作らず、アプリで 1 つだけ作る。
 * 同じ URL を同時に何度頼まれても、問い合わせは 1 回。問い合わせに失敗したら、その回の URL は表示しない (null) で返し、覚えない
 * (次に頼まれたときに問い合わせ直す)。
 */
export function createSignedPhotoUrlResolver(options: SignedPhotoUrlResolverOptions): SignedPhotoUrlResolver {
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((run: () => void) => void setTimeout(run, 0));
  const cache = new Map<string, CacheEntry>();
  const waiting = new Map<string, Waiter[]>();
  let queued: string[] = [];
  let scheduled = false;

  function lookup(url: string): ResolvedPhotoUrl | undefined {
    const entry = cache.get(url);
    if (!entry) return undefined;
    if (now() >= entry.usableUntil) {
      cache.delete(url);
      return undefined;
    }
    return { url: entry.value, refreshAt: entry.usableUntil };
  }

  function remember(url: string, value: string | null, expiresInSeconds: number): ResolvedPhotoUrl {
    const lifetimeMs = expiresInSeconds * 1000;
    // 有効期限が余白より短い設定でも、すぐに取り直しを繰り返さないよう、余白は有効期限の半分までにする
    const marginMs = Math.min(SIGNED_PHOTO_URL_REFRESH_MARGIN_MS, lifetimeMs / 2);
    const usableUntil = now() + lifetimeMs - marginMs;
    cache.delete(url);
    cache.set(url, { value, usableUntil });
    while (cache.size > SIGNED_PHOTO_URL_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return { url: value, refreshAt: usableUntil };
  }

  function settle(url: string, value: ResolvedPhotoUrl): void {
    const waiters = waiting.get(url) ?? [];
    waiting.delete(url);
    for (const waiter of waiters) waiter.resolve(value);
  }

  async function flushChunk(urls: string[]): Promise<void> {
    let response: SignedPhotoUrlsResponse;
    try {
      response = await options.fetchSigned(urls);
    } catch {
      for (const url of urls) settle(url, { url: null, refreshAt: null });
      return;
    }
    for (const url of urls) {
      const value = response.signedUrls[url];
      settle(url, remember(url, typeof value === 'string' ? value : null, response.expiresInSeconds));
    }
  }

  function flush(): void {
    scheduled = false;
    const urls = queued;
    queued = [];
    for (let i = 0; i < urls.length; i += MAX_PHOTO_URLS_PER_SIGN_REQUEST) {
      void flushChunk(urls.slice(i, i + MAX_PHOTO_URLS_PER_SIGN_REQUEST));
    }
  }

  return {
    peek(url) {
      if (!isPhotoStorageUrl(url)) return { url, refreshAt: null };
      return lookup(url);
    },
    resolve(url) {
      if (!isPhotoStorageUrl(url)) return Promise.resolve({ url, refreshAt: null });
      const hit = lookup(url);
      if (hit) return Promise.resolve(hit);
      return new Promise<ResolvedPhotoUrl>((resolve) => {
        const waiters = waiting.get(url);
        if (waiters) {
          waiters.push({ resolve });
          return;
        }
        waiting.set(url, [{ resolve }]);
        queued.push(url);
        if (!scheduled) {
          scheduled = true;
          schedule(flush);
        }
      });
    },
    clear() {
      cache.clear();
    },
  };
}

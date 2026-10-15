/**
 * Storage の URL からバケット名とパスを取り出し、そのオブジェクトが誰のものかを判定する
 * - Next.js / Supabase Edge Functions 共用
 *
 * 使う側:
 *   - 退会 (#1175): src/lib/account-deletion-storage.ts (ここから import して、同じ名前で export し直す)
 *   - 運営が隠したコンテンツの完全削除 (#1538): supabase/functions/_shared/hidden-content-purge.ts
 *
 * URL は利用者が書き換えられる列 (meals.photo_url・recipes.image_url など) にも入るので、URL だけを信用しない。
 * 他人のファイルを消さないための決まりは isOwnedObjectPath の説明のとおり。
 *
 * このファイルが守る制約 (崩すと Edge Functions か Next.js のどちらかが動かなくなる):
 *  - 純粋な TypeScript。import なし、Deno / Node 固有の API なし (使うのは Web 標準の URL と decodeURIComponent だけ)。
 *    Next.js 側は相対パスで拡張子なしに import する (cron-secret.ts と同じ前例)。import を足すと、Deno 側は拡張子つきの
 *    import が要り、Next.js の tsc は拡張子つきの import を受け付けないので、どちらかが壊れる。
 */

/** アプリが写真を置くバケット (退会のときに掃除するもの・完全削除で消してよいもの) */
export const STORAGE_OBJECT_BUCKETS = ['meal_photos', 'fridge-images', 'health-checkups'] as const;
export type StorageObjectBucket = (typeof STORAGE_OBJECT_BUCKETS)[number];

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 制御文字の範囲 (この値より小さい文字コード) と DEL。パスの区間に入っていたら怪しいとみなす */
const FIRST_PRINTABLE_CHAR_CODE = 0x20;
const DEL_CHAR_CODE = 0x7f;

/**
 * Storage の URL からバケット名とパスを取り出す。
 *   https://<host>/storage/v1/object/public/<bucket>/<path>
 *   https://<host>/storage/v1/object/sign/<bucket>/<path>?token=…
 *   https://<host>/storage/v1/object/authenticated/<bucket>/<path>
 *   https://<host>/storage/v1/render/image/public/<bucket>/<path>?width=…
 * 3 つのバケット以外、Storage の URL でないもの、パスが空のもの、パスの組み立てが怪しいものは null。
 *
 * 「パスの組み立てが怪しい」= 区切りの `/` を `%2F` で隠したもの、`.` / `..` の区間、空の区間、制御文字を含むもの。
 * URL は利用者が書き換えられる列にも入るので、`old/<本人の id>/..%2F<他人の id>/x.png` のような形で
 * 「本人のパス」に見せかけた別のオブジェクトを指させないようにする (URL の解釈でも `..` は解決されるが、`%2F` は解決されない)。
 */
export function parseStorageObjectUrl(raw: unknown): { bucket: StorageObjectBucket; path: string } | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let pathname: string;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    return null;
  }
  const match = /^\/storage\/v1\/(?:object|render\/image)\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return null;

  let bucket: string;
  let segments: string[];
  try {
    bucket = decodeURIComponent(match[1]);
    segments = match[2].split('/').map(decodeURIComponent);
  } catch {
    return null; // 壊れたパーセントエンコード
  }
  if (!(STORAGE_OBJECT_BUCKETS as readonly string[]).includes(bucket)) return null;
  if (segments.some(isSuspiciousPathSegment)) return null;
  return { bucket: bucket as StorageObjectBucket, path: segments.join('/') };
}

/** デコードしたあとの 1 区間が、パスの組み立てに使われていそうな形か (空 / `.` / `..` / `/` `\` / 制御文字) */
function isSuspiciousPathSegment(segment: string): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..') return true;
  for (const ch of segment) {
    const code = ch.charCodeAt(0);
    if (ch === '/' || ch === '\\' || code < FIRST_PRINTABLE_CHAR_CODE || code === DEL_CHAR_CODE) return true;
  }
  return false;
}

/**
 * URL が指すオブジェクトを消してよいか (本人のものか)。
 *   - 先頭が他の利用者の uuid (= 他人のフォルダ) なら、いかなる場合も false
 *   - パスの中に本人の user_id がある (旧パス `<folder>/<user_id>/…` など) なら true
 *   - `generated/<本人の献立の id>/…` なら true (ownedPlannedMealIds は本人の献立の id だけを渡すこと)
 *   - それ以外 (持ち主がパスから分からない) は false
 */
export function isOwnedObjectPath(path: string, userId: string, ownedPlannedMealIds: ReadonlySet<string>): boolean {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  if (UUID_PATTERN.test(segments[0]) && segments[0].toLowerCase() !== userId.toLowerCase()) return false;
  if (segments.some((segment) => segment.toLowerCase() === userId.toLowerCase())) return true;
  return segments[0] === 'generated' && segments.length >= 3 && ownedPlannedMealIds.has(segments[1].toLowerCase());
}

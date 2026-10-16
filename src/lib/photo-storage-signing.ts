/**
 * 食事写真・冷蔵庫写真 (meal_photos / fridge-images) の署名付き URL をサーバーで作る (#1365 段 1)。
 *
 * 2 つのバケットは非公開 (段 2。migration `…_private_photo_buckets.sql`。番号の付け替えで古くならないよう、番号は書かない)。
 * DB には公開 URL と同じ形の文字列 (保存形。オブジェクトを指す識別子で、そのままでは読めない) が保存されている (書き換えない)。
 * 画面と AI の読み出しは、保存された URL からバケットとパスを取り出し、ここで署名した URL を使う。
 *
 * 他人の写真に署名しないための決まり (保存された URL は利用者が書き換えられる列にも入るので、URL だけを信用しない。
 * 退会の掃除 (src/lib/account-deletion-storage.ts) と同じ決まりを使う):
 *   - URL からバケット名とパスを取り出し (parseStorageObjectUrl。`%2F` や `..` で別のパスを指させる形は弾く)、
 *     2 つのバケット以外には署名しない。
 *   - パスの先頭が「本人以外の uuid」(= 他の利用者のフォルダ) なら署名しない。
 *   - パスの中に本人の user_id がある (今の `<user_id>/…` と旧パス `meals/<user_id>/…` など)、
 *     または `generated/<本人の献立の id>/…` (画像生成ジョブの画像) のものだけに署名する。
 *     本人の献立の id は、user_daily_meals.user_id が本人の planned_meals の行から取る (利用者が書ける列の値は使わない)。
 *   - 持ち主がパスから分からないもの (旧パスのバケット直下の `<タイムスタンプ>.jpg` など) には署名しない。
 *
 * 署名は service_role の client で行う (storage.objects の RLS は本人のフォルダ `<user_id>/…` しか許さず、
 * 旧パスと generated/ に署名できないため)。呼び出し側は、先に本人を確かめた user id だけを渡すこと。
 *
 * このファイルは Next.js の実行環境に依存しない (単体テストと結合テストから直接呼べる)。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PHOTO_STORAGE_BUCKETS, type PhotoStorageBucket } from '@homegohan/shared';
import { isOwnedObjectPath, parseStorageObjectUrl } from './account-deletion-storage';

/** 署名付き URL の有効期限の既定 (秒)。画面を開いている間に切れにくく、URL が漏れても長くは使えない長さ */
export const PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS = 3600;
/** 環境変数で上書きできる有効期限の下限 (秒)。画面は期限の前に取り直すので、短すぎると問い合わせが増えるだけになる */
export const PHOTO_SIGNED_URL_MIN_TTL_SECONDS = 60;
/** 環境変数で上書きできる有効期限の上限 (秒。1 日)。漏れた URL が使える時間を 1 日より長くしない */
export const PHOTO_SIGNED_URL_MAX_TTL_SECONDS = 86_400;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 画像生成ジョブの画像のパスの頭 (`generated/<planned_meal_id>/<job_id>-<timestamp>.png`。process-meal-image-jobs) */
const GENERATED_FOLDER = 'generated';

/**
 * 署名付き URL の有効期限 (秒)。環境変数 PHOTO_SIGNED_URL_TTL_SECONDS が
 * PHOTO_SIGNED_URL_MIN_TTL_SECONDS 以上 PHOTO_SIGNED_URL_MAX_TTL_SECONDS 以下の整数ならその値、
 * 未設定・範囲の外・整数でないときは PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS
 */
export function photoSignedUrlTtlSeconds(value: string | undefined = process.env.PHOTO_SIGNED_URL_TTL_SECONDS): number {
  if (value === undefined || value.trim() === '') return PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= PHOTO_SIGNED_URL_MIN_TTL_SECONDS && parsed <= PHOTO_SIGNED_URL_MAX_TTL_SECONDS
    ? parsed
    : PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS;
}

/** 署名に使う client (service_role)。テストでは from と storage だけを持つ偽物を渡す */
export type PhotoSigningAdmin = Pick<SupabaseClient, 'from' | 'storage'>;

export interface PhotoObject {
  bucket: PhotoStorageBucket;
  path: string;
}

/** 保存された URL から、2 つのバケットのどれかのオブジェクトを取り出す。それ以外の URL・怪しいパスは null */
export function parsePhotoObjectUrl(raw: unknown): PhotoObject | null {
  const parsed = parseStorageObjectUrl(raw);
  if (!parsed) return null;
  if (!(PHOTO_STORAGE_BUCKETS as readonly string[]).includes(parsed.bucket)) return null;
  return { bucket: parsed.bucket as PhotoStorageBucket, path: parsed.path };
}

export interface SignPhotoUrlsResult {
  /** 渡した URL ごとの、署名付き URL か null (2 つのバケットの URL でない・本人の写真でない・ファイルが無い・署名に失敗した) */
  signedUrls: Record<string, string | null>;
  /** 署名を頼んだのに失敗した数 (ファイルが無いものを含む)。持ち主の確認で断ったものは数えない */
  signFailures: number;
  /** 本人の写真でないので署名しなかった数 */
  notOwned: number;
}

/** パスが `generated/<uuid>/…` なら、その uuid (小文字)。それ以外は null */
function generatedPlannedMealId(path: string): string | null {
  const segments = path.split('/');
  if (segments.length < 3 || segments[0] !== GENERATED_FOLDER) return null;
  return UUID_PATTERN.test(segments[1]) ? segments[1].toLowerCase() : null;
}

/**
 * 渡した献立の id のうち、本人の献立 (user_daily_meals.user_id が本人) のものだけを返す。
 * 読み出しに失敗したら空 (= どれにも署名しない。fail-closed)
 */
async function ownedPlannedMealIdsAmong(
  admin: PhotoSigningAdmin,
  userId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const owned = new Set<string>();
  if (candidateIds.length === 0) return owned;
  const { data, error } = await admin
    .from('planned_meals')
    .select('id, user_daily_meals!inner(user_id)')
    .eq('user_daily_meals.user_id', userId)
    .in('id', [...candidateIds]);
  if (error || !Array.isArray(data)) return owned;
  for (const row of data as Array<{ id?: unknown }>) {
    if (typeof row.id === 'string') owned.add(row.id.toLowerCase());
  }
  return owned;
}

interface StorageSignedUrlItem {
  error: string | null;
  path: string | null;
  signedUrl: string | null;
}

/** バケットごとにまとめて署名する。返り値は「バケット/パス」→ 署名付き URL か null */
async function signObjects(
  admin: PhotoSigningAdmin,
  objects: readonly PhotoObject[],
  ttlSeconds: number,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const pathsByBucket = new Map<PhotoStorageBucket, string[]>();
  for (const object of objects) {
    const paths = pathsByBucket.get(object.bucket) ?? [];
    if (!paths.includes(object.path)) paths.push(object.path);
    pathsByBucket.set(object.bucket, paths);
  }
  for (const [bucket, paths] of pathsByBucket) {
    let items: StorageSignedUrlItem[] = [];
    try {
      const { data, error } = await admin.storage.from(bucket).createSignedUrls(paths, ttlSeconds);
      if (!error && Array.isArray(data)) items = data as StorageSignedUrlItem[];
    } catch {
      items = [];
    }
    // 応答はパスで突き合わせる (頼んでいないパスの署名付き URL を、別の URL の答えにしない)
    const itemByPath = new Map<string, StorageSignedUrlItem>();
    for (const item of items) {
      if (item && typeof item.path === 'string') itemByPath.set(item.path, item);
    }
    for (const path of paths) {
      const item = itemByPath.get(path);
      const signed = item && !item.error && typeof item.signedUrl === 'string' && item.signedUrl.length > 0 ? item.signedUrl : null;
      result.set(objectKey({ bucket, path }), signed);
    }
  }
  return result;
}

function objectKey(object: PhotoObject): string {
  return `${object.bucket}/${object.path}`;
}

/**
 * 本人の写真の URL にだけ署名する。
 * @param userId 先に認証で確かめた本人の user id (利用者が送った値を渡さない)
 */
export async function signOwnedPhotoUrls(
  admin: PhotoSigningAdmin,
  userId: string,
  urls: readonly string[],
  ttlSeconds: number = photoSignedUrlTtlSeconds(),
): Promise<SignPhotoUrlsResult> {
  const signedUrls: Record<string, string | null> = {};
  const parsedByUrl = new Map<string, PhotoObject>();
  const generatedIds = new Set<string>();
  for (const url of urls) {
    signedUrls[url] = null;
    const parsed = parsePhotoObjectUrl(url);
    if (!parsed) continue;
    parsedByUrl.set(url, parsed);
    const plannedMealId = generatedPlannedMealId(parsed.path);
    if (plannedMealId) generatedIds.add(plannedMealId);
  }

  const ownedPlannedMealIds = await ownedPlannedMealIdsAmong(admin, userId, [...generatedIds]);
  const owned: PhotoObject[] = [];
  let notOwned = 0;
  for (const [url, object] of parsedByUrl) {
    if (isOwnedObjectPath(object.path, userId, ownedPlannedMealIds)) {
      owned.push(object);
    } else {
      notOwned += 1;
      parsedByUrl.delete(url);
    }
  }

  const signedByObject = await signObjects(admin, owned, ttlSeconds);
  let signFailures = 0;
  for (const [url, object] of parsedByUrl) {
    const signed = signedByObject.get(objectKey(object)) ?? null;
    if (signed === null) signFailures += 1;
    signedUrls[url] = signed;
  }
  return { signedUrls, signFailures, notOwned };
}

/**
 * 持ち主を確かめずに署名する。運営の審査 (通報された写真を見る) のように、呼び出し側が先に
 * 役割 (requireRole) で見てよい人だと確かめた場合にだけ使う。2 つのバケットの URL 以外は null。
 */
export async function signPhotoUrlsForAuthorizedViewer(
  admin: PhotoSigningAdmin,
  urls: readonly string[],
  ttlSeconds: number = photoSignedUrlTtlSeconds(),
): Promise<Record<string, string | null>> {
  const signedUrls: Record<string, string | null> = {};
  const objects: Array<[string, PhotoObject]> = [];
  for (const url of urls) {
    signedUrls[url] = null;
    const parsed = parsePhotoObjectUrl(url);
    if (parsed) objects.push([url, parsed]);
  }
  const signedByObject = await signObjects(
    admin,
    objects.map(([, object]) => object),
    ttlSeconds,
  );
  for (const [url, object] of objects) signedUrls[url] = signedByObject.get(objectKey(object)) ?? null;
  return signedUrls;
}

export type PhotoReadUrlResolution =
  /** 読み出しに使う URL (2 つのバケットの URL なら本人の写真に署名したもの、それ以外は渡された URL のまま) */
  | { ok: true; url: string }
  /** 2 つのバケットの URL だが、本人の写真でない・ファイルが無い・署名に失敗した */
  | { ok: false };

/**
 * サーバーが写真を読み出す (AI に渡す) 前に、URL を読み出せるものにする。
 *   - 2 つのバケットの URL: 本人の写真なら署名付き URL。本人の写真でなければ { ok: false } (他人の写真を AI に渡さない)
 *   - それ以外の URL: そのまま (今までどおり、呼び出し側のホストの確かめに任せる)
 */
export async function resolvePhotoUrlForOwnerRead(
  admin: PhotoSigningAdmin,
  userId: string,
  url: string,
  ttlSeconds: number = photoSignedUrlTtlSeconds(),
): Promise<PhotoReadUrlResolution> {
  if (!parsePhotoObjectUrl(url)) return { ok: true, url };
  const { signedUrls } = await signOwnedPhotoUrls(admin, userId, [url], ttlSeconds);
  const signed = signedUrls[url];
  return signed ? { ok: true, url: signed } : { ok: false };
}

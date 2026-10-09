/**
 * 退会 (#1175) のときに、本人の Storage のファイルを消す。
 *
 * 消すもの (すべて service_role の client で、退会 API が本人を確認したあとにだけ呼ぶ):
 *   1. 3 つのバケット (meal_photos / fridge-images / health-checkups) の `<user_id>/` 以下。
 *      現在の保存先はすべてこの形 (src/lib/storage-paths.ts。storage.objects の RLS が本人のフォルダだけを許可する)。
 *   2. 旧パス `<folder>/<user_id>/…` (#1260 より前の保存先: meals/<user_id>/・generated/<user_id>/・uploads/<user_id>/)。
 *   3. 本人の行に保存された URL が指す、1・2 の外にあるオブジェクト (ベストエフォート)。
 *        - `generated/<planned_meal_id>/…`: 画像生成ジョブ (Edge Function process-meal-image-jobs) が
 *          本人の献立 (planned_meals) の画像として保存したもの。
 *
 * 他人のファイルを消さないための決まり (3 の URL は利用者が書き換えられる列にも入るため、URL だけを信用しない):
 *   - URL からバケット名とパスを取り出し、3 つのバケット以外は触らない。
 *   - パスの先頭が「本人以外の uuid」(= 他の利用者のフォルダ) なら触らない。
 *   - パスの中に本人の user_id がある、または `generated/<本人の献立の id>/…` の形のものだけを消す。
 *     本人の献立の id は、user_daily_meals.user_id が本人の planned_meals の行から取る (利用者が書ける列の値は使わない)。
 *   - 名前だけで持ち主が分からないファイル (旧パスのバケット直下の `<タイムスタンプ>.jpg` など) は消さない。
 *
 * 1・2 の失敗は例外にして退会を止める (写真が残ったまま本人の紐づけだけが消えるのを防ぐ。やり直せる: 何度流しても同じ結果)。
 * 3 の「URL を集める」失敗は警告にとどめる (ベストエフォート)。集めたオブジェクトの削除の失敗は例外にする。
 *
 * このファイルは Next.js の実行環境に依存しない (単体テストと結合テストから直接呼べる)。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** 退会時に掃除するバケット */
export const ACCOUNT_STORAGE_BUCKETS = ['meal_photos', 'fridge-images', 'health-checkups'] as const;
export type AccountStorageBucket = (typeof ACCOUNT_STORAGE_BUCKETS)[number];

/** #1260 より前に使われていた `<folder>/<user_id>/…` の <folder>。これらのバケットにだけ旧パスがありうる */
export const LEGACY_FOLDER_PARENTS = ['meals', 'generated', 'uploads'] as const;
export const LEGACY_FOLDER_BUCKETS: readonly AccountStorageBucket[] = ['fridge-images', 'meal_photos'];

/** list の 1 回の取得件数 / remove の 1 回の削除件数 (Storage API の上限 1000 より小さくしておく) */
export const STORAGE_LIST_PAGE_SIZE = 500;
export const STORAGE_REMOVE_BATCH_SIZE = 500;
/** 1 つのフォルダで「一覧 → 削除」を繰り返す回数の上限 (500 件 × 1000 回 = 50 万件)。超えたら失敗にする */
const MAX_DRAIN_ROUNDS = 1000;
/** フォルダの深さの上限 (本人のフォルダの下は <用途>/<ファイル> の 2 段が通常) */
const MAX_FOLDER_DEPTH = 8;
/** DB の読み出しは 1000 行ずつ (PostgREST の max_rows の既定) */
const DB_PAGE_SIZE = 1000;
/** 全体の時間の上限の既定 (ms)。退会 API の maxDuration (60 秒) より短くして、制御された失敗で終わらせる */
export const DEFAULT_MAX_DURATION_MS = 45_000;
/** 一覧に出ているのに 1 件も消せなかった回数がこれに達したら失敗にする (別の退会処理が同時に消している場合を許すため 1 回では止めない) */
const MAX_STALLED_ROUNDS = 3;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Storage 掃除に使う client。service_role の SupabaseClient を渡す */
export type AccountStorageAdmin = Pick<SupabaseClient, 'from' | 'storage'>;

/** 掃除の途中経過を残すロガー (db-logger の createLogger(...) が返すものの一部) */
export interface AccountStorageLogger {
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface AccountStorageResult {
  /** 消したオブジェクトの数 (バケットごと) */
  removed_by_bucket: Record<string, number>;
  /** 消したオブジェクトの合計 */
  removed_total: number;
  /** URL から見つけて消したオブジェクトの数 (removed_total の内数) */
  removed_by_reference: number;
  /** URL から見つけたが、持ち主を確認できず消さなかった数 */
  skipped_unowned: number;
  /** URL を集める途中で失敗した読み出しの数 (ベストエフォートのため、退会は止めない) */
  reference_read_errors: number;
}

export class AccountStorageTimeoutError extends Error {
  constructor() {
    super('account storage cleanup exceeded its time budget');
    this.name = 'AccountStorageTimeoutError';
  }
}

interface StorageErrorLike {
  message?: string;
  status?: number | string;
  statusCode?: number | string;
}

/** バケットが無い (404 Bucket not found)。消すものが無いのと同じなので失敗にしない */
function isBucketMissing(error: StorageErrorLike): boolean {
  return /bucket not found/i.test(error.message ?? '');
}

function describeStorageError(action: string, bucket: string, error: StorageErrorLike): Error {
  // メッセージにはパスを入れない (ファイル名から個人が分かることがある)
  return new Error(`storage ${action} failed (bucket=${bucket}): ${error.message ?? 'unknown error'}`);
}

interface Budget {
  /** これを過ぎたら AccountStorageTimeoutError を投げる時刻 (ms)。無制限にするときは Infinity */
  deadlineAt: number;
  now: () => number;
}

function assertWithinBudget(budget: Budget): void {
  if (budget.now() > budget.deadlineAt) {
    throw new AccountStorageTimeoutError();
  }
}

/** 渡されたパスのオブジェクトを消す。消せた数を返す。バケットが無ければ 0 */
async function removeObjects(
  admin: AccountStorageAdmin,
  bucket: string,
  paths: readonly string[],
  budget: Budget,
): Promise<number> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += STORAGE_REMOVE_BATCH_SIZE) {
    assertWithinBudget(budget);
    const chunk = paths.slice(i, i + STORAGE_REMOVE_BATCH_SIZE);
    const { data, error } = await admin.storage.from(bucket).remove(chunk);
    if (error) {
      if (isBucketMissing(error)) return removed;
      throw describeStorageError('remove', bucket, error);
    }
    removed += data?.length ?? 0;
  }
  return removed;
}

/**
 * prefix 以下のオブジェクトを (サブフォルダも含めて) すべて消す。消せた数を返す。
 * 一覧は常に先頭 (offset 0) から取り直す: 消したぶんだけ次の一覧が前に詰まるため。
 */
async function removeFolder(
  admin: AccountStorageAdmin,
  bucket: string,
  prefix: string,
  budget: Budget,
  depth = 0,
): Promise<number> {
  if (depth > MAX_FOLDER_DEPTH) {
    throw new Error(`storage folder is nested too deeply (bucket=${bucket})`);
  }

  let removed = 0;
  let stalledRounds = 0;
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
    assertWithinBudget(budget);
    const { data, error } = await admin.storage
      .from(bucket)
      .list(prefix, { limit: STORAGE_LIST_PAGE_SIZE, offset: 0 });
    if (error) {
      if (isBucketMissing(error)) return removed;
      throw describeStorageError('list', bucket, error);
    }
    if (!data || data.length === 0) return removed;

    // フォルダは id が null で返る (ファイルは id が入っている)
    const files = data.filter((entry) => entry.id != null).map((entry) => `${prefix}/${entry.name}`);
    const folders = data.filter((entry) => entry.id == null).map((entry) => entry.name);

    let removedNow = 0;
    if (files.length > 0) removedNow = await removeObjects(admin, bucket, files, budget);
    for (const folder of folders) {
      removedNow += await removeFolder(admin, bucket, `${prefix}/${folder}`, budget, depth + 1);
    }
    removed += removedNow;

    // 一覧に出ているのに何も消せない状態が続くなら、繰り返しても進まないので失敗にする
    stalledRounds = removedNow === 0 ? stalledRounds + 1 : 0;
    if (stalledRounds >= MAX_STALLED_ROUNDS) {
      throw new Error(`storage remove made no progress (bucket=${bucket})`);
    }
  }
  throw new Error(`storage folder did not drain within ${MAX_DRAIN_ROUNDS} rounds (bucket=${bucket})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DB に保存された URL が指すオブジェクト
// ─────────────────────────────────────────────────────────────────────────────

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
export function parseStorageObjectUrl(raw: unknown): { bucket: AccountStorageBucket; path: string } | null {
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
  if (!(ACCOUNT_STORAGE_BUCKETS as readonly string[]).includes(bucket)) return null;
  if (segments.some(isSuspiciousPathSegment)) return null;
  return { bucket: bucket as AccountStorageBucket, path: segments.join('/') };
}

/** デコードしたあとの 1 区間が、パスの組み立てに使われていそうな形か (空 / `.` / `..` / `/` `\` / 制御文字) */
function isSuspiciousPathSegment(segment: string): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..') return true;
  for (const ch of segment) {
    const code = ch.charCodeAt(0);
    if (ch === '/' || ch === '\\' || code < 0x20 || code === 0x7f) return true;
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

interface PageResult {
  data: Record<string, unknown>[] | null;
  error: { message: string } | null;
}

/** 1000 行ずつ最後まで読む。読み出しに失敗したら例外 */
async function readAllRows(fetchPage: (from: number, to: number) => PromiseLike<PageResult>): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += DB_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + DB_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < DB_PAGE_SIZE) return rows;
  }
}

interface ReferencedUrls {
  /** 本人の献立の id (user_daily_meals.user_id が本人の planned_meals の行から取ったもの) */
  ownedPlannedMealIds: Set<string>;
  urls: string[];
  readErrors: number;
}

/** 本人の行に保存された、Storage の URL を集める (ベストエフォート: 読み出しに失敗した列は飛ばして数える) */
async function collectReferencedUrls(
  admin: AccountStorageAdmin,
  userId: string,
  log?: AccountStorageLogger,
): Promise<ReferencedUrls> {
  const result: ReferencedUrls = { ownedPlannedMealIds: new Set(), urls: [], readErrors: 0 };

  const sources: ReadonlyArray<{ label: string; column: string; read: () => Promise<Record<string, unknown>[]> }> = [
    {
      label: 'meals.photo_url',
      column: 'photo_url',
      read: () =>
        readAllRows((from, to) =>
          admin.from('meals').select('id, photo_url').eq('user_id', userId).not('photo_url', 'is', null).order('id').range(from, to),
        ),
    },
    {
      label: 'health_checkups.image_url',
      column: 'image_url',
      read: () =>
        readAllRows((from, to) =>
          admin.from('health_checkups').select('id, image_url').eq('user_id', userId).not('image_url', 'is', null).order('id').range(from, to),
        ),
    },
    {
      label: 'blood_test_results.report_image_url',
      column: 'report_image_url',
      read: () =>
        readAllRows((from, to) =>
          admin
            .from('blood_test_results')
            .select('id, report_image_url')
            .eq('user_id', userId)
            .not('report_image_url', 'is', null)
            .order('id')
            .range(from, to),
        ),
    },
    {
      label: 'weekly_menu_requests.inventory_image_url',
      column: 'inventory_image_url',
      read: () =>
        readAllRows((from, to) =>
          admin
            .from('weekly_menu_requests')
            .select('id, inventory_image_url')
            .eq('user_id', userId)
            .not('inventory_image_url', 'is', null)
            .order('id')
            .range(from, to),
        ),
    },
    {
      label: 'meal_image_jobs.result_image_url',
      column: 'result_image_url',
      read: () =>
        readAllRows((from, to) =>
          admin
            .from('meal_image_jobs')
            .select('id, result_image_url')
            .eq('user_id', userId)
            .not('result_image_url', 'is', null)
            .order('id')
            .range(from, to),
        ),
    },
  ];

  for (const source of sources) {
    try {
      for (const row of await source.read()) {
        const value = row[source.column];
        if (typeof value === 'string') result.urls.push(value);
      }
    } catch (error) {
      result.readErrors += 1;
      log?.warn('account deletion: could not read storage urls from a table (skipped)', {
        source: source.label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 本人の献立: user_daily_meals.user_id が本人の行だけ。画像の URL と、持ち主の確認に使う献立の id を取る
  try {
    const plannedMeals = await readAllRows((from, to) =>
      admin
        .from('planned_meals')
        .select('id, image_url, user_daily_meals!inner(user_id)')
        .eq('user_daily_meals.user_id', userId)
        .order('id')
        .range(from, to),
    );
    for (const row of plannedMeals) {
      if (typeof row.id === 'string') result.ownedPlannedMealIds.add(row.id.toLowerCase());
      if (typeof row.image_url === 'string') result.urls.push(row.image_url);
    }
  } catch (error) {
    result.readErrors += 1;
    log?.warn('account deletion: could not read planned_meals image urls (skipped)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

/**
 * 本人の Storage のファイルを消す。
 * @param options.maxDurationMs 全体の時間の上限 (既定 45 秒)。超えたら AccountStorageTimeoutError (やり直せる)
 */
export async function removeAccountStorage(
  admin: AccountStorageAdmin,
  userId: string,
  options: { log?: AccountStorageLogger; maxDurationMs?: number; now?: () => number } = {},
): Promise<AccountStorageResult> {
  if (!UUID_PATTERN.test(userId)) {
    // 空文字や不正な値で `/` 直下を掃除してしまわないための安全装置
    throw new Error('removeAccountStorage: userId must be a uuid');
  }

  const now = options.now ?? Date.now;
  const budget: Budget = { deadlineAt: now() + (options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS), now };

  const removedByBucket: Record<string, number> = Object.fromEntries(ACCOUNT_STORAGE_BUCKETS.map((bucket) => [bucket, 0]));

  // 1. 本人のフォルダ <user_id>/ 以下 (現在の保存先)
  for (const bucket of ACCOUNT_STORAGE_BUCKETS) {
    removedByBucket[bucket] += await removeFolder(admin, bucket, userId, budget);
  }

  // 2. 旧パス <folder>/<user_id>/ 以下 (#1260 より前)
  for (const bucket of LEGACY_FOLDER_BUCKETS) {
    for (const parent of LEGACY_FOLDER_PARENTS) {
      removedByBucket[bucket] += await removeFolder(admin, bucket, `${parent}/${userId}`, budget);
    }
  }

  // 3. 本人の行に保存された URL が指すオブジェクト (1・2 で消したものは飛ばす)
  const referenced = await collectReferencedUrls(admin, userId, options.log);
  const pathsByBucket = new Map<AccountStorageBucket, Set<string>>();
  let skippedUnowned = 0;
  for (const url of referenced.urls) {
    const parsed = parseStorageObjectUrl(url);
    if (!parsed) continue;
    const alreadySwept =
      parsed.path.startsWith(`${userId}/`) ||
      LEGACY_FOLDER_PARENTS.some((parent) => parsed.path.startsWith(`${parent}/${userId}/`));
    if (alreadySwept) continue;
    if (!isOwnedObjectPath(parsed.path, userId, referenced.ownedPlannedMealIds)) {
      skippedUnowned += 1;
      continue;
    }
    if (!pathsByBucket.has(parsed.bucket)) pathsByBucket.set(parsed.bucket, new Set());
    pathsByBucket.get(parsed.bucket)!.add(parsed.path);
  }

  let removedByReference = 0;
  for (const [bucket, paths] of pathsByBucket) {
    const removed = await removeObjects(admin, bucket, [...paths], budget);
    removedByBucket[bucket] += removed;
    removedByReference += removed;
  }

  const removedTotal = Object.values(removedByBucket).reduce((sum, n) => sum + n, 0);
  return {
    removed_by_bucket: removedByBucket,
    removed_total: removedTotal,
    removed_by_reference: removedByReference,
    skipped_unowned: skippedUnowned,
    reference_read_errors: referenced.readErrors,
  };
}

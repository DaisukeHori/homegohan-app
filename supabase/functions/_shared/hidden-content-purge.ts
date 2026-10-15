/**
 * 運営が隠したコンテンツ (#1101) を、隠してから保管期間 (90 日) を過ぎたら完全に消す (#1538)
 * - Edge Function purge-hidden-content の本体。単体テストと結合テストからも直接呼ぶ (時刻 now を渡して固定する)
 *
 * オーナーの選択 (2026-10-15、Issue #1538 のコメント): 運営が隠したコンテンツは、90 日後に完全削除する (定期のジョブ)。
 *
 * 対象 (#1101 / #1445 で hidden_at を足した表は、この 2 つだけ: supabase/migrations/20261009000500_hide_moderated_content.sql):
 *   - meals   (食事の記録)  画像の列は photo_url
 *   - recipes (レシピ)      画像の列は image_url
 *   hidden_at が「now の 90 日前」より前 (= 隠してから 90 日を過ぎた) の行。90 日ちょうどの行はまだ消さない。
 *
 * 手順 (表ごとに、古い順に BATCH_SIZE 行ずつ):
 *   1. 行の画像の URL から Storage のオブジェクトを探し、消してよいものだけを Storage API で消す
 *      (storage.objects には protect_objects_delete トリガーがあり、SQL では画像のファイルを消せないため、この関数は Edge Function で動く)
 *   2. 行を消す (DELETE ... WHERE id IN (...) AND hidden_at < 期限。消す直前にも期限を確かめ直す)
 *      関連の行は外部キーの ON DELETE のとおりに動く (退会 #1175 で食事・レシピが消えるときと同じ):
 *        - 通報 (moderation_flags.meal_id / recipe_flags.recipe_id)・食事の AI の評価・栄養の推定・レシピのいいね・コメント・
 *          コレクションの項目は CASCADE で一緒に消える
 *        - 献立の実績 (planned_meals.actual_meal_id)・レシピの依頼 (recipe_requests.base_meal_id) は SET NULL で行が残る
 *        - 運営の判断の記録 (admin_audit_logs。通報の ID・持ち主・コンテンツの ID・隠した行の ID) は外部キーが無いので残る
 *   画像を先に消す: 行を先に消すと、画像の URL が分からなくなり、ファイルが残ったままになる。
 *   画像を消したあとで行の削除に失敗しても、次の回に同じ行をもう一度処理する (消えたファイルの削除は失敗にならない)。
 *
 * 消してよい画像 (他人のファイル・まだ使われているファイルを消さないための決まり):
 *   - URL が 3 つのバケット (meal_photos / fridge-images / health-checkups) の Storage の URL である (storage-object-url.ts)
 *   - パスが行の持ち主のもの (isOwnedObjectPath。パスの中に持ち主の user_id がある。先頭が他人の uuid なら消さない)。
 *     URL は利用者が書き換えられる列に入るので、他人のファイルの URL を自分の行に入れて隠されても、他人のファイルは消えない。
 *     持ち主の無い行 (退会で user_id が外れた公開レシピ) の画像は消さない (退会のときに本人のフォルダごと消えている)
 *   - 期限を過ぎていないほかの行 (隠していない行・まだ 90 日たっていない隠した行) が、同じオブジェクトを指していない
 *     (家族への貼り付けの複製のうち中身を書き換えて隠さなかった行・献立・健診などが同じ画像を使っていることがある)。
 *     確かめるのは DB の関数 public.hidden_content_purge_referenced_needles (migration 20261016100000_purge_hidden_content.sql)
 *
 * 1 回の実行の時間の上限 (MAX_DURATION_MS) を過ぎたら、その時点で止めて completed: false を返す (失敗ではない)。
 * 残りは次の回 (翌日) に消す。DB・Storage の失敗は例外にする (ジョブの実行は失敗として残り、次の回にやり直す)。
 *
 * Deno と Node の両方で読み込む (Deno の Edge Function と、vitest の単体・結合テスト)。import は型と storage-object-url.ts だけ。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isOwnedObjectPath, parseStorageObjectUrl, type StorageObjectBucket } from "./storage-object-url.ts";

/** 隠してから完全に消すまでの日数 (オーナーの選択 2026-10-15: 90 日)。変えるときはオーナーの判断を経て、このファイルを直す */
export const HIDDEN_CONTENT_RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 1 回に読んで消す行の数。消すときに id を URL のクエリ (id=in.(...)) に並べるので、uuid (36 文字 + 区切り) × この数が
 * URL の長さの上限 (ゲートウェイの既定で 8KB 前後) に収まるようにする
 */
export const HIDDEN_CONTENT_PURGE_BATCH_SIZE = 100;

/**
 * 1 回の実行の時間の上限 (ms)。Edge Function の実行時間の上限 (wall clock 400 秒) と、pg_net の応答の待ち時間の上限
 * (public.invoke_purge_hidden_content の c_timeout_ms = 400 秒) より短くして、時間切れで途中のまま切られずに、
 * 結果を返して終わる
 */
export const HIDDEN_CONTENT_PURGE_MAX_DURATION_MS = 300_000;

/** Storage の remove の 1 回の削除件数 (Storage API の上限 1000 より小さくしておく。退会の掃除と同じ値) */
const STORAGE_REMOVE_BATCH_SIZE = 500;

/** 同じオブジェクトをほかの行が指しているかを調べる DB の関数 (migration 20261016100000_purge_hidden_content.sql) */
export const REFERENCED_NEEDLES_RPC = "hidden_content_purge_referenced_needles";

/** 隠したコンテンツの表と、その画像の URL の列 */
export const HIDDEN_CONTENT_TABLES = [
  { table: "meals", imageColumn: "photo_url" },
  { table: "recipes", imageColumn: "image_url" },
] as const;

export type HiddenContentTable = (typeof HIDDEN_CONTENT_TABLES)[number]["table"];

/** 持ち主の判定に、献立の画像 (generated/<献立の id>/…) は使わない (隠したコンテンツの画像は利用者のフォルダにある) */
const NO_OWNED_PLANNED_MEALS: ReadonlySet<string> = new Set();

/** 完全削除に使う client。service_role の SupabaseClient を渡す */
export type HiddenContentPurgeAdmin = Pick<SupabaseClient, "from" | "storage" | "rpc">;

export interface HiddenContentPurgeOptions {
  /** 今の時刻。期限 (now − 90 日) はこれから決める。テストはこれで時刻を固定する */
  now: Date;
  /** 1 回に読んで消す行の数 (既定 HIDDEN_CONTENT_PURGE_BATCH_SIZE) */
  batchSize?: number;
  /** 時間の上限 (ms。既定 HIDDEN_CONTENT_PURGE_MAX_DURATION_MS) */
  maxDurationMs?: number;
  /** 経過時間を測る時計 (ms)。既定 Date.now。テストが時間切れを作るのに使う */
  clock?: () => number;
}

export interface HiddenContentPurgeResult {
  /** 期限。hidden_at がこれより前の行を消した */
  cutoff: string;
  /** 消した行の数 (表ごと) */
  deleted_rows: Record<HiddenContentTable, number>;
  /** 消した画像のオブジェクトの数 */
  removed_objects: number;
  /** 持ち主のものと確認できず、消さなかった画像の数 (他人のフォルダ・持ち主の無い行・パスから持ち主が分からないもの) */
  skipped_unowned_objects: number;
  /** ほかの行がまだ使っているので、消さなかった画像の数 */
  skipped_referenced_objects: number;
  /** 期限を過ぎた行を最後まで処理したか。false なら時間の上限で止めた (残りは次の回) */
  completed: boolean;
}

/** 期限 = now の 90 日前。hidden_at がこれより前の行が、完全削除の対象 */
export function hiddenContentCutoff(now: Date): Date {
  return new Date(now.getTime() - HIDDEN_CONTENT_RETENTION_DAYS * MS_PER_DAY);
}

interface StorageErrorLike {
  message?: string;
}

/** バケットが無い (404 Bucket not found)。消すものが無いのと同じなので失敗にしない */
function isBucketMissing(error: StorageErrorLike): boolean {
  return /bucket not found/i.test(error.message ?? "");
}

type ContentRow = { id: string; user_id: string | null; url: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * オブジェクトを指す URL に必ず含まれる部分 (`/<bucket>/<path>`)。パスの区間を符号化した形と、しない形の両方を返す
 * (同じオブジェクトを、日本語のファイル名などを符号化した URL と、していない URL の両方で指していることがある)
 */
export function objectNeedles(bucket: StorageObjectBucket, path: string): string[] {
  const decoded = `/${bucket}/${path}`;
  const encoded = `/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  return decoded === encoded ? [decoded] : [decoded, encoded];
}

interface ImageOutcome {
  removed: number;
  skippedUnowned: number;
  skippedReferenced: number;
}

/** 行の画像のうち、消してよいものを Storage API で消す */
async function removeRowImages(
  admin: HiddenContentPurgeAdmin,
  rows: readonly ContentRow[],
  cutoffIso: string,
): Promise<ImageOutcome> {
  // 同じオブジェクトを複数の行が指すことがある (家族への貼り付けの複製)。オブジェクトごとにまとめ、
  // どれかの行の持ち主のものなら「持ち主のもの」とする (複製の持ち主は、元の写真のパスの持ち主ではない)
  const objects = new Map<string, { bucket: StorageObjectBucket; path: string; owned: boolean }>();
  for (const row of rows) {
    const parsed = parseStorageObjectUrl(row.url);
    if (!parsed) continue; // 画像なし・外部の URL・3 つのバケット以外。消すファイルが無い
    const key = `${parsed.bucket}/${parsed.path}`;
    const owned = typeof row.user_id === "string" && isOwnedObjectPath(parsed.path, row.user_id, NO_OWNED_PLANNED_MEALS);
    const existing = objects.get(key);
    if (existing) existing.owned = existing.owned || owned;
    else objects.set(key, { ...parsed, owned });
  }

  const outcome: ImageOutcome = { removed: 0, skippedUnowned: 0, skippedReferenced: 0 };
  const owned = [...objects.values()].filter((object) => {
    if (!object.owned) outcome.skippedUnowned += 1;
    return object.owned;
  });
  if (owned.length === 0) return outcome;

  const needles = [...new Set(owned.flatMap((object) => objectNeedles(object.bucket, object.path)))];
  const { data: referencedData, error: referencedError } = await admin.rpc(REFERENCED_NEEDLES_RPC, {
    p_needles: needles,
    p_cutoff: cutoffIso,
  });
  if (referencedError) throw new Error(`${REFERENCED_NEEDLES_RPC} failed: ${referencedError.message}`);
  if (!Array.isArray(referencedData)) throw new Error(`${REFERENCED_NEEDLES_RPC} returned a non-array`);
  const referenced = new Set(referencedData.filter((needle): needle is string => typeof needle === "string"));

  const pathsByBucket = new Map<StorageObjectBucket, string[]>();
  for (const object of owned) {
    if (objectNeedles(object.bucket, object.path).some((needle) => referenced.has(needle))) {
      outcome.skippedReferenced += 1;
      continue;
    }
    const paths = pathsByBucket.get(object.bucket) ?? [];
    paths.push(object.path);
    pathsByBucket.set(object.bucket, paths);
  }

  for (const [bucket, paths] of pathsByBucket) {
    for (let i = 0; i < paths.length; i += STORAGE_REMOVE_BATCH_SIZE) {
      const { data, error } = await admin.storage.from(bucket).remove(paths.slice(i, i + STORAGE_REMOVE_BATCH_SIZE));
      if (error) {
        if (isBucketMissing(error)) break;
        // メッセージにはパスを入れない (ファイル名から個人が分かることがある)
        throw new Error(`storage remove failed (bucket=${bucket}): ${error.message ?? "unknown error"}`);
      }
      outcome.removed += data?.length ?? 0;
    }
  }
  return outcome;
}

/**
 * 隠してから 90 日を過ぎた行と、その画像を消す。
 * 何度流しても結果は同じ (消したものは対象から外れる)。途中で失敗したら例外 (次の回にやり直す)。
 */
export async function purgeExpiredHiddenContent(
  admin: HiddenContentPurgeAdmin,
  options: HiddenContentPurgeOptions,
): Promise<HiddenContentPurgeResult> {
  const batchSize = options.batchSize ?? HIDDEN_CONTENT_PURGE_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("purgeExpiredHiddenContent: batchSize must be a positive integer");
  }
  if (Number.isNaN(options.now.getTime())) {
    throw new Error("purgeExpiredHiddenContent: now must be a valid date");
  }
  const clock = options.clock ?? Date.now;
  const deadlineAt = clock() + (options.maxDurationMs ?? HIDDEN_CONTENT_PURGE_MAX_DURATION_MS);
  const cutoffIso = hiddenContentCutoff(options.now).toISOString();

  const result: HiddenContentPurgeResult = {
    cutoff: cutoffIso,
    deleted_rows: { meals: 0, recipes: 0 },
    removed_objects: 0,
    skipped_unowned_objects: 0,
    skipped_referenced_objects: 0,
    completed: true,
  };

  for (const spec of HIDDEN_CONTENT_TABLES) {
    for (;;) {
      if (clock() > deadlineAt) {
        result.completed = false;
        return result;
      }

      const { data, error } = await admin
        .from(spec.table)
        .select(`id, user_id, ${spec.imageColumn}`)
        .lt("hidden_at", cutoffIso)
        .order("hidden_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(batchSize);
      if (error) throw new Error(`${spec.table} read failed: ${error.message}`);
      // 列の名前を組み立てた select なので、行は形の分からない値として受け取り、列ごとに型を確かめて取り出す
      const rawRows: unknown[] = Array.isArray(data) ? data : [];
      const rows: ContentRow[] = rawRows.filter(isRecord).map((row) => ({
        id: String(row.id),
        user_id: typeof row.user_id === "string" ? row.user_id : null,
        url: row[spec.imageColumn],
      }));
      if (rows.length === 0) break;

      const images = await removeRowImages(admin, rows, cutoffIso);
      result.removed_objects += images.removed;
      result.skipped_unowned_objects += images.skippedUnowned;
      result.skipped_referenced_objects += images.skippedReferenced;

      const { data: deleted, error: deleteError } = await admin
        .from(spec.table)
        .delete()
        .in("id", rows.map((row) => row.id))
        .lt("hidden_at", cutoffIso)
        .select("id");
      if (deleteError) throw new Error(`${spec.table} delete failed: ${deleteError.message}`);
      const deletedCount = deleted?.length ?? 0;
      result.deleted_rows[spec.table] += deletedCount;

      // 読んだ行が 1 行も消えなかった (同時に別の処理が消した・戻した) なら、同じ行を読み続けないように止める
      if (deletedCount === 0 || rows.length < batchSize) break;
    }
  }

  return result;
}

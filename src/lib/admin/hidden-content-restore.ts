/**
 * 運営が隠したコンテンツ (#1101) を戻す (#1538 の項目 4) — 判定の純関数と、service_role での読み書き。
 * 呼ぶのは POST /api/admin/moderation/{type}/{id}/restore (設計 docs/design/operator/13-hidden-content-restore.md)。
 *
 * 隠すのは src/lib/admin/moderation-backend.ts の hideModeratedContent (1 回の UPDATE で、同じ操作で隠した行に同じ hidden_at を書く)。
 * 完全削除は pg_cron のジョブ purge-hidden-content (supabase/functions/_shared/hidden-content-purge.ts。隠してから 90 日を過ぎた行と画像を消す)。
 * 戻した行は hidden_at が NULL になるので、完全削除の対象から外れ、画像も「使っている行がある」として残る。
 *
 * - 戻せるのは、隠されていて (hidden_at IS NOT NULL)、隠してから HIDDEN_CONTENT_RESTORE_WINDOW_DAYS (89 日) 以内の行だけ
 * - 食事は、通報された行と同じ paste_group_id の隠れている行のうち、hidden_at が同じ行 (= 同じ操作で隠した複製) と、
 *   通報された行よりあとに隠れ、写真とメモが通報された行と今も同じ行 (= 同じ行への 2 件目以降の delete_* が隠した複製) をまとめて戻す。
 *   レシピはその行だけ
 * - 書く順は「通報 (rejected → approved) → 行 (hidden_* を NULL。hidden_at の値ごとに 1 文で、通報された行の組を最後に)」。
 *   通報された行が隠れたままなら、同じ操作をやり直して戻せる
 * - hidden_* を書き換えられるのは service_role だけ (DB のトリガー trg_meals_guard_hidden_columns・trg_recipes_guard_hidden_columns (関数 guard_hidden_content_columns)) なので、admin には
 *   認可 (requireRole) を通したあとの getSupabaseAdmin() を渡すこと
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModerationBackedType } from '@/lib/admin/moderation-backend';

/**
 * 隠してから完全に消すまでの日数の写し。正本は supabase/functions/_shared/hidden-content-purge.ts の HIDDEN_CONTENT_RETENTION_DAYS
 * (オーナーの選択 2026-10-15: 90 日)。Edge Function のモジュールは Deno の書き方 (拡張子つきの import) で、src から型検査を通して
 * import できないので、ここに写す。一致は契約テスト (tests/hidden-content-restore-contract.test.ts CT-1) が確かめる
 */
export const HIDDEN_CONTENT_RETENTION_DAYS = 90;

/**
 * 戻せる期間を保管期間より短くする幅 (日)。完全削除のジョブは「実行を始めた時刻の 90 日前」より前の行を消し、戻す操作は
 * 「要求の時刻の 89 日前」以後の行だけを戻す。2 つの期限は別の時刻で決まるので、同じ行が両方の対象になる余地を、
 * ジョブの 1 回の実行時間 (300 秒。HIDDEN_CONTENT_PURGE_MAX_DURATION_MS) より十分長い 1 日の幅で消す。
 * これが無いと、ジョブが画像を消したあと行を消す前に戻す操作が割り込み、画像の無い行が残ることがある
 */
export const HIDDEN_CONTENT_RESTORE_MARGIN_DAYS = 1;

/** 戻せる期間 (隠してからの日数)。この日数を過ぎた行は戻さない (完全削除を待つ) */
export const HIDDEN_CONTENT_RESTORE_WINDOW_DAYS = HIDDEN_CONTENT_RETENTION_DAYS - HIDDEN_CONTENT_RESTORE_MARGIN_DAYS;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 通報の状態 (moderation_flags.status / recipe_flags.status) のうち、戻す操作が読む値と書く値 */
export const FLAG_STATUS_REJECTED = 'rejected';
export const FLAG_STATUS_APPROVED = 'approved';

/** 通報されたコンテンツ本体の表 (hideModeratedContent の contentTable と同じ対応) */
export const HIDDEN_CONTENT_TABLE_OF = {
  food: 'meals',
  recipe: 'recipes',
} as const satisfies Record<ModerationBackedType, 'meals' | 'recipes'>;

/** 通報の表 */
export const MODERATION_FLAG_TABLE_OF = {
  food: 'moderation_flags',
  recipe: 'recipe_flags',
} as const satisfies Record<ModerationBackedType, 'moderation_flags' | 'recipe_flags'>;

/** 通報の表の、コンテンツ本体を指す列 */
export const MODERATION_FLAG_CONTENT_COLUMN_OF = {
  food: 'meal_id',
  recipe: 'recipe_id',
} as const satisfies Record<ModerationBackedType, 'meal_id' | 'recipe_id'>;

/**
 * コンテンツの行から読む列。paste_group_id・photo_url・memo は meals にしか無い。
 * 型は string にしておく (文字列のリテラルのままだと、supabase-js の select の型の解析が長い列の並びで ParserError になる。
 * 行の形は unknown として受けて列ごとに確かめる: readHiddenContentRow)
 */
const HIDDEN_CONTENT_COLUMNS_OF: Readonly<Record<ModerationBackedType, string>> = {
  food: 'id, user_id, hidden_at, hidden_by, hidden_reason, paste_group_id, photo_url, memo',
  recipe: 'id, user_id, hidden_at, hidden_by, hidden_reason',
};

/** 同じまとまり (paste_group_id) の行から読む列。戻す対象を決める (listRowsHiddenTogether) */
const PASTE_GROUP_ROW_COLUMNS = 'id, hidden_at, photo_url, memo';

/** 戻す操作に使う client。認可 (requireRole) を通したあとの service_role の client を渡す */
export type HiddenContentRestoreAdmin = Pick<SupabaseClient, 'from'>;

/** 通報が指すコンテンツ本体の行の、戻す操作に関わる列 */
export interface HiddenContentRow {
  id: string;
  /** 持ち主。退会で外れた公開レシピは null (外部キーは ON DELETE SET NULL)。戻せるかの判定には使わない (S-23) */
  user_id: string | null;
  hidden_at: string | null;
  hidden_by: string | null;
  hidden_reason: string | null;
  /** 家族への貼り付けのまとまり (meals だけ)。recipes は常に null */
  paste_group_id: string | null;
  /** 写真 (meals だけ。recipes は常に null)。同じ中身の複製の判定 (hasSameMealContent) に使う */
  photo_url: string | null;
  /** メモ (meals だけ。recipes は常に null) */
  memo: string | null;
}

/** 隠れている行 (hidden_at が入っている) */
export interface HiddenContentRowHidden extends HiddenContentRow {
  hidden_at: string;
}

/** 戻す対象の 1 行 (id と、読んだときの hidden_at) */
export interface HiddenContentTarget {
  id: string;
  hidden_at: string;
}

/** 行を戻す UPDATE の 1 文分 (hidden_at が同じ行の組) */
export interface HiddenContentRestoreBatch {
  hiddenAt: string;
  ids: string[];
}

/** 写真とメモ (同じ中身かを比べる列) */
export interface MealContentFields {
  photo_url: string | null;
  memo: string | null;
}

/**
 * 写真とメモが同じか。隠す側 (src/lib/admin/moderation-backend.ts の isSameMealContent。export されていない) と同じ式で、
 * 一致は契約テスト (tests/hidden-content-restore-contract.test.ts CT-8) が確かめる
 */
export function hasSameMealContent(a: MealContentFields, b: MealContentFields): boolean {
  return a.photo_url === b.photo_url && a.memo === b.memo;
}

/** 2 つの hidden_at (ISO の文字列) が同じ時刻か (PostgREST の書き方の違いに左右されないよう、時刻の値で比べる) */
function isSameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

/** 戻せるかの判定 (読んだ行と「今」だけで決まる純関数の結果) */
export type HiddenContentRestorability =
  | { kind: 'restorable'; row: HiddenContentRowHidden }
  | { kind: 'not_hidden'; row: HiddenContentRow }
  | { kind: 'window_expired'; row: HiddenContentRowHidden }
  | { kind: 'gone' };

/** 戻せる期間の下限 = now の 89 日前。hidden_at がこれ以後の行だけを戻す */
export function hiddenContentRestoreCutoff(now: Date): Date {
  return new Date(now.getTime() - HIDDEN_CONTENT_RESTORE_WINDOW_DAYS * MS_PER_DAY);
}

/**
 * 隠した日時が戻せる期間の中か (hidden_at >= now − 89 日)。画面 (欄を出すか) と判定 (judgeHiddenContentRestorability) の両方が使う。
 * hidden_at が日時として読めないときは例外 (DB の timestamptz の列なので、起きるのはプログラムの誤り)
 */
export function isWithinHiddenContentRestoreWindow(hiddenAt: string, now: Date): boolean {
  const hiddenAtMs = Date.parse(hiddenAt);
  if (Number.isNaN(hiddenAtMs)) {
    throw new Error('isWithinHiddenContentRestoreWindow: hidden_at is not a valid timestamp');
  }
  return hiddenAtMs >= hiddenContentRestoreCutoff(now).getTime();
}

/** 読んだ行から、戻せるかを決める (§10.1.1 の判定表 P-9〜P-11 の正本) */
export function judgeHiddenContentRestorability(row: HiddenContentRow | null, now: Date): HiddenContentRestorability {
  if (row === null) return { kind: 'gone' };
  if (row.hidden_at === null) return { kind: 'not_hidden', row };
  const hidden: HiddenContentRowHidden = { ...row, hidden_at: row.hidden_at };
  return isWithinHiddenContentRestoreWindow(hidden.hidden_at, now)
    ? { kind: 'restorable', row: hidden }
    : { kind: 'window_expired', row: hidden };
}

/**
 * PostgREST が返す 1 行。列を文字列で組み立てた select なので、supabase-js の型は行の形を表さない (GenericStringError)。
 * 形の分からない値 (unknown) として受けて、列ごとに確かめる
 */
type UnknownRow = Readonly<Record<string, unknown>>;

function isUnknownRow(value: unknown): value is UnknownRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 列の値が文字列ならその値、それ以外 (null・列が無い) なら null */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 通報が指すコンテンツ本体の行を読む。無ければ null。DB エラーは例外 */
export async function readHiddenContentRow(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  contentId: string,
): Promise<HiddenContentRow | null> {
  const { data, error } = await admin
    .from(HIDDEN_CONTENT_TABLE_OF[type])
    .select(HIDDEN_CONTENT_COLUMNS_OF[type])
    .eq('id', contentId)
    .maybeSingle();
  if (error) throw error;
  const raw: unknown = data;
  if (raw === null) return null;
  if (!isUnknownRow(raw) || typeof raw.id !== 'string') {
    throw new Error('readHiddenContentRow: unexpected row shape');
  }
  return {
    id: raw.id,
    user_id: stringOrNull(raw.user_id),
    hidden_at: stringOrNull(raw.hidden_at),
    hidden_by: stringOrNull(raw.hidden_by),
    hidden_reason: stringOrNull(raw.hidden_reason),
    paste_group_id: stringOrNull(raw.paste_group_id),
    photo_url: stringOrNull(raw.photo_url),
    memo: stringOrNull(raw.memo),
  };
}

/**
 * 戻す対象の行 (D-5)。食事は、通報された行と同じ paste_group_id で、通報された行の hidden_at 以後に隠れた行
 * (gte。NULL = 隠れていない行は入らない) のうち、
 *   (a) hidden_at が通報された行と同じ行 (= hideModeratedContent の 1 回の UPDATE で隠した行。隠したあとで持ち主が中身を書き換えていても戻す)
 *   (b) 写真とメモが通報された行と今も同じ行 (= 通報された行が隠れている間に来た 2 件目以降の delete_* が、まだ隠れていなかった
 *       同じ中身の複製を、別の時刻で隠したもの)
 * を戻す。通報された行より前に隠れた行と、あとに隠れて中身が違う行 (別の行への通報の判定で隠れたもの) は戻さない。
 * レシピには複製の仕組みが無いので、通報された行だけ。通報された行は必ず含める (その hidden_at は読んだ値のまま)
 */
export async function listRowsHiddenTogether(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  row: HiddenContentRowHidden,
): Promise<HiddenContentTarget[]> {
  const self: HiddenContentTarget = { id: row.id, hidden_at: row.hidden_at };
  if (type !== 'food' || row.paste_group_id === null) return [self];
  const { data, error } = await admin
    .from(HIDDEN_CONTENT_TABLE_OF.food)
    .select(PASTE_GROUP_ROW_COLUMNS)
    .eq('paste_group_id', row.paste_group_id)
    .gte('hidden_at', row.hidden_at);
  if (error) throw error;
  const rows: unknown = data ?? [];
  const others = (Array.isArray(rows) ? rows : []).flatMap((r: unknown): HiddenContentTarget[] => {
    if (!isUnknownRow(r) || typeof r.id !== 'string' || r.id === row.id) return [];
    const hiddenAt = stringOrNull(r.hidden_at);
    if (hiddenAt === null) return [];
    const content: MealContentFields = { photo_url: stringOrNull(r.photo_url), memo: stringOrNull(r.memo) };
    return isSameInstant(hiddenAt, row.hidden_at) || hasSameMealContent(content, row) ? [{ id: r.id, hidden_at: hiddenAt }] : [];
  });
  return [self, ...others];
}

/**
 * 戻す対象を hidden_at ごとの組 (行を戻す UPDATE の 1 文分) に分ける。組の順は対象の並びのとおりで、通報された行 (content) の組を
 * 必ず最後にする (途中の組で失敗しても、通報された行が隠れたままなので、画面の欄からやり直せる: D-7)
 */
export function groupTargetsByHiddenAt(
  targets: readonly HiddenContentTarget[],
  content: HiddenContentTarget,
): HiddenContentRestoreBatch[] {
  const batches: HiddenContentRestoreBatch[] = [];
  const contentBatch: HiddenContentRestoreBatch = { hiddenAt: content.hidden_at, ids: [content.id] };
  for (const target of targets) {
    if (target.id === content.id) continue;
    if (isSameInstant(target.hidden_at, content.hidden_at)) {
      contentBatch.ids.push(target.id);
      continue;
    }
    const batch = batches.find((b) => isSameInstant(b.hiddenAt, target.hidden_at));
    if (batch) batch.ids.push(target.id);
    else batches.push({ hiddenAt: target.hidden_at, ids: [target.id] });
  }
  return [...batches, contentBatch];
}

export interface ApproveRejectedFlagsParams {
  /** 戻した運営 (resolved_by / reviewed_by) */
  resolvedBy: string;
  /** 戻す理由。moderation_flags.resolution_note に書く (recipe_flags には列が無い) */
  resolutionNote: string;
  now: Date;
}

/**
 * 戻す行を指す通報のうち rejected のものを approved にする (D-6)。pending / escalated / approved は触らない。
 * 戻り値は状態を変えた通報の ID (0 件も正常: やり直し・別の運営が先に戻した)。DB エラーは例外
 */
export async function approveRejectedFlagsOfContent(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  contentIds: readonly string[],
  params: ApproveRejectedFlagsParams,
): Promise<string[]> {
  const nowIso = params.now.toISOString();
  const patch =
    type === 'food'
      ? {
          status: FLAG_STATUS_APPROVED,
          resolved_by: params.resolvedBy,
          resolved_at: nowIso,
          resolution_note: params.resolutionNote,
        }
      : { status: FLAG_STATUS_APPROVED, reviewed_by: params.resolvedBy, reviewed_at: nowIso };
  const { data, error } = await admin
    .from(MODERATION_FLAG_TABLE_OF[type])
    .update(patch)
    .in(MODERATION_FLAG_CONTENT_COLUMN_OF[type], [...contentIds])
    .eq('status', FLAG_STATUS_REJECTED)
    .select('id');
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * 行の hidden_at / hidden_by / hidden_reason を NULL に戻す (D-3)。hidden_at が同じ行の組 (groupTargetsByHiddenAt の 1 組) を 1 文で。
 * - eq('hidden_at', hiddenAt): 読んだときと同じ隠し操作の行だけ (読んでから書くまでに戻されて隠し直された行は外れる)
 * - gte('hidden_at', 期限): 戻せる期間 (89 日) を書く瞬間にもう一度確かめる (完全削除のジョブと同じ行を扱わない: D-13)
 * 戻り値は戻した行の ID。通報された行の組で 0 件なら「読んでから書くまでに状態が変わった」の合図 (restoreModeratedContent が読み直す)。
 * DB エラーは例外
 */
export async function restoreHiddenContentRows(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  contentIds: readonly string[],
  hiddenAt: string,
  now: Date,
): Promise<string[]> {
  const cutoffIso = hiddenContentRestoreCutoff(now).toISOString();
  const { data, error } = await admin
    .from(HIDDEN_CONTENT_TABLE_OF[type])
    .update({ hidden_at: null, hidden_by: null, hidden_reason: null })
    .in('id', [...contentIds])
    .eq('hidden_at', hiddenAt)
    .gte('hidden_at', cutoffIso)
    .select('id');
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/** restoreModeratedContent の段 (失敗したときに、どこまで進んだかを route が監査ログに残す) */
export type HiddenContentRestoreStep = 'read' | 'flags' | 'rows' | 'reread';

/** 失敗した (または途中で止まった) ときに、それまでに済んだこと。route が監査ログに残す */
export interface HiddenContentRestoreProgress {
  /** 戻す対象の行 (まとまりを読む前なら空) */
  readonly targetIds: readonly string[];
  /** approved にできた通報 (flags の段より前なら空) */
  readonly approvedFlagIds: readonly string[];
  /** 戻せた行 (rows の段の途中で失敗したときは、先に書いた組の行) */
  readonly restoredIds: readonly string[];
}

/** まだ何も済んでいない (read の段の失敗) */
export const NO_RESTORE_PROGRESS: HiddenContentRestoreProgress = { targetIds: [], approvedFlagIds: [], restoredIds: [] };

/** 段の DB の失敗。route は step で応答のコードを決め、before / progress を監査ログに残す */
export class HiddenContentRestoreStepError extends Error {
  readonly step: HiddenContentRestoreStep;
  /** 元のエラー (supabase-js のエラーは Error とは限らない)。応答の本文には出さない */
  readonly reason: unknown;
  /** 判定の時点で読んだ行 (読めなかったときは null) */
  readonly before: HiddenContentRowHidden | null;
  /** 失敗の前に済んだこと */
  readonly progress: HiddenContentRestoreProgress;

  constructor(
    step: HiddenContentRestoreStep,
    reason: unknown,
    before: HiddenContentRowHidden | null,
    progress: HiddenContentRestoreProgress,
  ) {
    super(`restoreModeratedContent: ${step} failed`);
    this.name = 'HiddenContentRestoreStepError';
    this.step = step;
    this.reason = reason;
    this.before = before;
    this.progress = progress;
  }
}

export interface RestoreModeratedContentParams {
  /** 戻した運営 */
  restoredBy: string;
  /** 戻す理由 (検証済み。1〜5000 字) */
  restoreNote: string;
  now: Date;
}

/** restoreModeratedContent の結果 (§10.1 の判定表の正本) */
export type HiddenContentRestoreOutcome =
  | Exclude<HiddenContentRestorability, { kind: 'restorable' }>
  | {
      kind: 'restored';
      /** 判定の時点の行 (隠していたときの 3 列の値。監査ログに残す) */
      before: HiddenContentRowHidden;
      /** 戻す対象の行 (D-5) */
      targetIds: string[];
      /** 実際に戻した行 (通報された行を必ず含む) */
      restoredIds: string[];
      /** approved にした通報 */
      approvedFlagIds: string[];
    }
  | {
      /**
       * 通報された行の UPDATE が 0 行だった (読んでから書くまでに、別の操作が戻した・消した・隠し直した・期限の境を越えた)。
       * again は読み直した判定 (restorable = 別の時刻で隠し直されている)。それまでに書いたこと (通報の approved・先に書いた組の行) を持つ
       */
      kind: 'raced';
      before: HiddenContentRowHidden;
      targetIds: string[];
      restoredIds: string[];
      approvedFlagIds: string[];
      again: HiddenContentRestorability;
    };

/**
 * 通報が指すコンテンツを戻す。順は「行を読む → 判定 → 戻す対象の行 → 通報を approved に → 行を NULL に (hidden_at の組ごと。通報された行の組が最後)」。
 * 判定で戻せないときは何も書かずにその理由を返す。DB の失敗は HiddenContentRestoreStepError (どの段かと、済んだことを持つ)
 */
export async function restoreModeratedContent(
  admin: HiddenContentRestoreAdmin,
  type: ModerationBackedType,
  contentId: string,
  params: RestoreModeratedContentParams,
): Promise<HiddenContentRestoreOutcome> {
  let row: HiddenContentRow | null;
  try {
    row = await readHiddenContentRow(admin, type, contentId);
  } catch (reason) {
    throw new HiddenContentRestoreStepError('read', reason, null, NO_RESTORE_PROGRESS);
  }
  const judged = judgeHiddenContentRestorability(row, params.now);
  if (judged.kind !== 'restorable') return judged;
  const before = judged.row;

  let targets: HiddenContentTarget[];
  try {
    targets = await listRowsHiddenTogether(admin, type, before);
  } catch (reason) {
    throw new HiddenContentRestoreStepError('read', reason, before, NO_RESTORE_PROGRESS);
  }
  const targetIds = targets.map((target) => target.id);

  let approvedFlagIds: string[];
  try {
    approvedFlagIds = await approveRejectedFlagsOfContent(admin, type, targetIds, {
      resolvedBy: params.restoredBy,
      resolutionNote: params.restoreNote,
      now: params.now,
    });
  } catch (reason) {
    throw new HiddenContentRestoreStepError('flags', reason, before, { ...NO_RESTORE_PROGRESS, targetIds });
  }

  // hidden_at の組ごとに 1 文。通報された行の組が最後 (groupTargetsByHiddenAt)
  const restoredIds: string[] = [];
  for (const batch of groupTargetsByHiddenAt(targets, { id: before.id, hidden_at: before.hidden_at })) {
    try {
      restoredIds.push(...(await restoreHiddenContentRows(admin, type, batch.ids, batch.hiddenAt, params.now)));
    } catch (reason) {
      throw new HiddenContentRestoreStepError('rows', reason, before, {
        targetIds,
        approvedFlagIds,
        restoredIds: [...restoredIds],
      });
    }
  }
  if (restoredIds.includes(before.id)) return { kind: 'restored', before, targetIds, restoredIds, approvedFlagIds };

  // 通報された行が 0 行: 読んでから書くまでに、別の操作が戻した・消した・隠し直した・期限の境を越えた。読み直して理由を返す
  let again: HiddenContentRow | null;
  try {
    again = await readHiddenContentRow(admin, type, contentId);
  } catch (reason) {
    throw new HiddenContentRestoreStepError('reread', reason, before, { targetIds, approvedFlagIds, restoredIds });
  }
  return {
    kind: 'raced',
    before,
    targetIds,
    restoredIds,
    approvedFlagIds,
    again: judgeHiddenContentRestorability(again, params.now),
  };
}

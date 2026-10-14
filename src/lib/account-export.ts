/**
 * #1131 個人データエクスポート (GDPR データポータビリティ) の本体。
 *
 * ログイン中のユーザー本人のデータだけを 1 本の JSON として少しずつ (ストリームで) 生成する。
 * 出力するテーブルは src/lib/account-export-tables.ts の許可リストで決まる。
 *
 * 【他人のデータを混ぜないための 3 重の守り】
 * 1. ユーザーのセッションで動く Supabase クライアント (RLS が効く) を使う。service_role は使わない。
 * 2. 全テーブルに「本人の行だけ」の絞り込み (.eq) を明示する。RLS は他人の公開行や、運営ロールなら
 *    全員分の行を返す表があるため、RLS だけには頼らない。親テーブル経由の子表は親の user_id で絞る。
 * 3. 取得した各行の持ち主を確認し、本人以外の行が 1 件でもあれば出力を中止する (fail-closed)。
 *
 * 【サイズ・時間の上限】
 * 1000 行ずつページングし、メモリには 1 ページ分しか載せない。表ごとの行数・全体のバイト数・経過時間に
 * 上限を設け、超えた場合は途中までを有効な JSON として閉じ、summary に「どの表がなぜ切れたか」を記録する。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ACCOUNT_EXPORT_TABLES,
  type ExportRow,
  type ExportTableSpec,
} from '@/lib/account-export-tables';

export const EXPORT_FORMAT = 'homegohan-personal-data-export';
export const EXPORT_FORMAT_VERSION = 1;

export const EXPORT_NOTICE =
  'このファイルには、ログイン中のご本人のデータだけが含まれます。' +
  '他のユーザーの情報、運営側の内部記録、パスワードやトークンなどの認証情報は含まれません。' +
  '画像などのファイル本体は含まれず、保存先の URL / パスだけが記録されています。' +
  '健康情報などの機微な情報が含まれるため、取り扱いにご注意ください。';

export interface ExportLimits {
  /**
   * 1 回の問い合わせで取得する行数。PostgREST の max_rows (既定 1000) 以下にしておく。
   * サーバー側がこれより少なく返しても、返った行数ぶんだけ次の位置へ進むので取りこぼさない。
   */
  pageSize: number;
  /** 1 テーブルあたりの最大行数 */
  maxRowsPerTable: number;
  /** 出力全体の最大バイト数 (UTF-8) */
  maxTotalBytes: number;
  /** 出力に使ってよい時間 (ミリ秒)。route の maxDuration より短くする */
  maxDurationMs: number;
  /** 末尾の summary を書くために、maxTotalBytes から常に空けておくバイト数 */
  reservedBytes: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  pageSize: 1000,
  maxRowsPerTable: 20_000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxDurationMs: 45_000,
  reservedBytes: 64 * 1024,
};

export type ExportLimitReason = 'row_limit' | 'size_limit' | 'time_limit';

export interface TruncatedTable {
  table: string;
  reason: ExportLimitReason;
  exported_rows: number;
  /** 本人の全行数 (数えられなかったときは null) */
  total_rows: number | null;
}

export interface SkippedTable {
  table: string;
  reason: 'size_limit' | 'time_limit';
}

export interface ExportSummary {
  /** 上限による打ち切りが 1 件も無ければ true */
  complete: boolean;
  row_counts: Record<string, number>;
  truncated_tables: TruncatedTable[];
  skipped_tables: SkippedTable[];
}

/** 本人以外の行が取得結果に混ざっていたときに投げる。出力は中止され、本人以外の行は 1 件も渡らない */
export class ExportScopeViolationError extends Error {
  constructor(public readonly table: string) {
    super(`Account export aborted: a row of "${table}" does not belong to the requesting user`);
    this.name = 'ExportScopeViolationError';
  }
}

export interface GenerateAccountExportOptions {
  tables?: readonly ExportTableSpec[];
  limits?: Partial<ExportLimits>;
  /** テスト用に差し替える */
  now?: () => Date;
  nowMs?: () => number;
}

export type AccountExportSupabase = Pick<SupabaseClient, 'from'>;

interface PageResult {
  data: ExportRow[] | null;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

/** supabase-js のクエリビルダーのうち、このモジュールが使う部分だけ */
interface PageQuery extends PromiseLike<PageResult> {
  eq(column: string, value: string | number | boolean): PageQuery;
  order(column: string, options?: { ascending?: boolean }): PageQuery;
  range(from: number, to: number): PageQuery;
}

function buildSelect(spec: ExportTableSpec): string {
  const base = spec.columns ?? '*';
  if (spec.scope.kind === 'parent') {
    // 外部キー列をヒントにして、親との関係を 1 つに固定する (関係が増えても曖昧にならない)
    return `${base},${spec.scope.parent}!${spec.scope.fk}!inner(${spec.scope.parentColumn})`;
  }
  return base;
}

function buildPageQuery(
  supabase: AccountExportSupabase,
  spec: ExportTableSpec,
  userId: string,
  range: { from: number; to: number },
  withCount: boolean,
): PageQuery {
  const select = buildSelect(spec);
  const table = supabase.from(spec.table);
  let query = (
    withCount ? table.select(select, { count: 'exact' }) : table.select(select)
  ) as unknown as PageQuery;

  // 本人の行だけに絞る (RLS に頼らない)
  query =
    spec.scope.kind === 'self'
      ? query.eq(spec.scope.column, userId)
      : query.eq(`${spec.scope.parent}.${spec.scope.parentColumn}`, userId);

  for (const [column, value] of Object.entries(spec.eq ?? {})) {
    query = query.eq(column, value);
  }
  for (const column of spec.orderBy ?? ['id']) {
    query = query.order(column, { ascending: true });
  }
  return query.range(range.from, range.to);
}

/** 行の持ち主の ID。親経由の表は、結合で付いてきた親の行から読む */
function ownerOf(spec: ExportTableSpec, row: ExportRow): unknown {
  if (spec.scope.kind === 'self') return row[spec.scope.column];
  const embedded = row[spec.scope.parent] as ExportRow | ExportRow[] | null | undefined;
  const parentRow = Array.isArray(embedded) ? embedded[0] : embedded;
  return parentRow?.[spec.scope.parentColumn];
}

function shapeRow(spec: ExportTableSpec, row: ExportRow, userId: string): ExportRow {
  const shaped: ExportRow = { ...row };
  if (spec.scope.kind === 'parent') delete shaped[spec.scope.parent];
  for (const column of spec.omit ?? []) delete shaped[column];
  return spec.transform ? spec.transform(shaped, { userId }) : shaped;
}

const utf8Length = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * 本人のデータを JSON テキストの断片として順に返す。返り値は summary。
 * 最初の断片は最初のテーブルの 1 ページ目を取得してから返す (ここで失敗すれば呼び出し側が 500 にできる)。
 */
export async function* generateAccountExport(
  supabase: AccountExportSupabase,
  userId: string,
  options: GenerateAccountExportOptions = {},
): AsyncGenerator<string, ExportSummary, void> {
  const tables = options.tables ?? ACCOUNT_EXPORT_TABLES;
  const limits: ExportLimits = { ...DEFAULT_EXPORT_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date());
  const nowMs = options.nowMs ?? Date.now;
  const startedAt = nowMs();

  const rowCounts: Record<string, number> = {};
  const truncated: TruncatedTable[] = [];
  const skipped: SkippedTable[] = [];

  let buffer = '';
  let bufferBytes = 0;
  let flushedBytes = 0;
  const append = (text: string) => {
    buffer += text;
    bufferBytes += utf8Length(text);
  };
  const flush = () => {
    const out = buffer;
    flushedBytes += bufferBytes;
    buffer = '';
    bufferBytes = 0;
    return out;
  };
  const usedBytes = () => flushedBytes + bufferBytes;

  const header: Record<string, unknown> = {
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    exported_at: now().toISOString(),
    user_id: userId,
    notice: EXPORT_NOTICE,
  };
  append(
    '{\n' +
      Object.entries(header)
        .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
        .join(',\n') +
      ',\n  "data": {',
  );

  // 全体の上限 (サイズ / 時間) に達したら、以降のテーブルは取得せず skipped に記録する
  let stopReason: 'size_limit' | 'time_limit' | null = null;
  let wroteTable = false;

  for (const spec of tables) {
    if (!stopReason && nowMs() - startedAt > limits.maxDurationMs) stopReason = 'time_limit';
    if (!stopReason && usedBytes() + limits.reservedBytes >= limits.maxTotalBytes) stopReason = 'size_limit';
    if (stopReason) {
      skipped.push({ table: spec.table, reason: stopReason });
      continue;
    }

    append(`${wroteTable ? ',' : ''}\n    ${JSON.stringify(spec.table)}: [`);
    wroteTable = true;

    let offset = 0;
    let total: number | null = null;
    let exported = 0;
    let cut: ExportLimitReason | null = null;

    while (!cut) {
      // 2 ページ目以降だけ時間を見る (1 ページ目は上の判定済み)
      if (offset > 0 && nowMs() - startedAt > limits.maxDurationMs) {
        cut = 'time_limit';
        break;
      }

      const result = await buildPageQuery(
        supabase,
        spec,
        userId,
        { from: offset, to: offset + limits.pageSize - 1 },
        offset === 0,
      );
      if (result.error) {
        throw new Error(
          `Account export query failed for "${spec.table}": ${result.error.message}` +
            (result.error.code ? ` (${result.error.code})` : ''),
        );
      }
      if (offset === 0) total = typeof result.count === 'number' ? result.count : null;

      const rows = result.data ?? [];
      if (rows.length === 0) break;

      for (const raw of rows) {
        if (ownerOf(spec, raw) !== userId) throw new ExportScopeViolationError(spec.table);
        if (exported >= limits.maxRowsPerTable) {
          cut = 'row_limit';
          break;
        }
        const line = JSON.stringify(shapeRow(spec, raw, userId));
        const piece = `${exported === 0 ? '' : ','}\n      ${line}`;
        if (usedBytes() + utf8Length(piece) + limits.reservedBytes > limits.maxTotalBytes) {
          cut = 'size_limit';
          break;
        }
        append(piece);
        exported += 1;
      }
      if (cut) break;

      offset += rows.length;
      // 件数が分かっていればそれで、分からなければ「ページが満杯でない」ことで最後のページを判定する
      if (total !== null ? offset >= total : rows.length < limits.pageSize) break;

      yield flush();
    }

    append(exported === 0 ? ']' : '\n    ]');
    rowCounts[spec.table] = exported;
    if (cut) {
      truncated.push({ table: spec.table, reason: cut, exported_rows: exported, total_rows: total });
      if (cut !== 'row_limit') stopReason = cut;
    }

    // 最初のテーブルの分は、ここで必ず断片を返す (呼び出し側が取得の成否を先に確認できるように)
    if (spec === tables[0]) yield flush();
  }

  const summary: ExportSummary = {
    complete: truncated.length === 0 && skipped.length === 0,
    row_counts: rowCounts,
    truncated_tables: truncated,
    skipped_tables: skipped,
  };
  append(
    `${wroteTable ? '\n  ' : ' '}},\n  "summary": ${JSON.stringify(summary, null, 2).replace(/\n/g, '\n  ')}\n}\n`,
  );
  yield flush();
  return summary;
}

/** ダウンロードのファイル名 (CSV エクスポートと同じく UTC の日付) */
export function buildExportFilename(date: Date = new Date()): string {
  return `homegohan-export-${date.toISOString().slice(0, 10)}.json`;
}

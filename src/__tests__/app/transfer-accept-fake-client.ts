/**
 * 譲渡の承諾ページ (家族 / 組織) の単体テスト用に、ブラウザ側の Supabase クライアントを模す。
 *
 * 存在しない列を select すると、PostgREST は 42703 で失敗し、supabase-js は { data: null, error } を返す。
 * 呼び出し元が error を見ていないと「行が無い」と区別できず、画面が「見つかりません」になったり、
 * 名前が出なかったりする (#1110 / #1306)。ここでは実際のスキーマの列だけを持たせ、
 * 知らない列を select したら同じ失敗を返す。単体テストはふつう Supabase をモックして列の有無を見ないため、
 * この確認で「存在しない列を読んでいない」ことを画面のテストで固定する。
 */
import { vi } from 'vitest';

type Row = Record<string, unknown>;

/** 実際のスキーマの列 (supabase/baseline/prod_schema.sql)。user_profiles に email 列は無く、ownership_transfer_proposals に reason 列は無い */
export const SCHEMA_COLUMNS: Record<string, string[]> = {
  ownership_transfer_proposals: [
    'id',
    'scope',
    'scope_id',
    'from_user_id',
    'to_user_id',
    'status',
    'expires_at',
    'proposed_at',
    'resolved_at',
  ],
  user_profiles: ['id', 'nickname', 'age_group', 'family_id', 'organization_id', 'org_role'],
  family_groups: ['id', 'name', 'representative_id', 'plan_key', 'member_limit', 'status'],
  organizations: ['id', 'name', 'owner_id', 'plan', 'status'],
};

export interface PageClientOptions {
  /** ログイン中のユーザー ID */
  userId: string;
  /** テーブル名 -> 行 */
  tables: Record<string, Row[]>;
}

export function createPageClient({ userId, tables }: PageClientOptions) {
  /** スキーマに無い列を select した呼び出し (空であること) */
  const invalidSelects: Array<{ table: string; columns: string; unknown: string[] }> = [];

  const from = vi.fn((table: string) => {
    let selected: string[] | null = null;
    let unknown: string[] = [];
    const filters: Array<(row: Row) => boolean> = [];

    const query = {
      select(columns: string) {
        const names = columns.split(',').map((name) => name.trim()).filter(Boolean);
        selected = names.includes('*') ? null : names;
        unknown = names.filter((name) => name !== '*' && !(SCHEMA_COLUMNS[table] ?? []).includes(name));
        if (unknown.length > 0) invalidSelects.push({ table, columns, unknown });
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return query;
      },
      single: async () => {
        if (unknown.length > 0) {
          return { data: null, error: { code: '42703', message: `column ${table}.${unknown[0]} does not exist` } };
        }
        const row = (tables[table] ?? []).find((candidate) => filters.every((matches) => matches(candidate)));
        if (!row) {
          return {
            data: null,
            error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
          };
        }
        const data = selected ? Object.fromEntries(selected.map((column) => [column, row[column]])) : { ...row };
        return { data, error: null };
      },
    };
    return query;
  });

  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: userId } } })) },
    from,
    invalidSelects,
  };
}

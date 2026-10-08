/**
 * #1131 個人データエクスポートの対象テーブル (src/lib/account-export-tables.ts) の棚卸しテスト
 *
 * 本番スキーマのスナップショット (supabase/baseline/) と、それより新しい migration から public テーブルを読み、
 *   1. ユーザーの識別列を持つ表 / 出力する表の子表が、「出力する」か「出力しない (理由つき)」のどちらかに
 *      必ず分類されていること (新しい表の分類漏れ = 将来のデータ漏れ / エクスポート漏れを防ぐ)
 *   2. 許可リストの表・列がスキーマに実在し、並び順が主キーの全列を含むこと
 *   3. 出力する列に、秘密っぽい列名・他のユーザーを指す列が残っていないこと
 * を確認する。DB には接続しない。
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_EXPORT_EXCLUDED,
  ACCOUNT_EXPORT_TABLES,
  type ExportTableSpec,
} from '@/lib/account-export-tables';
import { applyMigration, loadSchemaModel, type SchemaTable } from './helpers/schema-snapshot';

/** 「この行は誰のデータか」を表す列名。持っていたら分類が必要 */
const DATA_SUBJECT_COLUMNS = new Set([
  'user_id',
  'owner_id',
  'created_by_user_id',
  'user_id_1',
  'user_id_2',
  'from_user_id',
  'to_user_id',
  'target_user_id',
  'referrer_id',
  'referred_id',
  'reporter_id',
  'sender_id',
]);

/**
 * auth.users を指すが「操作した運営スタッフ / 作成者」を表す列 (データの持ち主ではない)。
 * これらだけを持つ表 (お知らせ・クーポン・フラグ等) は、ユーザーのデータではないので分類を求めない。
 * 新しい列名が auth.users を指していたら、ここに足すか、分類するかを開発者に決めさせる。
 */
const ACTOR_COLUMNS = new Set([
  'created_by',
  'updated_by',
  'added_by',
  'admin_id',
  'assigned_to',
  'assignee_id',
  'resolved_by',
  'reviewed_by',
  'approved_by',
  'invited_by',
  'accepted_by',
  'revoked_by',
  'ack_by',
  'changed_by',
  'executed_by',
  'frozen_by',
  'manager_id',
  'impersonated_by',
  'actor_id',
  'requested_by',
]);

/** 出力する表に残してよい、秘密っぽい名前の列 (中身は秘密ではない) */
const SENSITIVE_NAME_ALLOWLIST = new Set(['ai_consultation_messages.tokens_used']);
const SENSITIVE_NAME = /password|passwd|secret|token|api_?key|credential|private_?key|hash|stripe_|lease/i;

/** 他のユーザーを指す列のうち、出力する表に残ってよいもの (本人判定の列、または transform で置き換える列) */
const OTHER_USER_COLUMN_ALLOWLIST = new Set(['support_ticket_messages.sender_id']);

const schema = loadSchemaModel();
const exportedNames = new Set(ACCOUNT_EXPORT_TABLES.map((t) => t.table));
const excludedNames = new Set(Object.keys(ACCOUNT_EXPORT_EXCLUDED));

const tableOf = (name: string): SchemaTable => {
  const table = schema.get(name);
  if (!table) throw new Error(`schema に ${name} が無い`);
  return table;
};

/** select 句のうち、括弧の外にある素の列名 */
function plainSelectColumns(columns: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of columns) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter((p) => !p.includes('(') && p !== '*');
}

/** その表から実際に取得される列 (omit を引く前) */
function selectedColumns(spec: ExportTableSpec, model: Map<string, SchemaTable> = schema): string[] {
  const table = model.get(spec.table);
  if (!table) throw new Error(`schema に ${spec.table} が無い`);
  if (spec.columns && !spec.columns.split(',').some((c) => c.trim() === '*')) {
    return plainSelectColumns(spec.columns);
  }
  return table.columns;
}

/** 出力される列のうち、秘密っぽい名前のもの */
function sensitiveExposedColumns(spec: ExportTableSpec, model: Map<string, SchemaTable> = schema): string[] {
  return selectedColumns(spec, model)
    .filter((c) => !(spec.omit ?? []).includes(c))
    .filter((c) => SENSITIVE_NAME.test(c) && !SENSITIVE_NAME_ALLOWLIST.has(`${spec.table}.${c}`));
}

/** 出力される列のうち、他のユーザーを指すもの (本人判定の列と、置き換え済みの列を除く) */
function otherUserExposedColumns(spec: ExportTableSpec, model: Map<string, SchemaTable> = schema): string[] {
  const table = model.get(spec.table);
  if (!table) throw new Error(`schema に ${spec.table} が無い`);
  const exposed = selectedColumns(spec, model).filter((c) => !(spec.omit ?? []).includes(c));
  const scopeColumn = spec.scope.kind === 'self' ? spec.scope.column : null;
  return table.foreignKeys
    .filter((fk) => fk.refSchema === 'auth' && fk.refTable === 'users')
    .map((fk) => fk.column)
    .filter((c) => exposed.includes(c) && c !== scopeColumn && !OTHER_USER_COLUMN_ALLOWLIST.has(`${spec.table}.${c}`));
}

/** 分類が必要な表 (ユーザーの識別列を持つ / 出力する表の子表) と、その理由 */
function requiredTables(model: Map<string, SchemaTable>): Map<string, string> {
  const required = new Map<string, string>();
  for (const table of model.values()) {
    const subjectColumn = table.columns.find((c) => DATA_SUBJECT_COLUMNS.has(c));
    if (subjectColumn) {
      required.set(table.name, `ユーザーの識別列 ${subjectColumn} を持つ`);
      continue;
    }
    const userFk = table.foreignKeys.find(
      (fk) => fk.refSchema === 'auth' && fk.refTable === 'users' && !ACTOR_COLUMNS.has(fk.column),
    );
    if (userFk) {
      required.set(table.name, `auth.users を指す列 ${userFk.column} を持つ`);
      continue;
    }
    const parentFk = table.foreignKeys.find((fk) => fk.refSchema === 'public' && exportedNames.has(fk.refTable));
    if (parentFk) {
      required.set(table.name, `出力する表 ${parentFk.refTable} の子表 (${parentFk.column})`);
    }
  }
  return required;
}

describe('スキーマの読み取り (テストの前提)', () => {
  it('本番スナップショットから public テーブルの列・主キー・外部キーを読めている', () => {
    expect(schema.size).toBeGreaterThan(100);
    for (const name of ['user_profiles', 'meals', 'planned_meals', 'support_tickets']) {
      expect(schema.has(name), name).toBe(true);
    }
    expect(tableOf('planned_meals').primaryKey).toEqual(['id']);
    expect(tableOf('user_badges').primaryKey).toEqual(['user_id', 'badge_id']);
    expect(tableOf('planned_meals').foreignKeys).toContainEqual({
      column: 'daily_meal_id',
      refSchema: 'public',
      refTable: 'user_daily_meals',
    });
  });

  it('migration の CREATE TABLE / DROP TABLE を重ねて読める (コメント・引用符・テーブル制約・インライン REFERENCES)', () => {
    const model = new Map<string, SchemaTable>();
    applyMigration(
      `
      -- create table public.commented_out (id uuid);
      /* create table public.block_commented (id uuid); */
      create table if not exists public.user_notes (
        id uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references auth.users(id) on delete cascade,
        body text,
        constraint user_notes_len check (char_length(body) < 100)
      );
      CREATE TABLE "public"."note_tags" (
        note_id uuid NOT NULL,
        tag text NOT NULL,
        PRIMARY KEY (note_id, tag),
        FOREIGN KEY (note_id) REFERENCES public.user_notes (id)
      );
      create table public.temp_things (id uuid primary key);
      drop table if exists public.temp_things;
      create table auth.not_public (id uuid);
      `,
      model,
    );

    expect([...model.keys()].sort()).toEqual(['note_tags', 'user_notes']);
    expect(model.get('user_notes')).toEqual({
      name: 'user_notes',
      columns: ['id', 'user_id', 'body'],
      primaryKey: ['id'],
      foreignKeys: [{ column: 'user_id', refSchema: 'auth', refTable: 'users' }],
    });
    expect(model.get('note_tags')).toEqual({
      name: 'note_tags',
      columns: ['note_id', 'tag'],
      primaryKey: ['note_id', 'tag'],
      foreignKeys: [{ column: 'note_id', refSchema: 'public', refTable: 'user_notes' }],
    });
  });

  it('migration の ALTER TABLE (列の追加・削除・改名、制約の追加、表の改名) を反映できる', () => {
    const model = new Map<string, SchemaTable>();
    applyMigration(
      `
      create table public.user_notes (id uuid primary key, body text, legacy text);
      alter table public.user_notes
        add column if not exists api_secret text,
        add column owner uuid references auth.users(id),
        add column price numeric(10,2) not null default 0;
      alter table only public.user_notes rename column body to content;
      alter table public.user_notes drop column if exists legacy;
      alter table public.user_notes add constraint user_notes_owner_fk foreign key (owner) references public.owners (id);
      alter table public.user_notes add constraint user_notes_pk2 primary key (id, owner);
      alter table public.user_notes enable row level security;
      alter table public.missing_table add column ignored text;
      alter table public.user_notes rename to user_memos;
      `,
      model,
    );

    expect([...model.keys()]).toEqual(['user_memos']);
    expect(model.get('user_memos')).toEqual({
      name: 'user_memos',
      columns: ['id', 'content', 'api_secret', 'owner', 'price'],
      primaryKey: ['id', 'owner'],
      foreignKeys: [
        { column: 'owner', refSchema: 'auth', refTable: 'users' },
        { column: 'owner', refSchema: 'public', refTable: 'owners' },
      ],
    });
  });
});

describe('分類漏れの検知 (ユーザーに紐づく表は、出力するか / 出力しない理由があるか)', () => {
  it('分類されていない表が無い (新しい表を足したら ACCOUNT_EXPORT_TABLES か ACCOUNT_EXPORT_EXCLUDED に分類する)', () => {
    const unclassified = [...requiredTables(schema)]
      .filter(([name]) => !exportedNames.has(name) && !excludedNames.has(name))
      .map(([name, why]) => `${name}: ${why}`);
    expect(
      unclassified,
      'src/lib/account-export-tables.ts に分類してください (出力するなら scope 必須、出力しないなら理由を書く)',
    ).toEqual([]);
  });

  it('検知の自己確認: 新しい migration で user_id 付きの表 / 出力する表の子表を足すと、分類が必要と判定される', () => {
    const model = new Map(schema);
    applyMigration(
      `
      create table public.user_notes (id uuid primary key, user_id uuid references auth.users(id), body text);
      create table public.planned_meal_notes (id uuid primary key, planned_meal_id uuid references public.planned_meals(id));
      create table public.diary (id uuid primary key, owner_id uuid);
      create table public.announcements_v2 (id uuid primary key, created_by uuid references auth.users(id));
      create table public.site_settings (key text primary key, value text);
      `,
      model,
    );
    const required = requiredTables(model);

    expect(required.has('user_notes')).toBe(true); // auth.users を指す列 (名前が user_id でなくても)
    expect(required.has('planned_meal_notes')).toBe(true); // 出力する表 planned_meals の子表
    expect(required.has('diary')).toBe(true); // 識別列 owner_id
    expect(required.has('announcements_v2')).toBe(false); // created_by は運営 / 作成者の列
    expect(required.has('site_settings')).toBe(false); // ユーザーと無関係
  });

  it('出力する表と出力しない表が重複していない', () => {
    expect([...exportedNames].filter((name) => excludedNames.has(name))).toEqual([]);
    expect(exportedNames.size).toBe(ACCOUNT_EXPORT_TABLES.length);
  });

  it('許可リスト / 除外リストの表がスキーマに実在する (リネーム・削除の取り残しを検知)', () => {
    expect([...exportedNames, ...excludedNames].filter((name) => !schema.has(name))).toEqual([]);
  });

  it('除外リストには理由が書いてある', () => {
    for (const [name, reason] of Object.entries(ACCOUNT_EXPORT_EXCLUDED)) {
      expect(reason.trim().length, `${name} の理由`).toBeGreaterThan(5);
    }
  });

  it('除外リストの表は、実際にユーザー識別列を持つか出力する表の子表である (不要な除外を残さない)', () => {
    const required = requiredTables(schema);
    const notNeeded = [...excludedNames].filter((name) => !required.has(name));
    expect(notNeeded, '分類の対象でない表が除外リストに残っている').toEqual([]);
  });
});

describe('許可リストの定義がスキーマと合っている', () => {
  it.each(ACCOUNT_EXPORT_TABLES.map((t) => [t.table, t] as const))('%s: 絞り込み・列・並び順が実在する', (_name, spec) => {
    const table = tableOf(spec.table);
    const has = (column: string) => table.columns.includes(column);

    if (spec.scope.kind === 'self') {
      expect(has(spec.scope.column), `scope の列 ${spec.scope.column}`).toBe(true);
      // columns を明示するなら、本人判定の列を含める (含めないと出力前の持ち主確認ができない)
      if (spec.columns) expect(selectedColumns(spec)).toContain(spec.scope.column);
    } else {
      const { parent, fk, parentColumn } = spec.scope;
      const parentSpec = ACCOUNT_EXPORT_TABLES.find((t) => t.table === parent);
      expect(parentSpec, `親 ${parent} は出力する表であること`).toBeDefined();
      expect(parentSpec!.scope, `親 ${parent} は本人の列で直接絞れること`).toEqual({ kind: 'self', column: parentColumn });
      expect(has(fk), `外部キー列 ${fk}`).toBe(true);
      expect(tableOf(parent).columns).toContain(parentColumn);
      expect(table.foreignKeys, `${spec.table}.${fk} が ${parent} を指す外部キーであること`).toContainEqual({
        column: fk,
        refSchema: 'public',
        refTable: parent,
      });
    }

    for (const column of spec.omit ?? []) expect(has(column), `omit の列 ${column}`).toBe(true);
    for (const column of Object.keys(spec.eq ?? {})) expect(has(column), `eq の列 ${column}`).toBe(true);
    for (const column of spec.columns ? plainSelectColumns(spec.columns) : []) {
      expect(has(column), `columns の列 ${column}`).toBe(true);
    }
    for (const column of spec.omit ?? []) {
      expect(selectedColumns(spec), `omit の列 ${column} は取得対象に含まれていること`).toContain(column);
    }

    // ページングを安定させるため、並び順は主キーの全列を含める (日時などを先頭に足すのは可)
    const orderBy = spec.orderBy ?? ['id'];
    for (const column of orderBy) expect(has(column), `orderBy の列 ${column}`).toBe(true);
    if (table.primaryKey) {
      for (const column of table.primaryKey) {
        expect(orderBy, `${spec.table} の orderBy に主キーの列 ${column} が無い`).toContain(column);
      }
    }
  });

  it('表の指定が重複していない', () => {
    const names = ACCOUNT_EXPORT_TABLES.map((t) => t.table);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('出力する列に、秘密・他人を指す列が残っていない', () => {
  it.each(ACCOUNT_EXPORT_TABLES.map((t) => [t.table, t] as const))('%s', (_name, spec) => {
    expect(
      sensitiveExposedColumns(spec),
      '秘密っぽい列名。omit するか、中身が秘密でなければ SENSITIVE_NAME_ALLOWLIST に追加',
    ).toEqual([]);
    expect(otherUserExposedColumns(spec), '他のユーザーを指す列。omit するか、transform で置き換える').toEqual([]);
  });

  it('検知の自己確認: 出力する表に、秘密っぽい列 / 他のユーザーを指す列を足す migration を重ねると検知される', () => {
    const model = new Map([...schema].map(([name, table]) => [name, { ...table, columns: [...table.columns], foreignKeys: [...table.foreignKeys] }]));
    applyMigration(
      `
      alter table public.user_profiles add column if not exists api_token text, add column last_editor uuid references auth.users(id);
      alter table public.meals add column note_hash text;
      alter table public.support_tickets drop column assignee_id;
      `,
      model,
    );

    expect(sensitiveExposedColumns(ACCOUNT_EXPORT_TABLES.find((t) => t.table === 'user_profiles')!, model)).toEqual(['api_token']);
    expect(otherUserExposedColumns(ACCOUNT_EXPORT_TABLES.find((t) => t.table === 'user_profiles')!, model)).toEqual(['last_editor']);
    expect(sensitiveExposedColumns(ACCOUNT_EXPORT_TABLES.find((t) => t.table === 'meals')!, model)).toEqual(['note_hash']);
    // 列が無くなった表は、もう他人を指す列を持たない (omit の取り残しは別のテストで検知される)
    expect(otherUserExposedColumns(ACCOUNT_EXPORT_TABLES.find((t) => t.table === 'support_tickets')!, model)).toEqual([]);
    // 元のスキーマには影響しない
    expect(schema.get('user_profiles')!.columns).not.toContain('api_token');
  });

  it('同意の記録 (IP アドレス・User-Agent を含む) は本人の個人データなので出力する', () => {
    // 秘密ではなく本人の個人データ。除外すると同意の証跡が本人に渡らなくなる
    for (const name of ['cookie_consents', 'terms_acceptances', 'external_data_consents']) {
      expect(exportedNames.has(name), name).toBe(true);
    }
  });
});

describe('設計上の不変条件', () => {
  it('認証情報・トークン・パスワードの表は出力しない', () => {
    for (const name of ['password_history', 'user_push_tokens', 'user_sessions_metadata', 'native_bridge_codes', 'family_invites', 'family_promotion_requests']) {
      expect(exportedNames.has(name), name).toBe(false);
      expect(excludedNames.has(name), name).toBe(true);
    }
  });

  it('運営の内部記録・ログの表は出力しない', () => {
    for (const name of ['admin_user_notes', 'app_logs', 'llm_usage_logs', 'meal_nutrition_debug_logs', 'moderation_flags', 'membership_audit']) {
      expect(exportedNames.has(name), name).toBe(false);
      expect(excludedNames.has(name), name).toBe(true);
    }
  });

  it('RLS が他人の行を返しうる表は、すべて本人の列 / 親で絞っている', () => {
    // recipes: 公開レシピ, recipe_collections: 公開コレクション, meals: 家族, support_*: 運営ロール など
    for (const name of ['recipes', 'recipe_collections', 'recipe_likes', 'recipe_comments', 'meals', 'support_tickets', 'inquiries', 'personal_subscriptions', 'cookie_consents', 'family_members', 'organization_challenge_participants']) {
      const spec = ACCOUNT_EXPORT_TABLES.find((t) => t.table === name);
      expect(spec, name).toBeDefined();
      expect(spec!.scope.kind === 'self' || spec!.scope.kind === 'parent').toBe(true);
    }
  });

  it('子表は、親の user_id (本人) で絞っている', () => {
    const children = ACCOUNT_EXPORT_TABLES.filter((t) => t.scope.kind === 'parent');
    expect(children.map((t) => t.table).sort()).toEqual(
      [
        'ai_action_logs',
        'ai_consultation_messages',
        'meal_ai_feedbacks',
        'meal_nutrition_estimates',
        'planned_meals',
        'recipe_collection_items',
        'shopping_list_items',
        'support_ticket_messages',
      ].sort(),
    );
    for (const child of children) {
      expect(child.scope).toMatchObject({ kind: 'parent', parentColumn: 'user_id' });
    }
  });

  it('運営の内部メッセージ (is_internal) は出力から除く', () => {
    const spec = ACCOUNT_EXPORT_TABLES.find((t) => t.table === 'support_ticket_messages')!;
    expect(spec.eq).toEqual({ is_internal: false });
  });
});

/**
 * #1131 個人データエクスポート (src/lib/account-export.ts) のユニットテスト
 *
 * 守りたいこと:
 *   - ログイン中のユーザー本人の行だけが出力に入る (他人の行・公開行・家族の行・運営の内部メモは入らない)
 *   - 絞り込みを付け忘れても (= 他人の行が返ってきても) 出力せず中止する
 *   - 秘密 / 内部の列 (Stripe の ID・運営の備考・権限など) は出力に入らない
 *   - 出力は常に有効な JSON。サイズ / 行数 / 時間の上限に達したときも、どこが切れたかを summary に残す
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_EXPORT_TABLES,
  type ExportTableSpec,
} from '@/lib/account-export-tables';
import {
  DEFAULT_EXPORT_LIMITS,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  ExportScopeViolationError,
  buildExportFilename,
  generateAccountExport,
  type AccountExportSupabase,
  type ExportSummary,
  type GenerateAccountExportOptions,
} from '@/lib/account-export';
import { createFakePostgrest, type FakePostgrestOptions, type FakeRow } from './helpers/fake-postgrest';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const spec = (table: string): ExportTableSpec => {
  const found = ACCOUNT_EXPORT_TABLES.find((t) => t.table === table);
  if (!found) throw new Error(`spec not found: ${table}`);
  return found;
};

/** 親テーブル経由で絞る表の関係 (レジストリから作る) + user_badges の badges 埋め込み */
const RELATIONS: NonNullable<FakePostgrestOptions['relations']> = {
  user_badges: { badges: 'badge_id' },
};
for (const t of ACCOUNT_EXPORT_TABLES) {
  if (t.scope.kind === 'parent') RELATIONS[t.table] = { [t.scope.parent]: t.scope.fk };
}

async function drain(
  tables: Record<string, FakeRow[]>,
  userId: string,
  options: GenerateAccountExportOptions = {},
  fakeOptions: Partial<FakePostgrestOptions> = {},
) {
  const db = createFakePostgrest({ tables, relations: RELATIONS, ...fakeOptions });
  const generator = generateAccountExport(db as unknown as AccountExportSupabase, userId, options);
  const chunks: string[] = [];
  let summary: ExportSummary | undefined;
  for (;;) {
    const step = await generator.next();
    if (step.done) {
      summary = step.value;
      break;
    }
    chunks.push(step.value);
  }
  const text = chunks.join('');
  return { db, chunks, text, json: JSON.parse(text), summary: summary! };
}

/** ユーザー A / B (と運営スタッフ) の行が混在したテーブル群。RLS が他人の行も返す状況を想定している */
function buildFixture(): Record<string, FakeRow[]> {
  return {
    user_profiles: [
      { id: A, nickname: 'エー', age: 30, roles: ['user'], is_banned: false, banned_reason: null, frozen_by: null, plan_key_cached: 'free' },
      { id: B, nickname: 'B-secret-nickname', age: 41, roles: ['admin'], is_banned: false, banned_reason: null, frozen_by: null, plan_key_cached: 'pro' },
    ],
    meals: [
      { id: 'm-a1', user_id: A, memo: 'A-meal-1' },
      { id: 'm-a2', user_id: A, memo: 'A-meal-2' },
      { id: 'm-b1', user_id: B, memo: 'B-secret-meal' },
    ],
    meal_ai_feedbacks: [
      { id: 'f-a1', meal_id: 'm-a1', feedback_text: 'A-feedback' },
      { id: 'f-b1', meal_id: 'm-b1', feedback_text: 'B-secret-feedback' },
    ],
    user_daily_meals: [
      { id: 'd-a1', user_id: A, day_date: '2026-10-01' },
      { id: 'd-a2', user_id: A, day_date: '2026-10-02' },
      { id: 'd-b1', user_id: B, day_date: '2026-10-01' },
    ],
    planned_meals: [
      { id: 'p-a1', daily_meal_id: 'd-a1', dish_name: 'A-dish-1' },
      { id: 'p-a2', daily_meal_id: 'd-a1', dish_name: 'A-dish-2' },
      { id: 'p-a3', daily_meal_id: 'd-a2', dish_name: 'A-dish-3' },
      { id: 'p-b1', daily_meal_id: 'd-b1', dish_name: 'B-secret-dish' },
    ],
    weekly_menu_requests: [
      { id: 'w-a', user_id: A, start_date: '2026-10-01', status: 'completed', prompt: 'A-prompt', result_json: { huge: 'RESULT-JSON' }, worker_id: 'worker-1', attempt_count: 2, created_at: 't', updated_at: 't' },
      { id: 'w-b', user_id: B, start_date: '2026-10-01', status: 'completed', prompt: 'B-secret-prompt', result_json: {}, worker_id: 'worker-2', attempt_count: 1, created_at: 't', updated_at: 't' },
    ],
    recipes: [
      { id: 'r-a1', user_id: A, name: 'A-recipe', is_public: false },
      { id: 'r-b1', user_id: B, name: 'B-public-recipe', is_public: true },
      { id: 'r-sys', user_id: null, name: 'system-recipe', is_public: true },
    ],
    recipe_collections: [
      { id: 'rc-a', user_id: A, name: 'A-collection', is_public: false },
      { id: 'rc-b', user_id: B, name: 'B-public-collection', is_public: true },
    ],
    recipe_collection_items: [
      { collection_id: 'rc-a', recipe_id: 'r-a1' },
      { collection_id: 'rc-b', recipe_id: 'r-b1' },
    ],
    recipe_likes: [
      { user_id: A, recipe_id: 'r-b1' },
      { user_id: B, recipe_id: 'r-a1' },
    ],
    recipe_comments: [
      { id: 'c-a', user_id: A, content: 'A-comment' },
      { id: 'c-b', user_id: B, content: 'B-secret-comment' },
    ],
    recipe_flags: [
      { id: 'rf-a', reporter_id: A, reason: 'A-report', reviewed_by: STAFF },
      { id: 'rf-b', reporter_id: B, reason: 'B-secret-report', reviewed_by: STAFF },
    ],
    support_tickets: [
      { id: 't-a', user_id: A, subject: 'A-ticket', assignee_id: STAFF },
      { id: 't-b', user_id: B, subject: 'B-secret-ticket', assignee_id: STAFF },
    ],
    support_ticket_messages: [
      { id: 'tm-1', ticket_id: 't-a', sender_id: A, is_internal: false, body: 'A-asks' },
      { id: 'tm-2', ticket_id: 't-a', sender_id: STAFF, is_internal: false, body: 'support-replies' },
      { id: 'tm-3', ticket_id: 't-a', sender_id: STAFF, is_internal: true, body: 'INTERNAL-NOTE' },
      { id: 'tm-4', ticket_id: 't-b', sender_id: B, is_internal: false, body: 'B-secret-message' },
    ],
    inquiries: [
      { id: 'i-a', user_id: A, subject: 'A-inquiry', admin_notes: 'ADMIN-NOTE-A' },
      { id: 'i-b', user_id: B, subject: 'B-secret-inquiry', admin_notes: 'ADMIN-NOTE-B' },
    ],
    personal_subscriptions: [
      { id: 's-a', user_id: A, plan_key: 'premium', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', stripe_price_id: 'price_A', notes: 'STAFF-NOTE-A' },
      { id: 's-b', user_id: B, plan_key: 'pro', stripe_customer_id: 'cus_B', stripe_subscription_id: 'sub_B', stripe_price_id: 'price_B', notes: 'STAFF-NOTE-B' },
    ],
    cookie_consents: [
      { id: 'cc-a', user_id: A, analytics: true },
      { id: 'cc-b', user_id: B, analytics: false },
      { id: 'cc-anon', user_id: null, session_id: 'anon-session' },
    ],
    family_members: [
      { id: 'fm-a', user_id: A, family_id: 'fam-1', display_name: 'A-member' },
      { id: 'fm-b', user_id: B, family_id: 'fam-1', display_name: 'B-secret-member' },
    ],
    family_groups: [
      { id: 'fam-1', representative_id: B, name: 'B-secret-family' },
      { id: 'fam-2', representative_id: A, name: 'A-family' },
    ],
    badges: [{ id: 'bd-1', code: 'first_record', name: '初めての記録', description: 'desc', condition_json: { rule: 'CONDITION-JSON' } }],
    user_badges: [
      { user_id: A, badge_id: 'bd-1', obtained_at: 't' },
      { user_id: B, badge_id: 'bd-1', obtained_at: 't' },
    ],
    organization_challenge_participants: [
      { id: 'ocp-a', user_id: A, challenge_id: 'ch-1' },
      { id: 'ocp-b', user_id: B, challenge_id: 'ch-1' },
    ],
    health_records: [
      { id: 'h-a1', user_id: A, record_date: '2026-10-01', weight: 60 },
      { id: 'h-b1', user_id: B, record_date: '2026-10-01', weight: 99 },
    ],
  };
}

describe('generateAccountExport: 出力の形式', () => {
  it('format / version / exported_at / user_id / notice / data / summary を持つ有効な JSON になる', async () => {
    const fixedNow = new Date('2026-10-07T12:34:56.789Z');
    const { json } = await drain(buildFixture(), A, { now: () => fixedNow });

    expect(Object.keys(json)).toEqual(['format', 'version', 'exported_at', 'user_id', 'notice', 'data', 'summary']);
    expect(json.format).toBe(EXPORT_FORMAT);
    expect(json.version).toBe(EXPORT_FORMAT_VERSION);
    expect(json.exported_at).toBe('2026-10-07T12:34:56.789Z');
    expect(json.user_id).toBe(A);
    expect(typeof json.notice).toBe('string');
    expect(json.notice).toContain('ご本人のデータだけ');
  });

  it('data には許可リストのテーブルが、定義した順にすべて入る (空のテーブルも [] で入る)', async () => {
    const { json } = await drain(buildFixture(), A);
    expect(Object.keys(json.data)).toEqual(ACCOUNT_EXPORT_TABLES.map((t) => t.table));
    expect(json.data.pantry_items).toEqual([]);
    expect(Array.isArray(json.data.user_profiles)).toBe(true);
  });

  it('summary に行数と打ち切りの有無が入る', async () => {
    const { json, summary } = await drain(buildFixture(), A);
    expect(summary).toEqual(json.summary);
    expect(summary.complete).toBe(true);
    expect(summary.truncated_tables).toEqual([]);
    expect(summary.skipped_tables).toEqual([]);
    expect(summary.row_counts.meals).toBe(2);
    expect(summary.row_counts.planned_meals).toBe(3);
    expect(summary.row_counts.pantry_items).toBe(0);
    expect(Object.keys(summary.row_counts)).toEqual(ACCOUNT_EXPORT_TABLES.map((t) => t.table));
  });

  it('1 行 1 レコードの読みやすい整形で出力する (全体を 1 行にしない)', async () => {
    const { text } = await drain(buildFixture(), A);
    expect(text.split('\n').length).toBeGreaterThan(20);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('ファイル名は homegohan-export-YYYY-MM-DD.json (UTC の日付)', () => {
    expect(buildExportFilename(new Date('2026-10-07T23:59:59Z'))).toBe('homegohan-export-2026-10-07.json');
    expect(buildExportFilename()).toMatch(/^homegohan-export-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

describe('generateAccountExport: 本人の行だけを出す (スコープ)', () => {
  it('他人 (B) の行・公開行・システムの行・家族の行は 1 件も入らない', async () => {
    const { text, json } = await drain(buildFixture(), A);

    expect(json.data.user_profiles.map((r: FakeRow) => r.id)).toEqual([A]);
    expect(json.data.meals.map((r: FakeRow) => r.id)).toEqual(['m-a1', 'm-a2']);
    expect(json.data.recipes.map((r: FakeRow) => r.id)).toEqual(['r-a1']);
    expect(json.data.recipe_collections.map((r: FakeRow) => r.id)).toEqual(['rc-a']);
    expect(json.data.recipe_likes).toEqual([{ user_id: A, recipe_id: 'r-b1' }]);
    expect(json.data.recipe_comments.map((r: FakeRow) => r.id)).toEqual(['c-a']);
    expect(json.data.cookie_consents.map((r: FakeRow) => r.id)).toEqual(['cc-a']);
    expect(json.data.family_members.map((r: FakeRow) => r.id)).toEqual(['fm-a']);
    expect(json.data.family_groups.map((r: FakeRow) => r.id)).toEqual(['fam-2']);
    expect(json.data.organization_challenge_participants.map((r: FakeRow) => r.id)).toEqual(['ocp-a']);
    expect(json.data.support_tickets.map((r: FakeRow) => r.id)).toEqual(['t-a']);
    expect(json.data.inquiries.map((r: FakeRow) => r.id)).toEqual(['i-a']);
    expect(json.data.personal_subscriptions.map((r: FakeRow) => r.id)).toEqual(['s-a']);

    // どのテーブルにも B の ID も B の固有文字列も現れない
    expect(text).not.toContain(B);
    expect(text).not.toContain('B-secret');
    expect(text).not.toContain('B-public');
    expect(text).not.toContain('system-recipe');
    expect(text).not.toContain('anon-session');
  });

  it('親テーブル経由の子表は、本人の親に属する行だけが入る', async () => {
    const { json } = await drain(buildFixture(), A);
    expect(json.data.planned_meals.map((r: FakeRow) => r.id)).toEqual(['p-a1', 'p-a2', 'p-a3']);
    expect(json.data.meal_ai_feedbacks.map((r: FakeRow) => r.id)).toEqual(['f-a1']);
    expect(json.data.recipe_collection_items).toEqual([{ collection_id: 'rc-a', recipe_id: 'r-a1' }]);
  });

  it('結合のために付けた親テーブルのキーは出力に残らない', async () => {
    const { json } = await drain(buildFixture(), A);
    for (const row of json.data.planned_meals) expect(row).not.toHaveProperty('user_daily_meals');
    for (const row of json.data.meal_ai_feedbacks) expect(row).not.toHaveProperty('meals');
    for (const row of json.data.support_ticket_messages) expect(row).not.toHaveProperty('support_tickets');
  });

  it('同じデータでも、ユーザーが B なら B の行だけが入る (A の行は入らない)', async () => {
    const { text, json } = await drain(buildFixture(), B);
    expect(json.data.meals.map((r: FakeRow) => r.id)).toEqual(['m-b1']);
    expect(json.data.planned_meals.map((r: FakeRow) => r.id)).toEqual(['p-b1']);
    expect(text).not.toContain(A);
    expect(text).not.toContain('A-meal');
    expect(text).not.toContain('A-dish');
  });

  it('全テーブルの問い合わせに、本人で絞る .eq が付いている', async () => {
    const { db } = await drain({}, A);
    expect(db.queries).toHaveLength(ACCOUNT_EXPORT_TABLES.length);
    for (const t of ACCOUNT_EXPORT_TABLES) {
      const query = db.queries.find((q) => q.table === t.table);
      expect(query, `${t.table} が問い合わせられていない`).toBeDefined();
      const scopeColumn = t.scope.kind === 'self' ? t.scope.column : `${t.scope.parent}.${t.scope.parentColumn}`;
      expect(query!.eq, `${t.table} に本人の絞り込みが無い`).toContainEqual([scopeColumn, A]);
      if (t.scope.kind === 'parent') {
        // 親との結合は外部キー列のヒント付きの !inner (関係が曖昧にならず、親が無い行は返らない)
        expect(query!.select).toBe(`${t.columns ?? '*'},${t.scope.parent}!${t.scope.fk}!inner(${t.scope.parentColumn})`);
      }
    }
  });

  it('運営ロールのユーザー (RLS では全員分が読める表) でも、自分の行だけが入る', async () => {
    const tables = buildFixture();
    tables.user_profiles.push({ id: STAFF, nickname: 'staff', roles: ['support'] });
    tables.support_tickets.push({ id: 't-staff', user_id: STAFF, subject: 'STAFF-ticket' });
    tables.inquiries.push({ id: 'i-staff', user_id: STAFF, subject: 'STAFF-inquiry' });
    const { json, text } = await drain(tables, STAFF);

    expect(json.data.support_tickets.map((r: FakeRow) => r.id)).toEqual(['t-staff']);
    expect(json.data.inquiries.map((r: FakeRow) => r.id)).toEqual(['i-staff']);
    expect(json.data.personal_subscriptions).toEqual([]);
    expect(text).not.toContain('A-ticket');
    expect(text).not.toContain('B-secret');
  });
});

describe('generateAccountExport: 取得結果に他人の行が混ざったら中止する (fail-closed)', () => {
  it('絞り込みが効かず他人の行が返ったら ExportScopeViolationError。何も出力しない', async () => {
    const db = createFakePostgrest({ tables: buildFixture(), relations: RELATIONS, ignoreFilters: true });
    const generator = generateAccountExport(db as unknown as AccountExportSupabase, A);
    const chunks: string[] = [];

    await expect(
      (async () => {
        for (;;) {
          const step = await generator.next();
          if (step.done) return;
          chunks.push(step.value);
        }
      })(),
    ).rejects.toBeInstanceOf(ExportScopeViolationError);
    // 最初のテーブル (user_profiles) の時点で止まり、B のデータは 1 バイトも出ていない
    expect(chunks).toEqual([]);
  });

  it('親テーブル経由の子表でも、親が他人の行なら中止する', async () => {
    const db = createFakePostgrest({ tables: buildFixture(), relations: RELATIONS, ignoreFilters: true });
    const generator = generateAccountExport(db as unknown as AccountExportSupabase, A, {
      tables: [spec('planned_meals')],
    });
    await expect(generator.next()).rejects.toMatchObject({ name: 'ExportScopeViolationError', table: 'planned_meals' });
  });

  it('持ち主を確認できない行 (親が引けない孤児) も出力しない', async () => {
    const tables = { planned_meals: [{ id: 'p-orphan', daily_meal_id: 'no-such-daily-meal' }] };
    const db = createFakePostgrest({ tables, relations: RELATIONS, ignoreFilters: true });
    const generator = generateAccountExport(db as unknown as AccountExportSupabase, A, {
      tables: [spec('planned_meals')],
    });
    await expect(generator.next()).rejects.toBeInstanceOf(ExportScopeViolationError);
  });
});

describe('generateAccountExport: 秘密・内部の列を出さない', () => {
  it('Stripe の ID・運営の備考・権限・BAN / 凍結情報・担当者 ID は出力に入らない', async () => {
    const { text, json } = await drain(buildFixture(), A);

    expect(json.data.personal_subscriptions[0]).toMatchObject({ id: 's-a', plan_key: 'premium' });
    for (const secret of ['cus_A', 'sub_A', 'price_A', 'STAFF-NOTE-A', 'ADMIN-NOTE-A', 'admin_notes', 'stripe_']) {
      expect(text).not.toContain(secret);
    }
    const profile = json.data.user_profiles[0];
    expect(profile).toMatchObject({ id: A, nickname: 'エー', age: 30 });
    for (const column of ['roles', 'is_banned', 'banned_reason', 'frozen_by', 'plan_key_cached']) {
      expect(profile).not.toHaveProperty(column);
    }
    expect(json.data.support_tickets[0]).not.toHaveProperty('assignee_id');
    expect(json.data.recipe_flags[0]).not.toHaveProperty('reviewed_by');
    // 運営スタッフのユーザー ID はどこにも出ない
    expect(text).not.toContain(STAFF);
  });

  it('columns を明示した表は、指定した列だけを取得する (生成結果やジョブ管理の列は取得しない)', async () => {
    const { db, json } = await drain(buildFixture(), A);
    const query = db.queries.find((q) => q.table === 'weekly_menu_requests')!;
    expect(query.select).not.toContain('result_json');
    expect(query.select).not.toContain('worker_id');
    expect(json.data.weekly_menu_requests).toHaveLength(1);
    expect(json.data.weekly_menu_requests[0]).toMatchObject({ id: 'w-a', prompt: 'A-prompt', status: 'completed' });
    expect(json.data.weekly_menu_requests[0]).not.toHaveProperty('result_json');
    expect(json.data.weekly_menu_requests[0]).not.toHaveProperty('worker_id');
    expect(json.data.weekly_menu_requests[0]).not.toHaveProperty('attempt_count');
  });

  it('サポートへの問い合わせ: 運営の内部メモは出さず、返信者の ID は user / support に置き換える', async () => {
    const { db, text, json } = await drain(buildFixture(), A);
    const query = db.queries.find((q) => q.table === 'support_ticket_messages')!;
    expect(query.eq).toContainEqual(['is_internal', false]);

    expect(json.data.support_ticket_messages).toEqual([
      { id: 'tm-1', ticket_id: 't-a', is_internal: false, body: 'A-asks', sender: 'user' },
      { id: 'tm-2', ticket_id: 't-a', is_internal: false, body: 'support-replies', sender: 'support' },
    ]);
    expect(text).not.toContain('INTERNAL-NOTE');
    expect(text).not.toContain('sender_id');
  });

  it('user_badges にはバッジの名前・説明を添える (条件式は出さない)', async () => {
    const { json, text } = await drain(buildFixture(), A);
    expect(json.data.user_badges).toEqual([
      {
        user_id: A,
        badge_id: 'bd-1',
        obtained_at: 't',
        badge: { code: 'first_record', name: '初めての記録', description: 'desc' },
      },
    ]);
    expect(text).not.toContain('CONDITION-JSON');
  });
});

describe('generateAccountExport: ページングとサイズ・時間の上限', () => {
  const rowsFor = (n: number, userId = A): FakeRow[] =>
    Array.from({ length: n }, (_, i) => ({ id: `h-${String(i).padStart(5, '0')}`, user_id: userId, weight: i }));
  const onlyHealthRecords = [spec('health_records')];

  it('1000 行ずつ取得し、全件を id 順に出力する。件数の取得 (count: exact) は 1 ページ目だけ', async () => {
    const tables = { health_records: [...rowsFor(2500), ...rowsFor(100, B).map((r) => ({ ...r, id: `b-${r.id}` }))] };
    const { db, json, summary } = await drain(tables, A, { tables: onlyHealthRecords });

    const queries = db.queries.filter((q) => q.table === 'health_records');
    expect(queries.map((q) => q.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(queries.map((q) => q.count)).toEqual([true, false, false]);
    expect(queries.every((q) => q.order.join() === 'id')).toBe(true);

    expect(json.data.health_records).toHaveLength(2500);
    expect(json.data.health_records[0].id).toBe('h-00000');
    expect(json.data.health_records[2499].id).toBe('h-02499');
    expect(summary).toMatchObject({ complete: true, row_counts: { health_records: 2500 } });
  });

  it('サーバーの max_rows が pageSize より小さくても、取りこぼさず全件出力する', async () => {
    const tables = { health_records: rowsFor(1000) };
    const { db, json } = await drain(tables, A, { tables: onlyHealthRecords }, { maxRows: 400 });
    expect(json.data.health_records).toHaveLength(1000);
    expect(new Set(json.data.health_records.map((r: FakeRow) => r.id)).size).toBe(1000);
    expect(db.queries.filter((q) => q.table === 'health_records')).toHaveLength(3);
  });

  it('ちょうど 1 ページ分 (1000 行) のテーブルでも余計なページを取りに行かない', async () => {
    const { db, json } = await drain({ health_records: rowsFor(1000) }, A, { tables: onlyHealthRecords });
    expect(json.data.health_records).toHaveLength(1000);
    expect(db.queries.filter((q) => q.table === 'health_records')).toHaveLength(1);
  });

  it('1 テーブルの行数上限: 超えた分は切り、summary に row_limit と総件数を記録する (他の表は続ける)', async () => {
    const tables = { health_records: rowsFor(2500), meals: [{ id: 'm-1', user_id: A }] };
    const { json, summary } = await drain(tables, A, {
      tables: [spec('health_records'), spec('meals')],
      limits: { maxRowsPerTable: 1500 },
    });

    expect(json.data.health_records).toHaveLength(1500);
    expect(json.data.meals).toHaveLength(1);
    expect(summary.complete).toBe(false);
    expect(summary.truncated_tables).toEqual([
      { table: 'health_records', reason: 'row_limit', exported_rows: 1500, total_rows: 2500 },
    ]);
    expect(summary.skipped_tables).toEqual([]);
  });

  it('行数がちょうど上限のテーブルは、打ち切り扱いにしない', async () => {
    const { summary } = await drain({ health_records: rowsFor(1500) }, A, {
      tables: onlyHealthRecords,
      limits: { maxRowsPerTable: 1500 },
    });
    expect(summary.complete).toBe(true);
    expect(summary.row_counts.health_records).toBe(1500);
  });

  it('全体のサイズ上限: 途中で止めても有効な JSON になり、切れた表と飛ばした表を summary に記録する', async () => {
    const bigRows = (prefix: string): FakeRow[] =>
      Array.from({ length: 50 }, (_, i) => ({ id: `${prefix}-${String(i).padStart(3, '0')}`, user_id: A, memo: 'x'.repeat(100) }));
    const tables = { meals: bigRows('m'), health_records: bigRows('h'), pantry_items: bigRows('p') };
    const limits = { maxTotalBytes: 6000, reservedBytes: 1500 };
    const { text, json, summary } = await drain(tables, A, {
      tables: [spec('meals'), spec('health_records'), spec('pantry_items')],
      limits,
    });

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(limits.maxTotalBytes);
    expect(summary.complete).toBe(false);
    expect(summary.truncated_tables).toHaveLength(1);
    expect(summary.truncated_tables[0]).toMatchObject({ table: 'meals', reason: 'size_limit', total_rows: 50 });
    expect(summary.truncated_tables[0].exported_rows).toBeGreaterThan(0);
    expect(summary.truncated_tables[0].exported_rows).toBeLessThan(50);
    expect(summary.skipped_tables).toEqual([
      { table: 'health_records', reason: 'size_limit' },
      { table: 'pantry_items', reason: 'size_limit' },
    ]);
    // 飛ばした表は data に出さない
    expect(Object.keys(json.data)).toEqual(['meals']);
    expect(json.summary).toEqual(summary);
  });

  it('時間の上限: 最初の表のあと残りを飛ばして有効な JSON で閉じる', async () => {
    let clock = 0;
    const { json, summary } = await drain(
      { meals: [{ id: 'm-1', user_id: A }], health_records: rowsFor(3), pantry_items: [] },
      A,
      {
        tables: [spec('meals'), spec('health_records'), spec('pantry_items')],
        limits: { maxDurationMs: 30_000 },
        nowMs: () => (clock += 20_000),
      },
    );
    expect(Object.keys(json.data)).toEqual(['meals']);
    expect(summary.complete).toBe(false);
    expect(summary.skipped_tables).toEqual([
      { table: 'health_records', reason: 'time_limit' },
      { table: 'pantry_items', reason: 'time_limit' },
    ]);
  });

  it('時間の上限: テーブルの途中 (2 ページ目の前) で切れたら time_limit として記録する', async () => {
    let clock = 0;
    const { json, summary } = await drain({ health_records: rowsFor(2500), meals: [] }, A, {
      tables: [spec('health_records'), spec('meals')],
      limits: { maxDurationMs: 30_000 },
      nowMs: () => (clock += 20_000),
    });
    expect(json.data.health_records).toHaveLength(1000);
    expect(summary.truncated_tables).toEqual([
      { table: 'health_records', reason: 'time_limit', exported_rows: 1000, total_rows: 2500 },
    ]);
    expect(summary.skipped_tables).toEqual([{ table: 'meals', reason: 'time_limit' }]);
  });

  it('既定の上限: 1 ページ 1000 行 (PostgREST の max_rows 既定値以下)、1 表 2 万行、全体 50MB', () => {
    expect(DEFAULT_EXPORT_LIMITS.pageSize).toBeLessThanOrEqual(1000);
    expect(DEFAULT_EXPORT_LIMITS.maxRowsPerTable).toBe(20_000);
    expect(DEFAULT_EXPORT_LIMITS.maxTotalBytes).toBe(50 * 1024 * 1024);
    // route の maxDuration (60 秒) より短い
    expect(DEFAULT_EXPORT_LIMITS.maxDurationMs).toBeLessThan(60_000);
  });
});

describe('generateAccountExport: エラーの扱い', () => {
  it('最初のテーブルの取得に失敗したら、何も出力する前に例外になる (呼び出し側が 500 にできる)', async () => {
    const db = createFakePostgrest({
      tables: buildFixture(),
      relations: RELATIONS,
      errors: { user_profiles: { message: 'permission denied', code: '42501' } },
    });
    const generator = generateAccountExport(db as unknown as AccountExportSupabase, A);
    await expect(generator.next()).rejects.toThrow(/user_profiles.*permission denied.*42501/);
  });

  it('途中のテーブルで失敗したら、そこまでの出力のあとで例外になる (欠けた JSON を完成品にしない)', async () => {
    const db = createFakePostgrest({
      tables: buildFixture(),
      relations: RELATIONS,
      errors: { meals: { message: 'statement timeout', code: '57014' } },
    });
    const generator = generateAccountExport(db as unknown as AccountExportSupabase, A);
    const first = await generator.next();
    expect(first.done).toBe(false);
    await expect(
      (async () => {
        for (;;) {
          const step = await generator.next();
          if (step.done) return;
        }
      })(),
    ).rejects.toThrow(/meals.*statement timeout/);
  });
});

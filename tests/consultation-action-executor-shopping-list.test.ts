/**
 * #1214: AI 相談チャットのアクション add_to_shopping_list (consultation-action-executor.ts) も、
 * add-recipe API と同じ「アクティブな買い物リストの get-or-create」を使っていた。
 *
 * 修正前の実装には add-recipe と同じ 2 つの欠陥があった。
 *   - INSERT が存在しない name 列を送るため、アクティブなリストが無いユーザーは常に
 *     「買い物リストの作成に失敗しました」になる (本番の shopping_lists の列は title)
 *   - SELECT → INSERT の check-then-act のため、同時実行で 23505 に負けた側が失敗する
 *
 * 共通ヘルパー (src/lib/shopping-list/active-list.ts) に置き換えた後の挙動を確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeShoppingListsDb, pgError, type FakeShoppingListsDb } from './helpers/fake-shopping-lists-db';

const USER_ID = 'user-1';

const logError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/menu-generation-feature-flags', () => ({
  loadFeatureFlags: vi.fn(async () => ({})),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

import { runConsultationAction, type ConsultationActionRow } from '../src/lib/ai/consultation-action-executor';

function addToShoppingListAction(items: unknown): ConsultationActionRow {
  return {
    id: 'action-1',
    action_type: 'add_to_shopping_list',
    action_params: { items },
    ai_consultation_sessions: { user_id: USER_ID },
  };
}

const ITEMS = [
  { name: '牛乳', quantity: '1本', category: '乳製品' },
  { name: '食パン', quantity: '1斤' },
];

let db: FakeShoppingListsDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = createFakeShoppingListsDb(USER_ID);
});

describe('runConsultationAction: add_to_shopping_list', () => {
  it('アクティブなリストが無いユーザーでも、リストを作って食材を追加できる (title / start_date / end_date 付き)', async () => {
    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToShoppingListAction(ITEMS));

    expect(success).toBe(true);
    expect(result).toEqual({ itemsAdded: 2 });
    expect(db.lists).toHaveLength(1);
    expect(db.lists[0]).toMatchObject({ user_id: USER_ID, status: 'active', title: '買い物リスト' });
    expect(db.lists[0].start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(db.lists[0].end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(db.items.map((i) => i.item_name)).toEqual(['牛乳', '食パン']);
    expect(db.items.every((i) => i.shopping_list_id === db.lists[0].id)).toBe(true);
  });

  it('既存のアクティブなリストがあれば、新しいリストは作らずそこへ追加する', async () => {
    const existing = db.seedActiveList(USER_ID);

    const { success } = await runConsultationAction(db.supabase, { id: USER_ID }, addToShoppingListAction(ITEMS));

    expect(success).toBe(true);
    expect(db.lists).toHaveLength(1);
    expect(db.items.every((i) => i.shopping_list_id === existing.id)).toBe(true);
  });

  it('SELECT の後 INSERT の前に別リクエストがリストを作っても (23505)、失敗せず既存のリストへ追加する', async () => {
    let winner = '';
    db.beforeNextListInsert(() => {
      winner = db.seedActiveList(USER_ID).id;
    });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToShoppingListAction(ITEMS));

    expect(success).toBe(true);
    expect(result).toEqual({ itemsAdded: 2 });
    expect(db.lists).toHaveLength(1);
    expect(db.items.every((i) => i.shopping_list_id === winner)).toBe(true);
    expect(logError).not.toHaveBeenCalled();
  });

  it('リストを作れなければ、従来どおり「買い物リストの作成に失敗しました」を返し、原因をログに残す', async () => {
    const raw = pgError('42501', 'new row violates row-level security policy for table "shopping_lists"');
    db.failNext('shopping_lists', 'insert', raw);

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToShoppingListAction(ITEMS));

    expect(success).toBe(false);
    expect(result).toEqual({ error: '買い物リストの作成に失敗しました' });
    expect(db.items).toHaveLength(0);
    expect(logError).toHaveBeenCalledTimes(1);
    const [message, loggedError, meta] = logError.mock.calls[0];
    expect(message).toBe('Failed to get or create active shopping list');
    expect(loggedError).toBeInstanceOf(Error);
    expect((loggedError as Error).message).toBe(raw.message);
    expect(meta).toEqual({ actionId: 'action-1', pg_code: '42501' });
  });
});

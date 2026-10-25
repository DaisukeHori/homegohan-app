// @vitest-environment node
/**
 * #2025: 献立の完了の切り替え setPlannedMealCompleted (src/modules/planned-meals-integrity/server.ts)。
 * 設計: docs/design/cross/23-planned-meals-score-integrity.md §7.8・§12.1
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PLANNED_MEALS_SET_COMPLETED_RPC,
  PLANNED_MEAL_NOT_FOUND_CODE,
  PLANNED_MEAL_NOT_FOUND_SQLSTATE,
} from '@homegohan/shared';
import { PLANNED_MEAL_COMPLETION_ROW_SHAPE_FAILURE_MESSAGE } from '@/modules/planned-meals-integrity/core';
import { setPlannedMealCompleted, type PlannedMealsIntegrityDb } from '@/modules/planned-meals-integrity/server';

const MEAL_ID = '22222222-2222-4222-8222-222222222222';
const COMPLETED_AT = '2026-01-10T03:00:00+00:00';
const UPDATED_AT = '2026-01-10T03:00:01+00:00';
const ROW = { id: MEAL_ID, is_completed: true, completed_at: COMPLETED_AT, updated_at: UPDATED_AT };

type RpcResponse = { data: unknown; error: unknown };

function dbReturning(response: RpcResponse) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => response);
  // rpc だけを使う偽物 (PostgrestFilterBuilder の型は持たないので、関数の形だけを合わせて渡す)
  const db = { rpc } as unknown as PlannedMealsIntegrityDb;
  return { db, rpc };
}

describe('#2025 setPlannedMealCompleted', () => {
  it('UUID の形でない id は rpc を呼ばず not_found', async () => {
    const { db, rpc } = dbReturning({ data: [ROW], error: null });
    for (const mealId of ['', 'abc', '123', `${MEAL_ID}x`]) {
      expect(await setPlannedMealCompleted(db, { mealId, completed: true }), mealId).toEqual({ ok: false, reason: 'not_found' });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rpc を PLANNED_MEALS_SET_COMPLETED_RPC と { p_meal_id, p_completed } で 1 回呼ぶ', async () => {
    const { db, rpc } = dbReturning({ data: [ROW], error: null });
    await setPlannedMealCompleted(db, { mealId: MEAL_ID, completed: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id: MEAL_ID, p_completed: true });

    const undo = dbReturning({ data: [{ ...ROW, is_completed: false, completed_at: null }], error: null });
    await setPlannedMealCompleted(undo.db, { mealId: MEAL_ID, completed: false });
    expect(undo.rpc).toHaveBeenCalledWith(PLANNED_MEALS_SET_COMPLETED_RPC, { p_meal_id: MEAL_ID, p_completed: false });
  });

  it('P0002 / PLANNED_MEAL_NOT_FOUND の error は not_found', async () => {
    const byCode = dbReturning({ data: null, error: { code: PLANNED_MEAL_NOT_FOUND_SQLSTATE, message: 'x' } });
    expect(await setPlannedMealCompleted(byCode.db, { mealId: MEAL_ID, completed: true })).toEqual({ ok: false, reason: 'not_found' });
    const byMessage = dbReturning({ data: null, error: { code: 'XX000', message: `ERROR: ${PLANNED_MEAL_NOT_FOUND_CODE}` } });
    expect(await setPlannedMealCompleted(byMessage.db, { mealId: MEAL_ID, completed: true })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('ほかの error は db (error をそのまま持つ)', async () => {
    const error = { code: 'PGRST202', message: 'Could not find the function' };
    const { db } = dbReturning({ data: null, error });
    const result = await setPlannedMealCompleted(db, { mealId: MEAL_ID, completed: true });
    expect(result).toEqual({ ok: false, reason: 'db', error });
    if (!result.ok && result.reason === 'db') expect(result.error).toBe(error);
  });

  it('data が配列でも単体でも同じ行を返す', async () => {
    const asArray = dbReturning({ data: [ROW], error: null });
    expect(await setPlannedMealCompleted(asArray.db, { mealId: MEAL_ID, completed: true })).toEqual({ ok: true, row: ROW });
    const asObject = dbReturning({ data: ROW, error: null });
    expect(await setPlannedMealCompleted(asObject.db, { mealId: MEAL_ID, completed: true })).toEqual({ ok: true, row: ROW });
  });

  it('行の形が違えば db (PLANNED_MEAL_COMPLETION_ROW_SHAPE_FAILURE_MESSAGE)', async () => {
    for (const data of [[], null, undefined, [{ ...ROW, is_completed: 'yes' }], [{ id: MEAL_ID }]]) {
      const { db } = dbReturning({ data, error: null });
      const result = await setPlannedMealCompleted(db, { mealId: MEAL_ID, completed: true });
      expect(result.ok, JSON.stringify(data) ?? 'undefined').toBe(false);
      if (result.ok || result.reason !== 'db') throw new Error('db の失敗のはず');
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe(PLANNED_MEAL_COMPLETION_ROW_SHAPE_FAILURE_MESSAGE);
    }
  });
});

// C-4 (設計書 docs/design/family/10-family-menu-view.md §19.6): 生成型 → 正典の型の片方向の検査。
// tests/ は tsc の対象外 (tsconfig.json の exclude) なので、型が掛かる src/__tests__ に置く。
// route と同じ 2 つの経路 (生成型の行 → FamilyMenuVisibleMemberRow・生成型の Json → FamilyMenuRpcRowsSchema.safeParse) を通る。
import { describe, expect, it } from 'vitest';
import type { Database } from '@/types/database.types';
import { FamilyMenuRpcRowsSchema } from '@/schemas/membership/family-menu';
import { groupFamilyMenuRows, type FamilyMenuVisibleMemberRow } from '@/lib/membership/family-menu';

type Fns = Database['public']['Functions'];
type GeneratedMemberRow = Fns['family_menu_visible_members']['Returns'][number];
/** RETURNS jsonb なので生成型は Json (llm_usage_summary と同じ) */
type GeneratedMealsReturn = Fns['family_menu_planned_meals']['Returns'];

const MEMBER_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const MEAL_ID = '00000000-0000-4000-8000-000000000003';
const FAMILY_ID = '00000000-0000-4000-8000-000000000004';
const DAY = '2026-10-16';

describe('C-4: 生成型 (database.types.ts) の Returns は、route と同じ経路で groupFamilyMenuRows に渡せる', () => {
  it('C-4: 生成型の行を FamilyMenuVisibleMemberRow として、生成型の Json を FamilyMenuRpcRowsSchema で読んで、応答の形にまとめる', () => {
    const generatedMember: GeneratedMemberRow = { member_id: MEMBER_ID, user_id: USER_ID };
    const member: FamilyMenuVisibleMemberRow = generatedMember; // 生成型 → 正典の型 (片方向)
    const meals: GeneratedMealsReturn = [{
      member_id: MEMBER_ID, user_id: USER_ID, day_date: DAY, id: MEAL_ID, meal_type: 'dinner',
      dish_name: '肉じゃが', dish_names: ['肉じゃが'], is_simple: null,
      calories_kcal: null, cooking_time_minutes: null, display_order: null, is_completed: null,
    }];
    const parsed = FamilyMenuRpcRowsSchema.safeParse(meals);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = groupFamilyMenuRows([member], parsed.data, { family_id: FAMILY_ID, start_date: DAY, end_date: DAY });
    expect(data.members).toEqual([
      {
        member_id: MEMBER_ID,
        user_id: USER_ID,
        days: [{
          day_date: DAY,
          meals: [expect.objectContaining({
            id: MEAL_ID, meal_type: 'dinner', dish_name: '肉じゃが', dish_names: ['肉じゃが'],
            is_simple: true, display_order: 0, is_completed: false,
          })],
        }],
      },
    ]);
  });
});

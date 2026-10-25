// 一時的な調べ (PostgREST の PATCH の返り値と count が、更新した列の絞り込みでどう変わるか)。結果を見たら消す
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/supabase';

const db = adminClient();
const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

describe('probe', () => {
  it('probe', async () => {
    const email = `probe-${Date.now()}-${randomBytes(3).toString('hex')}@homegohan.test`;
    const u = await db.auth.admin.createUser({ email, password: `${randomBytes(18).toString('base64url')}Aa1!`, email_confirm: true });
    const userId = u.data.user!.id;
    const day = await db.from('user_daily_meals').insert({ user_id: userId, day_date: '2026-01-13' }).select('id').single();
    const mk = async () => (await db.from('planned_meals').insert({ daily_meal_id: day.data!.id, meal_type: 'dinner', dish_name: 'probe' }).select('id, updated_at').single()).data!;
    const out: Record<string, unknown> = {};
    let m = await mk();
    let r: { data: unknown; error: unknown; count?: number | null; status?: number } = await db.from('planned_meals').update({ memo: 'a' }).eq('id', m.id).lte('updated_at', FUTURE).select('id, updated_at');
    out.lteSelect = { data: r.data, error: r.error, after: (await db.from('planned_meals').select('memo, updated_at').eq('id', m.id).single()).data };
    m = await mk();
    r = await db.from('planned_meals').update({ memo: 'b' }).eq('id', m.id).or(`updated_at.is.null,updated_at.lte."${FUTURE}"`).select('id, updated_at');
    out.orSelect = { data: r.data, error: r.error, after: (await db.from('planned_meals').select('memo, updated_at').eq('id', m.id).single()).data };
    m = await mk();
    r = await db.from('planned_meals').update({ memo: 'c' }, { count: 'exact' }).eq('id', m.id).or(`updated_at.is.null,updated_at.lte."${FUTURE}"`);
    out.orCount = { count: r.count, status: r.status, error: r.error };
    m = await mk();
    r = await db.from('planned_meals').update({ memo: 'd' }, { count: 'exact' }).eq('id', m.id).or(`updated_at.is.null,updated_at.lte."${PAST}"`);
    out.orCountPast = { count: r.count, status: r.status, error: r.error };
    m = await mk();
    r = await db.from('planned_meals').update({ memo: 'e' }, { count: 'exact' }).eq('id', m.id).eq('updated_at', m.updated_at);
    out.eqCount = { count: r.count, status: r.status, error: r.error };
    m = await mk();
    r = await db.from('planned_meals').update({ memo: 'f' }).eq('id', m.id).eq('updated_at', m.updated_at).select('id');
    out.eqSelect = { data: r.data, error: r.error };
    m = await mk();
    r = await db.from('planned_meals').update({ memo: 'g' }).eq('id', m.id).select('id, updated_at');
    out.idOnly = { data: r.data, before: m.updated_at };
    console.log('PROBE_RESULT ' + JSON.stringify(out));
    await db.from('user_daily_meals').delete().eq('user_id', userId);
    await db.auth.admin.deleteUser(userId);
    expect(true).toBe(true);
  }, 120_000);
});

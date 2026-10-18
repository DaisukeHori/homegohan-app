/**
 * #1867 「計画上手」(planner) を、AI の週の献立の生成が完了 (completed) した時点で DB のトリガーで付ける migration
 * (supabase/migrations/20261018060000_planner_badge_award_on_weekly_menu_completed.sql) の静的な突き合わせ (DB 無し。SQL の文面を読む)。
 * オーナーの選択 (2026-10-18 17 時台、選択式): 「取れる条件を足す」— AI で週の献立を初めて作ったときにも付くようにし、説明もそれに合わせる。
 *
 * 付与の発火点を読む側 (状態の確認・バッジの一覧) だけに置くと、完了を読まない画面 (モバイルは Realtime と行の直接の読み取りで完了を知り、
 * バッジの一覧の画面も無い) の利用者には付かない。そこで完了を書いた時点で付けるトリガーを置いた。ここでは次を確かめる。
 *   - トリガーは weekly_menu_requests の status の更新で、completed 以外から completed になったときだけ動く (失敗 failed では動かない)
 *   - 印のキーと値が、アプリの印の定義 (src/lib/ai/weekly-menu-request-origin.ts) と同じ。更新後 (NEW) と更新前 (OLD) の両方を見る
 *   - 付けるバッジは planner で、付与処理のあるバッジの一覧 (AWARDABLE_BADGE_CODES) にある
 *   - user_badges への追加は ON CONFLICT (user_id, badge_id) DO NOTHING (お試しなどで付いていれば何もしない)。付ける相手は行の持ち主 (NEW.user_id)
 *   - 付与の失敗で献立の最終の書き込みを止めない (EXCEPTION WHEN OTHERS で WARNING にして NEW を返す)
 *   - トリガー関数は SECURITY DEFINER・search_path ''・EXECUTE を誰にも付けない (REVOKE は完全形・GRANT 無し。anon-definer-execute の番兵の対象)
 *   - down.sql がトリガーと関数を消す。migration は何度流しても同じ (CREATE OR REPLACE・DROP TRIGGER IF EXISTS)
 * 実 DB での確認は tests/integration/security/planner-badge-weekly-menu.test.ts の W-5・W-6。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AWARDABLE_BADGE_CODES } from '@/lib/badges/awardable';
import {
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_VALUE,
  WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY,
} from '@/lib/ai/weekly-menu-request-origin';

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = 'supabase/migrations/20261018060000_planner_badge_award_on_weekly_menu_completed.sql';
const ROLLBACK = 'supabase/rollbacks/20261018060000_planner_badge_award_on_weekly_menu_completed.down.sql';
const TRIGGER_FUNCTION = 'public.award_planner_badge_on_weekly_menu_completed';
const TRIGGER_NAME = 'weekly_menu_requests_award_planner';
/** 状態の確認 (保険の経路) が付ける条件の status。トリガーも同じ status で付ける */
const WEEKLY_STATUS_ROUTE = 'src/app/api/ai/menu/weekly/status/route.ts';

/** SQL のコメント (-- から行末) を外す。説明文の中の語に当たらないようにする */
function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}
/** 空白を 1 つにそろえる */
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const migrationRaw = read(MIGRATION);
const migration = squash(stripSqlComments(migrationRaw));
const rollback = squash(stripSqlComments(read(ROLLBACK)));

/** 関数の本体 ($$ と $$ の間) */
function functionBody(): string {
  const start = migration.indexOf('AS $$');
  const end = migration.indexOf('$$;', start + 'AS $$'.length);
  expect(start, '関数の本体の始まり (AS $$) が無い').toBeGreaterThanOrEqual(0);
  expect(end, '関数の本体の終わり ($$;) が無い').toBeGreaterThan(start);
  return migration.slice(start, end);
}

/** 本体の定数 (c_<名前> CONSTANT text := '<値>') の値 */
function constantOf(name: string): string | undefined {
  return functionBody().match(new RegExp(`\\b${name} CONSTANT text := '([^']*)';`))?.[1];
}

describe('#1867 planner を週の献立の生成の完了で付けるトリガーの migration', () => {
  it('migration と戻し口の 1 行目が自分の名前を指す', () => {
    expect(migrationRaw.split('\n')[0]).toBe(`-- migration: ${path.basename(MIGRATION)}`);
    expect(read(ROLLBACK).split('\n')[0]).toBe(`-- rollback: ${path.basename(MIGRATION)}`);
    expect(migrationRaw).toContain(`-- 戻し方: ${ROLLBACK}`);
  });

  it('トリガーは status の更新で、completed 以外から completed になったときだけ動く', () => {
    expect(migration).toContain(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON public.weekly_menu_requests;`);
    expect(migration).toContain(
      `CREATE TRIGGER ${TRIGGER_NAME} AFTER UPDATE OF status ON public.weekly_menu_requests FOR EACH ROW ` +
        `WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'completed') ` +
        `EXECUTE FUNCTION ${TRIGGER_FUNCTION}();`,
    );
    // 関数だけでも同じ条件を守る (WHEN 句を外しても failed・status の変わらない更新では付けない)
    expect(functionBody()).toContain(
      "IF NEW.status IS DISTINCT FROM 'completed' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;",
    );
    // 状態の確認 (保険) と同じ status で付ける
    expect(read(WEEKLY_STATUS_ROUTE)).toContain("request.status === 'completed' && isWeeklyMenuRequestWeeklyOrigin(");
    expect(migration).not.toMatch(/'failed'/);
  });

  it('印のキーと値はアプリの印の定義と同じで、更新後 (NEW) と更新前 (OLD) の両方を見る', () => {
    expect(constantOf('c_origin_key')).toBe(WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY);
    expect(constantOf('c_origin_value')).toBe(WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_VALUE);
    expect(functionBody()).toContain(
      'IF (NEW.generated_data ->> c_origin_key) IS DISTINCT FROM c_origin_value ' +
        'AND (OLD.generated_data ->> c_origin_key) IS DISTINCT FROM c_origin_value THEN RETURN NEW; END IF;',
    );
  });

  it('付けるのは planner (付与処理のあるバッジ) で、行の持ち主に ON CONFLICT DO NOTHING で足す', () => {
    const code = constantOf('c_badge_code');
    expect(code).toBe('planner');
    expect(AWARDABLE_BADGE_CODES).toContain(code);
    expect(functionBody()).toContain('SELECT b.id INTO v_badge_id FROM public.badges AS b WHERE b.code = c_badge_code;');
    expect(functionBody()).toContain(
      'INSERT INTO public.user_badges (user_id, badge_id, obtained_at) VALUES (NEW.user_id, v_badge_id, now()) ' +
        'ON CONFLICT (user_id, badge_id) DO NOTHING;',
    );
    // 付ける相手は行の持ち主だけ (家族のメンバーなどほかの利用者に付けない)
    expect(functionBody().match(/INSERT INTO/g) ?? []).toHaveLength(1);
  });

  it('付与の失敗で献立の最終の書き込みを止めない (例外は WARNING にして NEW を返す)', () => {
    expect(functionBody()).toMatch(/EXCEPTION WHEN OTHERS THEN RAISE WARNING '[^']*', SQLERRM, NEW\.id; RETURN NEW; END;\s*$/);
  });

  it('トリガー関数は SECURITY DEFINER・search_path \'\'・EXECUTE を誰にも付けない', () => {
    expect(migration).toContain(
      `CREATE OR REPLACE FUNCTION ${TRIGGER_FUNCTION}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$`,
    );
    expect(migration).toContain(
      `REVOKE ALL ON FUNCTION ${TRIGGER_FUNCTION}() FROM PUBLIC, anon, authenticated, service_role;`,
    );
    expect(migration).not.toMatch(/\bGRANT\b/);
  });

  it('down.sql はトリガーと関数を消す (user_badges の行には触れない)', () => {
    expect(rollback).toBe(
      `DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON public.weekly_menu_requests; DROP FUNCTION IF EXISTS ${TRIGGER_FUNCTION}();`,
    );
  });
});

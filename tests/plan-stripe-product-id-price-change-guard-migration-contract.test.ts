/**
 * #2112 Z1-1: supabase/migrations/20261030160000_plan_stripe_product_id_price_change_guard.sql (と、その戻し口) の文面の契約テスト
 * (DB は使わない)。
 *
 * 価格の変更 (Stripe の Price の作成) が進行中のあいだプランの stripe_product_id を変えさせないトリガーの、番号の付け直しや
 * 後の migration の上書き・route の期限の変更で崩れやすい所を、ファイルの文面だけで確かめる。実 DB での振る舞い
 * (begin を開いたままにすると商品の ID の UPDATE はその commit を待って止まる・期限を過ぎた予約では止めない・権限) は
 * tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts の PG-1〜PG-4。
 *   1. 関数とトリガーを定義する migration はこれだけで、版は前の最大より大きい
 *   2. 関数は RETURNS trigger・SECURITY DEFINER・search_path = ''。期限内の予約 (OLD.id の行) があれば
 *      PLAN_PRICE_CHANGE_IN_PROGRESS_DB_ERROR (P0001) で止める (route が 409 に写す文と同じ)
 *   3. 期限 (c_stale_after_seconds) は route が begin に渡す PRICE_CHANGE_RESERVATION_STALE_SECONDS と同じ
 *   4. トリガーは subscription_plans の BEFORE UPDATE OF stripe_product_id の行トリガーで、商品の ID が変わる行だけ
 *      (価格の変更の apply・表示名の編集・状態の変更は止めない)
 *   5. 関数は誰にも EXECUTE を与えない (トリガーだけが呼ぶ)
 *   6. 戻し口はトリガーと関数を消すだけ
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLAN_PRICE_CHANGE_IN_PROGRESS_DB_ERROR,
  PRICE_CHANGE_RESERVATION_STALE_SECONDS,
} from '@/lib/super-admin/plan-price-change-reservation';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261030160000_plan_stripe_product_id_price_change_guard';
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** この migration を足したときの origin/main の最大の版 (これより大きくなければ本番へ当たらない) */
const PREVIOUS_MAX_VERSION = '20261030150000';
const FN = 'guard_plan_stripe_product_id_price_change';
const TRIGGER = 'trg_guard_plan_stripe_product_id_price_change';

const read = (file: string): string => fs.readFileSync(file, 'utf-8');
/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** 空白をまとめる (字下げ・改行の違いを無視して比べるため) */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: read(path.join(MIGRATIONS_DIR, file)) }));

const sql = read(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`));
const code = squash(stripLineComments(sql));

/** 関数の定義 (CREATE OR REPLACE FUNCTION ... AS $$ ... $$) の見出しと本文 */
function definitionOf(source: string): { header: string; body: string } {
  const start = source.search(new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${FN}\s*\(`));
  expect(start, `${FN} の定義が無い`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const opener = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
  expect(opener, `${FN} の本文の始まりが無い`).not.toBeNull();
  const bodyStart = opener!.index + opener![0].length;
  const bodyEnd = rest.indexOf(opener![1], bodyStart);
  return { header: rest.slice(0, opener!.index), body: rest.slice(bodyStart, bodyEnd) };
}

const { header, body: rawBody } = definitionOf(sql);
const body = squash(stripLineComments(rawBody));

describe(`${FN} の定義`, () => {
  it('関数とトリガーを定義する migration はこれだけ (後の migration が上書きしていない)。版は前の最大より大きい', () => {
    const definers = migrations
      .filter(({ sql: text }) => new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?${FN}"?\s*\(`, 'i').test(text))
      .map(({ file }) => file);
    expect(definers).toEqual([`${MIGRATION}.sql`]);
    const triggerDefiners = migrations
      .filter(({ sql: text }) => new RegExp(String.raw`CREATE\s+TRIGGER\s+${TRIGGER}\b`, 'i').test(text))
      .map(({ file }) => file);
    expect(triggerDefiners).toEqual([`${MIGRATION}.sql`]);
    expect(MIGRATION.slice(0, PREVIOUS_MAX_VERSION.length) > PREVIOUS_MAX_VERSION).toBe(true);
    expect(sql.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION}.sql`);
    expect(sql).toContain(`supabase/rollbacks/${MIGRATION}.down.sql`);
  });

  it("RETURNS trigger・SECURITY DEFINER・search_path = ''", () => {
    const head = squash(header);
    expect(head).toContain(`CREATE OR REPLACE FUNCTION public.${FN}()`);
    expect(head).toContain('RETURNS trigger');
    expect(head).toContain('SECURITY DEFINER');
    expect(head).toContain("SET search_path = ''");
  });

  it('そのプラン (OLD.id) の期限内の予約があれば、route が 409 に写す文 (P0001) で止める', () => {
    expect(body).toContain(
      'IF EXISTS ( SELECT 1 FROM public.plan_price_change_reservations AS r WHERE r.plan_id = OLD.id AND r.reserved_at > pg_catalog.now() - pg_catalog.make_interval(secs => c_stale_after_seconds) ) THEN',
    );
    expect(body).toContain(`RAISE EXCEPTION '${PLAN_PRICE_CHANGE_IN_PROGRESS_DB_ERROR}' USING ERRCODE = 'P0001';`);
    // 止めないときは NEW をそのまま返す (行の値を変えない)
    expect(body).toMatch(/END IF; RETURN NEW; END$/);
  });

  it('期限 (c_stale_after_seconds) は、route が begin に渡す PRICE_CHANGE_RESERVATION_STALE_SECONDS と同じ', () => {
    const declared = /\bc_stale_after_seconds CONSTANT integer := (\d+);/.exec(body);
    expect(declared, 'c_stale_after_seconds の宣言が無い').not.toBeNull();
    expect(Number(declared![1])).toBe(PRICE_CHANGE_RESERVATION_STALE_SECONDS);
  });

  it('トリガーは subscription_plans の BEFORE UPDATE OF stripe_product_id の行トリガーで、商品の ID が変わる行だけに動く', () => {
    expect(code).toContain(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.subscription_plans;`);
    expect(code).toContain(
      `CREATE TRIGGER ${TRIGGER} BEFORE UPDATE OF stripe_product_id ON public.subscription_plans FOR EACH ROW WHEN (NEW.stripe_product_id IS DISTINCT FROM OLD.stripe_product_id) EXECUTE FUNCTION public.${FN}();`,
    );
  });

  it('関数は誰にも EXECUTE を与えない (PUBLIC・anon・authenticated・service_role から外し、GRANT しない)', () => {
    expect(code).toContain(`REVOKE ALL ON FUNCTION public.${FN}() FROM PUBLIC, anon, authenticated, service_role;`);
    expect(code).not.toMatch(new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.${FN}`, 'i'));
  });

  it('表・ポリシー・既存の関数・行を変えない (関数 1 本とトリガー 1 本だけ)', () => {
    expect(code).not.toMatch(/\b(?:ALTER|CREATE|DROP) TABLE\b/i);
    expect(code).not.toMatch(/\b(?:CREATE|DROP|ALTER) POLICY\b/i);
    expect(code).not.toMatch(/\b(?:INSERT INTO|DELETE FROM)\b/i);
    expect(code.match(/\bCREATE OR REPLACE FUNCTION\b/g)).toHaveLength(1);
    expect(code.match(/\bCREATE TRIGGER\b/g)).toHaveLength(1);
  });
});

describe('戻し口', () => {
  it('トリガーと関数を消すだけ', () => {
    const rollback = squash(stripLineComments(read(ROLLBACK_PATH)));
    expect(rollback).toBe(
      `SET LOCAL lock_timeout = '10s'; DROP TRIGGER IF EXISTS ${TRIGGER} ON public.subscription_plans; DROP FUNCTION IF EXISTS public.${FN}();`,
    );
  });
});

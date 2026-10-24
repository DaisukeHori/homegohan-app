/**
 * #1917 の続き: supabase/migrations/20261024130000_plan_deprecate_lock_and_price_change_reservation.sql を、ファイルの読み取りで確かめる
 * (DB には接続しない。実際の挙動 (待ち合い・結果) は tests/integration/security/plan-deprecate-lock-price-change-reservation.test.ts)。
 *
 * (1) 廃止の安全弁のトリガー guard_plan_deprecate_subscribers
 *   1. BEFORE UPDATE OF status で、status が deprecated 以外から deprecated に変わる行だけに効く
 *   2. 数える前に、プランの行を FOR UPDATE でロックし直す (契約者が増える書き込みの FOR KEY SHARE (trg_subscriber_plan_key_share・外部キーの確認) と衝突する強さ)
 *   3. 数え方が src/lib/super-admin/plan-subscribers.ts と同じ: 個人の live の status の一覧 (ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES)・
 *      家族と組織は active・組織のプランの行の判定に使う組織の段階の一覧 (ORG_PLAN_VALUES)
 *   4. RAISE の文は route が見分ける PLAN_HAS_SUBSCRIBERS_DB_ERROR、DETAIL は内訳の JSON (キーは PlanSubscriberCounts と同じ)
 * (1b) 契約者が増える書き込みのロック trg_subscriber_plan_key_share (personal_subscriptions・family_groups・organizations)
 *   4b. 3 表とも BEFORE INSERT OR UPDATE (列を限らない) で、WHEN は書いた後の行が数えられる行 (個人 = live の status の一覧・家族と組織 = active)
 *   4c. 関数は、書く前も数えられていた UPDATE (数えられる status のまま・plan_key (組織は plan) も同じ) だけを飛ばし、
 *       ほかはプランの行を FOR KEY SHARE でロックする (FOR UPDATE / FOR NO KEY UPDATE ではない: 価格の変更・プランの編集と待ち合わない)。
 *       SECURITY DEFINER・search_path = ''・利用者から EXECUTE を外す
 * (2) 価格の変更の予約
 *   5. 関数の名前は src の PLAN_PRICE_CHANGE_RPC と同じ。3 本とも SECURITY DEFINER・search_path = ''・service_role だけに EXECUTE
 *   6. begin / apply はプランの行を FOR NO KEY UPDATE でロックする (FOR UPDATE ではない: 契約者が増える書き込みの FOR KEY SHARE と待ち合わない)。
 *      apply は予約の token を確かめてから、ロックの下で読んだ値 (v_plan) を履歴の old_* にする
 *   7. 予約の表は RLS を有効にし、anon / authenticated から権限を外す
 * (3) 戻し口・型・同じ型の機械検査
 *   8. 戻し口は、トリガー 4 本・関数 7 本・表をすべて外す
 *   9. 型の生成物 2 ファイルに、表と関数 3 本 (引数の名前) がある
 *  10. plan_price_history を書く src のコードは無い (履歴は apply_plan_price_change の中だけで書く)。
 *      価格の変更の route は subscription_plans を直接書かない (予約を通らない書き込みが増えたら、ここで止めて見直す)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_PLAN_VALUES } from '@/lib/org-plans';
import { ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES, PLAN_HAS_SUBSCRIBERS_DB_ERROR } from '@/lib/super-admin/plan-subscribers';
import { PLAN_PRICE_CHANGE_RPC } from '@/lib/super-admin/plan-price-change-reservation';

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = '20261024130000_plan_deprecate_lock_and_price_change_reservation';
const MIGRATION_PATH = path.join(ROOT, 'supabase', 'migrations', `${MIGRATION}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;
const PRICE_CHANGE_ROUTE = 'src/app/api/super-admin/plans/[id]/price-change/route.ts';

/** 正規表現の記号をすべてエスケープする (関数の引数の型の並びを、そのまま照合するため) */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** SQL のコメント (-- から行末) を除く (コメントの中の語に一致させない) */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const migration = stripSqlComments(fs.readFileSync(MIGRATION_PATH, 'utf8'));
const rollback = stripSqlComments(fs.readFileSync(ROLLBACK_PATH, 'utf8'));

/** CREATE OR REPLACE FUNCTION public.<name>(...) から、次の CREATE までの本文 */
function functionBlock(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf('CREATE ', start + 1);
  return migration.slice(start, end === -1 ? undefined : end);
}

/** 本文の中の、SQL の文字列の一覧 ('a', 'b', ...) を取り出す (IN (...) の中身) */
function quotedList(source: string): string[] {
  return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('(1) 廃止の安全弁のトリガー', () => {
  const guard = functionBlock('guard_plan_deprecate_subscribers');

  it('1. BEFORE UPDATE OF status で、deprecated 以外から deprecated に変わる行だけに効く', () => {
    expect(migration).toMatch(
      /CREATE TRIGGER trg_guard_plan_deprecate_subscribers\s+BEFORE UPDATE OF status ON public\.subscription_plans\s+FOR EACH ROW\s+WHEN \(NEW\.status = 'deprecated' AND OLD\.status IS DISTINCT FROM 'deprecated'\)\s+EXECUTE FUNCTION public\.guard_plan_deprecate_subscribers\(\);/,
    );
    expect(guard).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/);
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.guard_plan_deprecate_subscribers() FROM PUBLIC, anon, authenticated, service_role;',
    );
  });

  it('2. 数える前に、プランの行を FOR UPDATE でロックし直す', () => {
    const lock = guard.indexOf('PERFORM 1 FROM public.subscription_plans AS p WHERE p.id = OLD.id FOR UPDATE;');
    expect(lock).toBeGreaterThanOrEqual(0);
    const firstCount = guard.indexOf('count(*)');
    expect(firstCount).toBeGreaterThan(lock);
  });

  it('3. 数え方が plan-subscribers.ts と同じ (個人の live の status・家族と組織の active・組織の段階の一覧)', () => {
    const personal = guard.match(/FROM public\.personal_subscriptions AS s\s+WHERE s\.plan_key = OLD\.plan_key\s+AND s\.status IN \(([^)]*)\)/);
    expect(personal).not.toBeNull();
    expect(quotedList(personal![1])).toEqual([...ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES]);

    expect(guard).toMatch(/FROM public\.family_groups AS g\s+WHERE g\.plan_key = OLD\.plan_key\s+AND g\.status = 'active'/);
    expect(guard).toMatch(/FROM public\.organizations AS o\s+WHERE o\.plan = OLD\.plan_key\s+AND o\.status = 'active'/);

    const orgRow = guard.match(/NOT \(OLD\.plan_type = 'org' AND OLD\.plan_key NOT IN \(([^)]*)\)\)/);
    expect(orgRow).not.toBeNull();
    expect(quotedList(orgRow![1])).toEqual([...ORG_PLAN_VALUES]);
  });

  it('4. RAISE の文は PLAN_HAS_SUBSCRIBERS_DB_ERROR (P0001)、DETAIL は内訳の JSON (組織は数えたときだけ)', () => {
    expect(guard).toContain(`RAISE EXCEPTION '${PLAN_HAS_SUBSCRIBERS_DB_ERROR}' USING ERRCODE = 'P0001', DETAIL = v_counts::text;`);
    expect(guard).toContain("v_counts := jsonb_build_object('personal_subscriptions', v_personal, 'family_groups', v_family);");
    expect(guard).toContain("v_counts := v_counts || jsonb_build_object('organizations', v_organizations);");
  });
});

describe('(1b) 契約者が増える書き込みのロック trg_subscriber_plan_key_share', () => {
  /** 表ごとの関数・数えられる行の WHEN・書く前も数えられていたかの条件・ロックするプランの列 */
  const HOLDERS = [
    {
      table: 'personal_subscriptions',
      fn: 'personal_subscription_hold_plan_key_share',
      when: /WHEN \(NEW\.status IN \(([^)]*)\)\)/,
      alreadyCounted: /IF TG_OP = 'UPDATE'\s+AND COALESCE\(OLD\.status IN \(([^)]*)\), false\)\s+AND OLD\.plan_key IS NOT DISTINCT FROM NEW\.plan_key THEN\s+RETURN NEW;\s+END IF;/,
      lock: 'PERFORM 1 FROM public.subscription_plans AS p WHERE p.plan_key = NEW.plan_key FOR KEY SHARE;',
    },
    {
      table: 'family_groups',
      fn: 'family_group_hold_plan_key_share',
      when: /WHEN \(NEW\.status = 'active'\)/,
      alreadyCounted: /IF TG_OP = 'UPDATE'\s+AND OLD\.status IS NOT DISTINCT FROM 'active'\s+AND OLD\.plan_key IS NOT DISTINCT FROM NEW\.plan_key THEN\s+RETURN NEW;\s+END IF;/,
      lock: 'PERFORM 1 FROM public.subscription_plans AS p WHERE p.plan_key = NEW.plan_key FOR KEY SHARE;',
    },
    {
      table: 'organizations',
      fn: 'organization_hold_plan_key_share',
      when: /WHEN \(NEW\.status = 'active'\)/,
      alreadyCounted: /IF TG_OP = 'UPDATE'\s+AND OLD\.status IS NOT DISTINCT FROM 'active'\s+AND OLD\.plan IS NOT DISTINCT FROM NEW\.plan THEN\s+RETURN NEW;\s+END IF;/,
      lock: 'PERFORM 1 FROM public.subscription_plans AS p WHERE p.plan_key = NEW.plan FOR KEY SHARE;',
    },
  ] as const;

  /** CREATE TRIGGER trg_subscriber_plan_key_share ... ON public.<table> から EXECUTE FUNCTION ...; まで */
  function triggerStatement(table: string): string {
    const match = migration.match(
      new RegExp(`CREATE TRIGGER trg_subscriber_plan_key_share\\s+[^;]*?ON public\\.${table}\\s[^;]*;`),
    );
    expect(match, table).not.toBeNull();
    return match![0];
  }

  it.each(HOLDERS)('4b. $table: BEFORE INSERT OR UPDATE (列を限らない) で、WHEN は数えられる行', ({ table, fn, when }) => {
    const statement = triggerStatement(table);
    expect(statement).toMatch(
      new RegExp(`BEFORE INSERT OR UPDATE ON public\\.${table}\\s+FOR EACH ROW\\s+WHEN \\(.*\\)\\s+EXECUTE FUNCTION public\\.${fn}\\(\\);`),
    );
    expect(statement).not.toMatch(/UPDATE OF/);
    const whenMatch = statement.match(when);
    expect(whenMatch, table).not.toBeNull();
    if (table === 'personal_subscriptions') {
      expect(quotedList(whenMatch![1])).toEqual([...ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES]);
    }
    expect(migration).toContain(`DROP TRIGGER IF EXISTS trg_subscriber_plan_key_share ON public.${table};`);
  });

  it.each(HOLDERS)('4c. $table: 書く前も数えられていた UPDATE だけを飛ばし、ほかはプランの行を FOR KEY SHARE でロックする', ({ table, fn, alreadyCounted, lock }) => {
    // 関数の本文 (END $$; まで。後ろの COMMENT ON の文は含めない)
    const block = functionBlock(fn).split('END $$;')[0];
    expect(block).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/);
    const skip = block.match(alreadyCounted);
    expect(skip, table).not.toBeNull();
    if (table === 'personal_subscriptions') {
      expect(quotedList(skip![1])).toEqual([...ACTIVE_PERSONAL_SUBSCRIPTION_STATUSES]);
    }
    const lockAt = block.indexOf(lock);
    expect(lockAt, table).toBeGreaterThan(block.indexOf('RETURN NEW;'));
    // 衝突するのは廃止の FOR UPDATE だけにする (価格の変更の begin / apply の FOR NO KEY UPDATE と待ち合わない)
    expect(block).not.toMatch(/FOR (NO KEY )?UPDATE/);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC, anon, authenticated, service_role;`);
  });
});

describe('(2) 価格の変更の予約', () => {
  it('5. 関数の名前は PLAN_PRICE_CHANGE_RPC と同じで、SECURITY DEFINER・search_path = \'\'・service_role だけに EXECUTE', () => {
    const signatures: Record<string, string> = {
      [PLAN_PRICE_CHANGE_RPC.begin]: 'uuid, integer',
      [PLAN_PRICE_CHANGE_RPC.apply]: 'uuid, uuid, integer, integer, text, text, uuid, text, timestamptz, text',
      [PLAN_PRICE_CHANGE_RPC.release]: 'uuid, uuid',
    };
    for (const [name, args] of Object.entries(signatures)) {
      expect(functionBlock(name), name).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/);
      const revoke = new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${name}\\(${escapeRegExp(args)}\\)\\s+FROM PUBLIC, anon, authenticated, service_role;`,
      );
      expect(migration, name).toMatch(revoke);
      const grant = new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(${escapeRegExp(args)}\\)\\s+TO service_role;`);
      expect(migration, name).toMatch(grant);
    }
  });

  it('6. begin / apply はプランの行を FOR NO KEY UPDATE でロックし、apply は予約の token を確かめてから v_plan を履歴の old_* にする', () => {
    const planLock = 'SELECT p.* INTO v_plan FROM public.subscription_plans AS p WHERE p.id = p_plan_id FOR NO KEY UPDATE;';
    const beginBlock = functionBlock(PLAN_PRICE_CHANGE_RPC.begin);
    const applyBlock = functionBlock(PLAN_PRICE_CHANGE_RPC.apply);
    expect(beginBlock).toContain(planLock);
    expect(applyBlock).toContain(planLock);
    expect(`${beginBlock}${applyBlock}`).not.toMatch(/subscription_plans AS p WHERE p\.id = p_plan_id FOR UPDATE/);

    const tokenCheck = applyBlock.indexOf('WHERE r.plan_id = p_plan_id AND r.token = p_token');
    const historyInsert = applyBlock.indexOf('INSERT INTO public.plan_price_history');
    expect(tokenCheck).toBeGreaterThan(applyBlock.indexOf(planLock));
    expect(historyInsert).toBeGreaterThan(tokenCheck);
    expect(applyBlock).toMatch(
      /p_plan_id, v_plan\.monthly_price_jpy, COALESCE\(p_new_monthly_price_jpy, v_plan\.monthly_price_jpy\),\s+v_plan\.yearly_price_jpy, COALESCE\(p_new_yearly_price_jpy, v_plan\.yearly_price_jpy\),\s+v_plan\.stripe_price_id, p_new_stripe_price_id,/,
    );
    // 変える前の値 (previous) も v_plan から返す (route は監査の old_* をこれで書く)
    expect(applyBlock).toMatch(/'previous', jsonb_build_object\(\s+'monthly_price_jpy', v_plan\.monthly_price_jpy,/);
  });

  it('7. 予約の表は RLS を有効にし、anon / authenticated から権限を外す', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.plan_price_change_reservations (');
    expect(migration).toContain('plan_id uuid PRIMARY KEY REFERENCES public.subscription_plans(id) ON DELETE CASCADE');
    expect(migration).toContain('ALTER TABLE public.plan_price_change_reservations ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('REVOKE ALL ON TABLE public.plan_price_change_reservations FROM PUBLIC, anon, authenticated;');
  });
});

describe('(3) 戻し口・型・同じ型の機械検査', () => {
  it('8. 戻し口は、トリガー 4 本・関数 7 本・表をすべて外す', () => {
    expect(rollback).toContain('DROP TRIGGER IF EXISTS trg_guard_plan_deprecate_subscribers ON public.subscription_plans;');
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.guard_plan_deprecate_subscribers();');
    for (const [table, fn] of [
      ['personal_subscriptions', 'personal_subscription_hold_plan_key_share'],
      ['family_groups', 'family_group_hold_plan_key_share'],
      ['organizations', 'organization_hold_plan_key_share'],
    ]) {
      expect(rollback).toContain(`DROP TRIGGER IF EXISTS trg_subscriber_plan_key_share ON public.${table};`);
      expect(rollback).toContain(`DROP FUNCTION IF EXISTS public.${fn}();`);
    }
    // 移行で作るトリガーと関数の数と、戻し口で外す数が同じ
    expect((migration.match(/CREATE TRIGGER /g) ?? []).length).toBe((rollback.match(/DROP TRIGGER IF EXISTS /g) ?? []).length);
    expect((migration.match(/CREATE OR REPLACE FUNCTION /g) ?? []).length).toBe((rollback.match(/DROP FUNCTION IF EXISTS /g) ?? []).length);
    expect(rollback).toContain(`DROP FUNCTION IF EXISTS public.${PLAN_PRICE_CHANGE_RPC.begin}(uuid, integer);`);
    expect(rollback).toContain(
      `DROP FUNCTION IF EXISTS public.${PLAN_PRICE_CHANGE_RPC.apply}(uuid, uuid, integer, integer, text, text, uuid, text, timestamptz, text);`,
    );
    expect(rollback).toContain(`DROP FUNCTION IF EXISTS public.${PLAN_PRICE_CHANGE_RPC.release}(uuid, uuid);`);
    expect(rollback).toContain('DROP TABLE IF EXISTS public.plan_price_change_reservations;');
  });

  it.each(TYPE_FILES)('9. 型の生成物 %s に、表と関数 3 本 (引数の名前) がある', (file) => {
    const types = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(types).toMatch(/\n {6}plan_price_change_reservations: \{\n {8}Row: \{/);
    const argsOf = (name: string): string[] => {
      const start = types.indexOf(`\n      ${name}: {`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      const block = types.slice(start, types.indexOf('Returns:', start));
      return [...block.matchAll(/(p_[a-z_]+)\??:/g)].map((match) => match[1]).sort();
    };
    expect(argsOf(PLAN_PRICE_CHANGE_RPC.begin)).toEqual(['p_plan_id', 'p_stale_after_seconds']);
    expect(argsOf(PLAN_PRICE_CHANGE_RPC.apply)).toEqual(
      [
        'p_applies_to',
        'p_changed_by',
        'p_effective_at',
        'p_new_monthly_price_jpy',
        'p_new_stripe_price_id',
        'p_new_stripe_yearly_price_id',
        'p_new_yearly_price_jpy',
        'p_plan_id',
        'p_reason',
        'p_token',
      ].sort(),
    );
    expect(argsOf(PLAN_PRICE_CHANGE_RPC.release)).toEqual(['p_plan_id', 'p_token']);
  });

  it('10. plan_price_history を書く src のコードは無く、価格の変更の route は subscription_plans を直接書かない', () => {
    const srcFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          srcFiles.push(full);
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    const historyWriters = srcFiles.filter((file) =>
      /from\(\s*'plan_price_history'\s*\)\s*\.\s*(insert|upsert|update|delete)\(/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(historyWriters.map((file) => path.relative(ROOT, file))).toEqual([]);
    // 走査が空振りしていない (読み手の GET はある)
    expect(srcFiles.some((file) => fs.readFileSync(file, 'utf8').includes("from('plan_price_history')"))).toBe(true);

    const route = fs.readFileSync(path.join(ROOT, PRICE_CHANGE_ROUTE), 'utf8');
    expect(route).not.toMatch(/from\(\s*'subscription_plans'\s*\)/);
    expect(route).toContain('beginPlanPriceChange(');
    expect(route).toContain('applyPlanPriceChange(');
  });
});

// @vitest-environment node
/**
 * tests/integration-lock-holder.test.ts
 *
 * 結合テストの「先の処理をコミット前のまま開いておく接続」の部品 (tests/integration/helpers/lock-holder.ts) の単体テスト (#1917)。
 *
 * 回帰: 結合テストの接続は pg_sleep の決まった秒数だけ行を持ち、その窓のうちに後の処理が並ぶことを仮定していた。負荷が高いと
 * 並ぶまでが窓より長くなり、並ぶ前に commit して揺らいだ (#1984 の OT-25)。部品は「放されるまで持つ」「並んだのを確かめてから放す」
 * 形で、ここでは /pg/query の代わりの偽の接続の上で、その手順 (放す前に並んだのを確かめる・放すのは pg_sleep の途中だけ・
 * 並ばなければ手順の名前で落ちる) を確かめる。あわせて、結合テストに決まった秒数の pg_sleep が戻らないことを番兵で見る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOLDER_DEADLINE_MS,
  DEFAULT_HOLDER_MAX_HOLD_SECONDS,
  GATEWAY_UPSTREAM_TIMEOUT_SECONDS,
  HOLDER_DEADLINE_MS_ENV,
  HOLDER_MAX_HOLD_SECONDS_ENV,
  HOLDER_NOT_RELEASED,
  HOLDER_POLL_MS,
  actAsAuthenticatedSql,
  createLockHolderKit,
  holdUntilReleasedSql,
  holderTimingsFromEnv,
  toHolderOutcome,
  type HolderTimings,
  type PgResponse,
} from './integration/helpers/lock-holder';

const ROOT = process.cwd();
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
/** 偽の接続が pg_sleep に入るまでに見られる回数 (1 回目の確かめでは、まだ入っていない) */
const POLLS_BEFORE_SLEEP = 1;
/** 偽の接続の pid の始まり */
const FIRST_PID = 4100;
/** テストの時間 (並ぶのを待つ上限は短く、持つ上限は既定のまま) */
const FAST_TIMINGS: HolderTimings = { maxHoldSeconds: DEFAULT_HOLDER_MAX_HOLD_SECONDS, deadlineMs: 200, pollMs: 0 };
const MARKER_COMMENT = /^\/\* (\S+) \*\//;
/** 偽の接続の上で、確かめ直すまでに待つ時間 (ミリ秒。並ぶのを待つ上限のうちに数回まわれば足りる) */
const FAKE_POLL_WAIT_MS = 1;
const MS_PER_SECOND = 1000;

interface FakeHolder {
  marker: string;
  pid: number;
  sql: string;
  polls: number;
  sleeping: boolean;
  resolve: (res: PgResponse) => void;
}

/**
 * /pg/query の代わり。marker のコメントで始まる SQL は holder の接続として開いたままにし (POLLS_BEFORE_SLEEP 回見られたら
 * pg_sleep に入る)、pg_cancel_backend で放されたら成功で返す。ロックの待ちの数は lockWaiters で決める
 */
function fakeDb(options: { failHolderImmediately?: boolean; neverSleep?: boolean } = {}) {
  const holders: FakeHolder[] = [];
  const log: string[] = [];
  const state = { lockWaiters: 0, nextPid: FIRST_PID, cancelReturnsNothing: false };
  const ok = (body: unknown): PgResponse => ({ ok: true, status: HTTP_OK, body });

  const pgRequest = async (query: string): Promise<PgResponse> => {
    const marker = MARKER_COMMENT.exec(query.trim())?.[1];
    if (marker) {
      log.push(`hold ${marker}`);
      if (options.failHolderImmediately) return { ok: false, status: HTTP_BAD_REQUEST, body: { error: 'boom', code: 'P0001' } };
      return new Promise<PgResponse>((resolve) => {
        holders.push({ marker, pid: state.nextPid++, sql: query, polls: 0, sleeping: false, resolve });
      });
    }
    if (query.includes("wait_event = 'PgSleep'") && query.includes('SELECT pid FROM')) {
      const holder = holders.find((h) => query.includes(h.marker));
      if (!holder || options.neverSleep) return ok([]);
      holder.polls += 1;
      if (holder.polls > POLLS_BEFORE_SLEEP) holder.sleeping = true;
      return ok(holder.sleeping ? [{ pid: holder.pid }] : []);
    }
    if (query.includes('pg_cancel_backend')) {
      log.push(`cancel ${query}`);
      const holder = holders.find((h) => query.includes(`pid = ${h.pid}`) && query.includes(h.marker) && h.sleeping);
      if (!holder || state.cancelReturnsNothing) return ok([]);
      holder.sleeping = false;
      holder.resolve(ok([{ result: 'held' }]));
      return ok([{ cancelled: true }]);
    }
    if (query.includes("wait_event_type = 'Lock'")) {
      log.push(`wait ${query}`);
      return ok([{ n: state.lockWaiters }]);
    }
    throw new Error(`偽の接続が知らない SQL: ${query}`);
  };

  return { pgRequest, holders, log, state };
}

function kitOn(db: ReturnType<typeof fakeDb>) {
  return createLockHolderKit({ pgRequest: db.pgRequest, markerPrefix: 'unit', timings: FAST_TIMINGS, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms + FAKE_POLL_WAIT_MS)) });
}

describe('holdUntilReleasedSql / actAsAuthenticatedSql / toHolderOutcome', () => {
  it('放されるまで持つ文は、例外のブロックの中で上限の秒数だけ眠り、上限に達したら HOLDER_NOT_RELEASED を RAISE し、取り消し (query_canceled) だけを握りつぶす', () => {
    const sql = holdUntilReleasedSql(DEFAULT_HOLDER_MAX_HOLD_SECONDS);
    const sleepAt = sql.indexOf(`PERFORM pg_sleep(${DEFAULT_HOLDER_MAX_HOLD_SECONDS});`);
    const raiseAt = sql.indexOf(`RAISE EXCEPTION '${HOLDER_NOT_RELEASED}';`);
    const catchAt = sql.indexOf('EXCEPTION WHEN query_canceled THEN');
    expect(sleepAt).toBeGreaterThan(-1);
    expect(raiseAt).toBeGreaterThan(sleepAt);
    expect(catchAt).toBeGreaterThan(raiseAt);
    expect(sql).not.toMatch(/WHEN OTHERS/);
  });

  it('本人のクレームで呼ぶ前置きは、sub・authenticated・足したクレームを set_config に入れ、ロールを authenticated にする', () => {
    const sql = actAsAuthenticatedSql('user-1', { aal: 'aal2' });
    const claims = /set_config\('request\.jwt\.claims', '([^']+)', true\)/.exec(sql)?.[1];
    expect(JSON.parse(claims ?? 'null')).toEqual({ sub: 'user-1', role: 'authenticated', aal: 'aal2' });
    expect(sql).toContain('SET LOCAL ROLE authenticated;');
    expect(JSON.parse(/'(\{[^']+\})'/.exec(actAsAuthenticatedSql('user-2'))?.[1] ?? 'null')).toEqual({ sub: 'user-2', role: 'authenticated' });
  });

  it('pg/query の応答を結果にする: 成功なら message / code は null、失敗なら error の文と code (文でなければ本文の JSON)', () => {
    expect(toHolderOutcome({ ok: true, status: HTTP_OK, body: [1] })).toEqual({ ok: true, status: HTTP_OK, body: [1], message: null, code: null });
    expect(toHolderOutcome({ ok: false, status: HTTP_BAD_REQUEST, body: { error: HOLDER_NOT_RELEASED, code: 'P0001' } })).toMatchObject({
      ok: false,
      message: HOLDER_NOT_RELEASED,
      code: 'P0001',
    });
    expect(toHolderOutcome({ ok: false, status: HTTP_BAD_REQUEST, body: { error: { x: 1 }, code: 7 } })).toMatchObject({
      message: JSON.stringify({ error: { x: 1 }, code: 7 }),
      code: null,
    });
    expect(toHolderOutcome({ ok: false, status: HTTP_BAD_REQUEST, body: null })).toMatchObject({ message: 'null', code: null });
  });
});

describe('holderTimingsFromEnv', () => {
  it('環境変数が無ければ既定 (持つ上限 30 秒・並ぶのを待つ上限 20 秒・間隔 50 ミリ秒)', () => {
    expect(holderTimingsFromEnv({})).toEqual({
      maxHoldSeconds: DEFAULT_HOLDER_MAX_HOLD_SECONDS,
      deadlineMs: DEFAULT_HOLDER_DEADLINE_MS,
      pollMs: HOLDER_POLL_MS,
    });
    expect(DEFAULT_HOLDER_DEADLINE_MS).toBeLessThan(DEFAULT_HOLDER_MAX_HOLD_SECONDS * MS_PER_SECOND);
    expect(DEFAULT_HOLDER_MAX_HOLD_SECONDS).toBeLessThan(GATEWAY_UPSTREAM_TIMEOUT_SECONDS);
  });

  it('環境変数で上書きでき、並ぶのを待つ上限 < 持つ上限 < Kong の上限 でなければ止める (黙って既定に戻さない)', () => {
    expect(holderTimingsFromEnv({ [HOLDER_MAX_HOLD_SECONDS_ENV]: '45', [HOLDER_DEADLINE_MS_ENV]: '40000' })).toMatchObject({
      maxHoldSeconds: 45,
      deadlineMs: 40_000,
    });
    expect(() => holderTimingsFromEnv({ [HOLDER_MAX_HOLD_SECONDS_ENV]: String(GATEWAY_UPSTREAM_TIMEOUT_SECONDS) })).toThrow(
      HOLDER_MAX_HOLD_SECONDS_ENV,
    );
    expect(() => holderTimingsFromEnv({ [HOLDER_MAX_HOLD_SECONDS_ENV]: '20' })).toThrow(HOLDER_DEADLINE_MS_ENV);
    expect(holderTimingsFromEnv({ [HOLDER_MAX_HOLD_SECONDS_ENV]: '21' }).maxHoldSeconds).toBe(21);
    expect(() => holderTimingsFromEnv({ [HOLDER_DEADLINE_MS_ENV]: '1.5' })).toThrow(HOLDER_DEADLINE_MS_ENV);
  });
});

describe('createLockHolderKit: 接続を開く・放す', () => {
  it('接続の SQL は 目印 → 先の文 → 放されるまで持つ文 → 後の文 の順で、pg_sleep に入ったら pid を覚え、release() はその pid と目印に取り消しを送って commit させる', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const holder = kit.startHolder('先の処理', 'SELECT 1 /* before */;', 'SELECT 2 /* after */;');

    expect(holder.marker).toMatch(/^unit-holder-[0-9a-f]{12}$/);
    const sql = db.holders[0].sql;
    const order = [`/* ${holder.marker} */`, 'SELECT 1 /* before */;', 'PERFORM pg_sleep(', 'SELECT 2 /* after */;', "SELECT 'held' AS result;"].map((part) =>
      sql.indexOf(part),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(holder.pid()).toBeNull();
    await holder.sleeping;
    expect(holder.pid()).toBe(FIRST_PID);
    expect(holder.finished()).toBe(false);

    await holder.release();
    const cancel = db.log.find((line) => line.startsWith('cancel '));
    expect(cancel).toContain(`pid = ${FIRST_PID}`);
    expect(cancel).toContain(holder.marker);
    expect(cancel).toContain("wait_event = 'PgSleep'");
    expect(await holder.done).toMatchObject({ ok: true, message: null });
    expect(holder.finished()).toBe(true);
  });

  it('pg_sleep に入る前に接続が終わったら (先の文が失敗した)、sleeping は名前と結果を付けて落ちる', async () => {
    const kit = kitOn(fakeDb({ failHolderImmediately: true }));
    const holder = kit.startHolder('失敗する接続', 'SELECT 1;');
    await holder.done;
    await expect(holder.sleeping).rejects.toThrow(/失敗する接続 が pg_sleep に入る前に終わりました: .*boom/);
  });

  it('上限のうちに pg_sleep に入らなければ、sleeping は名前と上限を付けて落ちる', async () => {
    const kit = kitOn(fakeDb({ neverSleep: true }));
    const holder = kit.startHolder('並んだままの接続', 'SELECT 1;');
    await expect(holder.sleeping).rejects.toThrow(`並んだままの接続 が ${FAST_TIMINGS.deadlineMs} ミリ秒のうちに pg_sleep に入りませんでした`);
  });

  it('放す前に接続が pg_sleep を抜けていたら (取り消しが 1 行も当たらない)、release() は落ちる (黙って成功にしない)', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const holder = kit.startHolder('抜けた接続', 'SELECT 1;');
    await holder.sleeping;
    db.state.cancelReturnsNothing = true;
    await expect(holder.release()).rejects.toThrow('抜けた接続 を放す前に、その接続が pg_sleep を抜けていました');
  });

  it('releaseOpenHolders は、まだ終わっていない接続だけを作った順に放し、settle は投げた接続の応答を全部待つ', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const first = kit.startHolder('1 本目', 'SELECT 1;');
    const second = kit.startHolder('2 本目', 'SELECT 2;');
    const third = kit.startHolder('3 本目', 'SELECT 3;');
    await Promise.all([first.sleeping, second.sleeping, third.sleeping]);
    await second.release();
    await second.done;

    await kit.releaseOpenHolders();
    const cancels = db.log.filter((line) => line.startsWith('cancel '));
    expect(cancels.map((line) => [first, second, third].find((h) => line.includes(h.marker))?.label)).toEqual(['2 本目', '1 本目', '3 本目']);
    await kit.settle();
    expect([first, second, third].every((h) => h.finished())).toBe(true);

    // 2 回目は何もしない (放した接続は覚えていない)
    await kit.releaseOpenHolders();
    expect(db.log.filter((line) => line.startsWith('cancel '))).toHaveLength(cancels.length);
  });
});

describe('createLockHolderKit: 後の処理が並んだのを確かめてから放す', () => {
  it('waitForLockWaiters は、待ちの相手 (pg_blocking_pids に holder の pid)・待ちの種類 (wait_event) まで絞り、count 本並んだら返る', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const holder = kit.startHolder('先の処理', 'SELECT 1;');
    await holder.sleeping;
    db.state.lockWaiters = 2;

    await kit.waitForLockWaiters('some_fn', 2, { step: '手順', blockedBy: holder, waitEvent: 'advisory' });
    const wait = db.log.find((line) => line.startsWith('wait '));
    expect(wait).toContain("query LIKE '%some_fn%'");
    expect(wait).toContain(`AND ${FIRST_PID} = ANY(pg_blocking_pids(pid))`);
    expect(wait).toContain("AND wait_event = 'advisory'");
    expect(wait).toContain('pid <> pg_backend_pid()');

    await kit.waitForLockWaiters('other_fn', 1, { step: '相手を問わない' });
    const unscoped = db.log.filter((line) => line.startsWith('wait ')).at(-1);
    expect(unscoped).not.toContain('pg_blocking_pids');
    expect(unscoped).not.toContain("wait_event = '");
    await holder.release();
  });

  it('並ばなければ、手順の名前・相手・待ちの種類・並んだ本数を付けて落ちる。相手がまだ pg_sleep に入っていなければすぐ落ちる', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const holder = kit.startHolder('先の処理', 'SELECT 1;');
    await expect(kit.waitForLockWaiters('some_fn', 1, { step: '(1) 早すぎる', blockedBy: holder })).rejects.toThrow(
      '手順「(1) 早すぎる」: 先の処理 がまだ pg_sleep に入っていません',
    );
    await holder.sleeping;
    db.state.lockWaiters = 1;
    await expect(kit.waitForLockWaiters('some_fn', 2, { step: '(2) 足りない', blockedBy: holder, waitEvent: 'advisory' })).rejects.toThrow(
      `手順「(2) 足りない」: some_fn の呼び出しが ${FAST_TIMINGS.deadlineMs} ミリ秒のうちに先の処理 の後ろの行のロックの待ち (advisory) に 2 本並びませんでした (並んだのは 1 本)`,
    );
    await holder.release();
  });

  it('waitForLockWaitersUnlessSettled は、count 本並んだら queued、並ぶ前に呼び出しが終わったら settled を返す (並んだかを数えてから終わったかを見る。両方なら queued)', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const holder = kit.startHolder('先の処理', 'SELECT 1;');
    await holder.sleeping;

    db.state.lockWaiters = 1;
    await expect(kit.waitForLockWaitersUnlessSettled('some_fn', 1, { step: '並んだ', blockedBy: holder }, () => false)).resolves.toBe('queued');
    await expect(kit.waitForLockWaitersUnlessSettled('some_fn', 1, { step: '並んでから終わった', blockedBy: holder }, () => true)).resolves.toBe(
      'queued',
    );
    const scoped = db.log.filter((line) => line.startsWith('wait ')).at(-1);
    expect(scoped).toContain(`AND ${FIRST_PID} = ANY(pg_blocking_pids(pid))`);

    db.state.lockWaiters = 0;
    const waitsBefore = db.log.filter((line) => line.startsWith('wait ')).length;
    const checks: number[] = [];
    const settled = () => {
      checks.push(db.log.filter((line) => line.startsWith('wait ')).length - waitsBefore);
      return checks.length >= 2;
    };
    await expect(kit.waitForLockWaitersUnlessSettled('some_fn', 1, { step: '先に終わった', blockedBy: holder }, settled)).resolves.toBe('settled');
    // 終わったかは、毎回の数えのあとに見る (数える前に見て、数えた回より前の状態で settled にしない)
    expect(checks).toEqual([1, 2]);
    await holder.release();
  });

  it('waitForLockWaitersUnlessSettled は、並ばず終わりもしなければ、waitForLockWaiters と同じ文で落ちる', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const holder = kit.startHolder('先の処理', 'SELECT 1;');
    await holder.sleeping;
    await expect(kit.waitForLockWaitersUnlessSettled('some_fn', 1, { step: "(4') 並ばない", blockedBy: holder }, () => false)).rejects.toThrow(
      `手順「(4') 並ばない」: some_fn の呼び出しが ${FAST_TIMINGS.deadlineMs} ミリ秒のうちに先の処理 の後ろの行のロックの待ちに 1 本並びませんでした (並んだのは 0 本)`,
    );
    await holder.release();
  });

  it('runBehindHolder は、接続が pg_sleep に入ってから後の処理を呼び、後の処理が並んだのを確かめてから放し、両方の結果を返す', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const holder = kit.startHolder('先の処理', 'SELECT 1;');
    const calls: string[] = [];
    const result = kit.runBehindHolder(holder, {
      fn: 'later_fn',
      waitEvent: 'transactionid',
      call: async () => {
        calls.push(`call pid=${holder.pid()} cancels=${db.log.filter((l) => l.startsWith('cancel ')).length}`);
        db.state.lockWaiters = 1;
        await holder.done;
        return 'later-result';
      },
    });

    const [held, later] = await result;
    expect(calls).toEqual([`call pid=${FIRST_PID} cancels=0`]);
    expect(held.ok).toBe(true);
    expect(later).toBe('later-result');
    const steps = db.log.map((line) => line.split(' ')[0]);
    expect(steps.indexOf('wait')).toBeGreaterThan(-1);
    expect(steps.indexOf('cancel')).toBeGreaterThan(steps.indexOf('wait'));
    expect(db.log.find((line) => line.startsWith('wait '))).toContain("AND wait_event = 'transactionid'");
  });

  it('runBehindHolder で後の処理が並ばなければ、手順の名前を付けて落ち、接続は放さない (afterEach の releaseOpenHolders が放す)', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const holder = kit.startHolder('先の処理', 'SELECT 1;');
    await expect(kit.runBehindHolder(holder, { fn: 'never_fn', step: '後の処理が並ぶ', call: async () => 'x' })).rejects.toThrow(
      '手順「後の処理が並ぶ」: never_fn の呼び出し',
    );
    expect(db.log.some((line) => line.startsWith('cancel '))).toBe(false);
    expect(holder.finished()).toBe(false);
    await kit.releaseOpenHolders();
    expect((await holder.done).ok).toBe(true);
  });

  it('runBehindHolder の手順の名前は、無ければ「fn が holder の commit を待つ」', async () => {
    const kit = kitOn(fakeDb());
    const holder = kit.startHolder('先の処理', 'SELECT 1;');
    await expect(kit.runBehindHolder(holder, { fn: 'never_fn', call: async () => 'x' })).rejects.toThrow(
      '手順「never_fn が 先の処理 の commit を待つ」',
    );
    await kit.releaseOpenHolders();
  });

  it('whileHolding は、接続を持ったまま body を済ませてから放し、body が落ちても放す', async () => {
    const db = fakeDb();
    const kit = kitOn(db);
    const holder = kit.startHolder('先の処理', 'SELECT 1;');
    const [held, value] = await kit.whileHolding(holder, async () => {
      expect(holder.finished()).toBe(false);
      expect(db.log.some((line) => line.startsWith('cancel '))).toBe(false);
      return 42;
    });
    expect(held.ok).toBe(true);
    expect(value).toBe(42);

    const failing = kit.startHolder('落ちる body', 'SELECT 1;');
    await expect(
      kit.whileHolding(failing, async () => {
        throw new Error('body が落ちた');
      }),
    ).rejects.toThrow('body が落ちた');
    expect((await failing.done).ok).toBe(true);
  });
});

describe('上書きの環境変数の持ち込みと説明', () => {
  it('scripts/local-ci.sh は、接続を持つ上限・並ぶのを待つ上限の環境変数を子プロセスに持ち込み、CONTRIBUTING.md の表に載っている', () => {
    const localCi = fs.readFileSync(path.join(ROOT, 'scripts', 'local-ci.sh'), 'utf8');
    const names = (/^readonly ENV_ALLOWLIST="([^"]*)"$/m.exec(localCi)?.[1] ?? '').split(/\s+/);
    const rows = fs
      .readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('| `'));
    for (const name of [HOLDER_MAX_HOLD_SECONDS_ENV, HOLDER_DEADLINE_MS_ENV]) {
      expect(names, name).toContain(name);
      expect(rows.some((row) => row.includes(`\`${name}\``)), name).toBe(true);
    }
  });
});

describe('番兵: 結合テストは決まった秒数の pg_sleep で行を持たない (#1917)', () => {
  /** tests/integration の *.test.ts を全部集める */
  function integrationTestFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return integrationTestFiles(full);
      return entry.name.endsWith('.test.ts') ? [full] : [];
    });
  }

  it('tests/integration/**/*.test.ts に pg_sleep( の呼び出しが無い (接続は helpers/lock-holder.ts で放すまで持つ)', () => {
    const files = integrationTestFiles(path.join(ROOT, 'tests', 'integration'));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((file) => /pg_sleep\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('pg_sleep を書くのは部品だけ (番兵が空振りしていない)', () => {
    const helper = fs.readFileSync(path.join(ROOT, 'tests', 'integration', 'helpers', 'lock-holder.ts'), 'utf8');
    expect(helper).toMatch(/pg_sleep\s*\(/);
  });
});

/**
 * 結合テストで「先の処理をコミット前のまま開いておく接続」(holder) を作り、後から呼んだ処理がその接続に待たされて
 * 行のロックの待ちに並んだのを pg_stat_activity / pg_blocking_pids で確かめてから放す (commit させる) 部品 (#1917)。
 *
 * org-transfer-toctou.test.ts (#1984) で作った形を切り出したもの。それまでの形は、接続を pg_sleep の決まった秒数だけ開いておき、
 * その窓のうちに後の処理が並ぶことを仮定していた。負荷が高いと並ぶまでが窓より長くなり、並ぶ前に commit して
 * 「commit のあとに呼んだ」のと同じになって揺らいだ。ここでは時間で放さない:
 *   - 接続は先の処理を済ませたあと、放されるまで pg_sleep で待つ (HOLD_UNTIL_RELEASED_SQL)。
 *   - 放すのは release() で、pg_sleep の途中にいることを確かめてから pg_cancel_backend を送る。取り消しは pg_sleep の文
 *     (例外のブロックのサブトランザクション) だけを抜けさせ、それより前の文 (先の処理・行のロック) と後の文はそのまま commit する。
 *   - 放されないまま上限 (maxHoldSeconds) に達した接続は HOLDER_NOT_RELEASED を RAISE して全体を失敗させる (黙って commit しない)。
 *
 * 使い方:
 *   const holders = createLockHolderKit({ pgRequest, markerPrefix: 'my-test' });
 *   afterEach(() => holders.releaseOpenHolders());   // テストが途中で落ちたときに残った接続を放す
 *   afterAll(() => holders.settle());                 // 投げた接続の応答を待つ
 *   const holder = holders.startHolder('承諾をコミット前のまま開いておく接続', `SELECT * FROM public.f(...);`);
 *   const [held, waiter] = await holders.runBehindHolder(holder, { fn: 'dissolve_org_by_owner', call: () => dissolveOrg(...) });
 *
 * 接続は postgres-meta (/pg/query。service_role キーが要る) に投げる。投げ方 (ゲートウェイの 502 のやり直し) は呼ぶ側のファイルの
 * pgRequest をそのまま使う。
 */
import { randomBytes } from 'node:crypto';
import { positiveIntFromEnv } from './gateway-transient';

/** 放されないまま接続を持ち続ける秒数の上限の上書き (放し忘れの安全弁。下の DEFAULT_HOLDER_MAX_HOLD_SECONDS) */
export const HOLDER_MAX_HOLD_SECONDS_ENV = 'INTEGRATION_HOLDER_MAX_HOLD_SECONDS';
/** 接続が pg_sleep に入る・呼び出しが行のロックの待ちに並ぶのを待つ上限 (ミリ秒) の上書き (下の DEFAULT_HOLDER_DEADLINE_MS) */
export const HOLDER_DEADLINE_MS_ENV = 'INTEGRATION_HOLDER_DEADLINE_MS';

/**
 * 接続を、テストが放さないまま持ち続ける秒数の上限の既定。放し忘れの安全弁で、上限に達した接続は HOLDER_NOT_RELEASED で失敗する。
 * 並ぶのを待つ上限 (DEFAULT_HOLDER_DEADLINE_MS の 20 秒) より長く、Kong が奥 (postgres-meta) の応答を待つ上限
 * (GATEWAY_UPSTREAM_TIMEOUT_SECONDS) より短くする (org-transfer-toctou.test.ts の #1984 と同じ値)
 */
export const DEFAULT_HOLDER_MAX_HOLD_SECONDS = 30;
/** 接続が pg_sleep に入る・呼び出しが行のロックの待ちに並ぶのを待つ上限の既定 (ミリ秒。#1984 と同じ値) */
export const DEFAULT_HOLDER_DEADLINE_MS = 20_000;
/** pg_stat_activity を確かめる間隔 (ミリ秒。#1984 と同じ値) */
export const HOLDER_POLL_MS = 50;
/** ローカルの Kong が奥 (postgres-meta) の応答を待つ既定の上限 (秒)。接続を持つ上限はこれより短くしないと、応答が 504 に化ける */
export const GATEWAY_UPSTREAM_TIMEOUT_SECONDS = 60;
/** 放されないまま上限に達した接続が RAISE する文 (pg/query の応答の error にこの文が出る) */
export const HOLDER_NOT_RELEASED = 'HOLDER_NOT_RELEASED';

const MS_PER_SECOND = 1000;
/** marker に付ける乱数のバイト数 (hex で 12 文字。同じテストの中の接続を見分けられれば足りる) */
const MARKER_RANDOM_BYTES = 6;

export interface HolderTimings {
  /** 放されないまま持ち続ける秒数の上限 */
  maxHoldSeconds: number;
  /** pg_sleep に入る・行のロックの待ちに並ぶのを待つ上限 (ミリ秒) */
  deadlineMs: number;
  /** pg_stat_activity を確かめる間隔 (ミリ秒) */
  pollMs: number;
}

/**
 * 環境変数 (INTEGRATION_HOLDER_MAX_HOLD_SECONDS / INTEGRATION_HOLDER_DEADLINE_MS) で上書きした時間。
 * 並ぶのを待つ上限 < 持つ上限 < Kong の上限 になっていなければ、設定の誤りとして止める (黙って既定に戻さない)
 */
export function holderTimingsFromEnv(env: Record<string, string | undefined>): HolderTimings {
  const maxHoldSeconds = positiveIntFromEnv(env, HOLDER_MAX_HOLD_SECONDS_ENV, DEFAULT_HOLDER_MAX_HOLD_SECONDS);
  const deadlineMs = positiveIntFromEnv(env, HOLDER_DEADLINE_MS_ENV, DEFAULT_HOLDER_DEADLINE_MS);
  if (maxHoldSeconds >= GATEWAY_UPSTREAM_TIMEOUT_SECONDS) {
    throw new Error(
      `${HOLDER_MAX_HOLD_SECONDS_ENV} (${maxHoldSeconds}) は Kong の上限 ${GATEWAY_UPSTREAM_TIMEOUT_SECONDS} 秒より短くしてください`,
    );
  }
  if (deadlineMs >= maxHoldSeconds * MS_PER_SECOND) {
    throw new Error(
      `${HOLDER_DEADLINE_MS_ENV} (${deadlineMs}) は、接続を持つ上限 ${HOLDER_MAX_HOLD_SECONDS_ENV} (${maxHoldSeconds} 秒) より短くしてください`,
    );
  }
  return { maxHoldSeconds, deadlineMs, pollMs: HOLDER_POLL_MS };
}

/**
 * 放されるまで持つ文。pg_sleep の途中で release() の取り消しを受けたら、例外のブロック (サブトランザクション) の中の pg_sleep だけを
 * 抜けて、それより前の文 (呼び出し・行のロック) はそのまま commit する。放されないまま maxHoldSeconds に達したら
 * HOLDER_NOT_RELEASED を RAISE して全体を失敗させる (時間で黙って放さない)
 */
export function holdUntilReleasedSql(maxHoldSeconds: number): string {
  return `DO $hold$
    BEGIN
      PERFORM pg_sleep(${maxHoldSeconds});
      RAISE EXCEPTION '${HOLDER_NOT_RELEASED}';
    EXCEPTION WHEN query_canceled THEN
      NULL;
    END
    $hold$;`;
}

/**
 * 本人 (userId) の JWT のクレームで後の文を呼ぶための前置き (PostgREST が本人の JWT で呼ぶのと同じく、authenticated のロールで
 * auth.uid() が userId になる)。extraClaims は運営の aal2 など
 */
export function actAsAuthenticatedSql(userId: string, extraClaims: Record<string, string> = {}): string {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated', ...extraClaims });
  return `SELECT set_config('request.jwt.claims', '${claims}', true);
    SET LOCAL ROLE authenticated;`;
}

export interface PgResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export type PgRequest = (query: string) => Promise<PgResponse>;

/** 接続の結果 (pg/query の応答。失敗なら error の文と SQLSTATE) */
export interface HolderOutcome {
  ok: boolean;
  status: number;
  body: unknown;
  /** 失敗の文 (pg/query の応答の error。成功なら null) */
  message: string | null;
  /** 失敗の SQLSTATE (pg/query の応答の code。成功・無ければ null) */
  code: string | null;
}

export function toHolderOutcome(res: PgResponse): HolderOutcome {
  if (res.ok) return { ok: true, status: res.status, body: res.body, message: null, code: null };
  const body = res.body as { error?: unknown; code?: unknown } | null;
  return {
    ok: false,
    status: res.status,
    body: res.body,
    message: typeof body?.error === 'string' ? body.error : JSON.stringify(body),
    code: typeof body?.code === 'string' ? body.code : null,
  };
}

export interface Holder {
  /** 失敗の文に出す名前 (どの接続を放せなかったか・どの接続の後ろに並ばなかったか) */
  label: string;
  /** その接続の SQL に埋めた目印 (pg_stat_activity.query で見分ける) */
  marker: string;
  /** 接続が先の処理を終え、放されるのを待つ pg_sleep に入るまで (入ったらその接続の pid を覚える) */
  sleeping: Promise<void>;
  /** 接続の結果 (放されて commit したか、失敗したか) */
  done: Promise<HolderOutcome>;
  /** 接続がもう終わったか (pg_sleep を抜けて、持っていた行を放したか) */
  finished: () => boolean;
  /** pg_sleep に入った接続の pid (まだ入っていなければ null) */
  pid: () => number | null;
  /**
   * 接続を放す (commit させる)。pg_sleep の途中にいることを確かめてから取り消し (pg_cancel_backend) を送る。
   * もう pg_sleep にいなければ (放す前に終わっていれば) 失敗する
   */
  release: () => Promise<void>;
}

export interface LockWaitOptions {
  /** 失敗の文に出す手順の名前 (どの手順で並ばなかったか) */
  step: string;
  /** 待ちの相手がこの接続であること (pg_blocking_pids に holder の pid が入っていること) まで確かめる */
  blockedBy?: Holder;
  /** 待ちの種類 (pg_stat_activity.wait_event。例: advisory lock なら 'advisory') まで確かめる。無ければ種類を問わない */
  waitEvent?: string;
}

/** 後から呼ぶ処理 1 本 (待ちを見分けるための文字列と、その呼び出し) */
export interface QueuedCall<T> {
  /** pg_stat_activity.query で待ちを見分ける文字列 (呼ぶ関数の名前・UPDATE する表の名前・接続の marker) */
  fn: string;
  call: () => Promise<T>;
  /** 並ばなかったときの文に出す手順の名前 (無ければ「fn が holder の commit を待つ」) */
  step?: string;
  /** 待ちの種類 (LockWaitOptions.waitEvent) */
  waitEvent?: string;
}

export interface LockHolderKitOptions {
  /** /pg/query に投げる関数 (ゲートウェイの 502 のやり直しは呼ぶ側のものを使う) */
  pgRequest: PgRequest;
  /** marker の頭 (テストのファイルの名前など。pg_stat_activity でほかのファイルの接続と見分ける) */
  markerPrefix: string;
  /** 時間 (無ければ環境変数 → 既定) */
  timings?: HolderTimings;
  /** 待ち (テストでは差し替える) */
  sleep?: (ms: number) => Promise<void>;
}

export interface LockHolderKit {
  timings: HolderTimings;
  /** /pg/query に投げて、失敗なら投げる */
  pgQuery: <T = Record<string, unknown>>(query: string) => Promise<T[]>;
  /**
   * beforeSql を流してから放されるまで開いておき、放されたら afterSql を流して commit する接続を投げる (終わりを待たない)。
   * beforeSql の行のロックは commit まで持つ
   */
  startHolder: (label: string, beforeSql: string, afterSql?: string) => Holder;
  /**
   * match を含む呼び出しが、行のロックの待ち (wait_event_type = 'Lock') に count 本以上入るまで待つ。blockedBy があれば、
   * その接続に待たされているもの (pg_blocking_pids に pid が入っている) だけを数える。並ばなければ手順の名前を付けて失敗する
   */
  waitForLockWaiters: (match: string, count: number, options: LockWaitOptions) => Promise<void>;
  /**
   * holder が持っている間に waiter を呼び、waiter が holder に待たされて行のロックの待ちに並んだのを確かめてから holder を放す
   * (waiter は holder の commit を待ってから判定する。並ぶ前に放して、commit のあとに呼んだのと同じになるのを防ぐ)
   */
  runBehindHolder: <T>(holder: Holder, waiter: QueuedCall<T>) => Promise<[HolderOutcome, T]>;
  /**
   * holder が持っている間に body を済ませてから holder を放す (body は holder を待たない処理。コミット前の行が見えないこと・
   * 待たずに返ることを見る)。body が失敗しても holder は放す
   */
  whileHolding: <T>(holder: Holder, body: () => Promise<T>) => Promise<[HolderOutcome, T]>;
  /**
   * テストが途中で落ちたときに残った接続を、作った順に放す (先に作った接続を放さないと、その後ろで待つ接続が pg_sleep に入れない)。
   * 通ったテストでは全部放し終わっているので何もしない。放せなかったものは maxHoldSeconds で自分で終わる。afterEach で呼ぶ
   */
  releaseOpenHolders: () => Promise<void>;
  /** 投げた接続の応答を全部待つ (afterAll の後片付けの前に呼ぶ) */
  settle: () => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createLockHolderKit(options: LockHolderKitOptions): LockHolderKit {
  const { pgRequest, markerPrefix } = options;
  const timings = options.timings ?? holderTimingsFromEnv(process.env);
  const sleep = options.sleep ?? defaultSleep;
  const holdSql = holdUntilReleasedSql(timings.maxHoldSeconds);
  /** まだ放していないかもしれない接続 (afterEach で放す) */
  const openHolders: Holder[] = [];
  /** 投げた接続の応答 (afterAll で待つ) */
  const pendingHolders: Array<Promise<unknown>> = [];

  async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
    const res = await pgRequest(query);
    if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body as T[];
  }

  function startHolder(label: string, beforeSql: string, afterSql = ''): Holder {
    const marker = `${markerPrefix}-holder-${randomBytes(MARKER_RANDOM_BYTES).toString('hex')}`;
    const sql = `/* ${marker} */
    ${beforeSql}
    ${holdSql}
    ${afterSql}
    SELECT 'held' AS result;`;
    const state: { outcome: HolderOutcome | null; pid: number | null } = { outcome: null, pid: null };
    const done = pgRequest(sql).then((res) => {
      const outcome = toHolderOutcome(res);
      state.outcome = outcome;
      return outcome;
    });
    pendingHolders.push(done);

    const sleeping = (async () => {
      const deadline = Date.now() + timings.deadlineMs;
      while (Date.now() < deadline) {
        if (state.outcome) throw new Error(`${label} が pg_sleep に入る前に終わりました: ${JSON.stringify(state.outcome)}`);
        const rows = await pgQuery<{ pid: number }>(`
        SELECT pid FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
        if (rows.length === 1) {
          state.pid = rows[0].pid;
          return;
        }
        await sleep(timings.pollMs);
      }
      throw new Error(`${label} が ${timings.deadlineMs} ミリ秒のうちに pg_sleep に入りませんでした (持つ行の手前で待ったままです)`);
    })();
    // 待つ前にテストが落ちたときの未処理の reject にしない (await した側には reject のまま届く)
    sleeping.catch(() => undefined);

    const release = async (): Promise<void> => {
      await sleeping;
      const rows = await pgQuery<{ cancelled: boolean }>(`
      SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity
      WHERE pid = ${state.pid} AND wait_event = 'PgSleep' AND query LIKE '%${marker}%'`);
      if (rows.length !== 1 || rows[0].cancelled !== true) {
        throw new Error(`${label} を放す前に、その接続が pg_sleep を抜けていました: ${JSON.stringify({ rows, outcome: state.outcome })}`);
      }
    };

    const holder: Holder = { label, marker, sleeping, done, finished: () => state.outcome !== null, pid: () => state.pid, release };
    openHolders.push(holder);
    return holder;
  }

  async function waitForLockWaiters(match: string, count: number, { step, blockedBy, waitEvent }: LockWaitOptions): Promise<void> {
    const blockerPid = blockedBy ? blockedBy.pid() : null;
    if (blockedBy && blockerPid === null) throw new Error(`手順「${step}」: ${blockedBy.label} がまだ pg_sleep に入っていません`);
    const blockedByClause = blockerPid === null ? '' : `AND ${blockerPid} = ANY(pg_blocking_pids(pid))`;
    const waitEventClause = waitEvent === undefined ? '' : `AND wait_event = '${waitEvent}'`;
    const deadline = Date.now() + timings.deadlineMs;
    let seen = 0;
    while (Date.now() < deadline) {
      const rows = await pgQuery<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' ${waitEventClause} AND query LIKE '%${match}%' AND pid <> pg_backend_pid() ${blockedByClause}`);
      seen = rows[0]?.n ?? 0;
      if (seen >= count) return;
      await sleep(timings.pollMs);
    }
    const behind = blockedBy ? `${blockedBy.label} の後ろの` : '';
    const kind = waitEvent === undefined ? '' : ` (${waitEvent}) `;
    throw new Error(
      `手順「${step}」: ${match} の呼び出しが ${timings.deadlineMs} ミリ秒のうちに${behind}行のロックの待ち${kind}に ${count} 本並びませんでした (並んだのは ${seen} 本)`,
    );
  }

  async function runBehindHolder<T>(holder: Holder, waiter: QueuedCall<T>): Promise<[HolderOutcome, T]> {
    await holder.sleeping;
    const waiterDone = waiter.call();
    // 並ばずに落ちたときの未処理の reject にしない (下の Promise.all には reject のまま届く)
    waiterDone.catch(() => undefined);
    await waitForLockWaiters(waiter.fn, 1, {
      step: waiter.step ?? `${waiter.fn} が ${holder.label} の commit を待つ`,
      blockedBy: holder,
      waitEvent: waiter.waitEvent,
    });
    await holder.release();
    return Promise.all([holder.done, waiterDone]);
  }

  async function whileHolding<T>(holder: Holder, body: () => Promise<T>): Promise<[HolderOutcome, T]> {
    await holder.sleeping;
    let result: T;
    try {
      result = await body();
    } finally {
      await holder.release();
    }
    return [await holder.done, result];
  }

  async function releaseOpenHolders(): Promise<void> {
    const holders = openHolders.splice(0);
    for (const holder of holders) {
      if (holder.finished()) continue;
      await holder.release().catch(() => undefined);
    }
  }

  async function settle(): Promise<void> {
    await Promise.allSettled(pendingHolders);
  }

  return { timings, pgQuery, startHolder, waitForLockWaiters, runBehindHolder, whileHolding, releaseOpenHolders, settle };
}

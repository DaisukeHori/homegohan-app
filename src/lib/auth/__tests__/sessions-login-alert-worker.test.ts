/**
 * src/lib/auth/sessions/login-alert-worker.ts の単体テスト
 * (#1190。設計 docs/design/cross/16-auth-history-sessions.md §13.3・§13.4・§10.2・§20.1)
 *
 * processLoginAlerts は deps を偽物にして、1 行の順 (§13.4) と件数の数え方 (claimed = queued + skipped + failed) を見る。
 * createLoginAlertWorkerDeps は、sendEmail (@/lib/emails/send) を vi.mock し、Supabase の client を偽物にして、
 * 送信待ちへの登録の引数・RPC の引数・getUserById の扱いを見る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { mockSendEmail } = vi.hoisted(() => ({ mockSendEmail: vi.fn() }));
vi.mock('@/lib/emails/send', () => ({ sendEmail: mockSendEmail }));

import {
  LOGIN_ALERT_BATCH_SIZE,
  LOGIN_ALERT_MAX_AGE_HOURS,
  LOGIN_ALERT_MAX_ATTEMPTS,
  LOGIN_ALERT_MIN_AGE_SECONDS,
  LOGIN_ALERT_PRIOR_MAX_ROWS,
  LOGIN_ALERT_RECLAIM_MINUTES,
  LOGIN_HISTORY_RETENTION_DAYS,
} from '@/lib/auth/sessions/constants';
import { deviceFamilyOf, deviceLabelOf } from '@/lib/auth/sessions/device-family';
import {
  createLoginAlertWorkerDeps,
  processLoginAlerts,
  type LoginAlertAccount,
  type LoginAlertRow,
  type LoginAlertWorkerDeps,
  type PriorLogin,
} from '@/lib/auth/sessions/login-alert-worker';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const WINDOWS_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAC_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const NOW = new Date('2026-10-17T10:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENT_ACCOUNT = new Date(NOW.getTime() - 10 * MS_PER_DAY);
const OLD_ACCOUNT = new Date(NOW.getTime() - (LOGIN_HISTORY_RETENTION_DAYS + 10) * MS_PER_DAY);

function row(overrides: Partial<LoginAlertRow> = {}): LoginAlertRow {
  return {
    session_id: SESSION_ID,
    user_id: USER_ID,
    user_agent: WINDOWS_CHROME_UA,
    ip_address: '203.0.113.10',
    ip_network: '203.0.113.0/24',
    country_code: 'JP',
    created_at: '2026-10-17T09:59:00.000Z',
    ...overrides,
  };
}

const knownMac: PriorLogin = { deviceFamilyKey: 'macos/safari', ipNetwork: '203.0.113.0/24', countryCode: 'JP' };

function makeDeps(options: {
  rows?: LoginAlertRow[];
  prior?: PriorLogin[];
  account?: LoginAlertAccount | null;
  sendOk?: boolean;
} = {}) {
  const calls: string[] = [];
  const deps = {
    claim: vi.fn(async () => {
      calls.push('claim');
      return options.rows ?? [row()];
    }),
    priorLogins: vi.fn(async () => options.prior ?? [knownMac]),
    accountOf: vi.fn(async () =>
      options.account === undefined ? { email: 'taro@example.com', createdAt: RECENT_ACCOUNT } : options.account,
    ),
    send: vi.fn(async (r: LoginAlertRow) => {
      calls.push(`send:${r.session_id}`);
      return { ok: options.sendOk ?? true };
    }),
    finish: vi.fn(async (sessionId: string) => {
      calls.push(`finish:${sessionId}`);
    }),
    release: vi.fn(async (sessionId: string) => {
      calls.push(`release:${sessionId}`);
    }),
    now: vi.fn(() => NOW),
  } satisfies LoginAlertWorkerDeps;
  return { deps, calls };
}

beforeEach(() => {
  mockSendEmail.mockReset();
});

describe('processLoginAlerts (§13.4)', () => {
  it('取り置いた行ごとに判定し、送るべき行だけ send を呼ぶ', async () => {
    const known = row({ session_id: 'known-session', user_agent: MAC_SAFARI_UA });
    const fresh = row({ session_id: 'new-session' });
    const { deps } = makeDeps({ rows: [known, fresh] });

    const summary = await processLoginAlerts(deps, { alertMode: 'on' });

    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith(fresh, 'Windows の Chrome', 'taro@example.com');
    expect(deps.finish).toHaveBeenCalledWith('known-session', {
      deviceFamily: 'macos/safari', isNewDevice: false, isNewIp: false, isNewCountry: false, sentAt: null,
    });
    expect(deps.finish).toHaveBeenCalledWith('new-session', {
      deviceFamily: 'windows/chrome', isNewDevice: true, isNewIp: false, isNewCountry: false, sentAt: NOW,
    });
    expect(summary).toEqual({ claimed: 2, queued: 1, skipped: 1, failed: 0 });
  });

  it('decideLoginAlert に accountOf の createdAt・now()・LOGIN_HISTORY_RETENTION_DAYS を渡す (prior が空で古いアカウントなら送る)', async () => {
    const oldAccount = makeDeps({ prior: [], account: { email: 'taro@example.com', createdAt: OLD_ACCOUNT } });
    expect(await processLoginAlerts(oldAccount.deps, { alertMode: 'on' })).toEqual({ claimed: 1, queued: 1, skipped: 0, failed: 0 });
    expect(oldAccount.deps.send).toHaveBeenCalledTimes(1);

    // 保持の日数以内に作ったアカウントで prior が空なら初めてのログイン (送らない)
    const newAccount = makeDeps({ prior: [], account: { email: 'taro@example.com', createdAt: RECENT_ACCOUNT } });
    expect(await processLoginAlerts(newAccount.deps, { alertMode: 'on' })).toEqual({ claimed: 1, queued: 0, skipped: 1, failed: 0 });
    expect(newAccount.deps.send).not.toHaveBeenCalled();
    expect(newAccount.deps.now).toHaveBeenCalled();
  });

  it('accountOf が null の行は送らずに印を false で finish し、skipped に数える', async () => {
    const { deps } = makeDeps({ account: null });
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.finish).toHaveBeenCalledWith(SESSION_ID, {
      deviceFamily: 'windows/chrome', isNewDevice: false, isNewIp: false, isNewCountry: false, sentAt: null,
    });
    expect(summary).toEqual({ claimed: 1, queued: 0, skipped: 1, failed: 0 });
  });

  it('alertMode が off なら送らず印だけ finish する', async () => {
    const { deps } = makeDeps();
    const summary = await processLoginAlerts(deps, { alertMode: 'off' });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.finish).toHaveBeenCalledWith(SESSION_ID, {
      deviceFamily: 'windows/chrome', isNewDevice: true, isNewIp: false, isNewCountry: false, sentAt: null,
    });
    expect(summary).toEqual({ claimed: 1, queued: 0, skipped: 1, failed: 0 });
  });

  it('email が無い行は skipped', async () => {
    const { deps } = makeDeps({ account: { email: null, createdAt: RECENT_ACCOUNT } });
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.finish).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ isNewDevice: true, sentAt: null }));
    expect(summary).toEqual({ claimed: 1, queued: 0, skipped: 1, failed: 0 });
  });

  it('send が ok: false (sendEmail が登録できなかった: suppressed・not_configured (skipped: true)・invalid_envelope・outbox_failed) でも done (sentAt null) にして再送せず、skipped に数える', async () => {
    const { deps } = makeDeps({ sendOk: false });
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.finish).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ isNewDevice: true, sentAt: null }));
    expect(deps.release).not.toHaveBeenCalled();
    expect(summary).toEqual({ claimed: 1, queued: 0, skipped: 1, failed: 0 });
  });

  it('send が ok: true (送信待ちに登録できた) なら sentAt = now() で done にし、finish が戻った後に queued に数える (配信の成否は待たず、email_outbox を読まない)', async () => {
    const { deps, calls } = makeDeps({ sendOk: true });
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(deps.finish).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ sentAt: NOW }));
    expect(calls).toEqual(['claim', `send:${SESSION_ID}`, `finish:${SESSION_ID}`]);
    expect(summary).toEqual({ claimed: 1, queued: 1, skipped: 0, failed: 0 });
  });

  it('send に渡す端末の文言は deviceLabelOf(deviceFamilyOf(user_agent)) で、取り置いた行に device_name があっても使わない (S-31)', async () => {
    const withName = { ...row(), device_name: 'Your iPhone 15 Pro' };
    const { deps } = makeDeps({ rows: [withName] });
    await processLoginAlerts(deps, { alertMode: 'on' });
    expect(deps.send).toHaveBeenCalledWith(withName, deviceLabelOf(deviceFamilyOf(WINDOWS_CHROME_UA)), 'taro@example.com');
    expect(deps.send.mock.calls[0][1]).not.toContain('Your iPhone');
  });

  it('1 行の例外は release して次へ進み、failed に数える', async () => {
    const failing = row({ session_id: 'failing-session' });
    const ok = row({ session_id: 'ok-session' });
    const { deps, calls } = makeDeps({ rows: [failing, ok] });
    deps.priorLogins.mockImplementationOnce(async () => {
      throw new Error('DB の一時的な失敗');
    });
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(calls).toEqual(['claim', 'release:failing-session', 'send:ok-session', 'finish:ok-session']);
    expect(summary).toEqual({ claimed: 2, queued: 1, skipped: 0, failed: 1 });
  });

  it('send が ok: true の後に finish が例外を投げた行は、release を 1 回呼んで failed に数え (queued は 0・skipped は 0)、同じ回の中で send をもう一度呼ばない (重複の登録は次の回の取り直しの 1 回だけ S-39・S-43)', async () => {
    const { deps } = makeDeps({ sendOk: true });
    deps.finish.mockRejectedValueOnce(new Error('UPDATE の失敗'));
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.release).toHaveBeenCalledTimes(1);
    expect(deps.release).toHaveBeenCalledWith(SESSION_ID);
    expect(summary).toEqual({ claimed: 1, queued: 0, skipped: 0, failed: 1 });
  });

  it('send が ok: false の後に finish が例外を投げた行は、failed だけに数える (skipped は 0)', async () => {
    const { deps } = makeDeps({ sendOk: false });
    deps.finish.mockRejectedValueOnce(new Error('UPDATE の失敗'));
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(summary).toEqual({ claimed: 1, queued: 0, skipped: 0, failed: 1 });
  });

  it('どの行も queued・skipped・failed のどれか 1 つだけに数え、claimed (claim が返した行の数) はその和になる', async () => {
    const rows = [
      row({ session_id: 'a' }), // 送る → queued
      row({ session_id: 'b', user_agent: MAC_SAFARI_UA }), // 既知 → skipped
      row({ session_id: 'c' }), // finish が例外 → failed
      row({ session_id: 'd' }), // send の後に finish が例外 → failed
    ];
    const { deps } = makeDeps({ rows });
    deps.finish.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'c' || sessionId === 'd') throw new Error('UPDATE の失敗');
    });
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(summary).toEqual({ claimed: 4, queued: 1, skipped: 1, failed: 2 });
    expect(summary.queued + summary.skipped + summary.failed).toBe(summary.claimed);
  });

  it('release も例外を投げても次の行へ進み、failed に数える', async () => {
    const { deps } = makeDeps({ rows: [row({ session_id: 'x' }), row({ session_id: 'y' })] });
    deps.accountOf.mockRejectedValueOnce(new Error('GoTrue の失敗'));
    deps.release.mockRejectedValueOnce(new Error('RPC の失敗'));
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(deps.release).toHaveBeenCalledWith('x');
    expect(deps.finish).toHaveBeenCalledWith('y', expect.anything());
    expect(summary).toEqual({ claimed: 2, queued: 1, skipped: 0, failed: 1 });
  });

  it('戻り値に件数 ({ claimed, queued, skipped, failed }) だけを返す', async () => {
    const { deps } = makeDeps();
    const summary = await processLoginAlerts(deps, { alertMode: 'on' });
    expect(Object.keys(summary).sort()).toEqual(['claimed', 'failed', 'queued', 'skipped']);
    expect(JSON.stringify(summary)).not.toContain('taro@example.com');
    expect(JSON.stringify(summary)).not.toContain('203.0.113');
  });

  it('claim 自体の失敗は例外のまま投げる (route が 500 にする)', async () => {
    const { deps } = makeDeps();
    deps.claim.mockRejectedValueOnce(new Error('RPC の失敗'));
    await expect(processLoginAlerts(deps, { alertMode: 'on' })).rejects.toThrow('RPC の失敗');
  });
});

/** createLoginAlertWorkerDeps に渡す偽の service_role の client */
function makeAdmin(options: { getUserById?: () => Promise<unknown>; priorRows?: unknown[] } = {}) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: [], error: null }));
  const getUserById = vi.fn(options.getUserById ?? (async () => ({ data: { user: null }, error: null })));
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    neq: vi.fn(() => query),
    lt: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(async () => ({ data: options.priorRows ?? [], error: null })),
  };
  const from = vi.fn(() => query);
  const admin = { rpc, from, auth: { admin: { getUserById } } };
  return { admin: admin as unknown as SupabaseClient, rpc, getUserById, query };
}

describe('createLoginAlertWorkerDeps (§13.3 の表)', () => {
  it('createLoginAlertWorkerDeps の send は、行の created_at・ip_address (ip_network ではない)・country_code と端末の文言で renderLoginNewDeviceEmail を作り、sendEmail に idempotencyKey login-alert:<session_id> と userId = row.user_id を付けて渡し、redactAfterSend は渡さない', async () => {
    mockSendEmail.mockResolvedValue({ ok: true, id: 'outbox-1', attempts: 0, skipped: false, error: null });
    const { admin } = makeAdmin();
    const deps = createLoginAlertWorkerDeps(admin);

    await deps.send(row(), 'Windows の Chrome', 'taro@example.com');

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [envelope, options] = mockSendEmail.mock.calls[0];
    expect(envelope).toMatchObject({ template: 'login_new_device', to: 'taro@example.com' });
    expect(envelope.text).toContain('端末: Windows の Chrome');
    expect(envelope.text).toContain('IP アドレス: 203.0.113.10');
    expect(envelope.text).not.toContain('203.0.113.0/24');
    expect(envelope.text).toContain('国: JP');
    // created_at 2026-10-17T09:59Z は日本時間の 18:59
    expect(envelope.text).toContain('18:59');
    expect(options).toEqual({ idempotencyKey: `login-alert:${SESSION_ID}`, userId: USER_ID });
    expect(options).not.toHaveProperty('redactAfterSend');
  });

  it('createLoginAlertWorkerDeps の send は sendEmail の戻りの ok をそのまま { ok } で返す (ok: true = 登録できた。{ ok: false, skipped: true } も ok: false。例外にしない)', async () => {
    const { admin } = makeAdmin();
    const deps = createLoginAlertWorkerDeps(admin);

    mockSendEmail.mockResolvedValueOnce({ ok: true, id: 'outbox-1', attempts: 0, skipped: false, error: null });
    await expect(deps.send(row(), 'Windows の Chrome', 'taro@example.com')).resolves.toEqual({ ok: true });

    mockSendEmail.mockResolvedValueOnce({ ok: false, id: null, attempts: 0, skipped: true, error: new Error('not_configured') });
    await expect(deps.send(row(), 'Windows の Chrome', 'taro@example.com')).resolves.toEqual({ ok: false });

    mockSendEmail.mockResolvedValueOnce({ ok: false, id: null, attempts: 0, skipped: false, error: new Error('suppressed') });
    await expect(deps.send(row(), 'Windows の Chrome', 'taro@example.com')).resolves.toEqual({ ok: false });
  });

  it('createLoginAlertWorkerDeps の claim / release は LOGIN_ALERT_BATCH_SIZE・LOGIN_ALERT_MIN_AGE_SECONDS・LOGIN_ALERT_RECLAIM_MINUTES・LOGIN_ALERT_MAX_AGE_HOURS (p_max_age_hours)・LOGIN_ALERT_MAX_ATTEMPTS を RPC の引数にする', async () => {
    const { admin, rpc } = makeAdmin();
    const deps = createLoginAlertWorkerDeps(admin);

    await deps.claim();
    await deps.release(SESSION_ID);

    expect(rpc).toHaveBeenCalledWith('claim_login_alerts', {
      p_batch_size: LOGIN_ALERT_BATCH_SIZE,
      p_min_age_seconds: LOGIN_ALERT_MIN_AGE_SECONDS,
      p_reclaim_minutes: LOGIN_ALERT_RECLAIM_MINUTES,
      p_max_age_hours: LOGIN_ALERT_MAX_AGE_HOURS,
    });
    expect(rpc).toHaveBeenCalledWith('release_login_alert', { p_session_id: SESSION_ID, p_max_attempts: LOGIN_ALERT_MAX_ATTEMPTS });
  });

  it('createLoginAlertWorkerDeps の accountOf は getUserById が 404 なら null、ほかの error は例外', async () => {
    const notFound = makeAdmin({ getUserById: async () => ({ data: { user: null }, error: { status: 404, message: 'User not found' } }) });
    await expect(createLoginAlertWorkerDeps(notFound.admin).accountOf(USER_ID)).resolves.toBeNull();

    const failing = makeAdmin({ getUserById: async () => ({ data: { user: null }, error: { status: 500, message: 'upstream' } }) });
    await expect(createLoginAlertWorkerDeps(failing.admin).accountOf(USER_ID)).rejects.toMatchObject({ status: 500 });

    const found = makeAdmin({
      getUserById: async () => ({ data: { user: { id: USER_ID, email: 'taro@example.com', created_at: '2026-01-01T00:00:00.000Z' } }, error: null }),
    });
    await expect(createLoginAlertWorkerDeps(found.admin).accountOf(USER_ID)).resolves.toEqual({
      email: 'taro@example.com',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('createLoginAlertWorkerDeps の priorLogins は listPriorLogins の行を PriorLogin にし (device_family が NULL なら UA から)、上限は LOGIN_ALERT_PRIOR_MAX_ROWS', async () => {
    const { admin, query } = makeAdmin({
      priorRows: [
        { user_agent: MAC_SAFARI_UA, device_family: null, ip_network: '198.51.100.0/24', country_code: null },
        { user_agent: 'node', device_family: 'ios/app', ip_network: null, country_code: 'JP' },
      ],
    });
    const prior = await createLoginAlertWorkerDeps(admin).priorLogins(row());
    expect(prior).toEqual([
      { deviceFamilyKey: 'macos/safari', ipNetwork: '198.51.100.0/24', countryCode: null },
      { deviceFamilyKey: 'ios/app', ipNetwork: null, countryCode: 'JP' },
    ]);
    expect(query.limit).toHaveBeenCalledWith(LOGIN_ALERT_PRIOR_MAX_ROWS);
  });
});

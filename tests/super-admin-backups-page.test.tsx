/**
 * #1129 / #1191 運営の画面 /super-admin/backups (バックアップの取得の状態と DR 訓練の記録) を描画して確かめる
 * 設計: docs/design/cross/17-backup-automation.md §7.4・§15 の super-admin-backups-page の行 (段 B)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (super-admin-llm-quotas-page と同じ)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_AUDIT_TARGET_TYPE,
  BACKUP_STALE_AFTER_HOURS,
  BACKUP_TIERS,
  BACKUP_TIER_LABELS,
  DR_TEST_AUDIT_ACTIONS,
  DR_TEST_AUDIT_TARGET_TYPE,
  DR_TEST_ENVIRONMENTS,
  DR_TEST_ENVIRONMENT_LABELS,
  DR_TEST_KINDS,
  DR_TEST_KIND_LABELS,
  DR_TEST_RESULTS,
  DR_TEST_RESULT_LABELS,
  DR_TEST_SMOKE_LABELS,
  DR_TEST_SMOKE_RESULTS,
  SUPER_ADMIN_BACKUPS_API_PATH,
  SUPER_ADMIN_DR_TESTS_API_PATH,
  backupAuditAction,
  drTestRecordBodySchema,
  type BackupAuditRow,
  type BackupStatusResponse,
} from '@/lib/backups/core';
import { invalidInputBody, invalidJsonBodyBody } from '@/lib/super-admin/validation-errors';
import { ADMIN_AUDIT_SEVERITY_LABELS } from '@/lib/admin/audit-severity-labels';

const { default: SuperAdminBackupsPage } = await import('@/app/super-admin/backups/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE_SOURCE_PATH = path.resolve(__dirname, '../src/app/super-admin/backups/page.tsx');

const SUPER_ADMIN_ID = '11111111-1111-4111-8111-111111111111';

const DAILY: BackupAuditRow = {
  id: '00000000-0000-4000-8000-000000000001',
  // 2026-10-19 17:31 UTC = 2026-10-20 02:31 JST
  created_at: '2026-10-19T17:31:00.000Z',
  action_type: backupAuditAction('daily', 'completed'),
  target_type: BACKUP_AUDIT_TARGET_TYPE,
  actor_id: null,
  severity: 'info',
  details: { tier: 'daily', key: 'daily/2026-10-20/homegohan-db-20261019T172300Z.tar.zst.age', size_bytes: 104_857_600 },
};
const WEEKLY: BackupAuditRow = {
  ...DAILY,
  id: '00000000-0000-4000-8000-000000000002',
  action_type: backupAuditAction('weekly', 'completed'),
  details: { tier: 'weekly', key: 'weekly/2026-10-19/x.tar.zst.age', size_bytes: 1024, restore_check: { result: 'passed' } },
};
const FAILED: BackupAuditRow = {
  ...DAILY,
  id: '00000000-0000-4000-8000-000000000003',
  action_type: backupAuditAction('daily', 'failed'),
  severity: 'warn',
  details: { tier: 'daily', stage: 'upload', reason: 'upload_failed' },
};
const DRILL: BackupAuditRow = {
  id: '00000000-0000-4000-8000-000000000004',
  created_at: '2026-10-14T03:00:00.000Z',
  action_type: DR_TEST_AUDIT_ACTIONS.quarterly_restore,
  target_type: DR_TEST_AUDIT_TARGET_TYPE,
  actor_id: SUPER_ADMIN_ID,
  severity: 'info',
  details: { kind: 'quarterly_restore', result: 'success', performed_on: '2026-10-13', notes: 'restore-note-xyz' },
};

function statusBody(overrides: Partial<BackupStatusResponse['data']> = {}): BackupStatusResponse {
  return {
    data: {
      latest: { daily: DAILY, weekly: WEEKLY, annual: null },
      latest_dr_tests: { monthly_pitr: null, quarterly_restore: DRILL, annual_drill: null },
      stale: false,
      stale_after_hours: BACKUP_STALE_AFTER_HOURS,
      backups: [DAILY, FAILED],
      dr_tests: [DRILL],
      ...overrides,
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let getResponse: { status: number; body: unknown };
let postResponses: Array<{ status: number; body: unknown }>;

beforeEach(() => {
  getResponse = { status: 200, body: statusBody() };
  postResponses = [];
  fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const response = init?.method === 'POST' ? (postResponses.shift() ?? { status: 201, body: { success: true } }) : getResponse;
    return { ok: response.status < 300, status: response.status, json: async () => response.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  await act(async () => {
    root.render(<SuperAdminBackupsPage />);
  });
  await flush();
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const form = () => byTestId('dr-test-form') as HTMLFormElement;
const alerts = () => Array.from(container.querySelectorAll('[role="alert"]')) as HTMLElement[];

async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

const field = (name: string) => container.querySelector(`#dr-test-${name}`) as HTMLInputElement | HTMLSelectElement;

async function submit() {
  await act(async () => {
    (form().querySelector('button[type="submit"]') as HTMLButtonElement).click();
  });
  await flush();
}

const postBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url, body: JSON.parse(String((init as RequestInit).body)) }));

const getCount = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === undefined).length;

describe('/super-admin/backups (バックアップ・DR)', () => {
  it('読み込みは SUPER_ADMIN_BACKUPS_API_PATH', async () => {
    await render();
    expect(fetchMock).toHaveBeenCalledWith(SUPER_ADMIN_BACKUPS_API_PATH);
  });

  it('鮮度が古い (stale true) と daily のカードに赤いバッジと文 (色だけでなく「古い」と時間を文で出す)', async () => {
    getResponse = { status: 200, body: statusBody({ stale: true }) };
    await render();
    const badge = byTestId('backups-stale-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('古い');
    expect(badge?.textContent).toContain(`${BACKUP_STALE_AFTER_HOURS} 時間以上`);
    expect(byTestId('backups-tier-daily')?.contains(badge)).toBe(true);
    expect(byTestId('backups-tier-daily')?.textContent).toContain('GitHub Actions の db-backup が止まっていないか確かめる');
  });

  it('鮮度が新しい (stale false) ならバッジを出さない', async () => {
    await render();
    expect(byTestId('backups-stale-badge')).toBeNull();
  });

  it('層のカード: 見出しは BACKUP_TIER_LABELS・最新の日時 (日本時間)・大きさ・R2 のキー・復元の検査。latest が null は「記録なし」', async () => {
    await render();
    for (const tier of BACKUP_TIERS) {
      expect(byTestId(`backups-tier-${tier}`)?.textContent).toContain(BACKUP_TIER_LABELS[tier]);
    }
    const daily = byTestId('backups-tier-daily')?.textContent ?? '';
    expect(daily).toContain('2026/10/20 02:31');
    expect(daily).toContain('100.0 MiB');
    expect(daily).toContain('daily/2026-10-20/homegohan-db-20261019T172300Z.tar.zst.age');
    expect(byTestId('backups-tier-weekly')?.textContent).toContain('passed');
    expect(byTestId('backups-tier-annual')?.textContent).toContain('記録なし');
  });

  it('dr-tests-latest に種類ごとの最後の訓練 (日付と結果)、無ければ「記録なし」', async () => {
    await render();
    const latest = byTestId('dr-tests-latest')?.textContent ?? '';
    for (const kind of DR_TEST_KINDS) expect(latest).toContain(DR_TEST_KIND_LABELS[kind]);
    const quarterly = byTestId('dr-tests-latest-quarterly_restore')?.textContent ?? '';
    expect(quarterly).toContain('2026-10-13');
    expect(quarterly).toContain(DR_TEST_RESULT_LABELS.success);
    expect(byTestId('dr-tests-latest-monthly_pitr')?.textContent).toContain('記録なし');
  });

  it('一覧: 取得の行 (action_type・severity・stage / reason・details の JSON) と訓練の行', async () => {
    await render();
    const backups = byTestId('backups-list')?.textContent ?? '';
    expect(backups).toContain(backupAuditAction('daily', 'failed'));
    // 重要度は表示名 (warn → 警告) で出す (#2112 Z3)
    expect(backups).toContain(ADMIN_AUDIT_SEVERITY_LABELS.warn);
    expect(backups).toContain('upload / upload_failed');
    expect(backups).toContain('"reason": "upload_failed"');
    const drTests = byTestId('dr-tests-list')?.textContent ?? '';
    expect(drTests).toContain(DR_TEST_AUDIT_ACTIONS.quarterly_restore);
    expect(drTests).toContain('"notes": "restore-note-xyz"');
  });

  it('a11y: form の select・input のすべてに id があり、同じ id を htmlFor に持つ label がちょうど 1 つある', async () => {
    await render();
    const controls = Array.from(form().querySelectorAll('select, input, textarea')) as HTMLElement[];
    expect(controls.length).toBe(9);
    for (const control of controls) {
      expect(control.id).not.toBe('');
      expect(container.querySelectorAll(`label[for="${control.id}"]`)).toHaveLength(1);
    }
    expect(form().querySelectorAll('select')).toHaveLength(4);
  });

  it('送信のボタンは button[type="submit"]', async () => {
    await render();
    expect(form().querySelectorAll('button[type="submit"]')).toHaveLength(1);
  });

  it('層のカード・一覧は h2 の見出しで区切る', async () => {
    await render();
    expect(container.querySelectorAll('h2').length).toBeGreaterThanOrEqual(3);
  });

  it('form の kind・result・environment・smoke の option は core.ts の配列と同じ並びで、表示は *_LABELS の値', async () => {
    await render();
    const cases: Array<[string, readonly string[], Readonly<Record<string, string>>]> = [
      ['kind', DR_TEST_KINDS, DR_TEST_KIND_LABELS],
      ['result', DR_TEST_RESULTS, DR_TEST_RESULT_LABELS],
      ['environment', DR_TEST_ENVIRONMENTS, DR_TEST_ENVIRONMENT_LABELS],
      ['smoke', DR_TEST_SMOKE_RESULTS, DR_TEST_SMOKE_LABELS],
    ];
    for (const [name, values, labels] of cases) {
      const options = Array.from((field(name) as HTMLSelectElement).options);
      expect(options.map((o) => o.value)).toEqual([...values]);
      expect(options.map((o) => o.textContent)).toEqual(values.map((v) => labels[v]));
    }
  });

  it('form の送信で POST の本文が drTestRecordBodySchema を通る形 (空の任意項目は null・datetime-local は日本時間の ISO)', async () => {
    await render();
    await setValue(field('kind'), 'quarterly_restore');
    await setValue(field('performed_on'), '2026-10-13');
    await setValue(field('restored_to'), '2026-10-13T02:23');
    await setValue(field('backup_key'), 'daily/2026-10-13/x.tar.zst.age');
    await setValue(field('rto_minutes'), '45');
    await submit();

    const [post] = postBodies();
    expect(post.url).toBe(SUPER_ADMIN_DR_TESTS_API_PATH);
    expect(drTestRecordBodySchema.safeParse(post.body).success).toBe(true);
    expect(post.body).toEqual({
      kind: 'quarterly_restore',
      result: DR_TEST_RESULTS[0],
      performed_on: '2026-10-13',
      environment: DR_TEST_ENVIRONMENTS[0],
      restored_to: '2026-10-13T02:23:00+09:00',
      backup_key: 'daily/2026-10-13/x.tar.zst.age',
      rto_minutes: 45,
      smoke: DR_TEST_SMOKE_RESULTS[0],
      notes: '',
    });
  });

  it('既定の値のまま送っても drTestRecordBodySchema を通る (restored_to・backup_key・rto_minutes は null)', async () => {
    await render();
    await submit();
    const [post] = postBodies();
    expect(drTestRecordBodySchema.safeParse(post.body).success).toBe(true);
    expect(post.body.restored_to).toBeNull();
    expect(post.body.backup_key).toBeNull();
    expect(post.body.rto_minutes).toBeNull();
  });

  it('400 (failed で notes 空の issues) で notes の下に role="alert" の文を出し、入力に aria-invalid と aria-describedby', async () => {
    const parsed = drTestRecordBodySchema.safeParse({
      kind: 'monthly_pitr',
      result: 'failed',
      performed_on: '2026-10-05',
      environment: 'staging',
      restored_to: null,
      backup_key: null,
      rto_minutes: null,
      smoke: 'not_run',
      notes: '',
    });
    if (parsed.success) throw new Error('検証が通ってしまった');
    postResponses = [{ status: 400, body: invalidInputBody(parsed.error.issues) }];
    await render();
    await submit();

    const error = byTestId('dr-test-field-error-notes');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toBe('失敗・見送りのときは理由を書いてください');
    const notes = field('notes');
    expect(notes.getAttribute('aria-invalid')).toBe('true');
    expect(notes.getAttribute('aria-describedby')).toBe(error?.id);
    expect(error?.id).not.toBe('');
    // 文の無い項目には付けない
    expect(field('kind').getAttribute('aria-invalid')).toBeNull();
    expect(field('kind').getAttribute('aria-describedby')).toBeNull();
  });

  it('400 (invalidJsonBodyBody) で dr-test-form-error に「リクエストボディが不正です」', async () => {
    postResponses = [{ status: 400, body: invalidJsonBodyBody() }];
    await render();
    await submit();
    const formError = byTestId('dr-test-form-error');
    expect(formError?.getAttribute('role')).toBe('alert');
    expect(formError?.textContent).toContain('リクエストボディが不正です');
  });

  it.each([
    [403, '記録する権限がありません'],
    [500, '記録できませんでした'],
  ])('送信の %i は固定の文を role="alert" の中に出す', async (status, text) => {
    postResponses = [{ status, body: { error: { code: 'X', message: 'secret_detail' } } }];
    await render();
    await submit();
    const texts = alerts().map((a) => a.textContent ?? '');
    expect(texts.some((t) => t.includes(text))).toBe(true);
    expect(container.textContent).not.toContain('secret_detail');
  });

  it('読み込みの 500 / 403 は固定の文を role="alert" に出し、カード・一覧は描かない', async () => {
    getResponse = { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'x' } } };
    await render();
    expect(alerts().map((a) => a.textContent).join('')).toContain('バックアップの状態を読み込めませんでした');
    expect(byTestId('backups-tier-daily')).toBeNull();
    expect(byTestId('backups-list')).toBeNull();
    expect(byTestId('dr-tests-list')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    getResponse = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'x' } } };
    await render();
    expect(alerts().map((a) => a.textContent).join('')).toContain('この画面を見る権限がありません');
  });

  it('読み込み・送信の 403 の本文の文が二段階認証の文なら、固定の文で上書きせずその文を出す (#1917 の続き・整合 1025b)', async () => {
    getResponse = { status: 403, body: { error: { code: 'FORBIDDEN', message: '二段階認証の確認が必要です' } } };
    await render();
    const loadAlerts = alerts().map((a) => a.textContent).join('');
    expect(loadAlerts).toContain('二段階認証の確認が必要です');
    expect(loadAlerts).not.toContain('この画面を見る権限がありません');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    getResponse = { status: 200, body: statusBody() };
    postResponses = [{ status: 403, body: { error: { code: 'FORBIDDEN', message: '二段階認証の確認が必要です' } } }];
    await render();
    await submit();
    const texts = alerts().map((a) => a.textContent ?? '');
    expect(texts.some((t) => t.includes('二段階認証の確認が必要です'))).toBe(true);
    expect(texts.some((t) => t.includes('記録する権限がありません'))).toBe(false);
  });

  it('201 で読み直し、項目の文が消え、role="alert" が無い', async () => {
    const parsed = drTestRecordBodySchema.safeParse({ kind: 'nope' });
    if (parsed.success) throw new Error('検証が通ってしまった');
    postResponses = [{ status: 400, body: invalidInputBody(parsed.error.issues) }, { status: 201, body: { success: true } }];
    await render();
    await submit();
    expect(byTestId('dr-test-field-error-kind')).not.toBeNull();
    expect(alerts().length).toBeGreaterThan(0);

    await submit();
    expect(getCount()).toBe(2);
    expect(byTestId('dr-test-field-error-kind')).toBeNull();
    expect(alerts()).toHaveLength(0);
  });

  it('page.tsx に選択肢の値・ラベルの直書きが無い (core.ts から import している)', () => {
    const source = fs.readFileSync(PAGE_SOURCE_PATH, 'utf8');
    const values = [...DR_TEST_KINDS, ...DR_TEST_RESULTS, ...DR_TEST_ENVIRONMENTS, ...DR_TEST_SMOKE_RESULTS, ...BACKUP_TIERS];
    for (const value of values) {
      expect(source).not.toContain(`'${value}'`);
      expect(source).not.toContain(`"${value}"`);
    }
    const labels = [
      ...Object.values(DR_TEST_KIND_LABELS),
      ...Object.values(DR_TEST_RESULT_LABELS),
      ...Object.values(DR_TEST_ENVIRONMENT_LABELS),
      ...Object.values(DR_TEST_SMOKE_LABELS),
      ...Object.values(BACKUP_TIER_LABELS),
    ];
    for (const label of labels) {
      expect(source).not.toContain(`'${label}'`);
      expect(source).not.toContain(`"${label}"`);
      expect(source).not.toContain(`>${label}<`);
    }
    expect(source).toContain("from '@/lib/backups/core'");
  });
});

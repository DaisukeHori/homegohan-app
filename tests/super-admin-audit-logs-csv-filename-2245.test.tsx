/**
 * #2245 K3: 監査ログ (/super-admin/audit-logs) の「CSV エクスポート」で保存するファイル名の日付は JST の今日。
 *
 * 以前は `new Date().toISOString().slice(0, 10)` (UTC の暦日) で、JST の 0:00〜8:59 に書き出すと前日の日付になっていた。
 * API (GET /api/super-admin/audit-logs?format=csv) の Content-Disposition の日付は tests/audit-log-date-range-routes.test.ts が見る。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JST_EXPORT_FILENAME_BOUNDARIES } from './helpers/jst-export-filename-boundaries';
import { TEST_TIME_ZONES, withTimeZoneAsync } from './helpers/time-zones';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, back: () => undefined }),
  useParams: () => ({}),
  usePathname: () => '/super-admin/audit-logs',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: AuditLogsPage } = await import('@/app/super-admin/audit-logs/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HTTP_OK = 200;
/** 描画・クリックのあとに、fetch と state の更新が落ち着くまで回すマイクロタスクの回数 (tests/admin-401-message-2112.test.tsx と同じ) */
const SETTLE_TICKS = 6;

let container: HTMLDivElement;
let root: Root;
const downloads: string[] = [];

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TICKS; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickCsvExport() {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'CSV エクスポート');
  expect(button, '「CSV エクスポート」ボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
  });
  await settle();
}

beforeEach(async () => {
  downloads.length = 0;
  vi.stubGlobal('fetch', async (input: string | URL) =>
    String(input).includes('format=csv')
      ? new Response('id,created_at\n', { status: HTTP_OK, headers: { 'content-type': 'text/csv' } })
      : new Response(JSON.stringify({ data: [], meta: { total: 0 } }), {
          status: HTTP_OK,
          headers: { 'content-type': 'application/json' },
        }),
  );
  vi.stubGlobal('alert', vi.fn());
  URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(AuditLogsPage));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('監査ログ: CSV エクスポートのファイル名の日付は JST の今日 (#2245 K3)', () => {
  it.each(TEST_TIME_ZONES)('TZ=%s でも、JST の 0:00〜8:59 は UTC の前日ではなく JST の今日の日付', async (tz) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const { now } of JST_EXPORT_FILENAME_BOUNDARIES) {
      vi.setSystemTime(new Date(now));
      await withTimeZoneAsync(tz, () => clickCsvExport());
    }
    expect(downloads).toEqual(JST_EXPORT_FILENAME_BOUNDARIES.map(({ jstToday }) => `audit-logs-${jstToday}.csv`));
  });
});

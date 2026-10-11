// @vitest-environment node
/**
 * src/lib/weekly-menu-request-stale.ts — 献立生成のリクエストの行が止まったかの判定 (#1494)
 *
 * - queued は止まったと見なさない (cron の順番待ち。積んだ時点で AI の 1 回を数えているので、failed にすると 1 回が消える)
 * - 生存信号: worker_acquired_at がある行は GREATEST(worker_acquired_at, updated_at)、無い行は updated_at、どちらも無ければ created_at
 * - しきい値は 1 つの定数を、止まった行を failed にするすべての route で共有する (同じ値を 2 か所に書かない)
 * - しきい値は claim_menu_request のリース (migration の interval) より長い (cron の取り直しを上書きしない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAIM_MENU_REQUEST_LEASE_MINUTES,
  WEEKLY_MENU_REQUEST_STALE_MINUTES,
  WEEKLY_MENU_REQUEST_STALE_MS,
  WEEKLY_MENU_REQUEST_STALE_TARGET_STATUSES,
  isWeeklyMenuRequestStale,
  weeklyMenuRequestLastAliveAtMs,
  weeklyMenuRequestStaleBefore,
} from '@/lib/weekly-menu-request-stale';

const ROOT = path.resolve(__dirname, '../../..');
const NOW_MS = Date.parse('2026-10-11T03:00:00.000Z');
const MIN = 60 * 1000;
const ago = (minutes: number) => new Date(NOW_MS - minutes * MIN).toISOString();

describe('isWeeklyMenuRequestStale', () => {
  it('queued は、作成からどれだけたっていても止まったと見なさない', () => {
    for (const minutes of [6, WEEKLY_MENU_REQUEST_STALE_MINUTES + 1, 24 * 60]) {
      expect(
        isWeeklyMenuRequestStale(
          { status: 'queued', created_at: ago(minutes), updated_at: ago(minutes), worker_acquired_at: null },
          NOW_MS,
        ),
      ).toBe(false);
    }
  });

  it('終わった行 (completed / failed) は止まったと見なさない', () => {
    for (const status of ['completed', 'failed']) {
      expect(isWeeklyMenuRequestStale({ status, created_at: ago(90), updated_at: ago(90), worker_acquired_at: null }, NOW_MS)).toBe(false);
    }
  });

  it('作成時刻ではなく生存信号で判定する: 作成は古くても updated_at が新しい processing の行は止まっていない', () => {
    expect(
      isWeeklyMenuRequestStale({ status: 'processing', created_at: ago(90), updated_at: ago(1), worker_acquired_at: null }, NOW_MS),
    ).toBe(false);
  });

  it('worker_acquired_at がある行は GREATEST(worker_acquired_at, updated_at) で判定する', () => {
    // 取り直した直後 (worker_acquired_at が新しい・updated_at は古い) → 止まっていない
    expect(
      isWeeklyMenuRequestStale({ status: 'processing', created_at: ago(90), updated_at: ago(40), worker_acquired_at: ago(1) }, NOW_MS),
    ).toBe(false);
    // 進捗が新しい (worker_acquired_at は古い) → 止まっていない
    expect(
      isWeeklyMenuRequestStale({ status: 'processing', created_at: ago(90), updated_at: ago(1), worker_acquired_at: ago(40) }, NOW_MS),
    ).toBe(false);
    // どちらもしきい値より古い → 止まった
    expect(
      isWeeklyMenuRequestStale({ status: 'processing', created_at: ago(90), updated_at: ago(40), worker_acquired_at: ago(30) }, NOW_MS),
    ).toBe(true);
    // updated_at が NULL の行は worker_acquired_at だけで判定する (SQL の GREATEST は NULL を無視する)
    expect(
      isWeeklyMenuRequestStale({ status: 'processing', created_at: ago(90), updated_at: null, worker_acquired_at: ago(30) }, NOW_MS),
    ).toBe(true);
    expect(
      isWeeklyMenuRequestStale({ status: 'processing', created_at: ago(90), updated_at: null, worker_acquired_at: ago(1) }, NOW_MS),
    ).toBe(false);
  });

  it('しきい値ちょうどは止まっていない。しきい値を超えたら止まった (pending も processing と同じ)', () => {
    for (const status of WEEKLY_MENU_REQUEST_STALE_TARGET_STATUSES) {
      const row = (minutes: number) => ({ status, created_at: ago(90), updated_at: ago(minutes), worker_acquired_at: null });
      expect(isWeeklyMenuRequestStale(row(WEEKLY_MENU_REQUEST_STALE_MINUTES - 1), NOW_MS)).toBe(false);
      expect(isWeeklyMenuRequestStale(row(WEEKLY_MENU_REQUEST_STALE_MINUTES), NOW_MS)).toBe(false);
      expect(isWeeklyMenuRequestStale(row(WEEKLY_MENU_REQUEST_STALE_MINUTES + 1), NOW_MS)).toBe(true);
    }
  });

  it('updated_at も worker_acquired_at も無い行は created_at で判定し、どれも読めない行は止まったと見なさない', () => {
    expect(isWeeklyMenuRequestStale({ status: 'processing', created_at: ago(30), updated_at: null, worker_acquired_at: null }, NOW_MS)).toBe(true);
    expect(isWeeklyMenuRequestStale({ status: 'processing', created_at: ago(5), updated_at: null, worker_acquired_at: null }, NOW_MS)).toBe(false);
    expect(isWeeklyMenuRequestStale({ status: 'processing', created_at: null, updated_at: null, worker_acquired_at: null }, NOW_MS)).toBe(false);
    expect(isWeeklyMenuRequestStale({ status: 'processing', created_at: 'not-a-date', updated_at: '', worker_acquired_at: null }, NOW_MS)).toBe(false);
  });
});

describe('weeklyMenuRequestLastAliveAtMs / weeklyMenuRequestStaleBefore', () => {
  it('生存信号の時刻を返す', () => {
    expect(weeklyMenuRequestLastAliveAtMs({ status: 'processing', created_at: ago(90), updated_at: ago(10), worker_acquired_at: ago(3) })).toBe(
      NOW_MS - 3 * MIN,
    );
    expect(weeklyMenuRequestLastAliveAtMs({ status: 'processing', created_at: ago(90), updated_at: ago(10), worker_acquired_at: null })).toBe(
      NOW_MS - 10 * MIN,
    );
  });

  it('しきい値の時刻 = 今 - WEEKLY_MENU_REQUEST_STALE_MINUTES 分', () => {
    expect(WEEKLY_MENU_REQUEST_STALE_MS).toBe(WEEKLY_MENU_REQUEST_STALE_MINUTES * MIN);
    expect(weeklyMenuRequestStaleBefore(NOW_MS).getTime()).toBe(NOW_MS - WEEKLY_MENU_REQUEST_STALE_MINUTES * MIN);
  });

  it('止まったかを判定する状態に queued を含めない', () => {
    expect([...WEEKLY_MENU_REQUEST_STALE_TARGET_STATUSES].sort()).toEqual(['pending', 'processing']);
  });
});

describe('しきい値の共有と、claim_menu_request のリースとの関係 (ソースと migration の突き合わせ)', () => {
  /** claim_menu_request を定義している migration のうち、いちばん新しいもの */
  function latestClaimMenuRequestMigration(): { file: string; source: string } {
    const dir = path.join(ROOT, 'supabase/migrations');
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
      .sort();
    const defining = files.filter((name) =>
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.claim_menu_request\s*\(/i.test(fs.readFileSync(path.join(dir, name), 'utf8')),
    );
    expect(defining.length, 'claim_menu_request を定義する migration が見つからない').toBeGreaterThan(0);
    const file = defining[defining.length - 1];
    return { file, source: fs.readFileSync(path.join(dir, file), 'utf8') };
  }

  it('CLAIM_MENU_REQUEST_LEASE_MINUTES は、いちばん新しい claim_menu_request の processing の取り直しの interval と一致する', () => {
    const { file, source } = latestClaimMenuRequestMigration();
    // コメント行を除いた本文から、GREATEST(worker_acquired_at, updated_at) < now() - interval 'N minutes' を探す
    const body = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const match = body.match(/GREATEST\(\s*worker_acquired_at\s*,\s*updated_at\s*\)\s*<\s*now\(\)\s*-\s*interval\s*'(\d+)\s+minutes'/i);
    expect(match, `${file} に GREATEST(worker_acquired_at, updated_at) の取り直しの条件が見つからない`).not.toBeNull();
    expect(Number(match?.[1]), file).toBe(CLAIM_MENU_REQUEST_LEASE_MINUTES);
  });

  it('しきい値は claim_menu_request のリースより長い (cron が取り直せる行を先に failed にしない)', () => {
    expect(WEEKLY_MENU_REQUEST_STALE_MINUTES).toBeGreaterThan(CLAIM_MENU_REQUEST_LEASE_MINUTES);
  });

  it.each([
    'src/app/api/ai/menu/weekly/cleanup/route.ts',
    'src/app/api/ai/menu/weekly/status/route.ts',
    'src/app/api/ai/menu/weekly/pending/route.ts',
    'src/app/api/ai/menu/meal/pending/route.ts',
  ])('%s はしきい値を自分で書かず、共有の判定 (src/lib/weekly-menu-request-stale.ts) を使う', (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(source).toContain("from '@/lib/weekly-menu-request-stale'");
    // 分数の直書き (以前の const staleMinutes = 20 / 5 * 60 * 1000 のような書き方) が残っていない
    expect(source).not.toMatch(/staleMinutes\s*=/);
    expect(source).not.toMatch(/\d+\s*\*\s*60\s*\*\s*1000/);
  });
});

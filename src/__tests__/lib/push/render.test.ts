import { describe, expect, it } from 'vitest';
import { PUSH_NOTIFICATION_KIND_SPECS } from '@homegohan/shared';
import { formatMonthDay, renderPushMessage } from '@/lib/push/render';

// #1136 Push 通知の文面 (src/lib/push/render.ts)。設計: docs/design/mobile/06-push-send.md §3.2・§6.2

const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const PATH = PUSH_NOTIFICATION_KIND_SPECS.weekly_menu_completed.path;
const payload = { request_id: REQUEST_ID, start_date: '2026-01-05', mode: 'v5' };

describe('renderPushMessage (#1136)', () => {
  it('weekly_menu_completed は日付入りの本文と data.path を返す', () => {
    expect(PATH).toBe('/menus');
    expect(renderPushMessage('weekly_menu_completed', payload, PATH)).toEqual({
      title: '献立ができました',
      body: '1月5日からの献立ができました。開いて確認しましょう',
      data: { kind: 'weekly_menu_completed', path: '/menus', request_id: REQUEST_ID },
    });
    // mode は null・省略でもよい
    expect(renderPushMessage('weekly_menu_completed', { request_id: REQUEST_ID, start_date: '2026-12-31', mode: null }, PATH)?.body).toBe(
      '12月31日からの献立ができました。開いて確認しましょう',
    );
    expect(formatMonthDay('2026-10-09')).toBe('10月9日');
  });

  it('weekly_menu_failed は日付入りの本文 ({M}月{D}日からの献立を作れませんでした) で、理由の確認を約束しない', () => {
    const rendered = renderPushMessage('weekly_menu_failed', { request_id: REQUEST_ID, start_date: '2026-10-20' }, PATH);
    expect(rendered).toEqual({
      title: '献立を作れませんでした',
      body: '10月20日からの献立を作れませんでした',
      data: { kind: 'weekly_menu_failed', path: '/menus', request_id: REQUEST_ID },
    });
    // 理由・確認・もう一度を約束する語を含まない (開いても理由は出ないため。設計書 §3.2)
    for (const word of ['理由', '確認', 'もう一度', '同意', '上限']) {
      expect(`${rendered?.title}${rendered?.body}`).not.toContain(word);
    }
  });

  it('payload の形が違えば null', () => {
    for (const bad of [
      {},
      { request_id: 'not-a-uuid', start_date: '2026-10-20' },
      { request_id: REQUEST_ID },
      { request_id: REQUEST_ID, start_date: '2026/10/20' },
      { request_id: REQUEST_ID, start_date: '2026-13-01' },
      { request_id: REQUEST_ID, start_date: '2026-10-20', mode: 'x'.repeat(33) },
      { request_id: REQUEST_ID, start_date: '2026-10-20', mode: 5 },
    ]) {
      expect(renderPushMessage('weekly_menu_completed', bad, PATH), JSON.stringify(bad)).toBeNull();
      expect(renderPushMessage('weekly_menu_failed', bad, PATH), JSON.stringify(bad)).toBeNull();
    }
  });

  it('知らない kind は null', () => {
    expect(renderPushMessage('family_meal_request', payload, PATH)).toBeNull();
    expect(renderPushMessage('', payload, PATH)).toBeNull();
  });
});

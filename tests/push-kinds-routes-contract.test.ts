/**
 * #1136 サーバーから送る Push 通知の種類 (packages/shared の PUSH_NOTIFICATION_KINDS) の契約
 *   - 種類の全部に文面がある (src/lib/push/render.ts の renderPushMessage が、正しい payload で null でない文面を返す)
 *   - 種類の全部の行き先 path が、アプリの resolveNotificationHref で同じ値に解決される (= NOTIFICATION_ROUTES にある画面)
 * 種類を足したのに文面・行き先の画面を足し忘れると赤になる。設計: docs/design/mobile/06-push-send.md §6.2
 */
import { describe, expect, it } from 'vitest';
import {
  PUSH_NOTIFICATION_KINDS,
  PUSH_NOTIFICATION_KIND_SPECS,
  isPushNotificationKind,
  type PushNotificationKind,
} from '@homegohan/shared';
import { renderPushMessage } from '@/lib/push/render';
import { NOTIFICATION_ROUTES, resolveNotificationHref } from '../apps/mobile/src/lib/notificationRoute';

/** 種類ごとの、トリガー (weekly_menu_requests_enqueue_push。関数 enqueue_weekly_menu_result_push) が入れる形の payload */
const VALID_PAYLOADS: Readonly<Record<PushNotificationKind, Record<string, unknown>>> = {
  weekly_menu_completed: { request_id: '11111111-2222-4333-8444-555555555555', start_date: '2026-10-20', mode: 'v5' },
  weekly_menu_failed: { request_id: '11111111-2222-4333-8444-555555555555', start_date: '2026-10-20', mode: null },
};

describe('Push 通知の種類と文面・行き先 (#1136)', () => {
  it('PUSH_NOTIFICATION_KINDS の全部に文面がある', () => {
    expect(PUSH_NOTIFICATION_KINDS.length).toBeGreaterThan(0);
    expect(Object.keys(PUSH_NOTIFICATION_KIND_SPECS).sort()).toEqual([...PUSH_NOTIFICATION_KINDS].sort());
    for (const kind of PUSH_NOTIFICATION_KINDS) {
      const spec = PUSH_NOTIFICATION_KIND_SPECS[kind];
      expect(spec.kind, kind).toBe(kind);
      expect(isPushNotificationKind(kind)).toBe(true);
      const rendered = renderPushMessage(kind, VALID_PAYLOADS[kind], spec.path);
      expect(rendered, kind).not.toBeNull();
      expect(rendered?.title.trim(), kind).toBeTruthy();
      expect(rendered?.body.trim(), kind).toBeTruthy();
      expect(rendered?.data, kind).toMatchObject({ kind, path: spec.path });
    }
    expect(isPushNotificationKind('no_such_kind')).toBe(false);
    expect(isPushNotificationKind(undefined)).toBe(false);
  });

  it('全部の path が NOTIFICATION_ROUTES の画面に解決される', () => {
    for (const kind of PUSH_NOTIFICATION_KINDS) {
      const { path } = PUSH_NOTIFICATION_KIND_SPECS[kind];
      expect(resolveNotificationHref({ path }), `${kind}: ${path}`).toBe(path);
      expect(NOTIFICATION_ROUTES, `${kind}: ${path}`).toContain(path);
    }
  });
});

/**
 * Push 通知の文面 (#1136)。種類 (kind) と payload (push_outbox.payload) から title / body / data を作る。
 * 行き先 path は呼び出し側 (worker) が種類の方針 (packages/shared の PUSH_NOTIFICATION_KIND_SPECS) から渡す。
 * 文面は固定の日本語で、個人を特定する文字列 (名前・メールアドレス) は入れない。
 */
import { z } from 'zod';
import type { RenderedPushMessage } from './outbox';

/** 献立の結果 (weekly_menu_completed / weekly_menu_failed) の payload。トリガー weekly_menu_requests_enqueue_push (関数 enqueue_weekly_menu_result_push) が入れる */
export const WeeklyMenuResultPayloadSchema = z.object({
  request_id: z.uuid(),
  start_date: z.iso.date(),
  mode: z.string().max(32).nullable().optional(),
});
export type WeeklyMenuResultPayload = z.infer<typeof WeeklyMenuResultPayloadSchema>;

const WEEKLY_MENU_COMPLETED_TITLE = '献立ができました';
/**
 * 失敗の本文は日付だけで、理由 (同意・1 日の上限・生成の失敗など) も理由の確認も書かない。
 * 通知から開く献立のタブの WebView (Web の週の画面 src/app/(main)/menus/weekly/page.tsx) が error_message を出すのは追跡中の依頼の失敗だけで、
 * 起動時の GET /api/ai/menu/weekly/pending は failed の行を返さないため、開いても理由は出ない (設計書 §3.2・§14)
 */
const WEEKLY_MENU_FAILED_TITLE = '献立を作れませんでした';

/** 'YYYY-MM-DD' → 'M月D日' (JST の暦日をそのまま読む。時刻帯の変換はしない) */
export function formatMonthDay(isoDate: string): string {
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return `${month}月${day}日`;
}

/**
 * 種類と payload から文面を作る。知らない種類・形の違う payload は null。
 * @param kind push_outbox.kind
 * @param payload push_outbox.payload
 * @param path 種類の方針の path (worker が渡す)
 */
export function renderPushMessage(kind: string, payload: Record<string, unknown>, path: string): RenderedPushMessage | null {
  switch (kind) {
    case 'weekly_menu_completed': {
      const parsed = WeeklyMenuResultPayloadSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        title: WEEKLY_MENU_COMPLETED_TITLE,
        body: `${formatMonthDay(parsed.data.start_date)}からの献立ができました。開いて確認しましょう`,
        data: { kind, path, request_id: parsed.data.request_id },
      };
    }
    case 'weekly_menu_failed': {
      const parsed = WeeklyMenuResultPayloadSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        title: WEEKLY_MENU_FAILED_TITLE,
        body: `${formatMonthDay(parsed.data.start_date)}からの献立を作れませんでした`,
        data: { kind, path, request_id: parsed.data.request_id },
      };
    }
    default:
      return null;
  }
}

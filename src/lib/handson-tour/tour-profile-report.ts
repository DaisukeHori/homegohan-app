/**
 * ハンズオンツアーのプロフィール取得 (tour-profile.ts) の失敗を、計測とサーバーログに残す (#1040 / #1306)。
 *
 * ツアーは体験モードなので失敗してもブロックしないが、黙って握りつぶすと
 * 「存在しない列を select していて全員分パーソナライズが効かない」(今回の不具合) に気づけない。
 * #1057 (UX1-09) の方針どおり、失敗は必ず残す。
 *   - 計測: handson_tour_step_error (#1166 で PostHog をやめたため、いまは送り先がなく何も送られない)
 *   - サーバーログ: app_logs (source = 'client')。失敗が残るのはこちらで、原因 (PostgREST のエラーコード) が分かる
 */
import { fireAnalytics } from '@homegohan/handson-tour-shared';
import { logToServer } from '@/lib/db-logger';
import type { TourProfileFetchFailure, TourProfileTable } from './tour-profile';

const ERROR_CODE_BY_TABLE: Record<TourProfileTable, string> = {
  user_profiles: 'profile_fetch_failed',
  nutrition_targets: 'nutrition_target_fetch_failed',
};

export function reportTourProfileFailures(params: {
  step: 1 | 2;
  userId: string;
  failures: readonly TourProfileFetchFailure[];
}): void {
  const { step, userId, failures } = params;
  for (const failure of failures) {
    // 計測の失敗 (開発時の payload 検証エラーなど) でツアーを止めない
    try {
      fireAnalytics('handson_tour_step_error', {
        user_id: userId,
        timestamp: new Date().toISOString(),
        platform: 'web' as const,
        app_version: '1.0.0',
        step,
        // 取得はページを開いた直後 (その Step の最初の sub_step) に行う
        sub_step: `${step}.1`,
        error_code: ERROR_CODE_BY_TABLE[failure.table],
        error_message: `${failure.table} select failed${failure.code ? ` (${failure.code})` : ''}`,
      });
    } catch {
      // 計測の失敗は無視
    }
    // logToServer は失敗しても例外を投げない
    void logToServer('warn', `handson-tour step${step}: ${failure.table} select failed`, {
      step,
      table: failure.table,
      code: failure.code,
      message: failure.message,
    });
  }
}

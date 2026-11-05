/**
 * #2259 P1 Web の AI 相談の通信の時間の上限 (src/lib/ai/consultation-request-time-limit.ts)。
 *
 *   - withinConsultationRequestTimeLimit: 上限までに終われば結果を返し、過ぎたら signal を打ち切って時間切れの例外で終える。
 *     fetch が打ち切りに応じなくても上限で必ず終える。終わったら予約を残さない
 *   - resolveAiChatRequestTimeLimitMs: 環境変数の上書き (1000 以上の整数だけ。ほかは既定)
 *   - AI_ROUTE_MAX_DURATION_SECONDS は src/app/api/ai/ の route の maxDuration の最大と一致する (サーバーが打ち切る前に打ち切らない)
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS,
  AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS,
  AI_ROUTE_MAX_DURATION_SECONDS,
  CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE,
  ConsultationRequestTimeoutError,
  isConsultationRequestTimeout,
  resolveAiChatRequestTimeLimitMs,
  withinConsultationRequestTimeLimit,
} from '@/lib/ai/consultation-request-time-limit';

const ROOT = path.resolve(__dirname, '..');
/** テストの上限 (偽の時刻で進める) */
const TEST_LIMIT_MS = 1_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('withinConsultationRequestTimeLimit', () => {
  it('上限までに終われば結果を返し、予約を残さない', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | null = null;
    const result = await withinConsultationRequestTimeLimit(TEST_LIMIT_MS, async (signal) => {
      seen = signal;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('run の失敗はそのまま投げ、予約を残さない', async () => {
    vi.useFakeTimers();
    const failure = new TypeError('Failed to fetch');
    await expect(withinConsultationRequestTimeLimit(TEST_LIMIT_MS, async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('上限を過ぎたら signal を打ち切り、時間切れの例外で終える (run が打ち切りに応じなくても終える)', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | null = null;
    const pending = withinConsultationRequestTimeLimit(TEST_LIMIT_MS, (signal) => {
      seen = signal;
      return new Promise<string>(() => {});
    });
    const settled = pending.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(TEST_LIMIT_MS - 1);
    expect(seen!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(ConsultationRequestTimeoutError);
    expect((outcome as Error).message).toBe(CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE);
    expect(seen!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('打ち切られた run があとで失敗しても、未処理の失敗にしない', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const pending = withinConsultationRequestTimeLimit(TEST_LIMIT_MS, (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      );
      const settled = pending.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(TEST_LIMIT_MS);
      expect(await settled).toBeInstanceOf(ConsultationRequestTimeoutError);
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('isConsultationRequestTimeout', () => {
  it('この部品の時間切れ・TimeoutError・AbortError だけを時間切れとみなす', () => {
    expect(isConsultationRequestTimeout(new ConsultationRequestTimeoutError())).toBe(true);
    expect(isConsultationRequestTimeout(new DOMException('timeout', 'TimeoutError'))).toBe(true);
    expect(isConsultationRequestTimeout(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isConsultationRequestTimeout(new TypeError('Failed to fetch'))).toBe(false);
    expect(isConsultationRequestTimeout(null)).toBe(false);
    expect(isConsultationRequestTimeout('TimeoutError')).toBe(false);
  });
});

describe('resolveAiChatRequestTimeLimitMs (NEXT_PUBLIC_AI_CHAT_REQUEST_TIME_LIMIT_MS)', () => {
  it.each([
    ['未設定', undefined, AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS],
    ['空', '', AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS],
    ['空白だけ', '   ', AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS],
    ['整数でない', '60000.5', AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS],
    ['負の数', '-60000', AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS],
    ['数でない', 'abc', AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS],
    ['下限より短い', String(AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS - 1), AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS],
    ['下限ちょうど', String(AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS), AI_CHAT_REQUEST_TIME_LIMIT_MIN_MS],
    ['前後の空白は除く', ' 60000 ', 60_000],
    ['安全な整数を超える', '99999999999999999999', AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS],
  ])('%s → 値', (_label, raw, expected) => {
    expect(resolveAiChatRequestTimeLimitMs(raw)).toBe(expected);
  });

  it('既定は AI の route の maxDuration の最大より長い (サーバーがまだ処理を続けうる間は打ち切らない)', () => {
    expect(AI_CHAT_REQUEST_TIME_LIMIT_DEFAULT_MS).toBeGreaterThan(AI_ROUTE_MAX_DURATION_SECONDS * 1000);
  });
});

describe('AI_ROUTE_MAX_DURATION_SECONDS は src/app/api/ai/ の route の maxDuration の最大と一致する', () => {
  function routeFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return routeFiles(full);
      return entry.name === 'route.ts' ? [full] : [];
    });
  }

  it('最大の maxDuration (秒) と同じ', () => {
    const durations = routeFiles(path.join(ROOT, 'src/app/api/ai')).flatMap((file) => {
      const match = /export const maxDuration = (\d+)/.exec(fs.readFileSync(file, 'utf8'));
      return match ? [Number(match[1])] : [];
    });
    expect(durations.length).toBeGreaterThan(0);
    expect(Math.max(...durations)).toBe(AI_ROUTE_MAX_DURATION_SECONDS);
  });
});

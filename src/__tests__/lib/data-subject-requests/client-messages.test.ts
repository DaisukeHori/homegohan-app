/**
 * #1178 個人情報の請求の画面の文 src/lib/data-subject-requests/client-messages.ts の単体テスト (設計 cross/15 §9.1・§15)
 */
import { describe, expect, it } from 'vitest';
import { dsrRateLimitedMessage } from '@/lib/data-subject-requests/client-messages';

const message = (wait: string) =>
  `短い時間に請求の送信を繰り返したため、一時的に実行できません。${wait}待ってからもう一度お試しください。`;

describe('dsrRateLimitedMessage', () => {
  it('120 秒 → 「2分ほど」', () => {
    expect(dsrRateLimitedMessage(120)).toBe(message('2分ほど'));
  });

  it('61 秒 → 「2分ほど」(分に切り上げ)・60 秒 → 「1分ほど」・1 秒 → 「1分ほど」', () => {
    expect(dsrRateLimitedMessage(61)).toBe(message('2分ほど'));
    expect(dsrRateLimitedMessage(60)).toBe(message('1分ほど'));
    expect(dsrRateLimitedMessage(1)).toBe(message('1分ほど'));
  });

  it('null・0・負の数 → 「しばらく」', () => {
    expect(dsrRateLimitedMessage(null)).toBe(message('しばらく'));
    expect(dsrRateLimitedMessage(0)).toBe(message('しばらく'));
    expect(dsrRateLimitedMessage(-5)).toBe(message('しばらく'));
  });
});

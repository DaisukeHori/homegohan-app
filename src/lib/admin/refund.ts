/**
 * 返金の記録 (#1185) で、API (/api/admin/finance/refunds) と画面が共有する定数と金額の換算。
 *
 * 画面 (クライアントのバンドル) からも読み込むため、zod など重い依存は持たせない。
 * 入力の検証そのもの (zod スキーマ) は finance-schemas.ts にある。
 */

/** 返金額の上限 (最小通貨単位)。Stripe が 1 件で扱える金額の上限 (8 桁) に合わせる */
export const REFUND_AMOUNT_MAX = 99_999_999;

/** 返金理由の最大文字数 */
export const REFUND_REASON_MAX_LENGTH = 500;

/**
 * 通貨の「最小単位」への倍率。請求書の画面 (invoices/[id]/page.tsx の formatAmount) と同じ規則で、
 * JPY は小数がない (1 円 = 1)、それ以外は 1/100 (例: USD の 1 ドル = 100 セント)。
 * Stripe の amount / amount_paid もこの最小単位の整数で入っている。
 */
export function minorUnitDivisor(currency: string): number {
  return currency.toLowerCase() === 'jpy' ? 1 : 100;
}

/** 最小単位の整数 → 入力欄に出す文字列 (JPY: "1200"、USD: "12.34") */
export function minorToInputValue(amount: number, currency: string): string {
  const divisor = minorUnitDivisor(currency);
  if (divisor === 1) return String(amount);
  const whole = Math.floor(amount / divisor);
  const fraction = String(amount % divisor).padStart(2, '0');
  return `${whole}.${fraction}`;
}

/**
 * 入力欄の文字列 → 最小単位の整数。入力として読めないときは null。
 * 全角の数字・カンマ (日本語入力のまま打った場合) は半角にそろえてから読む。
 * JPY は整数のみ、それ以外は小数 2 桁まで。小数の足し算で誤差が出ないよう、文字列のまま換算する。
 */
export function inputValueToMinor(input: string, currency: string): number | null {
  const text = input.normalize('NFKC').replace(/,/g, '').trim();
  if (minorUnitDivisor(currency) === 1) {
    return /^\d+$/.test(text) ? Number(text) : null;
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

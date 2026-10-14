/**
 * design-tokens ユニットテスト (#590)
 *
 * 状態色のトークン (STATUS_COLOR_TOKENS) について、次の 4 つを確かめる。
 *   1. 値: 塗りの色は A 系 (オーナー判断 590。モバイルの colors.ts にあった値と同じ)
 *   2. 文字用の色 (successText / warningText / dangerText) は、WCAG 2.x の AA (4.5:1) を満たす。
 *      白地・各 Light の下地・Web とモバイルのページの背景・塗りの色の薄い透過の下地のすべての上で
 *   3. 文字用の色は、塗りの色と同じ色の仲間のまま、暗くしただけ (別の色に見えない)
 *   4. 塗りの色は白地で 4.5:1 に届かない = 文字用の色を別に持つ理由 (オーナー判断 590-2)
 */

import { describe, it, expect } from 'vitest';
import { STATUS_COLOR_TOKENS, type StatusColorTokenKey } from './design-tokens';

// ─────────────────────────────────────────────
// WCAG 2.x のコントラスト比 (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio)
// ─────────────────────────────────────────────
function toLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (!match) throw new Error(`#RRGGBB の形ではありません: ${hex}`);
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 前景色と背景色のコントラスト比 (1〜21。どちらが前景でも同じ) */
function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** 前景色を透明度 alpha (0〜1) で背景色の上に重ねた色。ブラウザの合成と同じく、各チャンネルを 8 bit に丸める */
function blendOver(foreground: string, background: string, alpha: number): string {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  const channels = fg.map((value, i) => Math.round(value * alpha + bg[i] * (1 - alpha)));
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** HSL の色相 (0〜360 度) */
function hueOf(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (sector * 60 + 360) % 360;
}

/** 文字の AA (通常サイズの文字) の基準 */
const AA_NORMAL_TEXT = 4.5;

const WHITE = '#FFFFFF';

/**
 * 文字用の色が載る下地 (白と、各 Light 以外)。中立色はこのトークンに含めない (別の変更で揃える) ので、
 * 画面で実際に使われている値を、使い道つきで並べる。Web の画面のページ背景とモバイルの背景は違うので両方で確かめる。
 */
const PAGE_BACKGROUNDS = [
  { name: 'Web のページ背景 (health・pantry・home の bg)', hex: '#FAF9F7' },
  { name: 'モバイルのページ背景 (apps/mobile/src/theme/colors.ts の bg)', hex: '#F7F6F3' },
] as const;

/** home が Tailwind のクラスで下地を塗っている箇所 (トークンの外にある下地) */
const TAILWIND_BACKGROUNDS = [
  { name: 'Tailwind の bg-amber-50 (home の「課題」バナーの下地。warningText が載る)', hex: '#FFFBEB' },
  { name: 'Tailwind の bg-green-50 (home の「チェックイン完了」の下地。successText が載る)', hex: '#F0FDF4' },
] as const;

const BACKGROUNDS = [...PAGE_BACKGROUNDS, ...TAILWIND_BACKGROUNDS];

/**
 * 文字用の色と、その文字が載る塗りの色・淡い下地。
 * error (#F44336) の赤い文字にも dangerText を使う (赤系の文字は 1 色にそろえる) ので、dangerText は error と danger の両方と組む。
 */
const TEXT_TOKENS = [
  { text: 'successText', fills: ['success'], lights: ['successLight'] },
  { text: 'warningText', fills: ['warning'], lights: ['warningLight'] },
  { text: 'dangerText', fills: ['error', 'danger'], lights: ['errorLight', 'dangerLight'] },
] as const satisfies ReadonlyArray<{
  text: StatusColorTokenKey;
  fills: readonly StatusColorTokenKey[];
  lights: readonly StatusColorTokenKey[];
}>;

/**
 * チャレンジ画面のバッジは、塗りの色の後ろに 20 (16 進で 32/255 = 約 12.5%) を足して透過の下地にし、その上に文字用の色を載せる。
 * 下地になる面は、白のカードか、ページの背景。
 */
const BADGE_ALPHA = 0x20 / 255;

describe('コントラスト比の計算 (このテストの物差し)', () => {
  it('黒と白は 21:1、同じ色どうしは 1:1', () => {
    expect(contrastRatio('#000000', WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  it('前景と背景を入れ替えても同じ値になる', () => {
    expect(contrastRatio('#4A704A', WHITE)).toBeCloseTo(contrastRatio(WHITE, '#4A704A'), 10);
  });

  it('AA の境目として知られる灰色: #767676 は白地で 4.54:1 (合格)、#777777 は 4.48:1 (不合格)', () => {
    expect(contrastRatio('#767676', WHITE)).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#767676', WHITE)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio('#777777', WHITE)).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#777777', WHITE)).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('透過の合成: 不透明なら前景そのもの、透明なら背景そのもの、半分なら中間', () => {
    expect(blendOver('#6B9B6B', WHITE, 1)).toBe('#6B9B6B');
    expect(blendOver('#6B9B6B', WHITE, 0)).toBe(WHITE);
    expect(blendOver('#000000', WHITE, 0.5)).toBe('#808080');
  });
});

describe('状態色トークン: 値 (A 系)', () => {
  it('トークンの一覧: 塗り 8 色 + 文字 3 色 (増減したときは、ここと使う側の両方を見直す)', () => {
    expect(Object.keys(STATUS_COLOR_TOKENS).sort()).toEqual(
      [
        'danger',
        'dangerLight',
        'dangerText',
        'error',
        'errorLight',
        'success',
        'successLight',
        'successText',
        'warning',
        'warningLight',
        'warningText',
      ].sort(),
    );
  });

  it('塗りの色は A 系 (オーナー判断 590。モバイルの値は変わらない)', () => {
    expect({
      success: STATUS_COLOR_TOKENS.success,
      successLight: STATUS_COLOR_TOKENS.successLight,
      warning: STATUS_COLOR_TOKENS.warning,
      warningLight: STATUS_COLOR_TOKENS.warningLight,
      error: STATUS_COLOR_TOKENS.error,
      errorLight: STATUS_COLOR_TOKENS.errorLight,
      danger: STATUS_COLOR_TOKENS.danger,
      dangerLight: STATUS_COLOR_TOKENS.dangerLight,
    }).toEqual({
      success: '#6B9B6B',
      successLight: '#EDF5ED',
      warning: '#E5A84B',
      warningLight: '#FEF9EE',
      error: '#F44336',
      errorLight: '#FFEBEE',
      danger: '#D64545',
      dangerLight: '#FDECEC',
    });
  });

  it('どの値も #RRGGBB の大文字 (チャレンジ画面は色の後ろに 2 桁を足して透過にするため 6 桁の hex が前提)', () => {
    for (const [key, value] of Object.entries(STATUS_COLOR_TOKENS)) {
      expect(value, key).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe('状態色トークン: 文字用の色は AA 4.5:1 以上 (オーナー判断 590-2)', () => {
  describe.each(TEXT_TOKENS)('$text', ({ text, fills, lights }) => {
    const textColor = STATUS_COLOR_TOKENS[text];

    it('白地の上で 4.5:1 以上', () => {
      expect(contrastRatio(textColor, WHITE)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });

    it.each(BACKGROUNDS)('$name の上で 4.5:1 以上', ({ hex }) => {
      expect(contrastRatio(textColor, hex)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });

    it.each(lights)('淡い下地 %s の上で 4.5:1 以上', (light) => {
      expect(contrastRatio(textColor, STATUS_COLOR_TOKENS[light])).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });

    describe.each(fills)('塗りの色 %s の薄い透過 (後ろに 20) の下地', (fill) => {
      it.each([{ name: '白のカード', hex: WHITE }, ...PAGE_BACKGROUNDS])('$name の上で 4.5:1 以上', ({ hex }) => {
        const badge = blendOver(STATUS_COLOR_TOKENS[fill], hex, BADGE_ALPHA);
        expect(contrastRatio(textColor, badge), `下地 ${badge}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    });

    it.each(fills)('塗りの色 %s より暗く、同じ色の仲間のまま (色相が 5 度以内)', (fill) => {
      const fillColor = STATUS_COLOR_TOKENS[fill];
      expect(relativeLuminance(textColor)).toBeLessThan(relativeLuminance(fillColor));
      const diff = Math.abs(hueOf(textColor) - hueOf(fillColor));
      expect(Math.min(diff, 360 - diff)).toBeLessThanOrEqual(5);
    });
  });
});

describe('状態色トークン: 塗りの色は文字に使えない (文字用の色を別に持つ理由)', () => {
  it.each(['success', 'warning', 'error', 'danger'] as const)('%s は白地の上で 4.5:1 に届かない', (fill) => {
    expect(contrastRatio(STATUS_COLOR_TOKENS[fill], WHITE)).toBeLessThan(AA_NORMAL_TEXT);
  });
});

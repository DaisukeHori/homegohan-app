import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRemovedUrls, isBlobUrl, revokeBlobUrls } from '../src/lib/object-url';

/**
 * #1222: 写真プレビュー用 Blob URL (URL.createObjectURL) が revoke されずメモリに残り続ける問題。
 * 純粋ヘルパー (src/lib/object-url.ts) の単体テスト。
 *
 * jsdom は URL.revokeObjectURL を実装していないため、実在の有無に関わらず
 * defineProperty で差し替え、テスト後に元の状態へ戻す。
 */
const BLOB_A = 'blob:http://localhost:3000/aaaaaaaa-0000-4000-8000-000000000001';
const BLOB_B = 'blob:http://localhost:3000/bbbbbbbb-0000-4000-8000-000000000002';
const BLOB_C = 'blob:http://localhost:3000/cccccccc-0000-4000-8000-000000000003';

const originalDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
let revokeSpy: ReturnType<typeof vi.fn>;

function stubRevokeObjectURL(value: unknown) {
  Object.defineProperty(URL, 'revokeObjectURL', {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  revokeSpy = vi.fn();
  stubRevokeObjectURL(revokeSpy);
});

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(URL, 'revokeObjectURL', originalDescriptor);
  } else {
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  }
});

describe('isBlobUrl', () => {
  it('blob: で始まる文字列だけを Blob URL とみなす', () => {
    expect(isBlobUrl(BLOB_A)).toBe(true);
    expect(isBlobUrl('blob:null/1234')).toBe(true);
  });

  it('通常の URL・data: URL・画面側の目印は Blob URL ではない', () => {
    expect(isBlobUrl('/handson-tour/sample-meal.webp')).toBe(false);
    expect(isBlobUrl('https://example.com/blob:fake.png')).toBe(false);
    expect(isBlobUrl('data:image/png;base64,AAAA')).toBe(false);
    // 健診ページが PDF 選択中に state へ入れる目印
    expect(isBlobUrl('__pdf__')).toBe(false);
  });

  it('文字列以外・空文字は false', () => {
    expect(isBlobUrl('')).toBe(false);
    expect(isBlobUrl(null)).toBe(false);
    expect(isBlobUrl(undefined)).toBe(false);
    expect(isBlobUrl(123)).toBe(false);
    expect(isBlobUrl({ url: BLOB_A })).toBe(false);
  });
});

describe('findRemovedUrls (前回あって今回無い URL)', () => {
  it('配列から外れた URL だけを返す (1 枚削除)', () => {
    expect(findRemovedUrls([BLOB_A, BLOB_B, BLOB_C], [BLOB_A, BLOB_C])).toEqual([BLOB_B]);
  });

  it('リセット (空配列) では前回の URL をすべて返す', () => {
    expect(findRemovedUrls([BLOB_A, BLOB_B], [])).toEqual([BLOB_A, BLOB_B]);
  });

  it('追加だけなら何も返さない (表示中の URL を解放しない)', () => {
    expect(findRemovedUrls([BLOB_A], [BLOB_A, BLOB_B])).toEqual([]);
    expect(findRemovedUrls([], [BLOB_A])).toEqual([]);
  });

  it('前回と今回が同じなら何も返さない', () => {
    expect(findRemovedUrls([BLOB_A, BLOB_B], [BLOB_A, BLOB_B])).toEqual([]);
    expect(findRemovedUrls([], [])).toEqual([]);
  });

  it('並び順が変わっただけでは外れた扱いにしない', () => {
    expect(findRemovedUrls([BLOB_A, BLOB_B], [BLOB_B, BLOB_A])).toEqual([]);
  });

  it('全部入れ替わったら前回の URL をすべて返す (選び直し)', () => {
    expect(findRemovedUrls([BLOB_A], [BLOB_B])).toEqual([BLOB_A]);
  });

  it('重複は 1 件にまとめ、今回に 1 つでも残っていれば外れた扱いにしない', () => {
    expect(findRemovedUrls([BLOB_A, BLOB_A, BLOB_B], [BLOB_B])).toEqual([BLOB_A]);
    expect(findRemovedUrls([BLOB_A, BLOB_A], [BLOB_A])).toEqual([]);
  });

  it('入力の配列を書き換えない', () => {
    const prev = [BLOB_A, BLOB_B];
    const next = [BLOB_B];
    findRemovedUrls(prev, next);
    expect(prev).toEqual([BLOB_A, BLOB_B]);
    expect(next).toEqual([BLOB_B]);
  });

  it('blob: かどうかは問わず単純な差分を返す (revoke 側で blob: だけに絞る)', () => {
    expect(findRemovedUrls(['__pdf__', BLOB_A], [])).toEqual(['__pdf__', BLOB_A]);
  });
});

describe('revokeBlobUrls', () => {
  it('blob: で始まる URL だけを URL.revokeObjectURL に渡す', () => {
    revokeBlobUrls([
      BLOB_A,
      '/handson-tour/sample-meal.webp',
      '__pdf__',
      'data:image/png;base64,AAAA',
      'https://example.com/photo.png',
      BLOB_B,
    ]);

    expect(revokeSpy).toHaveBeenCalledTimes(2);
    expect(revokeSpy).toHaveBeenNthCalledWith(1, BLOB_A);
    expect(revokeSpy).toHaveBeenNthCalledWith(2, BLOB_B);
  });

  it('null / undefined / 空文字は無視する', () => {
    revokeBlobUrls([null, undefined, '']);
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('空配列では何もしない', () => {
    revokeBlobUrls([]);
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('Blob URL が 1 件でも引数どおりの URL で revoke する', () => {
    revokeBlobUrls([BLOB_C]);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith(BLOB_C);
  });

  it('URL.revokeObjectURL が無い環境でも例外にしない (React の cleanup で画面を落とさない)', () => {
    stubRevokeObjectURL(undefined);
    expect(() => revokeBlobUrls([BLOB_A])).not.toThrow();
  });

  it('差分ヘルパーと組み合わせると「外れた Blob URL だけ」が解放される (削除・リセットの流れ)', () => {
    const before = [BLOB_A, BLOB_B, 'blob-less-url', BLOB_C];
    const after = [BLOB_B];

    revokeBlobUrls(findRemovedUrls(before, after));

    expect(revokeSpy.mock.calls.map((call) => call[0])).toEqual([BLOB_A, BLOB_C]);
  });
});

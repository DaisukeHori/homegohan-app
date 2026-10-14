/**
 * #1049 F7-17: 冷蔵庫写真のアップロード (src/lib/storage.ts の uploadFridgePhoto) と、base64 の変換 (src/lib/base64.ts)
 *
 * 以前は fetch(localUri) の Blob を supabase-js に渡していて、React Native では Blob の中身が送られず、
 * 0 バイトのファイルになることがあった。写真を expo-file-system で base64 として読み、ArrayBuffer にして渡す。
 * ここでは次を確かめる。
 *   1. アップロードに渡す本文は、写真の中身そのもの (ArrayBuffer。Blob ではない。fetch を使わない)
 *   2. Content-Type は拡張子から決める (jpg は image/jpeg。'image/jpg' にしない)
 *   3. 中身が空・読めないときはアップロードせず、画面に出せる文の Error にする
 *   4. base64 の変換が正しい (Node の Buffer と同じ結果。埋め草・改行・不正な文字・不正な長さ)
 */

const mockReadAsStringAsync = jest.fn();
jest.mock('expo-file-system', () => ({
  readAsStringAsync: (...args: unknown[]) => mockReadAsStringAsync(...args),
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockFrom = jest.fn(() => ({ upload: mockUpload, getPublicUrl: mockGetPublicUrl }));
jest.mock('../../src/lib/supabase', () => ({
  supabase: { storage: { from: (bucket: string) => mockFrom(bucket) } },
}));

import { InvalidBase64Error, base64ToArrayBuffer } from '../../src/lib/base64';
import { FRIDGE_PHOTO_READ_FAILED_MESSAGE, uploadFridgePhoto } from '../../src/lib/storage';

/** JPEG の先頭 (SOI + APP0 の一部) と、それ以外のバイトを混ぜた中身 */
const PHOTO_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x7f, 0x80]);
const PHOTO_BASE64 = Buffer.from(PHOTO_BYTES).toString('base64');

describe('uploadFridgePhoto (#1049 F7-17)', () => {
  const originalFetch = global.fetch;
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    mockReadAsStringAsync.mockReset();
    mockUpload.mockReset();
    mockGetPublicUrl.mockReset();
    mockFrom.mockClear();
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockUpload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
    mockGetPublicUrl.mockImplementation((path: string) => ({ data: { publicUrl: `https://cdn.example/${path}` } }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('写真を base64 で読み、中身そのものの ArrayBuffer をアップロードする (fetch・Blob を使わない)', async () => {
    mockReadAsStringAsync.mockResolvedValue(PHOTO_BASE64);

    const url = await uploadFridgePhoto('file:///tmp/photo.JPG', 'user-1');

    expect(mockReadAsStringAsync).toHaveBeenCalledWith('file:///tmp/photo.JPG', { encoding: 'base64' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledWith('fridge-images');
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [path, body, options] = mockUpload.mock.calls[0] as [string, unknown, { contentType: string }];
    expect(path).toMatch(/^user-1\/\d+\.jpg$/);
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(body as ArrayBuffer))).toEqual(Array.from(PHOTO_BYTES));
    expect(options).toEqual({ contentType: 'image/jpeg' });
    expect(url).toBe(`https://cdn.example/${path}`);
  });

  it.each([
    ['file:///a/b/photo.jpeg', 'jpg', 'image/jpeg'],
    ['file:///a/b/photo.png', 'png', 'image/png'],
    ['file:///a/b/photo.heic?x=1#y', 'heic', 'image/heic'],
    ['file:///a/b/photo', 'jpg', 'image/jpeg'],
    ['file:///a.b/photo.unknown', 'jpg', 'image/jpeg'],
  ])('%s は拡張子 %s・Content-Type %s で保存する', async (uri, ext, contentType) => {
    mockReadAsStringAsync.mockResolvedValue(PHOTO_BASE64);

    await uploadFridgePhoto(uri, 'user-1');

    const [path, , options] = mockUpload.mock.calls[0] as [string, unknown, { contentType: string }];
    expect(path.endsWith(`.${ext}`)).toBe(true);
    expect(options.contentType).toBe(contentType);
  });

  it('中身が空なら、アップロードせずに画面に出せる文の Error にする (0 バイトのファイルを作らない)', async () => {
    mockReadAsStringAsync.mockResolvedValue('');

    await expect(uploadFridgePhoto('file:///tmp/photo.jpg', 'user-1')).rejects.toThrow(FRIDGE_PHOTO_READ_FAILED_MESSAGE);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('写真を読めなければ、アップロードせずに画面に出せる文の Error にする (元の例外は cause)', async () => {
    const cause = new Error('File not found');
    mockReadAsStringAsync.mockRejectedValue(cause);

    let thrown: unknown;
    try {
      await uploadFridgePhoto('file:///tmp/missing.jpg', 'user-1');
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe(FRIDGE_PHOTO_READ_FAILED_MESSAGE);
    expect((thrown as Error & { cause?: unknown }).cause).toBe(cause);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('Storage のエラーは、そのまま投げる', async () => {
    mockReadAsStringAsync.mockResolvedValue(PHOTO_BASE64);
    const storageError = new Error('The resource already exists');
    mockUpload.mockResolvedValue({ data: null, error: storageError });

    await expect(uploadFridgePhoto('file:///tmp/photo.jpg', 'user-1')).rejects.toBe(storageError);
    expect(mockGetPublicUrl).not.toHaveBeenCalled();
  });
});

describe('base64ToArrayBuffer (#1049 F7-17)', () => {
  const bytesOf = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer));

  it.each([
    [[]],
    [[0]],
    [[0xff, 0xfe]],
    [[1, 2, 3]],
    [[0, 0x80, 0xff, 0x10]],
    [Array.from({ length: 256 }, (_, i) => i)],
  ])('Node の Buffer で作った base64 を、元のバイト列に戻す (%j)', (bytes) => {
    const base64 = Buffer.from(bytes).toString('base64');
    expect(bytesOf(base64ToArrayBuffer(base64))).toEqual(bytes);
  });

  it('末尾の埋め草 (=) が無くても、改行・空白が入っていても読める', () => {
    expect(bytesOf(base64ToArrayBuffer('/w'))).toEqual([0xff]);
    expect(bytesOf(base64ToArrayBuffer('AQID\nBA==\r\n'))).toEqual([1, 2, 3, 4]);
    expect(bytesOf(base64ToArrayBuffer('AQ ID'))).toEqual([1, 2, 3]);
  });

  it('標準の base64 に無い文字 (URL 用の - _ など) は InvalidBase64Error', () => {
    expect(() => base64ToArrayBuffer('ab-_')).toThrow(InvalidBase64Error);
    expect(() => base64ToArrayBuffer('あいうえ')).toThrow(InvalidBase64Error);
  });

  it('ありえない長さ (4 で割った余りが 1) は InvalidBase64Error', () => {
    expect(() => base64ToArrayBuffer('AQIDB')).toThrow(InvalidBase64Error);
  });
});

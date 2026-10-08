/**
 * storage.test.ts
 * 冷蔵庫写真のアップロード (src/lib/storage.ts の uploadFridgePhoto) のテスト (#1049 F7-17)
 *
 * 以前は fetch(uri).blob() を supabase-js の upload に渡していた。React Native では Blob が
 * FormData に載っても中身が送られず、0 バイトのファイルが保存されることがあった。
 * ファイルを expo-file-system で base64 として読み、ArrayBuffer にして渡す。
 */

// ── expo-file-system のモック ─────────────────────────────────────────────────
const mockReadAsStringAsync = jest.fn();
jest.mock('expo-file-system', () => ({
  readAsStringAsync: (...args: unknown[]) => mockReadAsStringAsync(...args),
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

// ── Supabase Storage のモック ─────────────────────────────────────────────────
const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockFrom = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    storage: {
      from: (...args: unknown[]) => mockFrom(...args),
    },
  },
}));

import { uploadFridgePhoto } from '../../src/lib/storage';

const NOW = 1_760_000_000_000;
// JPEG の先頭 (FF D8 FF E0) と、適当な 4 バイト
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const JPEG_BASE64 = Buffer.from(JPEG_BYTES).toString('base64');

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  // 以前の実装が使っていた fetch が呼ばれないことを確かめるため、呼ばれたら失敗させる
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('fetch は使わない');
  });

  mockReadAsStringAsync.mockResolvedValue(JPEG_BASE64);
  mockFrom.mockReturnValue({ upload: mockUpload, getPublicUrl: mockGetPublicUrl });
  mockUpload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
  mockGetPublicUrl.mockImplementation((path: string) => ({
    data: { publicUrl: `https://storage.example/fridge-images/${path}` },
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

function uploadedBody(): ArrayBuffer {
  return mockUpload.mock.calls[0][1] as ArrayBuffer;
}

describe('uploadFridgePhoto — 中身を確実に送る', () => {
  it('ファイルを base64 で読み、ArrayBuffer として upload に渡す (Blob や fetch は使わない)', async () => {
    await uploadFridgePhoto('file:///var/mobile/ImagePicker/abc.jpg', 'user-1');

    expect(mockReadAsStringAsync).toHaveBeenCalledWith('file:///var/mobile/ImagePicker/abc.jpg', {
      encoding: 'base64',
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const body = uploadedBody();
    expect(Object.prototype.toString.call(body)).toBe('[object ArrayBuffer]');
    // 中身がそのまま届く (0 バイトにならない)
    expect(body.byteLength).toBe(JPEG_BYTES.length);
    expect(Array.from(new Uint8Array(body))).toEqual(JPEG_BYTES);
  });

  it('フォルダは自分のユーザー ID、ファイル名は時刻で、冷蔵庫写真のバケットに保存する', async () => {
    await uploadFridgePhoto('file:///tmp/abc.jpg', 'user-1');

    expect(mockFrom).toHaveBeenCalledWith('fridge-images');
    expect(mockUpload).toHaveBeenCalledWith(`user-1/${NOW}.jpg`, expect.anything(), { contentType: 'image/jpeg' });
  });

  it('保存したファイルの public URL を返す', async () => {
    const url = await uploadFridgePhoto('file:///tmp/abc.jpg', 'user-1');

    expect(mockGetPublicUrl).toHaveBeenCalledWith(`user-1/${NOW}.jpg`);
    expect(url).toBe(`https://storage.example/fridge-images/user-1/${NOW}.jpg`);
  });
});

describe('uploadFridgePhoto — 拡張子と Content-Type', () => {
  it.each([
    ['file:///tmp/a.jpg', 'jpg', 'image/jpeg'],
    ['file:///tmp/a.jpeg', 'jpg', 'image/jpeg'],
    ['file:///tmp/a.JPG', 'jpg', 'image/jpeg'],
    ['file:///tmp/a.png', 'png', 'image/png'],
    ['file:///tmp/a.PNG', 'png', 'image/png'],
    ['file:///tmp/a.webp', 'webp', 'image/webp'],
    ['file:///tmp/a.heic', 'heic', 'image/heic'],
    ['file:///tmp/a.heif', 'heif', 'image/heif'],
    ['file:///tmp/a.gif', 'gif', 'image/gif'],
  ])('%s は拡張子 %s・Content-Type %s で保存する', async (uri, ext, contentType) => {
    await uploadFridgePhoto(uri, 'user-1');

    expect(mockUpload).toHaveBeenCalledWith(`user-1/${NOW}.${ext}`, expect.anything(), { contentType });
  });

  it('jpg を image/jpg (存在しない MIME) として送らない', async () => {
    await uploadFridgePhoto('file:///tmp/a.jpg', 'user-1');

    expect(mockUpload.mock.calls[0][2]).toEqual({ contentType: 'image/jpeg' });
  });

  it.each([
    ['クエリが付いている', 'file:///tmp/a.png?width=100', 'png', 'image/png'],
    ['ハッシュが付いている', 'file:///tmp/a.png#section', 'png', 'image/png'],
    ['拡張子が無い', 'file:///tmp/ImagePicker/abc-123', 'jpg', 'image/jpeg'],
    ['拡張子が未知', 'file:///tmp/a.bin', 'jpg', 'image/jpeg'],
    ['パスの途中にだけドットがある', 'file:///tmp/v1.2/abc', 'jpg', 'image/jpeg'],
    ['ホスト名にだけドットがある content URI', 'content://media.provider/external/images/42', 'jpg', 'image/jpeg'],
  ])('%s (%s)', async (_label, uri, ext, contentType) => {
    await uploadFridgePhoto(uri, 'user-1');

    expect(mockUpload).toHaveBeenCalledWith(`user-1/${NOW}.${ext}`, expect.anything(), { contentType });
  });

  it('拡張子に使えない文字が混ざる URI でも、保存先のパスを壊さない', async () => {
    await uploadFridgePhoto('file:///tmp/a.jpg?x=../../other-user/evil.png', 'user-1');

    const path = mockUpload.mock.calls[0][0] as string;
    expect(path).toBe(`user-1/${NOW}.jpg`);
  });
});

describe('uploadFridgePhoto — 失敗の扱い', () => {
  it('空のファイルはアップロードせず、分かりやすいエラーにする', async () => {
    mockReadAsStringAsync.mockResolvedValue('');

    await expect(uploadFridgePhoto('file:///tmp/a.jpg', 'user-1')).rejects.toThrow('写真を読み込めませんでした');

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('ファイルを読めなければ、アップロードせず、分かりやすいエラーにする (元のエラーは cause に残す)', async () => {
    const original = new Error('File does not exist');
    mockReadAsStringAsync.mockRejectedValue(original);

    const error = await uploadFridgePhoto('file:///tmp/missing.jpg', 'user-1').catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('写真を読み込めませんでした');
    expect((error as Error & { cause?: unknown }).cause).toBe(original);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('base64 が壊れていても、分かりやすいエラーにする', async () => {
    mockReadAsStringAsync.mockResolvedValue('これはbase64ではない*');

    await expect(uploadFridgePhoto('file:///tmp/a.jpg', 'user-1')).rejects.toThrow('写真を読み込めませんでした');

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('Storage がエラーを返したら、そのエラーを投げる (public URL は取らない)', async () => {
    const storageError = new Error('new row violates row-level security policy');
    mockUpload.mockResolvedValue({ data: null, error: storageError });

    await expect(uploadFridgePhoto('file:///tmp/a.jpg', 'user-1')).rejects.toBe(storageError);

    expect(mockGetPublicUrl).not.toHaveBeenCalled();
  });
});

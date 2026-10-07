import { describe, it, expect } from 'vitest';
import { userScopedStoragePath } from '@/lib/storage-paths';

const USER_ID = '11111111-2222-3333-4444-555555555555';

describe('userScopedStoragePath', () => {
  it('先頭のフォルダを本人の user id にする', () => {
    expect(userScopedStoragePath(USER_ID, 'meals', 'a.jpg')).toBe(`${USER_ID}/meals/a.jpg`);
  });

  it('用途のフォルダが無くてもファイル名だけで組み立てられる', () => {
    expect(userScopedStoragePath(USER_ID, 'a.jpg')).toBe(`${USER_ID}/a.jpg`);
  });

  it('各要素の前後のスラッシュは取り除き、空の要素は飛ばす', () => {
    expect(userScopedStoragePath(USER_ID, '/meals/', '', 'a.jpg')).toBe(`${USER_ID}/meals/a.jpg`);
  });

  it('user id が空なら例外', () => {
    expect(() => userScopedStoragePath('', 'a.jpg')).toThrow('userId is required');
  });

  it('ファイル名が無ければ例外', () => {
    expect(() => userScopedStoragePath(USER_ID)).toThrow('file name is required');
    expect(() => userScopedStoragePath(USER_ID, '/', '')).toThrow('file name is required');
  });
});

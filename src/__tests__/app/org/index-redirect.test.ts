// src/__tests__/app/org/index-redirect.test.ts
// #1143: /org が「編集機能は準備中」と表示する旧スタブ画面 ((main)/org/page.tsx) のままだった問題の回帰防止。
//  - /org は組織のダッシュボード (/org/dashboard) へ redirect する
//  - 送り先の画面があること
// /org を返す page.tsx が 1 つだけであること (ルートグループをまたいだ URL の重なりが無いこと) は
// ../route-uniqueness.test.ts で確かめる。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// next/navigation の redirect は NEXT_REDIRECT を throw して描画を打ち切る。その動きを模す
const redirectMock = vi.hoisted(() =>
  vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import OrgIndexPage from '@/app/(org)/org/page';

const ORG_DIR = path.resolve(__dirname, '../../../app/(org)/org');

describe('/org の入口 ((org)/org/page.tsx) (#1143)', () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it('/org/dashboard へ redirect する', () => {
    expect(() => OrgIndexPage()).toThrow('NEXT_REDIRECT:/org/dashboard');
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith('/org/dashboard');
  });

  it('送り先の /org/dashboard の画面がある (redirect 先が 404 にならない)', () => {
    expect(fs.existsSync(path.join(ORG_DIR, 'dashboard', 'page.tsx'))).toBe(true);
  });
});

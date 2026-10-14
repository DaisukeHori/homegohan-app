// src/__tests__/app/super-admin/index-redirect.test.ts
// /super-admin に page.tsx が無く、管理画面の「super_admin コンソール」リンクとロール切り替えが 404 になっていた問題の回帰防止。
//  - /super-admin はプラン管理 (/super-admin/plans) へ redirect する
//  - 送り先の画面があること
//  - /super-admin を指すリンクが残っていること (リンクを消して 404 を隠したのではないこと)

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

import SuperAdminIndexPage from '@/app/super-admin/page';

const APP_DIR = path.resolve(__dirname, '../../../app');

describe('/super-admin の入口 (super-admin/page.tsx)', () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it('/super-admin/plans へ redirect する', () => {
    expect(() => SuperAdminIndexPage()).toThrow('NEXT_REDIRECT:/super-admin/plans');
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith('/super-admin/plans');
  });

  it('送り先の /super-admin/plans の画面がある (redirect 先が 404 にならない)', () => {
    expect(fs.existsSync(path.join(APP_DIR, 'super-admin', 'plans', 'page.tsx'))).toBe(true);
  });

  it('管理画面とロール切り替えのリンクは /super-admin を指している (この入口を使う)', () => {
    const adminLayout = fs.readFileSync(path.join(APP_DIR, 'admin', 'layout.tsx'), 'utf8');
    const mainLayout = fs.readFileSync(path.join(APP_DIR, '(main)', 'MainLayout.tsx'), 'utf8');
    expect(adminLayout).toMatch(/href="\/super-admin"/);
    expect(mainLayout).toMatch(/href: "\/super-admin"/);
  });
});

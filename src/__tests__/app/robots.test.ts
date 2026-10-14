// src/__tests__/app/robots.test.ts
// #1194 /robots.txt は、サイトの URL (NEXT_PUBLIC_APP_URL。src/lib/site-config.ts) から作る。
// 以前は public/robots.txt に Sitemap の URL (ドメイン) を直書きしていて、サイトの URL を変えても古いまま残った。
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import robots from '@/app/robots';
import { DEFAULT_SITE_URL } from '@/lib/site-config';

const ROOT = path.resolve(__dirname, '../../..');

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('robots (/robots.txt)', () => {
  it('サイトマップの場所は、サイトの URL (NEXT_PUBLIC_APP_URL) を基点にする', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://homegohan.com');
    expect(robots().sitemap).toBe('https://homegohan.com/sitemap.xml');
  });

  it('環境変数が未設定なら、サイトの URL の既定値を基点にする', () => {
    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}/sitemap.xml`);
  });

  it('末尾に / が付いた設定でも、// にならない', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://homegohan.com/');
    expect(robots().sitemap).toBe('https://homegohan.com/sitemap.xml');
  });

  it('規則は以前の public/robots.txt と同じ: 全クローラーに許可し、/api/ と /admin/ は禁止する', () => {
    expect(robots().rules).toEqual({
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/admin/'],
    });
  });

  it('public/robots.txt を置かない (置くと同じパスのルートと衝突して next build が失敗する)', () => {
    expect(fs.existsSync(path.join(ROOT, 'public/robots.txt'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/app/robots.ts'))).toBe(true);
  });
});

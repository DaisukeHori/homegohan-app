// @vitest-environment node
/**
 * #1769: 週間献立 (/menus/weekly) の祝日の取得の URL は、CSP の connect-src と同じ定数 (HOLIDAYS_API_ORIGIN) から作る。
 * 以前は page.tsx に URL を文字どおりに書いていて、connect-src に無いオリジンだったのでブラウザに止められ、祝日が出なかった。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { japaneseHolidaysUrl } from '@/app/(main)/menus/weekly/_state/japaneseHolidays';
import { HOLIDAYS_API_ORIGIN, buildContentSecurityPolicy, cspDirectivesOf } from '@/lib/security/csp';

const ROOT = path.resolve(__dirname, '../../../../../..');
const WEEKLY_PAGE_FILE = 'src/app/(main)/menus/weekly/page.tsx';
const CSP_SOURCE_FILE = 'src/lib/security/csp.ts';
/** 祝日の API のホスト (文字どおりに書いてよいのは CSP_SOURCE_FILE だけ) */
const HOLIDAYS_API_HOST = 'holidays-jp.github.io';
/** URL を組み立てる見本の年 */
const SAMPLE_YEAR = 2026;
/** 見本の nonce (base64) */
const SAMPLE_NONCE = 'dGVzdG5vbmNlMTIzNDU2Nzg=';

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...listSourceFiles(relPath));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(relPath);
    }
  }
  return out;
}

describe('japaneseHolidaysUrl (#1769)', () => {
  it('その年の date.json の URL を HOLIDAYS_API_ORIGIN から作る', () => {
    const url = japaneseHolidaysUrl(SAMPLE_YEAR);

    expect(url).toBe(`${HOLIDAYS_API_ORIGIN}/api/v1/${SAMPLE_YEAR}/date.json`);
    expect(url).toBe('https://holidays-jp.github.io/api/v1/2026/date.json');
    expect(new URL(url).origin).toBe(HOLIDAYS_API_ORIGIN);
  });

  it('作った URL のオリジンは、本番の CSP の connect-src に入っている (ブラウザに止められない)', () => {
    const policy = buildContentSecurityPolicy({
      nonce: SAMPLE_NONCE,
      isDev: false,
      supabaseUrl: 'https://flmeolcfutuwwbjmzyoz.supabase.co',
    });

    expect(cspDirectivesOf(policy).get('connect-src')).toContain(new URL(japaneseHolidaysUrl(SAMPLE_YEAR)).origin);
  });

  it('週間献立のページは japaneseHolidaysUrl で祝日を fetch し、URL を文字どおりに書かない', () => {
    const page = fs.readFileSync(path.join(ROOT, WEEKLY_PAGE_FILE), 'utf8');

    expect(page).toMatch(/await fetch\(japaneseHolidaysUrl\(year\)\)/);
    expect(page).not.toContain(HOLIDAYS_API_HOST);
  });

  it('祝日の API のホストを文字どおりに書くのは src/lib/security/csp.ts の 1 か所だけ (2 か所の値がずれない)', () => {
    const filesWithHost = listSourceFiles('src').filter((file) =>
      fs.readFileSync(path.join(ROOT, file), 'utf8').includes(HOLIDAYS_API_HOST),
    );

    expect(filesWithHost).toEqual([CSP_SOURCE_FILE]);
  });
});

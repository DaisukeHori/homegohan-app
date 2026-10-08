import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POSTHOG_DEFAULT_HOST } from '@homegohan/shared';

// #1197 PostHog の既定ホストは packages/shared の POSTHOG_DEFAULT_HOST が唯一の定義元。
// Web (src/lib/posthog.ts) とモバイル (apps/mobile/src/lib/posthog.ts) はそれを import する。
// 素の Node ESM である next.config.mjs は TypeScript を import できないので、CSP (connect-src) に使う
// 既定のリテラルだけが残る。設定例の .env.example にも同じ値が書いてある。
// ここでは、その 2 つのリテラルが共通の定数と一致していることと、
// コード側に同じ文字列がまた増えていないことを確かめる (ホストを変えたのに直し忘れると落ちる)。

const ROOT = path.resolve(__dirname, '../../..');
const read = (relativePath: string) => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PostHog の既定ホスト: 共通の定数 (packages/shared)', () => {
  it('https の URL で、パスや末尾のスラッシュを含まない (CSP の connect-src にそのまま書ける形)', () => {
    expect(POSTHOG_DEFAULT_HOST).toMatch(/^https:\/\/[a-z0-9.-]+$/);
  });
});

describe('PostHog の既定ホスト: 素のリテラルが残る場所は共通の定数と同じ', () => {
  it('next.config.mjs の `NEXT_PUBLIC_POSTHOG_HOST ?? <既定>` のリテラルが、共通の定数と同じ', () => {
    const match = read('next.config.mjs').match(/process\.env\.NEXT_PUBLIC_POSTHOG_HOST\s*\?\?\s*(['"`])([^'"`]+)\1/);

    expect(
      match,
      'next.config.mjs に `process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "<既定ホスト>"` が見つからない。' +
        '書き方を変えたなら、このテストの正規表現も合わせること',
    ).not.toBeNull();
    expect(match![2]).toBe(POSTHOG_DEFAULT_HOST);
  });

  it('環境変数が未設定のとき、next.config.mjs の CSP は共通の既定ホストへの接続を許可する', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', undefined);
    vi.resetModules();
    // next.config.mjs は import 時に process.env を読むので、クエリ文字列を付けてフレッシュに評価する
    const mod = await import(/* @vite-ignore */ `../../../next.config.mjs?t=${Date.now()}-${Math.random()}`);

    const headerGroups = await mod.default.headers();
    const securityGroup = headerGroups.find((group: any) => group.source === '/(.*)');
    const csp = securityGroup.headers.find((header: any) => header.key === 'Content-Security-Policy').value as string;
    const connectSrc = csp.split('; ').find((directive) => directive.startsWith('connect-src')) ?? '';

    expect(connectSrc.split(' ')).toContain(POSTHOG_DEFAULT_HOST);
  });

  it('.env.example の NEXT_PUBLIC_POSTHOG_HOST の例が、共通の定数と同じ', () => {
    const match = read('.env.example').match(/^NEXT_PUBLIC_POSTHOG_HOST=(\S*)\s*$/m);

    expect(match, '.env.example に NEXT_PUBLIC_POSTHOG_HOST= の行が見つからない').not.toBeNull();
    expect(match![1]).toBe(POSTHOG_DEFAULT_HOST);
  });
});

describe('PostHog の既定ホスト: コード側にリテラルを増やさない', () => {
  const SCAN_DIRS = ['src', 'apps/mobile/src', 'apps/mobile/app'];

  function collectSourceFiles(dir: string): string[] {
    const absolute = path.join(ROOT, dir);
    if (!fs.existsSync(absolute)) return [];
    const files: string[] = [];
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        files.push(...collectSourceFiles(relative));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
        files.push(relative);
      }
    }
    return files;
  }

  const files = SCAN_DIRS.flatMap(collectSourceFiles);
  // 文字列リテラルとして書かれた既定ホスト (コメントの中の言及は対象にしない)
  const quotedHosts = ["'", '"', '`'].map((quote) => `${quote}${POSTHOG_DEFAULT_HOST}${quote}`);

  it('走査が機能している: Web とモバイルの PostHog 初期化のファイルを読んでいる', () => {
    expect(files).toEqual(expect.arrayContaining(['src/lib/posthog.ts', 'apps/mobile/src/lib/posthog.ts']));
  });

  it('Web / モバイルのコードは既定ホストを文字列で持たず、packages/shared の POSTHOG_DEFAULT_HOST を import する', () => {
    const offenders = files.filter((file) => {
      const source = read(file);
      return quotedHosts.some((literal) => source.includes(literal));
    });

    expect(
      offenders,
      `PostHog の既定ホストは "import { POSTHOG_DEFAULT_HOST } from '@homegohan/shared'" で使うこと: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it.each(['src/lib/posthog.ts', 'apps/mobile/src/lib/posthog.ts'])('%s は共通の定数を import して使っている', (file) => {
    const source = read(file);

    expect(source).toMatch(/import\s*\{[^}]*\bPOSTHOG_DEFAULT_HOST\b[^}]*\}\s*from\s*'@homegohan\/shared'/);
    // import のほかに、少なくとも 1 か所で使っている
    expect(source.match(/\bPOSTHOG_DEFAULT_HOST\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

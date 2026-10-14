/**
 * #1049 F7-14: アプリ内の画面遷移の行き先が、実在する画面 (apps/mobile/app/ のファイル) であることを確かめる。
 *
 * ハンズオンツアーの未ログイン時の遷移先が、存在しない '/(auth)/sign-in' になっていて、
 * 「Unmatched Route」の画面が出ていた (正しくは app/(auth)/login.tsx = '/login')。
 * 同じ取り違えが他に入らないよう、ソース (app/ と src/) に書かれた行き先を全部拾って、画面のファイルと突き合わせる。
 *
 * 拾う書き方: router.push / replace / navigate (と useRouter() の戻り値の同名のメソッド) の第 1 引数、
 * { pathname: ... }、href= / homeHref= の、'/' で始まる文字列 (テンプレート文字列の ${...} は 1 区間の任意の値として扱う)。
 * 行き先の中の (group) は、その group の中の画面であることも確かめる。
 */

import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(MOBILE_ROOT, 'app');
const SOURCE_DIRS = [APP_DIR, path.join(MOBILE_ROOT, 'src')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** テンプレート文字列の ${...} を置き換える印 (動的な区間 [id] にだけ一致する) */
const DYNAMIC_VALUE = '\u0000dynamic\u0000';

/**
 * 画面が無いことが分かっていて、別に扱う行き先 (行き先 → 理由)。ここに足すのは、直すのに画面を新しく作るなど、
 * この確認の範囲を超えるものだけ。直したら消す (使われていない行が残っていると、下のテストが落ちる)。
 */
const KNOWN_MISSING_TARGETS: Record<string, string> = {
  // 健康診断の一覧の各行のタップ。モバイルに詳細画面 (app/health/checkups/[id].tsx) が無い (Web にはある)。
  // 詳細画面を作るか、タップをやめるかの判断が要るので、#1049 の範囲外として報告した
  [`/health/checkups/${DYNAMIC_VALUE}`]: 'モバイルに健康診断の詳細画面が無い (#1049 の範囲外として報告済み)',
};

type RouteFile = { groups: string[]; segments: string[] };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const isGroup = (segment: string) => /^\(.+\)$/.test(segment);
const isDynamic = (segment: string) => /^\[.+\]$/.test(segment);

/** app/ の画面ファイルを、URL の区間 (group と index を除く) と、属する group に分ける。_layout と +html などは画面ではない */
function collectRoutes(): RouteFile[] {
  return walk(APP_DIR)
    .map((file) => path.relative(APP_DIR, file).replace(/\.tsx?$/, '').split(path.sep))
    .filter((parts) => {
      const name = parts[parts.length - 1];
      return !name.startsWith('_') && !name.startsWith('+');
    })
    .map((parts) => {
      const withoutIndex = parts[parts.length - 1] === 'index' ? parts.slice(0, -1) : parts;
      return {
        groups: withoutIndex.filter(isGroup),
        segments: withoutIndex.filter((segment) => !isGroup(segment)),
      };
    });
}

function routeExists(routes: RouteFile[], target: string): boolean {
  const pathname = target.split('?')[0].replace(/\/+$/, '');
  const parts = pathname.split('/').filter(Boolean);
  const groups = parts.filter(isGroup);
  const segments = parts.filter((segment) => !isGroup(segment));
  return routes.some(
    (route) =>
      groups.every((group) => route.groups.includes(group)) &&
      route.segments.length === segments.length &&
      route.segments.every((segment, index) =>
        isDynamic(segment) ? segments[index] !== '' : segment === segments[index],
      ),
  );
}

/** ソースから行き先を拾う。返すのは { file, target } (target の ${...} は DYNAMIC_VALUE) */
function collectTargets(): { file: string; target: string }[] {
  // 'xxx' / "xxx" / `xxx` の、'/' で始まる文字列
  const literal = String.raw`(?:'(\/[^'\n]*)'|"(\/[^"\n]*)"|\x60(\/[^\x60\n]*)\x60)`;
  const patterns = [
    new RegExp(String.raw`\b(?:push|replace|navigate)\(\s*${literal}`, 'g'),
    new RegExp(String.raw`\bpathname:\s*${literal}`, 'g'),
    new RegExp(String.raw`\b(?:href|homeHref)=\{?\s*${literal}`, 'g'),
  ];
  const results: { file: string; target: string }[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(dir)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const raw = match[1] ?? match[2] ?? match[3];
          // ${...} の後ろに文字が続く区間 (`/x/${a}-${b}` など) も 1 区間の任意の値として扱う
          const target = raw.replace(/\$\{[^}]*\}/g, DYNAMIC_VALUE).replace(new RegExp(`[^/]*${DYNAMIC_VALUE}[^/]*`, 'g'), DYNAMIC_VALUE);
          results.push({ file: path.relative(MOBILE_ROOT, file), target });
        }
      }
    }
  }
  return results;
}

describe('アプリ内の画面遷移の行き先が実在する (#1049 F7-14)', () => {
  const routes = collectRoutes();
  const targets = collectTargets();

  it('行き先を拾えている (拾い方が壊れて 0 件で通らないように)', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(targets.length).toBeGreaterThan(50);
    expect(targets.map((t) => t.target)).toContain('/login');
  });

  it('拾った行き先が、すべて app/ の画面に当たる (既知の例外を除く)', () => {
    const missing = targets
      .filter(({ target }) => !(target in KNOWN_MISSING_TARGETS))
      .filter(({ target }) => !routeExists(routes, target))
      .map(({ file, target }) => `${file}: ${target.replace(new RegExp(DYNAMIC_VALUE, 'g'), '${…}')}`);
    expect(missing).toEqual([]);
  });

  it('ハンズオンツアーの未ログイン時の遷移先は /login (存在しない /(auth)/sign-in ではない)', () => {
    const source = fs.readFileSync(path.join(APP_DIR, 'handson-tour/_layout.tsx'), 'utf8');
    expect(source).toMatch(/router\.replace\(\s*'\/login'\s*\)/);
    expect(source).not.toMatch(/(?:push|replace|navigate)\(\s*['"`]\/\(auth\)\/sign-in/);
    expect(routeExists(routes, '/login')).toBe(true);
    expect(routeExists(routes, '/(auth)/login')).toBe(true);
    expect(routeExists(routes, '/(auth)/sign-in')).toBe(false);
  });

  it('既知の例外の一覧に、もう使われていない行・実在する画面の行が残っていない', () => {
    const used = new Set(targets.map((t) => t.target));
    for (const target of Object.keys(KNOWN_MISSING_TARGETS)) {
      expect(used.has(target)).toBe(true);
      expect(routeExists(routes, target)).toBe(false);
    }
  });
});

/**
 * #1049 F7-14: アプリ内の画面遷移の行き先が、実在する画面 (apps/mobile/app/ のファイル) であることを確かめる。
 *
 * ハンズオンツアーの未ログイン時の遷移先が、存在しない '/(auth)/sign-in' になっていて、
 * 「Unmatched Route」の画面が出ていた (正しくは app/(auth)/login.tsx = '/login')。
 * 同じ取り違えが他に入らないよう、ソース (app/ と src/) に書かれた行き先を全部拾って、画面のファイルと突き合わせる。
 *
 * 拾う書き方: router.push / replace / navigate / dismissTo (と useRouter() の戻り値の同名のメソッド) の第 1 引数、
 * { pathname: ... }、href= / homeHref= (JSX) と、行き先の一覧の { href: ... } / { route: ... } の、'/' で始まる文字列
 * (テンプレート文字列の ${...} は 1 区間の任意の値として扱う)。行き先の中の (group) は、その group の中の画面であることも確かめる。
 *
 * 例外の一覧は持たない (#1049 の整合ゲート)。以前は「画面が無いことが分かっている行き先」の一覧 (KNOWN_MISSING_TARGETS) があり、
 * 健康診断の一覧の行のタップ ('/health/checkups/${id}') がそこに載っていたため、詳細の画面が無いまま、この確認を通っていた。
 * 画面の無い行き先は、画面を作るか遷移をやめて直す。
 */

import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const APP_DIR = path.join(MOBILE_ROOT, 'app');
const SOURCE_DIRS = [APP_DIR, path.join(MOBILE_ROOT, 'src')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** テンプレート文字列の ${...} を置き換える印 (動的な区間 [id] にだけ一致する) */
const DYNAMIC_VALUE = '\u0000dynamic\u0000';

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

/** 1 つのソースから行き先を拾う (target の ${...} は DYNAMIC_VALUE) */
function targetsInSource(source: string): string[] {
  // 'xxx' / "xxx" / `xxx` の、'/' で始まる文字列
  const literal = String.raw`(?:'(\/[^'\n]*)'|"(\/[^"\n]*)"|\x60(\/[^\x60\n]*)\x60)`;
  const patterns = [
    new RegExp(String.raw`\b(?:push|replace|navigate|dismissTo)\(\s*${literal}`, 'g'),
    new RegExp(String.raw`\bpathname:\s*${literal}`, 'g'),
    new RegExp(String.raw`\b(?:href|homeHref)=\{?\s*${literal}`, 'g'),
    // 行き先の一覧 ({ href: '/x', label: ... } / { route: '/x', ... })
    new RegExp(String.raw`\b(?:href|route):\s*${literal}`, 'g'),
  ];
  const results: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1] ?? match[2] ?? match[3];
      // ${...} の後ろに文字が続く区間 (`/x/${a}-${b}` など) も 1 区間の任意の値として扱う
      results.push(raw.replace(/\$\{[^}]*\}/g, DYNAMIC_VALUE).replace(new RegExp(`[^/]*${DYNAMIC_VALUE}[^/]*`, 'g'), DYNAMIC_VALUE));
    }
  }
  return results;
}

/** ソース (app/ と src/) から行き先を拾う。返すのは { file, target } */
function collectTargets(): { file: string; target: string }[] {
  const results: { file: string; target: string }[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(dir)) {
      for (const target of targetsInSource(fs.readFileSync(file, 'utf8'))) {
        results.push({ file: path.relative(MOBILE_ROOT, file), target });
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

  it('拾った行き先が、すべて app/ の画面に当たる (例外なし)', () => {
    const missing = targets
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

  it('健康診断の一覧の行のタップは、実在する詳細の画面 (app/health/checkups/[id].tsx) を開く (#1049)', () => {
    const listTargets = targets.filter((t) => t.file === path.join('app', 'health', 'checkups', 'index.tsx')).map((t) => t.target);
    expect(listTargets).toContain(`/health/checkups/${DYNAMIC_VALUE}`);
    expect(fs.existsSync(path.join(APP_DIR, 'health', 'checkups', '[id].tsx'))).toBe(true);
    expect(routeExists(routes, `/health/checkups/${DYNAMIC_VALUE}`)).toBe(true);
    // 登録の画面 (new.tsx) も残っている (expo-router は静的な区間 'new' を動的な区間 [id] より先に当てる)
    expect(routeExists(routes, '/health/checkups/new')).toBe(true);
  });

  it('このテストは例外の一覧を持たない (画面の無い行き先を、一覧に載せて通さない)', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    // 以前の例外の一覧の宣言 (const <名前>: Record<string, string> = { 行き先: 理由 })。説明のコメントにある名前には当たらない
    const exceptionTable = new RegExp(String.raw`const\s+${['KNOWN', 'MISSING', 'TARGETS'].join('_')}\b`);
    expect(source).not.toMatch(exceptionTable);
    expect(source).not.toMatch(/const\s+\w+\s*:\s*Record<string,\s*string>\s*=/);
  });
});

describe('行き先の拾い方 (#1049)', () => {
  it.each([
    ['router.push', "router.push('/a/b')", '/a/b'],
    ['as any を付けたテンプレート文字列', 'router.push(`/health/checkups/${checkup.id}` as any)', `/health/checkups/${DYNAMIC_VALUE}`],
    ['replace', 'router.replace("/login")', '/login'],
    ['dismissTo', "router.dismissTo('/home')", '/home'],
    ['pathname', "router.push({ pathname: '/x/y', params: { id } })", '/x/y'],
    ['JSX の href', '<Link href="/about">', '/about'],
    ['JSX の href={...}', '<Redirect href={`/u/${id}`} />', `/u/${DYNAMIC_VALUE}`],
    ['行き先の一覧の href:', '{ href: "/health/record" as const, label: "x" }', '/health/record'],
    ['行き先の一覧の route:', "{ label: 'メンバー', route: '/org/members' }", '/org/members'],
  ])('%s', (_name, source, expected) => {
    expect(targetsInSource(source)).toEqual([expected]);
  });

  it('画面の無い行き先は、routeExists が false を返す (確認が空振りしない)', () => {
    const routes = collectRoutes();
    expect(routeExists(routes, `/health/checkups/${DYNAMIC_VALUE}/edit`)).toBe(false);
    expect(routeExists(routes, '/no-such-screen')).toBe(false);
  });
});

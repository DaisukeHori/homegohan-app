/**
 * アプリ (apps/mobile) のバンドルが読むファイルが、EAS のビルドのアーカイブから落ちていないことの検査 (#1154 の整合ゲートの指摘)
 *
 * EAS のビルドは、リポジトリ直下の .easignore で除外したファイルを送らない (クラウドでは、送ったファイルだけで Metro がバンドルする)。
 * アプリのソースは apps/mobile の外 (packages/*、ルートの types/・lib/、supabase/functions/_shared/ など) も import しているので、
 * .easignore でそのファイルを除外すると EAS のビルドだけが「モジュールが見つからない」で落ちる。
 * jest とローカルの Metro (watchFolders にリポジトリのルートが入っている) は手元の全ファイルを読むので通ってしまい、気づけない。
 * 実例: .easignore の `src/` が apps/mobile/src まで除外していた (#774)。
 * apps/mobile/src/lib/ai-consent.ts が supabase/functions/_shared/ai-consent.ts を import したのに、.easignore が `/supabase/` を除外していた (#1154)。
 *
 * このテストは次を確かめる。
 *   1. apps/mobile の app/ と src/ (テストを除く) から import を構文木で辿り (推移的に)、バンドルが読みうるファイルを全部集める。
 *      辿るのは相対パスの import と、apps/mobile/tsconfig.json の paths の別名 (Metro も読む)、ワークスペースのパッケージ (@homegohan/*)。
 *      それ以外の名前 (react-native など) は node_modules のパッケージとして辿らない (EAS が install する)。
 *      `import type` も辿る (実行時には消えるが、型だけの import が除外されたファイルを指していても害が無いとは言い切らず、広めに見る)
 *   2. 集めたファイルのどれも、.easignore で除外されない。判定は EAS (eas-cli の makeShallowCopyAsync) と同じく、
 *      「ルートからそのファイルまでの各ディレクトリ (末尾の / を付けない名前) と、ファイルそのもの」のどれかが除外の規則に当たれば除外とみなす。
 *      eas-cli はディレクトリを末尾の / なしの名前で ignore パッケージに問い、当たればその下へ降りない。
 *      このため、否定の規則を `!/supabase/functions/` のように末尾の / 付きで書くと、ディレクトリそのものには当たらず
 *      (`/supabase/*` で除外されたまま) 下のファイルを残せない。
 *      規則の照合は gitignore の規則 (`git check-ignore --no-index`) で行う。ignore パッケージはこのリポジトリの直接の依存に無いので使わない。
 *      ファイルを置かない一時の git リポジトリで照合するので、問うた名前はすべて「ディレクトリでない名前」として照合され、上の eas-cli の問い方と揃う
 *   3. 1 の集め方が、外を指す既知の import (supabase/functions/_shared/ai-consent.ts・types/domain.ts・lib/slot-builder.ts・packages/shared) を
 *      取りこぼしていない (集め方が壊れて空振りしていないことの番兵)
 *   4. 2 の判定が、除外の規則を足したときに実際に赤になる (判定が空振りしていないことの番兵)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MOBILE_DIR = path.join(ROOT, 'apps/mobile');
const EASIGNORE_PATH = path.join(ROOT, '.easignore');
/** EAS がバンドルの入口として読むソースの置き場 (expo-router の app/ と、その下で使う src/)。 */
const MOBILE_ENTRY_DIRS = ['apps/mobile/app', 'apps/mobile/src'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
/** Metro (Expo の既定) が拡張子なしの import を解決するときに試す拡張子 (ソース + JSON)。 */
const RESOLVE_EXTENSIONS = [...SOURCE_EXTENSIONS, '.json'];
/**
 * Metro が拡張子の前に試すプラットフォームの接尾辞。iOS は .ios → .native → なし、Android は .android → .native → なしの順。
 * どちらのビルドも EAS で行うので、両方の解決先を辿る。
 */
const PLATFORM_RESOLUTION_ORDERS = [
  ['.ios', '.native', ''],
  ['.android', '.native', ''],
];
/** ワークスペースのパッケージの置き場 (ルートの package.json の workspaces と同じ)。 */
const WORKSPACE_PACKAGE_DIRS = ['packages', 'apps'];

type Edge = { from: string; specifier: string };

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function rel(abs: string): string {
  return toPosix(path.relative(ROOT, abs));
}

function isTestFile(abs: string): boolean {
  const r = toPosix(abs);
  return /\/(__tests__|__mocks__)\//.test(r) || /\.(test|spec)\.[jt]sx?$/.test(r);
}

function listSourceFiles(dirAbs: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(abs));
    } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      if (!isTestFile(abs)) out.push(abs);
    }
  }
  return out;
}

/** 構文木から、モジュールの指定子 (import / export from / require / import()) を全部集める。`import type` も含める (先頭のコメント参照)。 */
function collectSpecifiers(abs: string): string[] {
  const text = fs.readFileSync(abs, 'utf8');
  // .ts は型の断言 (<T>x) があるので TSX として読まない。JS は JSX を含みうるので JSX として読む (Expo は .js の JSX も通す)
  const ext = path.extname(abs);
  const kind = ext === '.ts' ? ts.ScriptKind.TS : ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

function isFile(abs: string): boolean {
  return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

/**
 * Metro と同じ順で、パス (拡張子なしのこともある) をファイルに解決する。iOS と Android で解決先が違いうるので、両方の解決先を返す。
 * 見つからなければ空の配列。
 */
function resolveFilePaths(baseAbs: string): string[] {
  if (isFile(baseAbs)) return [baseAbs];
  const found = new Set<string>();
  for (const order of PLATFORM_RESOLUTION_ORDERS) {
    const hit = order.flatMap((platform) => RESOLVE_EXTENSIONS.map((ext) => baseAbs + platform + ext)).find(isFile);
    if (hit) found.add(hit);
  }
  if (found.size > 0) return [...found];
  if (fs.existsSync(baseAbs) && fs.statSync(baseAbs).isDirectory()) {
    const entry = fs.existsSync(path.join(baseAbs, 'package.json')) ? packageEntry(baseAbs) : null;
    if (entry) return resolveFilePaths(entry);
    return resolveFilePaths(path.join(baseAbs, 'index'));
  }
  return [];
}

function packageEntry(pkgDirAbs: string): string | null {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDirAbs, 'package.json'), 'utf8')) as {
    main?: string;
    exports?: unknown;
  };
  const exp = pkg.exports;
  if (typeof exp === 'string') return path.join(pkgDirAbs, exp);
  if (exp && typeof exp === 'object' && '.' in exp) {
    const dot = (exp as Record<string, unknown>)['.'];
    if (typeof dot === 'string') return path.join(pkgDirAbs, dot);
  }
  if (pkg.main) return path.join(pkgDirAbs, pkg.main);
  return null;
}

type PathAlias = { prefix: string; wildcard: boolean; targets: string[] };

/** apps/mobile/tsconfig.json の paths (Expo の Metro も読む別名)。末尾が .d.ts の別名は Metro が無視するので除く (tsconfig のコメント参照)。 */
function loadMobilePathAliases(): PathAlias[] {
  const tsconfigPath = path.join(MOBILE_DIR, 'tsconfig.json');
  const read = ts.readConfigFile(tsconfigPath, (p) => fs.readFileSync(p, 'utf8'));
  if (read.error) throw new Error(`apps/mobile/tsconfig.json を読めない: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
  const config = read.config as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  const baseDir = path.resolve(MOBILE_DIR, config.compilerOptions?.baseUrl ?? '.');
  const aliases: PathAlias[] = [];
  for (const [key, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
    const runtimeTargets = targets.filter((t) => !t.endsWith('.d.ts')).map((t) => path.resolve(baseDir, t));
    if (runtimeTargets.length === 0) continue;
    const wildcard = key.endsWith('*');
    aliases.push({ prefix: wildcard ? key.slice(0, -1) : key, wildcard, targets: runtimeTargets });
  }
  return aliases;
}

/** ワークスペースのパッケージ名 → ディレクトリ。 */
function loadWorkspacePackages(): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of WORKSPACE_PACKAGE_DIRS) {
    const abs = path.join(ROOT, dir);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgJson = path.join(abs, entry.name, 'package.json');
      if (!fs.existsSync(pkgJson)) continue;
      const name = (JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { name?: string }).name;
      if (name) map.set(name, path.join(abs, entry.name));
    }
  }
  return map;
}

type Resolution = { kind: 'files'; abs: string[] } | { kind: 'external' } | { kind: 'unresolved' };

function toResolution(abs: string[]): Resolution {
  return abs.length > 0 ? { kind: 'files', abs } : { kind: 'unresolved' };
}

function makeResolver(aliases: PathAlias[], workspace: Map<string, string>) {
  // tsconfig の paths は、長い (具体的な) 別名を先に当てる
  const sorted = [...aliases].sort((a, b) => b.prefix.length - a.prefix.length);
  return (fromAbs: string, specifier: string): Resolution => {
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      return toResolution(resolveFilePaths(path.resolve(path.dirname(fromAbs), specifier)));
    }
    for (const alias of sorted) {
      const matches = alias.wildcard ? specifier.startsWith(alias.prefix) : specifier === alias.prefix;
      if (!matches) continue;
      const rest = alias.wildcard ? specifier.slice(alias.prefix.length) : '';
      for (const target of alias.targets) {
        const abs = resolveFilePaths(alias.wildcard ? target.replace('*', rest) : target);
        if (abs.length > 0) return { kind: 'files', abs };
      }
      return { kind: 'unresolved' };
    }
    const parts = specifier.split('/');
    const pkgName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const pkgDir = workspace.get(pkgName);
    if (pkgDir) {
      const subpath = specifier.slice(pkgName.length);
      return toResolution(resolveFilePaths(subpath ? path.join(pkgDir, subpath) : pkgDir));
    }
    return { kind: 'external' };
  };
}

type Closure = { files: Set<string>; unresolved: Edge[] };

/** apps/mobile の app/ と src/ から import を推移的に辿り、読みうるファイル (リポジトリのルートからの相対パス) を全部集める。 */
function collectMobileBundleInputs(): Closure {
  const resolve = makeResolver(loadMobilePathAliases(), loadWorkspacePackages());
  const files = new Set<string>();
  const unresolved: Edge[] = [];
  const queue: string[] = MOBILE_ENTRY_DIRS.flatMap((d) => listSourceFiles(path.join(ROOT, d)));
  while (queue.length > 0) {
    const abs = queue.pop();
    if (abs === undefined) break;
    const r = rel(abs);
    if (files.has(r)) continue;
    files.add(r);
    if (!SOURCE_EXTENSIONS.includes(path.extname(abs)) || abs.endsWith('.d.ts')) continue;
    for (const specifier of collectSpecifiers(abs)) {
      const res = resolve(abs, specifier);
      if (res.kind === 'files') queue.push(...res.abs);
      else if (res.kind === 'unresolved') unresolved.push({ from: r, specifier });
    }
  }
  return { files, unresolved };
}

/** ルートからそのファイルまでの各ディレクトリ (末尾の / なし) と、ファイルそのもの。eas-cli が ignore に問う名前の並び。 */
function pathsAskedByEasCopy(relPath: string): string[] {
  const segments = relPath.split('/');
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
}

/**
 * .easignore の規則で EAS のアーカイブから落ちるファイルを返す。
 * 規則を info/exclude に置いた、ファイルの無い一時の git リポジトリで `git check-ignore --no-index --stdin` に問う。
 * 利用者の git の設定 (グローバルの除外ファイルなど) と、外から渡された GIT_DIR などは効かせない。
 * 大文字と小文字は区別しない (eas-cli が使う ignore パッケージの既定。区別しないほうが除外が広く、検査として厳しい側)。
 * パスは NUL 区切りで渡し・受け取る (日本語などを含むパスを git が引用符で囲んで返すと、照合がずれるため)。
 */
function filesDroppedByEasignore(easignoreText: string, relPaths: string[]): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-easignore-'));
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('GIT_')) env[k] = v;
    }
    env.GIT_CONFIG_GLOBAL = os.devNull;
    env.GIT_CONFIG_NOSYSTEM = '1';
    // この一時のリポジトリでの git の実行にだけ効く設定 (環境変数で渡す。どの設定ファイルも書き換えない)
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'core.ignoreCase';
    env.GIT_CONFIG_VALUE_0 = 'true';
    execFileSync('git', ['init', '--quiet'], { cwd: tmp, env });
    fs.writeFileSync(path.join(tmp, '.git', 'info', 'exclude'), easignoreText);
    const asked = [...new Set(relPaths.flatMap(pathsAskedByEasCopy))];
    const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
      cwd: tmp,
      env,
      input: asked.map((p) => `${p}\0`).join(''),
      encoding: 'utf8',
    });
    // 終了コード 0 = どれかが除外される / 1 = どれも除外されない。それ以外は照合そのものの失敗
    if (r.status !== 0 && r.status !== 1) {
      throw new Error(`git check-ignore が失敗した (status=${String(r.status)}): ${r.stderr}`);
    }
    const ignored = new Set(r.stdout.split('\0').filter((l) => l.length > 0));
    return relPaths.filter((p) => pathsAskedByEasCopy(p).some((q) => ignored.has(q)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('apps/mobile のバンドルが読むファイルが .easignore で除外されない (#1154)', () => {
  const closure = collectMobileBundleInputs();
  const easignore = fs.readFileSync(EASIGNORE_PATH, 'utf8');
  const outside = [...closure.files].filter((f) => !f.startsWith('apps/mobile/')).sort();

  it('相対パス・別名・ワークスペースのパッケージの import はすべてファイルに解決できる (辿れない import を黙って飛ばさない)', () => {
    expect(closure.unresolved).toEqual([]);
  });

  it('apps/mobile の外を指す既知の import を辿れている (集め方の番兵)', () => {
    expect(outside).toEqual(
      expect.arrayContaining([
        'supabase/functions/_shared/ai-consent.ts',
        'types/domain.ts',
        'lib/slot-builder.ts',
        'packages/shared/src/index.ts',
        'packages/core/src/index.ts',
        'packages/handson-tour-shared/src/index.ts',
      ]),
    );
  });

  it('集めたファイルのどれも .easignore で除外されない', () => {
    const dropped = filesDroppedByEasignore(easignore, [...closure.files].sort());
    expect(
      dropped,
      'EAS のアーカイブから落ちるファイルをアプリが import している。.easignore を直すこと (否定の規則は末尾の / を付けずに書く。先頭のコメント参照)',
    ).toEqual([]);
  });

  describe('判定の番兵 (除外の規則を足すと赤になる)', () => {
    it.each([
      ['supabase/functions/_shared/ai-consent.ts を除外する', '/supabase/functions/_shared/ai-consent.ts', 'supabase/functions/_shared/ai-consent.ts'],
      ['ルートの types/ を除外する', '/types/', 'types/domain.ts'],
      ['ルートの lib/ を除外する', '/lib/', 'lib/slot-builder.ts'],
      ['packages/shared を除外する', '/packages/shared/', 'packages/shared/src/index.ts'],
      // eas-cli の ignore パッケージは大文字と小文字を区別しない
      ['大文字で書いた /Types/ も除外とみなす', '/Types/', 'types/domain.ts'],
    ])('%s', (_label, extraRule, expectedDropped) => {
      const dropped = filesDroppedByEasignore(`${easignore}\n${extraRule}\n`, outside);
      expect(dropped).toContain(expectedDropped);
    });

    it('否定の規則を末尾の / 付きで書くと、ディレクトリが除外されたままになり赤になる (eas-cli の問い方)', () => {
      const withTrailingSlash = [
        '/supabase/*',
        '!/supabase/functions/',
        '/supabase/functions/*',
        '!/supabase/functions/_shared/',
        '/supabase/functions/_shared/*',
        '!/supabase/functions/_shared/ai-consent.ts',
      ].join('\n');
      const dropped = filesDroppedByEasignore(withTrailingSlash, ['supabase/functions/_shared/ai-consent.ts']);
      expect(dropped).toEqual(['supabase/functions/_shared/ai-consent.ts']);
    });

    it('supabase/ のうち、アプリが読まないファイルは今までどおり除外される', () => {
      const dropped = filesDroppedByEasignore(easignore, [
        'supabase/migrations/20261009100000_x.sql',
        'supabase/config.toml',
        'supabase/functions/_shared/user-context.ts',
        'supabase/functions/generate-menu-v5/index.ts',
      ]);
      expect(dropped).toEqual([
        'supabase/migrations/20261009100000_x.sql',
        'supabase/config.toml',
        'supabase/functions/_shared/user-context.ts',
        'supabase/functions/generate-menu-v5/index.ts',
      ]);
    });
  });
});

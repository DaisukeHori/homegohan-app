/**
 * #1207 画面の描画中に起きた例外を受けるエラー境界 (error.tsx) のテスト
 *
 * 従来の問題:
 *   src/app に error.tsx が (main) の 1 つしか無く、(auth) (operator) (org) (support) admin super-admin
 *   onboarding handson-tour や公開ページの例外は、ルート全体を置き換える global-error.tsx まで届いていた。
 *   サイドバーやヘッダーごと画面が消え、その区画の中だけで「再試行」することもできなかった。
 *
 * 修正後:
 *   - ルートと各 route group に error.tsx を置き、共通部品 RouteError で表示と記録をそろえる
 *   - 「再試行」(reset) を出す。サーバーコンポーネントの例外にも効くよう router.refresh() も一緒に呼ぶ
 *   - 例外の文面・スタックは画面に出さない (出すのは digest だけ)。記録は URL を含めずに boundary 名で残す
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  logToServer: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock('@/lib/db-logger', () => ({
  logToServer: mocks.logToServer,
}));

const { RouteError } = await import('@/components/error/RouteError');
const { reportBoundaryError, toDisplayErrorCode } = await import('@/lib/report-boundary-error');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = process.cwd();
const APP_DIR = path.join(ROOT, 'src/app');

/** 画面に出てはいけない、例外の中身を想定した文面 (DB のエラー文・秘密情報・スタックの一部) */
const SECRET_MESSAGE =
  'relation "user_profiles" does not exist; password=hunter2 at /var/task/.next/server/app/page.js:1:2';

let container: HTMLDivElement;
let root: Root;
let consoleError: ReturnType<typeof vi.spyOn>;

function makeError(overrides: Partial<Error & { digest?: string }> = {}): Error & { digest?: string } {
  const error = new Error(SECRET_MESSAGE) as Error & { digest?: string };
  error.name = 'TypeError';
  Object.assign(error, overrides);
  return error;
}

async function mount(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

const text = () => container.textContent ?? '';
const findButton = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
const findLink = () => container.querySelector('a');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockReset();
  mocks.logToServer.mockReset();
  mocks.logToServer.mockResolvedValue(undefined);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  consoleError.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// toDisplayErrorCode
// ─────────────────────────────────────────────────────────────────────────────

describe('toDisplayErrorCode (画面に出してよいエラーコード)', () => {
  it('Next.js が付ける短い英数字の digest はそのまま返す', () => {
    expect(toDisplayErrorCode('3194257847')).toBe('3194257847');
    expect(toDisplayErrorCode('abc_DEF-9')).toBe('abc_DEF-9');
  });

  it('英数字・_・- 以外を含む値、長すぎる値、空、文字列以外は出さない', () => {
    expect(toDisplayErrorCode('<script>alert(1)</script>')).toBeUndefined();
    expect(toDisplayErrorCode('has space')).toBeUndefined();
    expect(toDisplayErrorCode('relation "x" does not exist')).toBeUndefined();
    expect(toDisplayErrorCode('a'.repeat(65))).toBeUndefined();
    expect(toDisplayErrorCode('')).toBeUndefined();
    expect(toDisplayErrorCode(undefined)).toBeUndefined();
    expect(toDisplayErrorCode(12345)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reportBoundaryError
// ─────────────────────────────────────────────────────────────────────────────

describe('reportBoundaryError (コンソールとサーバーログへの記録)', () => {
  it('コンソールに出し、logToServer(error) に boundary・種類・文面・digest を渡す', () => {
    const error = makeError({ digest: '999' });

    reportBoundaryError('org', error);

    expect(consoleError).toHaveBeenCalledWith('[ErrorBoundary:org]', error);
    expect(mocks.logToServer).toHaveBeenCalledTimes(1);
    const [level, message, metadata] = mocks.logToServer.mock.calls[0];
    expect(level).toBe('error');
    expect(message).toBe('error boundary caught: org');
    expect(metadata).toMatchObject({
      boundary: 'org',
      name: 'TypeError',
      message: SECRET_MESSAGE,
      digest: '999',
    });
    expect(typeof metadata.stack).toBe('string');
  });

  it('URL / パスは記録しない (招待 token などが URL に入るページがあるため)', () => {
    const originalPath = window.location.pathname;
    window.history.pushState({}, '', '/invite/SECRET-INVITE-TOKEN');
    try {
      reportBoundaryError('root', makeError());

      const serialized = JSON.stringify(mocks.logToServer.mock.calls[0]);
      expect(serialized).not.toContain('SECRET-INVITE-TOKEN');
      expect(Object.keys(mocks.logToServer.mock.calls[0][2])).not.toEqual(
        expect.arrayContaining(['url', 'path', 'pathname', 'href']),
      );
    } finally {
      window.history.pushState({}, '', originalPath);
    }
  });

  it('長い文面・スタックは切り詰めて渡す', () => {
    const error = makeError();
    error.message = 'm'.repeat(5000);
    error.stack = 's'.repeat(10000);

    reportBoundaryError('admin', error);

    const metadata = mocks.logToServer.mock.calls[0][2];
    expect(metadata.message.length).toBeLessThanOrEqual(501);
    expect(metadata.stack.length).toBeLessThanOrEqual(1501);
  });

  it('不審な digest は記録しない', () => {
    reportBoundaryError('admin', makeError({ digest: '<img src=x onerror=alert(1)>' }));

    expect(mocks.logToServer.mock.calls[0][2].digest).toBeUndefined();
  });

  it('Error 以外 (文字列・null・undefined) が投げられていても例外を投げない', () => {
    expect(() => reportBoundaryError('root', 'plain string thrown')).not.toThrow();
    expect(() => reportBoundaryError('root', null)).not.toThrow();
    expect(() => reportBoundaryError('root', undefined)).not.toThrow();
    expect(mocks.logToServer).toHaveBeenCalledTimes(3);
    expect(mocks.logToServer.mock.calls[0][2].message).toBe('plain string thrown');
  });

  it('logToServer が同期的に例外を投げても、拒否されても、呼び出し側には伝えない', async () => {
    mocks.logToServer.mockImplementationOnce(() => {
      throw new Error('logger exploded');
    });
    expect(() => reportBoundaryError('root', makeError())).not.toThrow();

    mocks.logToServer.mockRejectedValueOnce(new Error('network down'));
    expect(() => reportBoundaryError('root', makeError())).not.toThrow();
    // 拒否が未処理のまま残らない (unhandled rejection でテストが落ちない)
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RouteError
// ─────────────────────────────────────────────────────────────────────────────

describe('RouteError (共通のエラー画面)', () => {
  const baseProps = {
    boundary: 'org',
    backHref: '/org/dashboard',
    backLabel: 'ダッシュボードへ戻る',
  };

  it('見出し・再試行ボタン・戻るリンクを出す', async () => {
    await mount(<RouteError error={makeError()} reset={vi.fn()} {...baseProps} />);

    expect(container.querySelector('h1')?.textContent).toBe('エラーが発生しました');
    expect(findButton('再試行')).toBeTruthy();
    const link = findLink();
    expect(link?.getAttribute('href')).toBe('/org/dashboard');
    expect(link?.textContent).toBe('ダッシュボードへ戻る');
  });

  it.each([
    ['digest なし', undefined],
    ['digest あり', '3194257847'],
  ])('例外の文面・スタックは画面に出さない (%s)', async (_label, digest) => {
    const error = makeError({ digest });
    error.stack = 'TypeError: SECRET-STACK-FRAME\n    at secretFunction (/var/task/secret.js:1:1)';

    await mount(<RouteError error={error} reset={vi.fn()} {...baseProps} />);

    expect(text()).not.toContain('user_profiles');
    expect(text()).not.toContain('hunter2');
    expect(text()).not.toContain('SECRET-STACK-FRAME');
    expect(text()).not.toContain('secretFunction');
    expect(text()).not.toContain('TypeError');
    // 属性 (title / aria-label / data-*) にも入っていない
    expect(container.innerHTML).not.toContain('user_profiles');
    expect(container.innerHTML).not.toContain('hunter2');
  });

  it('安全な digest だけを「エラーコード」として出し、不審な値は出さない', async () => {
    await mount(<RouteError error={makeError({ digest: '3194257847' })} reset={vi.fn()} {...baseProps} />);
    expect(text()).toContain('エラーコード: 3194257847');

    await mount(
      <RouteError error={makeError({ digest: 'relation "user_profiles" does not exist' })} reset={vi.fn()} {...baseProps} />,
    );
    expect(text()).not.toContain('エラーコード');
    expect(text()).not.toContain('user_profiles');
  });

  it('digest が無ければ「エラーコード」の行を出さない', async () => {
    await mount(<RouteError error={makeError()} reset={vi.fn()} {...baseProps} />);

    expect(text()).not.toContain('エラーコード');
  });

  it('表示されたとき 1 回だけ記録する (boundary 名つき)', async () => {
    await mount(<RouteError error={makeError({ digest: '42' })} reset={vi.fn()} {...baseProps} />);

    expect(mocks.logToServer).toHaveBeenCalledTimes(1);
    expect(mocks.logToServer.mock.calls[0][1]).toBe('error boundary caught: org');
    expect(mocks.logToServer.mock.calls[0][2]).toMatchObject({ boundary: 'org', digest: '42' });
  });

  it('開発時の StrictMode (effect を 2 回走らせる) でも、同じ例外の記録は 1 回だけ', async () => {
    await mount(
      <StrictMode>
        <RouteError error={makeError({ digest: '42' })} reset={vi.fn()} {...baseProps} />
      </StrictMode>,
    );

    expect(mocks.logToServer).toHaveBeenCalledTimes(1);
  });

  it('再試行して別の例外が出たときは、その例外も記録する', async () => {
    const reset = vi.fn();
    await mount(<RouteError error={makeError()} reset={reset} {...baseProps} />);

    await mount(<RouteError error={makeError({ message: 'another failure' })} reset={reset} {...baseProps} />);

    expect(mocks.logToServer).toHaveBeenCalledTimes(2);
    expect(mocks.logToServer.mock.calls[1][2].message).toBe('another failure');
  });

  it('同じ例外のまま再描画されても記録を重ねない', async () => {
    const error = makeError();
    const reset = vi.fn();

    await mount(<RouteError error={error} reset={reset} {...baseProps} />);
    await mount(<RouteError error={error} reset={reset} {...baseProps} />);

    expect(mocks.logToServer).toHaveBeenCalledTimes(1);
  });

  it('「再試行」で router.refresh() と reset() の両方を呼ぶ (サーバーコンポーネントの例外にも効くように)', async () => {
    const reset = vi.fn();
    const order: string[] = [];
    mocks.refresh.mockImplementation(() => order.push('refresh'));
    reset.mockImplementation(() => order.push('reset'));
    await mount(<RouteError error={makeError()} reset={reset} {...baseProps} />);

    await act(async () => {
      findButton('再試行')!.click();
    });

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['refresh', 'reset']);
  });

  it('fullScreen のときだけ画面全体の高さを使い、既定ではレイアウトの中に収める', async () => {
    await mount(<RouteError error={makeError()} reset={vi.fn()} {...baseProps} />);
    expect(container.firstElementChild?.className).toContain('min-h-[60vh]');
    expect(container.firstElementChild?.className).not.toContain('min-h-screen');

    await mount(<RouteError error={makeError()} reset={vi.fn()} {...baseProps} fullScreen />);
    expect(container.firstElementChild?.className).toContain('min-h-screen');
  });

  it('見出しとメッセージは role="alert" の中にあり、スクリーンリーダーに伝わる', async () => {
    await mount(<RouteError error={makeError()} reset={vi.fn()} {...baseProps} />);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain('エラーが発生しました');
  });

  it('記録が失敗しても画面は出る', async () => {
    mocks.logToServer.mockImplementation(() => {
      throw new Error('logger exploded');
    });

    await mount(<RouteError error={makeError()} reset={vi.fn()} {...baseProps} />);

    expect(findButton('再試行')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 各 error.tsx
// ─────────────────────────────────────────────────────────────────────────────

interface ErrorFileSpec {
  /** src/app からの相対パス */
  file: string;
  boundary: string;
  backHref: string;
  backLabel: string;
  fullScreen: boolean;
}

const ERROR_FILES: ErrorFileSpec[] = [
  { file: 'error.tsx', boundary: 'root', backHref: '/', backLabel: 'トップページへ戻る', fullScreen: true },
  { file: '(main)/error.tsx', boundary: 'main', backHref: '/home', backLabel: 'ホームへ戻る', fullScreen: true },
  { file: '(auth)/error.tsx', boundary: 'auth', backHref: '/', backLabel: 'トップページへ戻る', fullScreen: false },
  { file: '(org)/error.tsx', boundary: 'org', backHref: '/org/dashboard', backLabel: 'ダッシュボードへ戻る', fullScreen: false },
  { file: '(operator)/operator/membership/error.tsx', boundary: 'operator-membership', backHref: '/operator/membership/orgs/inactive', backLabel: 'inactive owner 検索へ戻る', fullScreen: false },
  { file: '(support)/error.tsx', boundary: 'support', backHref: '/support', backLabel: 'サポートのトップへ戻る', fullScreen: false },
  { file: 'admin/error.tsx', boundary: 'admin', backHref: '/admin/users', backLabel: 'ユーザー管理へ戻る', fullScreen: false },
  { file: 'super-admin/error.tsx', boundary: 'super-admin', backHref: '/super-admin/plans', backLabel: 'プラン管理へ戻る', fullScreen: false },
  { file: 'onboarding/error.tsx', boundary: 'onboarding', backHref: '/onboarding/resume', backLabel: '続きから再開する', fullScreen: false },
  { file: 'handson-tour/error.tsx', boundary: 'handson-tour', backHref: '/home', backLabel: 'ホームへ戻る', fullScreen: true },
];

type ErrorPage = (props: { error: Error & { digest?: string }; reset: () => void }) => React.ReactElement;

/**
 * error.tsx を絶対パスで読み込む。ファイルが無いときは、そのファイルのテストだけが失敗する
 * (静的な import にすると、1 つ欠けただけでテストファイル全体が読み込みで落ちる)
 */
async function loadErrorPage(file: string): Promise<{ default: ErrorPage }> {
  return import(/* @vite-ignore */ path.join(APP_DIR, file));
}

describe.each(ERROR_FILES)('$file', ({ file, boundary, backHref, backLabel, fullScreen }) => {
  it('再試行を出し、押すと reset を呼ぶ', async () => {
    const { default: ErrorPage } = await loadErrorPage(file);
    const reset = vi.fn();
    await mount(<ErrorPage error={makeError()} reset={reset} />);

    await act(async () => {
      findButton('再試行')!.click();
    });

    expect(reset).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it(`戻り先は ${backHref} (${backLabel})`, async () => {
    const { default: ErrorPage } = await loadErrorPage(file);
    await mount(<ErrorPage error={makeError()} reset={vi.fn()} />);

    const link = findLink();
    expect(link?.getAttribute('href')).toBe(backHref);
    expect(link?.textContent).toBe(backLabel);
  });

  it('例外の文面・スタックを画面に出さない', async () => {
    const { default: ErrorPage } = await loadErrorPage(file);
    await mount(<ErrorPage error={makeError({ digest: '77' })} reset={vi.fn()} />);

    expect(container.innerHTML).not.toContain('user_profiles');
    expect(container.innerHTML).not.toContain('hunter2');
    expect(container.innerHTML).not.toContain('/var/task');
    expect(text()).toContain('エラーコード: 77');
  });

  it(`boundary 名 (${boundary}) つきで記録する`, async () => {
    const { default: ErrorPage } = await loadErrorPage(file);
    await mount(<ErrorPage error={makeError()} reset={vi.fn()} />);

    expect(mocks.logToServer).toHaveBeenCalledTimes(1);
    expect(mocks.logToServer.mock.calls[0][1]).toBe(`error boundary caught: ${boundary}`);
  });

  it(`${fullScreen ? '画面全体' : 'レイアウトの中'}に描画する`, async () => {
    const { default: ErrorPage } = await loadErrorPage(file);
    await mount(<ErrorPage error={makeError()} reset={vi.fn()} />);

    const className = container.firstElementChild?.className ?? '';
    expect(className.includes('min-h-screen')).toBe(fullScreen);
  });

  it('"use client" で、共通部品 RouteError を使っている', () => {
    const source = fs.readFileSync(path.join(APP_DIR, file), 'utf8');

    // error.tsx は Client Component でなければならない (Next.js の仕様)
    expect(source).toMatch(/^"use client";/);
    expect(source).toMatch(/from "@\/components\/error\/RouteError"/);
    expect(source).toMatch(/<RouteError\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 配置の取り決め (新しい区画を足したとき、error.tsx を忘れない)
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir: string, found: { layouts: string[]; errors: string[] }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // API ルートに layout / error は無い
      if (entry.name === 'api') continue;
      walk(full, found);
    } else if (entry.name === 'layout.tsx') {
      found.layouts.push(path.relative(APP_DIR, dir));
    } else if (entry.name === 'error.tsx') {
      found.errors.push(path.relative(APP_DIR, full));
    }
  }
}

describe('error.tsx の配置', () => {
  const found = { layouts: [] as string[], errors: [] as string[] };
  walk(APP_DIR, found);
  const toPosix = (p: string) => p.split(path.sep).join('/');
  const layouts = found.layouts.map(toPosix);
  const errors = found.errors.map(toPosix);

  it('src/app/error.tsx (ルート全体の受け皿) がある', () => {
    expect(errors).toContain('error.tsx');
  });

  it('src/app 配下の error.tsx は、すべてこのテストの対象に入っている', () => {
    expect(errors.sort()).toEqual(ERROR_FILES.map((spec) => spec.file).sort());
  });

  it('ルート以外の layout.tsx は、同じ階層か、layout を持つ上の階層に error.tsx がある', () => {
    // layout.tsx のある階層 (ルートは ''): 例 '(main)/health'
    const layoutDirs = new Set(layouts);
    // error.tsx のある階層 (ルートは ''): 例 '(main)'
    const errorDirs = new Set(errors.map((e) => (path.posix.dirname(e) === '.' ? '' : path.posix.dirname(e))));
    const missing: string[] = [];

    for (const dir of layoutDirs) {
      // ルートの layout 自体の例外は global-error.tsx が受ける
      if (dir === '') continue;
      // 同じ階層から上へたどり、error.tsx を持ち、かつ layout も持つ階層があればよい
      // (その error.tsx は、その layout の内側に描画されるので、下の layout は壊れずに残る)
      const parts = dir.split('/');
      const covered = parts.some((_, i) => {
        const candidate = parts.slice(0, parts.length - i).join('/');
        return errorDirs.has(candidate) && layoutDirs.has(candidate);
      });
      if (!covered) missing.push(`${dir}/layout.tsx`);
    }

    expect(missing).toEqual([]);
  });

  it('global-error.tsx は共通の記録を使い、例外の文面を画面に出さない', () => {
    const source = fs.readFileSync(path.join(APP_DIR, 'global-error.tsx'), 'utf8');

    expect(source).toMatch(/reportBoundaryError\("global", error\)/);
    expect(source).not.toMatch(/\{\s*error\.message\s*\}/);
    expect(source).not.toMatch(/\{\s*error\.stack\s*\}/);
    // digest は安全な値だけを出す
    expect(source).toMatch(/toDisplayErrorCode\(error\.digest\)/);
    expect(source).not.toMatch(/\{\s*error\.digest\s*\}/);
  });
});

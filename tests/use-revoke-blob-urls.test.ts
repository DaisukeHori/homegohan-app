import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useRevokeBlobUrls } from '../src/hooks/useRevokeBlobUrls';

/**
 * #1222: 写真プレビュー用 Blob URL (URL.createObjectURL) が revoke されずメモリに残り続ける問題。
 *
 * このリポジトリには @testing-library/react が無いため、react-dom/client + act で
 * フックを直接マウントして挙動を確認する (jsdom は vitest.config.ts の environment)。
 * 画面ページ本体の差し込み位置は、後半の「配線」テストでソースを静的に確認する。
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BLOB_A = 'blob:http://localhost:3000/aaaaaaaa-0000-4000-8000-000000000001';
const BLOB_B = 'blob:http://localhost:3000/bbbbbbbb-0000-4000-8000-000000000002';
const BLOB_C = 'blob:http://localhost:3000/cccccccc-0000-4000-8000-000000000003';

const originalDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
let revokeSpy: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;

type Urls = string | null | readonly string[];

/** フックだけを呼ぶ最小のコンポーネント。meals/new の photoPreviews や pantry の previewUrl を模す */
function Probe({ urls }: { urls: Urls }) {
  useRevokeBlobUrls(urls);
  return null;
}

function render(urls: Urls, options: { strict?: boolean } = {}) {
  const element = createElement(Probe, { urls });
  act(() => {
    root.render(options.strict ? createElement(StrictMode, null, element) : element);
  });
}

function revokedUrls(): string[] {
  return revokeSpy.mock.calls.map((call) => call[0] as string);
}

beforeEach(() => {
  revokeSpy = vi.fn();
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeSpy,
    configurable: true,
    writable: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  if (originalDescriptor) {
    Object.defineProperty(URL, 'revokeObjectURL', originalDescriptor);
  } else {
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  }
});

describe('useRevokeBlobUrls: 配列 (meals/new の photoPreviews)', () => {
  it('写真を追加しただけでは revoke しない (表示中の URL を解放しない)', () => {
    render([]);
    render([BLOB_A]);
    render([BLOB_A, BLOB_B]);

    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('1 枚削除 (removePhoto) すると、外れた URL だけ revoke する', () => {
    render([BLOB_A, BLOB_B, BLOB_C]);
    render([BLOB_A, BLOB_C]);

    expect(revokedUrls()).toEqual([BLOB_B]);
  });

  it('リセット (setPhotoPreviews([])) すると、残っていた URL をすべて revoke する', () => {
    render([BLOB_A, BLOB_B]);
    render([]);

    expect(revokedUrls()).toEqual([BLOB_A, BLOB_B]);
  });

  it('撮り直しを繰り返しても、そのたびに前の URL が revoke される (リークしない)', () => {
    render([BLOB_A]);
    render([]);
    render([BLOB_B]);
    render([]);
    render([BLOB_C]);

    expect(revokedUrls()).toEqual([BLOB_A, BLOB_B]);
  });

  it('再 render しても配列が同じなら何も起きない', () => {
    const urls = [BLOB_A, BLOB_B];
    render(urls);
    render(urls);
    render(urls);

    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('ページを離れる (アンマウント) と、残っている URL をすべて revoke する', () => {
    render([BLOB_A, BLOB_B]);
    act(() => {
      root.unmount();
    });

    expect(revokedUrls()).toEqual([BLOB_A, BLOB_B]);
  });

  it('削除済みの URL はアンマウント時に二重で revoke されない', () => {
    render([BLOB_A, BLOB_B]);
    render([BLOB_A]);
    act(() => {
      root.unmount();
    });

    expect(revokedUrls()).toEqual([BLOB_B, BLOB_A]);
  });

  it('blob: 以外 (ハンズオンの固定画像) は配列に入っていても revoke しない', () => {
    const sample = '/handson-tour/sample-meal.webp';
    render([sample]);
    render([]);
    render([BLOB_A, sample]);
    act(() => {
      root.unmount();
    });

    expect(revokedUrls()).toEqual([BLOB_A]);
  });
});

describe('useRevokeBlobUrls: 単一 URL (pantry の previewUrl / health の imagePreview)', () => {
  it('選び直すと前の URL を revoke し、新しい URL は残す', () => {
    render(null);
    render(BLOB_A);
    render(BLOB_B);

    expect(revokedUrls()).toEqual([BLOB_A]);
  });

  it('null に戻す (保存後・× で外す) と revoke する', () => {
    render(BLOB_A);
    render(null);

    expect(revokedUrls()).toEqual([BLOB_A]);
  });

  it('ページを離れると、選択中の URL を revoke する', () => {
    render(BLOB_A);
    act(() => {
      root.unmount();
    });

    expect(revokedUrls()).toEqual([BLOB_A]);
  });

  it('何も選んでいないままページを離れても revoke は呼ばれない', () => {
    render(null);
    act(() => {
      root.unmount();
    });

    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it("健診ページの PDF 目印 '__pdf__' は revoke せず、画像から PDF へ切り替えたときは画像の URL だけ revoke する", () => {
    render(BLOB_A);
    render('__pdf__');
    render(null);
    act(() => {
      root.unmount();
    });

    expect(revokedUrls()).toEqual([BLOB_A]);
  });
});

describe('useRevokeBlobUrls: StrictMode (開発時の二重 effect)', () => {
  it('マウント直後の二重実行で revoke を呼ばない', () => {
    render([], { strict: true });
    render(null, { strict: true });

    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('StrictMode 下でも、削除・リセット・アンマウントで 1 回ずつ revoke される', () => {
    render([], { strict: true });
    render([BLOB_A, BLOB_B], { strict: true });
    expect(revokeSpy).not.toHaveBeenCalled();

    render([BLOB_B], { strict: true });
    expect(revokedUrls()).toEqual([BLOB_A]);

    act(() => {
      root.unmount();
    });
    expect(revokedUrls()).toEqual([BLOB_A, BLOB_B]);
  });
});

/**
 * ページ側の配線。ページ本体は Supabase / framer-motion 等に依存し単体では描画できないため、
 * 既存の *-contracts.test.ts と同じくソースを静的に確認する。
 */
describe('#1222 配線: Blob URL を作るページはすべて解放処理を持つ', () => {
  const repoRoot = process.cwd();
  const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

  const previewPages: Array<{ name: string; file: string; state: string }> = [
    { name: '食事・冷蔵庫・健診・体重計の写真解析', file: 'src/app/(main)/meals/new/page.tsx', state: 'photoPreviews' },
    { name: '冷蔵庫の写真登録 (パントリー)', file: 'src/app/(main)/pantry/page.tsx', state: 'previewUrl' },
    { name: '健康診断の記録', file: 'src/app/(main)/health/checkups/new/page.tsx', state: 'imagePreview' },
  ];

  it.each(previewPages)('$name ($file) は $state を useRevokeBlobUrls に渡している', ({ file, state }) => {
    const source = read(file);
    // 失敗時にページ全文が出力されないよう、真偽値 + メッセージで判定する
    expect(
      source.includes('@/hooks/useRevokeBlobUrls'),
      `${file} が @/hooks/useRevokeBlobUrls を import していない`,
    ).toBe(true);
    expect(
      new RegExp(`useRevokeBlobUrls\\(\\s*${state}\\s*\\)`).test(source),
      `${file} が useRevokeBlobUrls(${state}) を呼んでいない`,
    ).toBe(true);
  });

  it('src 内で URL.createObjectURL を呼ぶファイルは、必ず revokeObjectURL か useRevokeBlobUrls も使っている', () => {
    const files = execSync(
      `grep -rl "createObjectURL(" src --include="*.ts" --include="*.tsx" || true`,
      { cwd: repoRoot, encoding: 'utf8' },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // grep が空振りして「0 件 = 問題なし」になっていないこと
    expect(files.length).toBeGreaterThan(0);

    const leaking = files.filter((file) => {
      const source = read(file);
      return !source.includes('revokeObjectURL') && !source.includes('useRevokeBlobUrls');
    });
    expect(
      leaking,
      'URL.createObjectURL を使うファイルには revokeObjectURL か useRevokeBlobUrls (src/hooks/useRevokeBlobUrls.ts) が必要です (#1222)',
    ).toEqual([]);
  });
});

/**
 * #1917 家族グループ / 組織を解散する区画 SelfDissolveSection (docs/design/family/11-self-dissolve.md §15.2・§21.3)。
 *
 * 解散の API の呼び出し (dissolveOwnScope) はモックにし、区画の動き (キーワード・送信中・結果ごとの扱い・文) を見る。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dissolveMock } = vi.hoisted(() => ({ dissolveMock: vi.fn() }));

vi.mock('@/lib/membership/self-dissolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/membership/self-dissolve')>();
  return { ...actual, dissolveOwnScope: dissolveMock };
});

import { SelfDissolveSection } from '@/components/membership/SelfDissolveSection';
import { SELF_DISSOLVE_COPY } from '@/lib/membership/self-dissolve';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 作りかけ・先送りを示す語 (R-12) */
const PENDING_WORDS = ['準備中', '予定'] as const;
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const DISSOLVED_AT = '2026-10-19T05:00:00.123456+00:00';
const FAMILY_EFFECT_LINES = 5;
const ORG_EFFECT_LINES = 4;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  dissolveMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(element: ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

function keywordInput(scope: 'family' | 'organization'): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="self-dissolve-${scope}-keyword"]`);
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

function submitButton(scope: 'family' | 'organization'): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="self-dissolve-${scope}-submit"]`);
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

describe('SelfDissolveSection (#1917)', () => {
  it('キーワードが「解散します」と一致するまでボタンは押せない。一致すると押せる', async () => {
    await render(<SelfDissolveSection scope="family" scopeId={FAMILY_ID} scopeName="山田家" onDissolved={vi.fn()} />);

    expect(submitButton('family').disabled).toBe(true);
    await type(keywordInput('family'), '解散');
    expect(submitButton('family').disabled).toBe(true);
    await type(keywordInput('family'), '解散します');
    expect(submitButton('family').disabled).toBe(false);
  });

  it('押すと dissolveOwnScope を scope と id で 1 回呼び、成功で onDissolved(dissolvedAt) を呼ぶ。送信中はボタンと入力欄が無効', async () => {
    let resolveCall: (value: { kind: 'dissolved'; dissolvedAt: string }) => void = () => undefined;
    dissolveMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve;
        }),
    );
    const onDissolved = vi.fn();
    await render(<SelfDissolveSection scope="organization" scopeId={ORG_ID} scopeName="株式会社テスト" onDissolved={onDissolved} />);

    await type(keywordInput('organization'), '解散します');
    await click(submitButton('organization'));

    expect(dissolveMock).toHaveBeenCalledTimes(1);
    expect(dissolveMock).toHaveBeenCalledWith('organization', ORG_ID);
    expect(submitButton('organization').disabled).toBe(true);
    expect(keywordInput('organization').disabled).toBe(true);
    expect(submitButton('organization').textContent).toBe(SELF_DISSOLVE_COPY.organization.submitting);
    // 送信中にもう一度押しても呼ばない
    await click(submitButton('organization'));
    expect(dissolveMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCall({ kind: 'dissolved', dissolvedAt: DISSOLVED_AT });
    });
    expect(onDissolved).toHaveBeenCalledWith(DISSOLVED_AT);
  });

  it('失敗は role=alert に文を出し、もう一度押せる', async () => {
    dissolveMock.mockResolvedValue({ kind: 'failed', message: 'この家族グループはすでに解散しています。' });
    const onDissolved = vi.fn();
    await render(<SelfDissolveSection scope="family" scopeId={FAMILY_ID} scopeName="山田家" onDissolved={onDissolved} />);

    await type(keywordInput('family'), '解散します');
    await click(submitButton('family'));

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('この家族グループはすでに解散しています。');
    expect(onDissolved).not.toHaveBeenCalled();
    expect(submitButton('family').disabled).toBe(false);
    expect(keywordInput('family').disabled).toBe(false);
  });

  it('401 は onUnauthorized を呼ぶ', async () => {
    dissolveMock.mockResolvedValue({ kind: 'unauthorized' });
    const onUnauthorized = vi.fn();
    const onDissolved = vi.fn();
    await render(
      <SelfDissolveSection scope="family" scopeId={FAMILY_ID} scopeName="山田家" onDissolved={onDissolved} onUnauthorized={onUnauthorized} />,
    );

    await type(keywordInput('family'), '解散します');
    await click(submitButton('family'));

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onDissolved).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('見出しに所属先の名前、効果の箇条書き (家族は 5 行・組織は 4 行)。文に R-12 の 2 語が無い', async () => {
    await render(<SelfDissolveSection scope="family" scopeId={FAMILY_ID} scopeName="山田家" onDissolved={vi.fn()} />);
    expect(container.querySelector('h3')?.textContent).toBe('「山田家」を解散する');
    expect(container.querySelectorAll('li')).toHaveLength(FAMILY_EFFECT_LINES);
    for (const word of PENDING_WORDS) expect(container.textContent).not.toContain(word);

    await render(<SelfDissolveSection scope="organization" scopeId={ORG_ID} scopeName="株式会社テスト" onDissolved={vi.fn()} />);
    expect(container.querySelector('h3')?.textContent).toBe('「株式会社テスト」を解散する');
    expect(container.querySelectorAll('li')).toHaveLength(ORG_EFFECT_LINES);
    for (const word of PENDING_WORDS) expect(container.textContent).not.toContain(word);
  });

  it('onCancel があるときだけ「キャンセル」が出る', async () => {
    const buttonTexts = () => Array.from(container.querySelectorAll('button')).map((b) => b.textContent);

    await render(<SelfDissolveSection scope="family" scopeId={FAMILY_ID} scopeName="山田家" onDissolved={vi.fn()} />);
    expect(buttonTexts()).not.toContain('キャンセル');

    const onCancel = vi.fn();
    await render(<SelfDissolveSection scope="family" scopeId={FAMILY_ID} scopeName="山田家" onDissolved={vi.fn()} onCancel={onCancel} />);
    const cancel = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'キャンセル');
    expect(cancel).toBeDefined();
    await click(cancel as HTMLButtonElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

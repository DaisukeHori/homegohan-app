/**
 * T15 (#1154) 外国の AI 事業者への提供の同意画面 (AiDataConsentModal) の component テスト
 *
 * 確認すること:
 *   - 提供先 (xAI / Google / OpenAI / Perplexity / AI/ML API とその所在国)・提供する情報 (食事の写真と記録、健康診断・血液検査、
 *     相談文、冷蔵庫の写真、献立・買い物リストの料理名と食材)・利用目的・事業者での保存・撤回の方法が画面に出る
 *   - 押せるのは「同意する」と「同意しない」の 2 つ。Esc は「同意しない」。背景のクリックでは閉じない
 *   - 「同意しない」と AI 機能は使えないことを説明する (未同意なら、サーバーが AI へ送らずに止める)
 *   - サーバーに止められて出した画面 (required) は、「この機能を使うには同意が必要です」の一文を足す
 *   - 記録中は「同意する」だけを押せなくし、「同意しない」は押せるまま。記録に失敗したときはメッセージを出す
 *   - role="dialog" / aria-modal / aria-labelledby で、見出しに結び付く
 *   - body 直下 (portal) に描画される
 *
 * @testing-library/react は未インストールのため、他のコンポーネントテストと同じく react-dom/client + act で描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

const { AiDataConsentModal } = await import('@/components/consent/AiDataConsentModal');
const { AI_CONSENT_COPY, AI_CONSENT_PROVIDERS, AI_CONSENT_PROVIDER_INFO, AI_CONSENT_SETTINGS_PATH } = await import(
  '@/lib/ai/consent-config'
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.style.overflow = '';
});

type Props = Parameters<typeof AiDataConsentModal>[0];

function render(props: Partial<Props> = {}) {
  const merged: Props = { isOpen: true, onAccept: () => {}, onDecline: () => {}, ...props };
  act(() => {
    root.render(createElement(AiDataConsentModal, merged));
  });
}

const modal = () => document.body.querySelector('[data-testid="ai-consent-modal"]') as HTMLElement | null;
const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = () => modal()?.textContent ?? '';

function click(el: HTMLElement | null) {
  expect(el, 'クリック対象が見つからない').not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AiDataConsentModal: 文面', () => {
  it('提供先の事業者 (実際に送っている 5 社) と所在国が出る', () => {
    render();
    expect(modal()).not.toBeNull();
    expect([...AI_CONSENT_PROVIDERS]).toEqual(['xai', 'google', 'openai', 'perplexity', 'aimlapi']);
    for (const provider of AI_CONSENT_PROVIDERS) {
      const info = AI_CONSENT_PROVIDER_INFO[provider];
      const row = byTestId(`ai-consent-provider-${provider}`);
      expect(row, info.name).not.toBeNull();
      expect(row!.textContent).toContain(info.name);
      expect(row!.textContent).toContain(info.country);
    }
    for (const name of ['xAI', 'Google', 'OpenAI', 'Perplexity', 'AI/ML API']) expect(text()).toContain(name);
    expect(AI_CONSENT_PROVIDER_INFO.aimlapi.country).toBe('エストニア');
    expect(AI_CONSENT_PROVIDER_INFO.perplexity.country).toBe('アメリカ合衆国');
  });

  it('提供する情報・利用目的・事業者での保存・撤回の方法が出る', () => {
    render();
    const body = text();
    expect(body).toContain('食事の写真と食事の記録');
    expect(body).toContain('健康診断・血液検査の写真と数値');
    expect(body).toContain('AI 相談に入力した文章');
    expect(body).toContain('冷蔵庫の写真と食材の情報');
    expect(body).toContain('献立・買い物リストの料理名と食材の名前');
    for (const purpose of AI_CONSENT_COPY.purposes) expect(body).toContain(purpose);
    expect(body).toContain(AI_CONSENT_COPY.retention);
    expect(body).toContain(AI_CONSENT_COPY.withdrawal);
  });

  it('撤回・確認のページへのリンクがある', () => {
    render();
    const link = byTestId('ai-consent-settings-link') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe(AI_CONSENT_SETTINGS_PATH);
    expect(AI_CONSENT_SETTINGS_PATH).toBe('/settings/ai-consent');
  });

  it('同意しないと AI 機能は使えないこと、あとからでも同意できることを説明する', () => {
    render();
    const note = byTestId('ai-consent-decline-note')?.textContent ?? '';
    expect(note).toBe(AI_CONSENT_COPY.declineNote);
    expect(note).toContain('同意しない場合、AI 機能');
    expect(note).toContain('お使いいただけません');
    expect(note).toContain('あとからいつでも同意できます');
    // 以前の「あとで」(同意せずに AI の操作を続ける) の文面は残っていない
    expect(text()).not.toContain('あとで');
  });

  it('サーバーに止められて出した画面 (required) だけ、「この機能を使うには同意が必要です」の一文を足す', () => {
    render();
    expect(byTestId('ai-consent-required-lead')).toBeNull();
    render({ required: true });
    expect(byTestId('ai-consent-required-lead')?.textContent).toBe(AI_CONSENT_COPY.requiredLead);
  });

  it('見出しに結び付いたダイアログ (role / aria-modal / aria-labelledby) で、body 直下に描画される', () => {
    render();
    const dialog = modal()!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe(AI_CONSENT_COPY.title);
    // portal: レンダリングした container の中ではなく body の直下
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('isOpen = false のときは何も出ない', () => {
    render({ isOpen: false });
    expect(modal()).toBeNull();
  });
});

describe('AiDataConsentModal: 操作', () => {
  it('押せるボタンは「同意しない」と「同意する」の 2 つ', () => {
    render();
    const labels = Array.from(modal()!.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['同意しない', '同意する']);
  });

  it('「同意する」で onAccept、「同意しない」で onDecline が呼ばれる', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    render({ onAccept, onDecline });

    click(byTestId('ai-consent-accept'));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();

    click(byTestId('ai-consent-decline'));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('Esc キーは「同意しない」として扱う', () => {
    const onDecline = vi.fn();
    const onAccept = vi.fn();
    render({ onDecline, onAccept });

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('背景のクリックでは閉じない (うっかり「同意しない」にしない)', () => {
    const onDecline = vi.fn();
    render({ onDecline });

    click(modal());

    expect(onDecline).not.toHaveBeenCalled();
  });

  it('記録中は「同意する」を押せず、「同意しない」は押せるまま', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    render({ isSubmitting: true, onAccept, onDecline });

    expect((byTestId('ai-consent-accept') as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId('ai-consent-decline') as HTMLButtonElement).disabled).toBe(false);
    expect(byTestId('ai-consent-accept')!.textContent).toContain('記録しています');

    click(byTestId('ai-consent-decline'));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('記録に失敗したときのメッセージを alert として出す。そのあとも「同意する」「同意しない」を押せる', () => {
    render({ errorMessage: '同意を記録できませんでした。通信状況を確認して、もう一度お試しください。' });

    const alert = byTestId('ai-consent-error');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('同意を記録できませんでした');
    expect((byTestId('ai-consent-accept') as HTMLButtonElement).disabled).toBe(false);
    expect((byTestId('ai-consent-decline') as HTMLButtonElement).disabled).toBe(false);
  });

  it('エラーが無いときは alert を出さない', () => {
    render();
    expect(byTestId('ai-consent-error')).toBeNull();
  });

  it('表示されたことを onShown で 1 回だけ知らせる (props が変わっても繰り返さない)', () => {
    const onShown = vi.fn();
    render({ onShown });
    expect(onShown).toHaveBeenCalledTimes(1);

    render({ onShown, isSubmitting: true });
    render({ onShown, isSubmitting: false, errorMessage: 'x' });
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('背景のスクロールを止め、閉じたら元に戻す', () => {
    render();
    expect(document.body.style.overflow).toBe('hidden');
    act(() => root.unmount());
    root = createRoot(container);
    expect(document.body.style.overflow).toBe('');
  });
});

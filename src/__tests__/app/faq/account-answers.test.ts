// src/__tests__/app/faq/account-answers.test.ts
// #1187: FAQ (src/app/faq/page.tsx) のアカウントまわりの案内が、アプリの実際の画面と食い違わないこと。
//
// 以前の FAQ は「設定画面の『アカウント』から (メールアドレスを) 変更できます」「『アカウント』→『アカウント削除』から削除できます」
// と案内していたが、Web の設定画面にそのような画面は無く、メール・パスワードの変更手段は何も無かった。
// 今は Web の設定画面に「アカウント」→「パスワード・メールアドレス」ができ、モバイルアプリの設定画面には
// まだ変更の項目が無い。FAQ の文言がそれぞれ実在する画面の言葉と一致していることを、ここで固定する。
//
// 1) FAQ を描画して、各回答の文言を確かめる
// 2) 回答が案内している画面の言葉が、Web・モバイルのソースに実在することを確かめる (言葉がずれたらここで気づく)
//
// NOTE: tsconfig の jsx: "preserve" の都合で、拡張子 .ts + React.createElement で書く (data-export.test.ts と同じ)。

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

const h = React.createElement;

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

// framer-motion はアニメーション完了待ち (AnimatePresence の exit) が jsdom で不安定なので素通しにする
vi.mock('framer-motion', async () => {
  const react = await import('react');
  const cache: Record<string, unknown> = {};
  const passthrough = (tag: string) =>
    function Passthrough({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      whileHover: _whileHover,
      whileTap: _whileTap,
      ...rest
    }: Record<string, unknown> & { children?: React.ReactNode }) {
      return react.createElement(tag, rest, children);
    };
  return {
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => (cache[tag] ??= passthrough(tag)),
      },
    ),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => react.createElement(react.Fragment, null, children),
  };
});

import FaqPage from '@/app/faq/page';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (relativePath: string) => fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(h(FaqPage));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

const categoryTabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('div.flex-wrap > button'));
const questionButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('div.max-w-3xl > div > button'));

/** すべてのカテゴリの全質問を開いて、質問 → 回答 の対応を集める */
async function collectAnswers(): Promise<Map<string, string>> {
  const answers = new Map<string, string>();
  const tabCount = categoryTabs().length;
  for (let t = 0; t < tabCount; t++) {
    await click(categoryTabs()[t]);
    const questionCount = questionButtons().length;
    for (let q = 0; q < questionCount; q++) {
      const button = questionButtons()[q];
      await click(button);
      answers.set(button.textContent ?? '', container.querySelector('p.leading-relaxed')?.textContent ?? '');
    }
  }
  return answers;
}

describe('#1187 FAQ: アカウントまわりの回答', () => {
  it('カテゴリ「アカウント」に、パスワード・メールアドレスの変更の質問がある', async () => {
    const answers = await collectAnswers();
    const questions = [...answers.keys()];

    expect(questions).toEqual(
      expect.arrayContaining([
        'パスワードを忘れました',
        'パスワードを変更したい',
        'メールアドレスを変更したい',
        'アカウントを削除したい',
      ]),
    );
    // どの質問にも、空でない回答がある
    for (const [question, answer] of answers) {
      expect(answer, question).not.toBe('');
    }
  });

  it('「メールアドレスを変更したい」: Web の設定画面の入口と手順、確認メール、モバイルにはまだ無いことを案内する', async () => {
    const answer = (await collectAnswers()).get('メールアドレスを変更したい')!;

    // Web の入口 (設定画面の「アカウント」→「パスワード・メールアドレス」→「メールアドレスを変更」)
    expect(answer).toContain('設定画面の「アカウント」→「パスワード・メールアドレス」');
    expect(answer).toContain('「メールアドレスを変更」');
    // 確認メール: 新しいアドレスに届き、現在のアドレスにも届く場合は両方のリンクを開く
    expect(answer).toContain('新しいメールアドレスに確認メールが届く');
    expect(answer).toContain('現在のメールアドレスにも確認メールが届く場合があります');
    expect(answer).toContain('両方のリンクを開いてください');
    expect(answer).toContain('確認が終わるまでは、これまでのメールアドレスでログインできます');
    // モバイルアプリの設定画面にはまだ無い。代わりの手順を示す
    expect(answer).toContain('モバイルアプリの設定画面には、まだ変更の項目がありません');
    expect(answer).toContain('Web版にログインして変更してください');
    // Google でログインしている人
    expect(answer).toContain('Googleアカウントでログインしている場合');
    expect(answer).toContain('お問い合わせ');

    // 以前の誤った案内 (存在しない画面からの変更) が残っていない
    expect(answer).not.toContain('設定画面の「アカウント」から変更できます');
  });

  it('「パスワードを変更したい」: Web の設定画面の入口と手順、他の端末が解除されること、モバイルでの当面の手順を案内する', async () => {
    const answer = (await collectAnswers()).get('パスワードを変更したい')!;

    expect(answer).toContain('設定画面の「アカウント」→「パスワード・メールアドレス」');
    expect(answer).toContain('「パスワードを変更」');
    expect(answer).toContain('現在のパスワードと新しいパスワードを入力');
    // 変更すると、操作した端末以外のログインが解除される (signOut({ scope: 'others' }))
    expect(answer).toContain('いま使っている端末以外のログインはすべて解除されます');
    // モバイルアプリの設定画面にはまだ無い。ブラウザで Web 版から変更するか、ログイン画面の再設定を使う
    expect(answer).toContain('モバイルアプリの設定画面には、まだ変更の項目がありません');
    expect(answer).toContain('Web版にログインして変更する');
    expect(answer).toContain('ログイン画面の「パスワードを忘れた？」からパスワードを再設定してください');
    // Google でログインしている人
    expect(answer).toContain('Googleアカウントでログインしている場合');
  });

  it('「パスワードを忘れました」: 実際のリンクの名前を案内し、再設定後は全端末がログアウトされることを伝える (#1188)', async () => {
    const answer = (await collectAnswers()).get('パスワードを忘れました')!;

    expect(answer).toContain('「忘れた場合」');
    expect(answer).toContain('「パスワードを忘れた？」');
    expect(answer).toContain('すべての端末からログアウトされます');
    expect(answer).toContain('新しいパスワードでログインし直してください');
  });

  it('「アカウントを削除したい」: Web は「危険ゾーン」、モバイルは「アカウント」→「アカウント管理」を案内する', async () => {
    const answer = (await collectAnswers()).get('アカウントを削除したい')!;

    expect(answer).toContain('Web版では、設定画面の一番下にある「危険ゾーン」→「アカウントを削除する」');
    expect(answer).toContain('モバイルアプリでは、設定画面の「アカウント」→「アカウント管理」→「アカウント削除」');
    expect(answer).toContain('復元できません');
    // Web に「アカウント」→「アカウント削除」という経路は無い
    expect(answer).not.toContain('設定画面の「アカウント」→「アカウント削除」');
  });

  it('「ログインできません」: 実在しない「パスワードを忘れた方」ではなく、実際のリンクの名前を案内する', async () => {
    const answer = (await collectAnswers()).get('ログインできません')!;

    expect(answer).toContain('「忘れた場合」');
    expect(answer).toContain('「パスワードを忘れた？」');
    expect(answer).not.toContain('パスワードを忘れた方');
  });

  it('登録に必要なもの: パスワードも必要だと正しく案内する', async () => {
    const answer = (await collectAnswers()).get('アカウント登録に必要なものは？')!;

    expect(answer).toContain('メールアドレスとパスワード');
    expect(answer).not.toContain('メールアドレスのみ');
  });

  it('どの回答にも、アプリに無い画面の名前 (「パスワードを忘れた方」) が残っていない', async () => {
    const answers = await collectAnswers();
    for (const [question, answer] of answers) {
      expect(answer, question).not.toContain('パスワードを忘れた方');
    }
  });
});

describe('#1187 FAQ が案内している画面の言葉は、アプリに実在する', () => {
  it('Web の設定画面: 「アカウント」セクションと「パスワード・メールアドレス」の入口、「危険ゾーン」の「アカウントを削除する」', () => {
    const settings = read('src/app/(main)/settings/page.tsx');
    expect(settings).toContain('>アカウント</h2>');
    expect(settings).toContain('パスワード・メールアドレス');
    expect(settings).toContain("router.push('/settings/account')");
    expect(settings).toContain('>危険ゾーン</h2>');
    expect(settings).toContain('アカウントを削除する');
  });

  it('Web のアカウント画面: 「パスワードを変更」と「メールアドレスを変更」の見出し', () => {
    const account = read('src/app/(main)/settings/account/page.tsx');
    expect(account).toContain('パスワードを変更');
    expect(account).toContain('メールアドレスを変更');
    expect(account).toContain('現在のパスワード');
    expect(account).toContain('新しいパスワード');
    expect(account).toContain('新しいメールアドレス');
  });

  it('ログイン画面のリンク名: Web は「忘れた場合」、モバイルは「パスワードを忘れた？」', () => {
    expect(read('src/app/(auth)/login/page.tsx')).toContain('忘れた場合');
    expect(read('apps/mobile/app/(auth)/login.tsx')).toContain('パスワードを忘れた？');
  });

  it('モバイルの設定画面: 「アカウント」セクション → 「アカウント管理」→ 「アカウント削除」', () => {
    const settings = read('apps/mobile/app/(tabs)/settings.tsx');
    expect(settings).toContain('<Text style={styles.sectionLabel}>アカウント</Text>');
    expect(settings).toContain('title="アカウント管理"');
    expect(settings).toContain('router.push("/settings/account")');
    expect(read('apps/mobile/app/settings/account.tsx')).toContain('アカウント削除');
  });

  it('モバイルの設定画面には、まだパスワード・メールアドレスの変更が無い (FAQ の「準備中」の根拠)', () => {
    // モバイルに変更機能 (updateUser) を入れたら、このテストが落ちる。そのときは次を一緒に直すこと:
    //   - src/app/faq/page.tsx の「パスワードを変更したい」「メールアドレスを変更したい」にあるモバイルの案内 (「準備中です」)
    //   - このテストと、上の「パスワードを変更したい」「メールアドレスを変更したい」のテスト
    const mobileSettingsFiles = [
      'apps/mobile/app/(tabs)/settings.tsx',
      ...fs
        .readdirSync(path.join(ROOT, 'apps/mobile/app/settings'))
        .filter((name) => /\.(ts|tsx)$/.test(name))
        .map((name) => `apps/mobile/app/settings/${name}`),
    ];
    for (const file of mobileSettingsFiles) {
      expect(read(file), `${file} に updateUser が入りました。FAQ の「モバイルはまだ」の案内を直してください`).not.toContain('updateUser');
    }
  });
});

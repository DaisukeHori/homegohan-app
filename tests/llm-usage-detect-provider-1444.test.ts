// @vitest-environment node
/**
 * #1444 (CodeQL js/incomplete-url-substring-sanitization) の回帰テスト。
 *
 * supabase/functions/_shared/llm-usage.ts の detectProvider は、fetch の宛先が計測するプロバイダの API かを
 * ホスト名で見分ける。以前は hostname.includes("api.openai.com") の部分文字列の一致で、
 * api.openai.com.example.net や evil-api.openai.com.test のような別のホストも OpenAI として数えていた。
 * ホスト名そのもの、またはそのサブドメインのときだけ一致とする。
 */
import { describe, expect, it } from 'vitest';

import { detectProvider } from '../supabase/functions/_shared/llm-usage';

describe('detectProvider: ホスト名そのもの・サブドメインのときだけプロバイダとみなす', () => {
  it.each([
    ['OpenAI', 'https://api.openai.com/v1/chat/completions', 'openai'],
    ['OpenAI (大文字のホスト)', 'https://API.OpenAI.com/v1/embeddings', 'openai'],
    ['OpenAI (ポートの指定つき)', 'https://api.openai.com:443/v1/responses', 'openai'],
    ['OpenAI のサブドメイン', 'https://eu.api.openai.com/v1/chat/completions', 'openai'],
    ['xAI', 'https://api.x.ai/v1/chat/completions', 'xai'],
  ])('%s', (_label, url, provider) => {
    expect(detectProvider(url)).toBe(provider);
  });

  it.each([
    ['ホスト名の後ろに別のドメインが続く', 'https://api.openai.com.example.net/v1/chat/completions'],
    ['ホスト名の前に文字が付いた別のホスト', 'https://evilapi.openai.com/v1/chat/completions'],
    ['ホスト名の前に文字が付いた別のホスト (xAI)', 'https://notapi.x.ai/v1/chat/completions'],
    ['パスにホスト名を含むだけ', 'https://example.com/api.openai.com/v1/chat/completions'],
    ['クエリにホスト名を含むだけ', 'https://example.com/?next=https://api.x.ai/'],
    ['利用者の情報の部分にホスト名を含むだけ', 'https://api.openai.com@example.com/v1/chat/completions'],
    ['計測しないプロバイダ', 'https://generativelanguage.googleapis.com/v1beta/models'],
  ])('%s は計測しない (null)', (_label, url) => {
    expect(detectProvider(url)).toBeNull();
  });
});

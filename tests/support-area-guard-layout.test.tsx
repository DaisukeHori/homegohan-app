/**
 * #1176 Web の (support) 区画の server layout (段 B)。docs/design/cross/12-operator-mfa.md §13.4.1・§21.1
 *
 * src/app/(support)/support/layout.tsx が requireRoleForPage を (support) 区画のロール・next・forbiddenPath で呼び、
 * 猶予中 (pass_grace) だけ MfaGraceBanner を描くことを確かめる。@/lib/auth/page-guard を差し替え、react-dom/server で HTML にする。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '@/lib/auth/types';

const h = vi.hoisted(() => ({ requireRoleForPage: vi.fn() }));

vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage: h.requireRoleForPage }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { default: SupportAreaGuardLayout } = await import('@/app/(support)/support/layout');

const ENFORCE_FROM = '2026-11-01T00:00:00.000Z';

function actorWith(decision: 'not_required' | 'pass' | 'pass_grace'): UserProfile {
  return {
    id: 'u-1',
    roles: ['admin'],
    assurance: {
      required: decision !== 'not_required',
      aal: decision === 'pass' ? 'aal2' : 'aal1',
      enrolled: decision === 'pass',
      decision,
      enforce_from: decision === 'pass_grace' ? ENFORCE_FROM : null,
    },
  };
}

beforeEach(() => {
  h.requireRoleForPage.mockReset();
});

describe('(support)/support/layout (段 B)', () => {
  it('(support)/support/layout は requireRoleForPage を SUPPORT_AREA_ROLES (support / admin / super_admin)・next /support・forbiddenPath /home で呼ぶ', async () => {
    h.requireRoleForPage.mockResolvedValue(actorWith('pass'));
    await SupportAreaGuardLayout({ children: <p>本文</p> });
    expect(h.requireRoleForPage).toHaveBeenCalledTimes(1);
    const [roles, options] = h.requireRoleForPage.mock.calls[0];
    expect([...roles].sort()).toEqual(['admin', 'super_admin', 'support']);
    expect(options).toEqual({ next: '/support', forbiddenPath: '/home' });
  });

  it('assurance.decision が pass_grace なら MfaGraceBanner を enforce_from と next=/support で描き、それ以外は描かない', async () => {
    h.requireRoleForPage.mockResolvedValue(actorWith('pass_grace'));
    const grace = renderToStaticMarkup(await SupportAreaGuardLayout({ children: <p id="body">本文</p> }));
    expect(grace).toContain('data-testid="mfa-grace-banner"');
    // 2026-11-01T00:00Z = 日本時間 11/01 09:00
    expect(grace).toContain('11/01 09:00 までに認証アプリを登録してください');
    expect(grace).toContain('href="/settings/security/mfa/setup?next=%2Fsupport"');
    expect(grace).toContain('id="body"');

    for (const decision of ['pass', 'not_required'] as const) {
      h.requireRoleForPage.mockResolvedValue(actorWith(decision));
      const html = renderToStaticMarkup(await SupportAreaGuardLayout({ children: <p id="body">本文</p> }));
      expect(html).not.toContain('mfa-grace-banner');
      expect(html).toContain('id="body"');
    }

    // assurance の無い UserProfile (テストで作るリテラルなど) でもバナーを出さない
    h.requireRoleForPage.mockResolvedValue({ id: 'u-2', roles: ['support'] });
    expect(renderToStaticMarkup(await SupportAreaGuardLayout({ children: null }))).not.toContain('mfa-grace-banner');
  });
});

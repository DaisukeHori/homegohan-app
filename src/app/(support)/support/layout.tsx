/**
 * (support) 区画の server layout (#1176。docs/design/cross/12-operator-mfa.md §13.4.1。段 B)
 *
 * 外側の src/app/(support)/layout.tsx は "use client" で、client から user_profiles.roles を読むだけ (requireRole を通らない)。
 * その client layout は変えず、内側の support/ の階層にこの Server Component の layout を足して、区画の全画面
 * (support/page.tsx・support/inquiries/page.tsx・support/users/page.tsx) を requireRoleForPage で守る。
 * Server Component の redirect() はサーバーの描画の時点で効くので、client layout の useEffect より先に回る。
 */
import type { ReactNode } from 'react';
import { MfaGraceBanner } from '@/components/admin/MfaGraceBanner';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import type { RoleName } from '@/lib/auth/types';

/** この区画に入れるロール (外側の client layout の判定 src/app/(support)/layout.tsx と同じ 3 つ) */
const SUPPORT_AREA_ROLES: ReadonlyArray<RoleName> = ['support', 'admin', 'super_admin'];
/** 2FA の画面から戻る先 (区画のトップ) */
const SUPPORT_AREA_NEXT = '/support';
/** ロールが無い人の行き先 (外側の client layout と同じ) */
const SUPPORT_AREA_FORBIDDEN_PATH = '/home';

/** Cookie のセッションで毎回判定する (src/app/admin/layout.tsx と同じ) */
export const dynamic = 'force-dynamic';

export default async function SupportAreaGuardLayout({ children }: { children: ReactNode }) {
  const actor = await requireRoleForPage(SUPPORT_AREA_ROLES, {
    next: SUPPORT_AREA_NEXT,
    forbiddenPath: SUPPORT_AREA_FORBIDDEN_PATH,
  });
  const grace = actor.assurance?.decision === 'pass_grace' ? actor.assurance.enforce_from : null;
  return (
    <>
      {grace ? <MfaGraceBanner enforceFrom={grace} next={SUPPORT_AREA_NEXT} /> : null}
      {children}
    </>
  );
}

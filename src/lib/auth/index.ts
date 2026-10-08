/**
 * src/lib/auth barrel export
 */

export {
  requireUser,
  requireRole,
  requireOrgRole,
  requireOrgAdmin,
  impersonate,
  endImpersonation,
  isImpersonating,
  type RoleName,
  type OrgRoleName,
  type UserProfile,
  type OrgAdminContext,
} from './helpers';

export { AuthError, ForbiddenError, PermError, ImpersonationError } from './errors';

export type { ImpersonationResult } from './types';

export { getSafeRedirectPath, getSafeRedirectPathOrDefault } from './safe-redirect';

export { validatePassword, PASSWORD_MIN_LENGTH, PASSWORD_HINT_TEXT } from './validate-password';

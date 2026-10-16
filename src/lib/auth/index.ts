/**
 * src/lib/auth barrel export
 */

export {
  requireUser,
  requireRole,
  requireOrgRole,
  requireOrgAdmin,
  type RoleName,
  type OrgRoleName,
  type UserProfile,
  type OrgAdminContext,
  type RequireRoleOptions,
} from './helpers';

export { AuthError, ForbiddenError, PermError, MfaRequiredError, type MfaRequiredCode } from './errors';

export { requireRoleForPage, MFA_PAGE_PATHS } from './page-guard';

export { getSafeRedirectPath, getSafeRedirectPathOrDefault } from './safe-redirect';

export { validatePassword, PASSWORD_MIN_LENGTH, PASSWORD_HINT_TEXT } from './validate-password';

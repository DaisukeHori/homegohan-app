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
} from './helpers';

export { AuthError, ForbiddenError, PermError } from './errors';

export { getSafeRedirectPath, getSafeRedirectPathOrDefault } from './safe-redirect';

export { validatePassword, PASSWORD_MIN_LENGTH, PASSWORD_HINT_TEXT } from './validate-password';

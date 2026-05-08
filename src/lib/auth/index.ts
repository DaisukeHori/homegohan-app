/**
 * src/lib/auth barrel export
 */

export {
  requireUser,
  requireRole,
  requireOrgRole,
  impersonate,
  endImpersonation,
  isImpersonating,
  type RoleName,
  type OrgRoleName,
  type UserProfile,
} from './helpers';

export { AuthError, ForbiddenError, PermError, ImpersonationError } from './errors';

export type { ImpersonationResult } from './types';

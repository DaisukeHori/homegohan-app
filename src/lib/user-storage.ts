/**
 * User-scoped localStorage helpers.
 *
 * Keys that are specific to an authenticated session should be listed here.
 * Call `clearUserScopedLocalStorage()` on SIGNED_OUT to prevent sensitive
 * settings from leaking to the next user on a shared device.
 */

/**
 * localStorage keys that belong to a specific auth session.
 * These must be cleared when the user signs out.
 */
const USER_SCOPED_KEYS: readonly string[] = [
  // AI generate modal – range settings (v4_range_days, v4_include_existing)
  'v4_range_days',
  'v4_include_existing',
  // In-progress generation state trackers
  'v4MenuGenerating',
  'weeklyMenuGenerating',
  'singleMealGenerating',
  'shoppingListRegenerating',
  // Profile reminder dismissal
  'profile_reminder_dismissed',
];

/**
 * Removes all user-scoped localStorage keys.
 * Safe to call in a non-browser environment (no-op if `localStorage` is
 * not available, e.g. during SSR).
 */
export function clearUserScopedLocalStorage(): void {
  if (typeof window === 'undefined') return;
  for (const key of USER_SCOPED_KEYS) {
    localStorage.removeItem(key);
  }
}

/**
 * Broadcasts a SIGNED_OUT event to other tabs via BroadcastChannel (#145).
 * Call this after supabase.auth.signOut() to ensure all open tabs redirect.
 * Safe to call in a non-browser environment (no-op if BroadcastChannel is
 * not available).
 */
export function broadcastSignOut(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('auth');
  channel.postMessage('SIGNED_OUT');
  // Close immediately after posting — we only need a one-shot message.
  channel.close();
}

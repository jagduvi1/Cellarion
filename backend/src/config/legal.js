/**
 * Single source of truth for the current privacy-policy version.
 *
 * Bump this whenever the policy materially changes (e.g. a new sub-processor or a
 * new category of data processing). Both registration (routes/auth.js) and the
 * `requiresPolicyReconsent` flag on User.toJSON() read it, so every already-
 * registered user who accepted an older version is prompted to review and
 * acknowledge the update on their next session (frontend ReconsentModal → POST
 * /api/users/me/accept-policy). This is a client-side prompt, not a hard server
 * gate — it surfaces the updated terms and records re-acknowledgement; it does
 * not grant consent to any optional feature (AI chat, label scan), which stays
 * governed by per-feature use. Keep it in sync with the version shown on the
 * Privacy Policy page (frontend/src/pages/PrivacyPolicy.js).
 */
const CURRENT_PRIVACY_POLICY_VERSION = '2026-07';

module.exports = { CURRENT_PRIVACY_POLICY_VERSION };

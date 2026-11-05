/**
 * Error codes with one fixed meaning: code → the English `error` sent with it.
 *
 * A route answers `res.status(n).json(errorBody('invalid_credentials'))`, which
 * is `{ error: 'Invalid credentials', code: 'invalid_credentials' }`. The
 * English `error` stays for API clients; the app shows the translation
 * `errors.codes.<code>` when one exists (frontend utils/friendlyError.js) and
 * this English otherwise.
 *
 * A code listed here means the same thing wherever it is sent, which is what
 * makes it translatable: never reword one into another meaning or reuse it for
 * a different refusal — add a new code instead. `{{name}}` in a sentence is
 * filled from the same-named field, and that field is sent in the body too, so
 * the translation can use it. A count goes in `count`, so a translation can
 * have plural forms.
 *
 * Codes: snake_case starting with a letter (two older ones are upper case),
 * never ending in _one/_other/_zero/_two/_few/_many — Weblate reads a key
 * ending like that as a plural family. errorCodes.test.js holds these rules,
 * and the frontend's locales/errorCodes.test.js only accepts a translation
 * whose code is listed here.
 *
 * Other codes the server sends (`state_changed`, `invalid`, …) are not listed
 * yet; they keep their English until they are moved here with one meaning.
 */
const ERROR_CODES = {
  // Signing in
  credentials_required: 'Username and password are required',
  invalid_credentials: 'Invalid credentials',
  EMAIL_NOT_VERIFIED: 'Please verify your email address before logging in.',
  // Registration
  registration_fields_required: 'Username, email, and password are required',
  username_invalid: 'Username must be 3–30 characters and use only letters, numbers, dots, underscores, or hyphens.',
  consent_required: 'You must accept the privacy policy and consent to data processing to register',
  REGISTRATION_REJECTED: 'Registration failed. Please check your details and try again.',
  // Email confirmation and password reset
  verification_token_invalid: 'Invalid or expired verification token',
  reset_token_invalid: 'Invalid or expired reset token',
};

/** The JSON body of a coded error, with `fields` filled into the sentence and sent along. */
function errorBody(code, fields = {}) {
  const sentence = ERROR_CODES[code];
  if (sentence === undefined) throw new Error(`Unknown error code "${code}" — add it to config/errorCodes.js`);
  const error = sentence.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in fields ? String(fields[name]) : match));
  return { error, code, ...fields };
}

module.exports = { ERROR_CODES, errorBody };

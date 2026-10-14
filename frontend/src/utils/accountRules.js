// The account rules the server enforces, in one place for every form that
// checks them before submitting (register, change password, reset password).
// Server side: routes/auth.js (username) and models/User.js (password) — a
// change there must be made here too.

/** 3–30 characters: letters, numbers, dots, underscores, hyphens. */
export const USERNAME_RULE = /^[a-z0-9_.-]{3,30}$/i;

/** At least 12 characters with an uppercase and a lowercase letter, a digit and a symbol. */
export const PASSWORD_POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d]).{12,}$/;

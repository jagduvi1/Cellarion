const FormData = require('form-data');
const Mailgun = require('mailgun.js');

const EMAIL_VERIFICATION_ENABLED = !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);

/** Escape user-supplied values for safe interpolation into HTML emails. */
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let mg;
if (EMAIL_VERIFICATION_ENABLED) {
  const mailgun = new Mailgun(FormData);
  mg = mailgun.client({
    username: 'api',
    key: process.env.MAILGUN_API_KEY,
    url: process.env.MAILGUN_API_URL || 'https://api.mailgun.net'
  });
}

const DOMAIN = process.env.MAILGUN_DOMAIN;
const FROM = process.env.MAILGUN_FROM || `Cellarion <no-reply@${DOMAIN}>`;

/**
 * Send an email verification link to a newly registered user.
 * @param {string} toEmail  - Recipient email address
 * @param {string} username - Username for greeting
 * @param {string} token    - Raw (unhashed) verification token
 */
async function sendVerificationEmail(toEmail, username, token) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const link = `${frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;

  await mg.messages.create(DOMAIN, {
    from: FROM,
    to: [toEmail],
    subject: 'Verify your Cellarion account',
    text: [
      `Hello ${username},`,
      '',
      'Please verify your email address by visiting the link below.',
      'This link expires in 24 hours.',
      '',
      link,
      '',
      'If you did not create a Cellarion account, you can safely ignore this email.'
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#2a2a2a;">
        <p>Hello <strong>${escapeHtml(username)}</strong>,</p>
        <p>Please verify your email address by clicking the button below.
           This link expires in <strong>24 hours</strong>.</p>
        <p style="margin:2rem 0;">
          <a href="${link}"
             style="background:#7B9E88;color:#0d0d0d;padding:12px 28px;
                    border-radius:4px;text-decoration:none;font-weight:600;
                    display:inline-block;">
            Verify Email
          </a>
        </p>
        <p>Or copy this link into your browser:</p>
        <p style="word-break:break-all;color:#555;font-size:0.85em;">${link}</p>
        <hr style="border:none;border-top:1px solid #ddd;margin:2rem 0;" />
        <p style="color:#9A9484;font-size:0.85em;">
          If you did not create a Cellarion account, you can safely ignore this email.
        </p>
      </div>
    `
  });
}

/**
 * Send a password-reset link to a user.
 * @param {string} toEmail  - Recipient email address
 * @param {string} username - Username for greeting
 * @param {string} token    - Raw (unhashed) reset token
 */
async function sendPasswordResetEmail(toEmail, username, token) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const link = `${frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;

  await mg.messages.create(DOMAIN, {
    from: FROM,
    to: [toEmail],
    subject: 'Reset your Cellarion password',
    text: [
      `Hello ${username},`,
      '',
      'We received a request to reset the password for your Cellarion account.',
      'Click the link below to set a new password. This link expires in 1 hour.',
      '',
      link,
      '',
      'If you did not request a password reset, you can safely ignore this email.'
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#2a2a2a;">
        <p>Hello <strong>${escapeHtml(username)}</strong>,</p>
        <p>We received a request to reset the password for your Cellarion account.
           Click the button below to set a new password.
           This link expires in <strong>1 hour</strong>.</p>
        <p style="margin:2rem 0;">
          <a href="${link}"
             style="background:#7B9E88;color:#0d0d0d;padding:12px 28px;
                    border-radius:4px;text-decoration:none;font-weight:600;
                    display:inline-block;">
            Reset Password
          </a>
        </p>
        <p>Or copy this link into your browser:</p>
        <p style="word-break:break-all;color:#555;font-size:0.85em;">${link}</p>
        <hr style="border:none;border-top:1px solid #ddd;margin:2rem 0;" />
        <p style="color:#9A9484;font-size:0.85em;">
          If you did not request a password reset, you can safely ignore this email.
        </p>
      </div>
    `
  });
}

/**
 * Send a drink-window digest email summarising bottles that need attention.
 * @param {string} toEmail
 * @param {string} username
 * @param {Array<{name:string, vintage:string, status:string}>} bottles
 */
async function sendDrinkWindowDigest(toEmail, username, bottles, userId) {
  if (!EMAIL_VERIFICATION_ENABLED || !bottles.length) return;
  // userId is required to build a working one-click unsubscribe link (GDPR
  // right to object). Fail loudly rather than ship an email whose unsubscribe
  // token resolves to "undefined" and is rejected by the unsubscribe route.
  if (!userId) throw new Error('sendDrinkWindowDigest: userId is required for the unsubscribe link');

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const { createUnsubscribeToken } = require('../utils/unsubscribe');
  const unsubToken = createUnsubscribeToken(userId);
  // Use FRONTEND_URL — the unsubscribe endpoint lives on the backend but is
  // routed through the same public host as the SPA via Traefik (/api/* → backend).
  // Using BACKEND_URL was a footgun: it isn't set on the standard deployment
  // and silently fell back to http://localhost:5000, shipping broken links in
  // every email. FRONTEND_URL is already required for CORS so it's guaranteed
  // present in any working production setup.
  const unsubLink = `${frontendUrl}/api/users/unsubscribe?token=${unsubToken}`;

  const statusLabel = (s) =>
    s === 'peak'      ? 'Entered peak — drink now'
    : s === 'ending'  ? 'Peak ending soon — don\'t miss it'
    : 'Past its window — drink immediately';

  const statusColor = (s) =>
    s === 'peak' ? '#2D7A45' : s === 'ending' ? '#D4A373' : '#C0504D';

  const rows = bottles.map(b => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(b.name)} ${escapeHtml(b.vintage)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:${statusColor(b.status)};font-weight:600;">
        ${statusLabel(b.status)}
      </td>
    </tr>
  `).join('');

  const textLines = bottles.map(b => `- ${b.name} ${b.vintage}: ${statusLabel(b.status)}`);

  await mg.messages.create(DOMAIN, {
    from: FROM,
    to: [toEmail],
    subject: `Cellarion: ${bottles.length} bottle${bottles.length > 1 ? 's' : ''} need${bottles.length === 1 ? 's' : ''} your attention`,
    text: [
      `Hello ${username},`,
      '',
      'Some bottles in your cellar have drink-window updates:',
      '',
      ...textLines,
      '',
      `View your cellar: ${frontendUrl}/cellars`,
      '',
      `You can manage these alerts in Settings > Notifications, or unsubscribe here: ${unsubLink}`
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#2a2a2a;">
        <p>Hello <strong>${escapeHtml(username)}</strong>,</p>
        <p>Some bottles in your cellar have drink-window updates:</p>
        <table style="width:100%;border-collapse:collapse;margin:1rem 0;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:8px 12px;text-align:left;font-size:0.85em;">Wine</th>
              <th style="padding:8px 12px;text-align:left;font-size:0.85em;">Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin:2rem 0;">
          <a href="${frontendUrl}/cellars"
             style="background:#7B9E88;color:#0d0d0d;padding:12px 28px;
                    border-radius:4px;text-decoration:none;font-weight:600;
                    display:inline-block;">
            View your cellar
          </a>
        </p>
        <hr style="border:none;border-top:1px solid #ddd;margin:2rem 0;" />
        <p style="color:#9A9484;font-size:0.85em;">
          You can manage these alerts in Settings &gt; Notifications.
          <br /><a href="${unsubLink}" style="color:#9A9484;">Unsubscribe from all emails</a>
        </p>
      </div>
    `
  });
}

/**
 * Send a wine recommendation email to someone who is not yet a Cellarion user.
 * @param {string} toEmail     - Recipient email address
 * @param {string} senderName  - Display name of the sender
 * @param {object} wine        - Wine object with name, producer, appellation
 * @param {string} note        - Personal note from the sender
 */
async function sendRecommendationEmail(toEmail, senderName, wine, note) {
  if (!EMAIL_VERIFICATION_ENABLED) return;

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const wineLink = `${frontendUrl}/wines/${wine._id}`;
  const wineName = wine.name || 'a wine';
  const producer = wine.producer ? ` by ${wine.producer}` : '';

  await mg.messages.create(DOMAIN, {
    from: FROM,
    to: [toEmail],
    subject: `${senderName} recommends a wine on Cellarion`,
    text: [
      `Hello,`,
      '',
      `${senderName} thinks you'd enjoy ${wineName}${producer}.`,
      ...(note ? ['', `"${note}"`] : []),
      '',
      `View this wine on Cellarion: ${wineLink}`,
      '',
      'Cellarion is a wine cellar management app. Sign up to save this wine to your wishlist!',
      `${frontendUrl}`
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#2a2a2a;">
        <p>Hello,</p>
        <p><strong>${escapeHtml(senderName)}</strong> thinks you'd enjoy
           <strong>${escapeHtml(wineName)}</strong>${escapeHtml(producer)}.</p>
        ${note ? `<blockquote style="border-left:3px solid #7B9E88;padding:8px 16px;margin:1rem 0;color:#555;font-style:italic;">"${escapeHtml(note)}"</blockquote>` : ''}
        <p style="margin:2rem 0;">
          <a href="${wineLink}"
             style="background:#7B9E88;color:#0d0d0d;padding:12px 28px;
                    border-radius:4px;text-decoration:none;font-weight:600;
                    display:inline-block;">
            View Wine
          </a>
        </p>
        <hr style="border:none;border-top:1px solid #ddd;margin:2rem 0;" />
        <p style="color:#9A9484;font-size:0.85em;">
          <a href="${frontendUrl}" style="color:#9A9484;">Cellarion</a> is a wine cellar management app.
          Sign up to save this wine to your wishlist!
        </p>
      </div>
    `
  });
}

/**
 * Send a cellar sharing invitation email to someone who is not yet a Cellarion user.
 * @param {string} toEmail       - Recipient email address
 * @param {string} senderName    - Display name / username of the person sharing
 * @param {string} senderEmail   - Email of the person sharing
 * @param {string} cellarName    - Name of the cellar being shared
 * @param {string} role          - 'viewer' or 'editor'
 */
async function sendCellarInviteEmail(toEmail, senderName, senderEmail, cellarName, role) {
  if (!EMAIL_VERIFICATION_ENABLED) return;

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const registerLink = `${frontendUrl}/register`;
  const googlePlayLink = 'https://play.google.com/store/apps/details?id=app.cellarion.twa';
  const websiteLink = 'https://cellarion.app';
  const roleLabel = role === 'editor' ? 'view and edit' : 'view';

  await mg.messages.create(DOMAIN, {
    from: FROM,
    to: [toEmail],
    subject: `${senderName} wants to share a wine cellar with you on Cellarion`,
    text: [
      'Hello,',
      '',
      `${senderName} (${senderEmail}) wants to share their wine cellar "${cellarName}" with you so you can ${roleLabel} it.`,
      '',
      'To accept the invitation, create a free Cellarion account using this email address:',
      registerLink,
      '',
      'Once you sign up, the shared cellar will automatically appear in your account.',
      '',
      'You can also get Cellarion on Google Play:',
      googlePlayLink,
      '',
      `Or visit our website: ${websiteLink}`,
      '',
      'Cheers!',
      'The Cellarion Team'
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#2a2a2a;">
        <p>Hello,</p>
        <p><strong>${escapeHtml(senderName)}</strong> (${escapeHtml(senderEmail)}) wants to share their wine cellar
           <strong>&ldquo;${escapeHtml(cellarName)}&rdquo;</strong> with you so you can ${roleLabel} it.</p>
        <p>To accept the invitation, create a free Cellarion account using this email address:</p>
        <p style="margin:2rem 0;">
          <a href="${registerLink}"
             style="background:#7B9E88;color:#0d0d0d;padding:12px 28px;
                    border-radius:4px;text-decoration:none;font-weight:600;
                    display:inline-block;">
            Join Cellarion
          </a>
        </p>
        <p>Once you sign up, the shared cellar will automatically appear in your account.</p>
        <p style="margin-top:1.5rem;">
          <a href="${googlePlayLink}" style="color:#7B9E88;font-weight:600;">Get it on Google Play</a>
          &nbsp;&middot;&nbsp;
          <a href="${websiteLink}" style="color:#7B9E88;font-weight:600;">Visit cellarion.app</a>
        </p>
        <hr style="border:none;border-top:1px solid #ddd;margin:2rem 0;" />
        <p style="color:#9A9484;font-size:0.85em;">
          Cheers!<br />The Cellarion Team
        </p>
      </div>
    `
  });
}

/**
 * Email a forum participant when someone replies to / quotes / mentions them.
 * No-ops when Mailgun isn't configured. The recipient is responsible for
 * having opted in via preferences.notifications.email — the route handler
 * checks that before calling this function.
 *
 * @param {string} toEmail
 * @param {string} recipientName  display/username of the recipient (greeting)
 * @param {string} recipientId    user ObjectId (for the unsubscribe token)
 * @param {string} replierName
 * @param {string} discussionTitle
 * @param {string} discussionUrl  full URL to the discussion (incl. anchor)
 * @param {string} replyText      plain-text reply preview (already sanitized)
 * @param {string} kind           'reply' | 'quote' | 'mention'
 */
async function sendDiscussionReplyEmail(toEmail, recipientName, recipientId, replierName, discussionTitle, discussionUrl, replyText, kind = 'reply') {
  if (!EMAIL_VERIFICATION_ENABLED) return;

  const { createUnsubscribeToken } = require('../utils/unsubscribe');
  const unsubToken = createUnsubscribeToken(recipientId);
  // See sendDrinkWindowDigest for why this uses FRONTEND_URL not BACKEND_URL.
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const unsubLink = `${frontendUrl}/api/users/unsubscribe?token=${unsubToken}`;

  const verb = kind === 'quote' ? 'quoted you' : kind === 'mention' ? 'mentioned you' : 'replied to your discussion';
  const subject = kind === 'quote'
    ? `${replierName} quoted you in "${discussionTitle}"`
    : kind === 'mention'
      ? `${replierName} mentioned you in "${discussionTitle}"`
      : `${replierName} replied to "${discussionTitle}"`;

  const previewText = (replyText || '').slice(0, 280);

  await mg.messages.create(DOMAIN, {
    from: FROM,
    to: [toEmail],
    subject,
    text: [
      `Hello ${recipientName},`,
      '',
      `${replierName} ${verb}: "${discussionTitle}".`,
      '',
      previewText ? `> ${previewText}` : '',
      '',
      `Read and reply: ${discussionUrl}`,
      '',
      `To stop receiving these emails: ${unsubLink}`
    ].filter(Boolean).join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#2a2a2a;">
        <p>Hello <strong>${escapeHtml(recipientName)}</strong>,</p>
        <p><strong>${escapeHtml(replierName)}</strong> ${verb}:
           <em>${escapeHtml(discussionTitle)}</em>.</p>
        ${previewText ? `<blockquote style="border-left:3px solid #D4A373;margin:1rem 0;padding:0.25rem 0.75rem;color:#555;">${escapeHtml(previewText)}</blockquote>` : ''}
        <p style="margin:1.5rem 0;">
          <a href="${discussionUrl}"
             style="background:#7B9E88;color:#0d0d0d;padding:10px 22px;
                    border-radius:4px;text-decoration:none;font-weight:600;
                    display:inline-block;">
            Read and reply
          </a>
        </p>
        <hr style="border:none;border-top:1px solid #ddd;margin:2rem 0;" />
        <p style="color:#9A9484;font-size:0.85em;">
          You're getting this because you have community email notifications turned on.
          <a href="${unsubLink}" style="color:#9A9484;">Unsubscribe</a>.
        </p>
      </div>
    `
  });
}

/**
 * Notify a user that their account just got locked after too many failed
 * login attempts (per-account brute-force protection). Deliberately vague
 * about source IPs — those are usually rotating residential proxies and
 * say nothing useful to an end user. The CTA is "reset your password if
 * it wasn't you" because that's the recovery path that also clears the
 * lockout.
 *
 * Dedupe is handled upstream in utils/loginAttempts.js — this function is
 * only called once per dedupe window.
 *
 * @param {string} toEmail
 * @param {string} username
 */
async function sendAccountLockoutAlert(toEmail, username) {
  if (!EMAIL_VERIFICATION_ENABLED) return;

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const resetUrl = `${frontendUrl}/forgot-password`;

  await mg.messages.create(DOMAIN, {
    from: FROM,
    to: [toEmail],
    subject: 'Cellarion: suspicious login activity on your account',
    text: [
      `Hello ${username},`,
      '',
      'We noticed a high number of failed login attempts on your Cellarion account in a short window of time. As a precaution, the account has been temporarily locked.',
      '',
      'If this was you (forgotten password, typing the wrong one), you can wait the cooldown period and try again — or reset your password right away to regain access immediately:',
      '',
      resetUrl,
      '',
      'If this was NOT you, someone may be trying to guess your password. We strongly recommend resetting it via the link above. The reset link will also clear the lock immediately.',
      '',
      'You do not need to take any action if you recognise the attempts as your own.',
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#2a2a2a;">
        <p>Hello <strong>${escapeHtml(username)}</strong>,</p>
        <p>We noticed a <strong>high number of failed login attempts</strong> on your Cellarion account in a short window of time. As a precaution, the account has been temporarily locked.</p>
        <p>If this was you (forgotten password, typing the wrong one), you can wait the cooldown period and try again — or reset your password right away to regain access immediately.</p>
        <p style="margin:2rem 0;">
          <a href="${resetUrl}"
             style="background:#7B9E88;color:#0d0d0d;padding:12px 28px;
                    border-radius:4px;text-decoration:none;font-weight:600;
                    display:inline-block;">
            Reset password
          </a>
        </p>
        <p>If this was <strong>NOT</strong> you, someone may be trying to guess your password. We strongly recommend resetting it via the link above. The reset link will also clear the lock immediately.</p>
        <hr style="border:none;border-top:1px solid #ddd;margin:2rem 0;" />
        <p style="color:#9A9484;font-size:0.85em;">
          You do not need to take any action if you recognise the attempts as your own.
        </p>
      </div>
    `
  });
}

/**
 * Notify the site admin that a security threshold was crossed. The audit log
 * already captures every event; this is the spike-only ping.
 */
async function sendSecurityAlertEmail(toEmail, trigger) {
  if (!EMAIL_VERIFICATION_ENABLED) return;

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const auditUrl = `${frontendUrl}/super-admin`;
  const windowMin = Math.round((trigger.windowMs || 0) / 60000);

  let subject, summary;
  if (trigger.kind === 'lockout_spike') {
    subject = `Cellarion security: ${trigger.count} account lockouts in ${windowMin} min`;
    summary = `${trigger.count} account-lockout events fired in the last ${windowMin} minutes (threshold: ${trigger.threshold}). This may indicate a credential-stuffing campaign targeting multiple accounts.`;
  } else if (trigger.kind === 'user_rate_limit_spike') {
    subject = `Cellarion security: user ${trigger.userId} hitting rate limits`;
    summary = `One user (id ${trigger.userId}) triggered ${trigger.count} rate-limit events in the last ${windowMin} minutes (threshold: ${trigger.threshold}). Worth a look in the audit log to decide if this is a stuck client or active abuse.`;
  } else {
    subject = `Cellarion security: ${trigger.kind}`;
    summary = JSON.stringify(trigger);
  }

  await mg.messages.create(DOMAIN, {
    from: FROM,
    to: [toEmail],
    subject,
    text: [
      subject,
      '',
      summary,
      '',
      `Audit log: ${auditUrl} (Audit Log tab)`,
      '',
      'Sent once per spike type per 4 hours. You will not get a stream of these.',
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#2a2a2a;">
        <p><strong>${escapeHtml(subject)}</strong></p>
        <p>${escapeHtml(summary)}</p>
        <p style="margin:2rem 0;">
          <a href="${auditUrl}"
             style="background:#7B9E88;color:#0d0d0d;padding:12px 28px;
                    border-radius:4px;text-decoration:none;font-weight:600;
                    display:inline-block;">
            Open audit log
          </a>
        </p>
        <hr style="border:none;border-top:1px solid #ddd;margin:2rem 0;" />
        <p style="color:#9A9484;font-size:0.85em;">
          Sent once per spike type per 4 hours. You will not get a stream of these.
        </p>
      </div>
    `,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendDrinkWindowDigest, sendRecommendationEmail, sendCellarInviteEmail, sendDiscussionReplyEmail, sendAccountLockoutAlert, sendSecurityAlertEmail, EMAIL_VERIFICATION_ENABLED };

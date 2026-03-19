const FormData = require('form-data');
const Mailgun = require('mailgun.js');

const EMAIL_VERIFICATION_ENABLED = !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);

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
        <p>Hello <strong>${username}</strong>,</p>
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
        <p>Hello <strong>${username}</strong>,</p>
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
async function sendDrinkWindowDigest(toEmail, username, bottles) {
  if (!EMAIL_VERIFICATION_ENABLED || !bottles.length) return;

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  const statusLabel = (s) =>
    s === 'peak'      ? 'Entered peak — drink now'
    : s === 'ending'  ? 'Peak ending soon — don\'t miss it'
    : 'Past its window — drink immediately';

  const statusColor = (s) =>
    s === 'peak' ? '#2D7A45' : s === 'ending' ? '#D4A373' : '#C0504D';

  const rows = bottles.map(b => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${b.name} ${b.vintage}</td>
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
      'You can manage these alerts in Settings > Notifications.'
    ].join('\n'),
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#2a2a2a;">
        <p>Hello <strong>${username}</strong>,</p>
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
        </p>
      </div>
    `
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendDrinkWindowDigest, EMAIL_VERIFICATION_ENABLED };

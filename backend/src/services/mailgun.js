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

module.exports = { sendVerificationEmail, EMAIL_VERIFICATION_ENABLED };

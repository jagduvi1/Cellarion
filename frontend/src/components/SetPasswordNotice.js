import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { requestPasswordReset } from '../api/auth';

/**
 * Shown wherever a password-confirmed action meets an SSO-only account
 * (user.hasPassword === false): explains why there is no password and offers
 * to email a set-password link — the SAME battle-tested reset flow the login
 * page uses, so control of the INBOX (not just this browser session) is what
 * mints the first password. A hijacked session must not be able to grant
 * itself a password silently.
 *
 * Pass `text` to override the default "this action asks for a password"
 * explanation (e.g. the Settings card supplies its own hint).
 */
export default function SetPasswordNotice({ text }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error

  const send = async () => {
    setStatus('sending');
    try {
      const res = await requestPasswordReset(user.email);
      setStatus(res.ok ? 'sent' : 'error');
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="set-password-notice">
      <p className="settings-hint">
        {text || t('settings.setPassword.notice',
          'You sign in with Google, so this account has no password yet — and this action asks for one as extra confirmation.')}
      </p>
      {status === 'sent' ? (
        <p className="settings-saved">
          {t('settings.setPassword.sent',
            "Link sent — check your inbox. After you set a password you'll be signed out everywhere once; sign back in with Google or your new password.")}
        </p>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={send}
          disabled={status === 'sending'}
        >
          {status === 'sending'
            ? t('settings.setPassword.sending', 'Sending…')
            : t('settings.setPassword.cta', 'Email me a set-password link')}
        </button>
      )}
      {status === 'error' && (
        <div className="alert alert-error">
          {t('settings.setPassword.error', 'Could not send the email — please try again.')}
        </div>
      )}
    </div>
  );
}

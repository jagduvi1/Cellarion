import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import CellarionLogo from '../components/CellarionLogo';
import { previewAccountDeletion, confirmAccountDeletion } from '../api/accountDeletion';
import './Login.css';

const longDate = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

// Where the "Not for you? Delete your account" link in our emails lands, no
// login needed. Opening it only SHOWS which account would go and what is in it;
// nothing happens until the button is pressed (mail scanners open links on
// their own). The deletion is the same 7-day one as Settings, cancelled by
// logging in before the date.
function DeleteAccountLink() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tokenRef = useRef(null);
  const ranRef = useRef(false);

  // 'checking' | 'ready' | 'invalid' | 'done'
  const [status, setStatus] = useState('checking');
  const [account, setAccount] = useState(null);
  const [scheduledFor, setScheduledFor] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);

  // Read the token once (StrictMode mounts twice) and drop it from the address
  // bar so it is not kept in history or reported anywhere.
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    const token = searchParams.get('token');
    if (!token) { setStatus('invalid'); return; }
    tokenRef.current = token;
    setSearchParams(new URLSearchParams(), { replace: true });

    previewAccountDeletion(token)
      .then(async (res) => {
        if (!res.ok) { setStatus('invalid'); return; }
        const data = await res.json();
        setAccount(data);
        if (data.deletionScheduledFor) {
          setScheduledFor(data.deletionScheduledFor);
          setStatus('done');
        } else {
          setStatus('ready');
        }
      })
      .catch(() => setStatus('invalid'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async () => {
    setDeleting(true);
    setFailed(false);
    try {
      const res = await confirmAccountDeletion(tokenRef.current);
      if (res.status === 400) { setStatus('invalid'); return; }
      if (!res.ok) { setFailed(true); return; }
      const data = await res.json();
      setScheduledFor(data.deletionScheduledFor);
      setStatus('done');
    } catch {
      setFailed(true);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <CellarionLogo size={90} color="var(--color-primary)" showText />
          <p>{t('deleteAccountLink.title', 'Delete your Cellarion account')}</p>
        </div>

        {status === 'checking' && (
          <div className="alert alert-info">{t('deleteAccountLink.checking', 'Checking the link…')}</div>
        )}

        {status === 'ready' && account && (
          <>
            <p>
              <Trans i18nKey="deleteAccountLink.intro" values={{ username: account.username }} components={{ strong: <strong /> }}>
                This deletes the account <strong>{'{{username}}'}</strong> and everything in it.
              </Trans>
            </p>
            <p>
              {account.bottles > 0
                ? t('deleteAccountLink.bottles', { count: account.bottles })
                : t('deleteAccountLink.noBottles', 'There are no bottles in it yet.')}
            </p>
            {account.supporter && (
              <p>{t('deleteAccountLink.supporter', 'Your supporter subscription is cancelled too.')}</p>
            )}
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
              {t('deleteAccountLink.grace', 'Nothing is removed straight away: you have 7 days to change your mind. Log in before then and cancel it in Settings.')}
            </p>
            {failed && (
              <div className="alert alert-error">{t('deleteAccountLink.failed', 'Something went wrong. Please try again.')}</div>
            )}
            <button className="btn btn-danger btn-full" onClick={handleDelete} disabled={deleting}>
              {deleting ? t('deleteAccountLink.deleting', 'Deleting…') : t('deleteAccountLink.confirm', 'Delete my account')}
            </button>
            <p style={{ textAlign: 'center', marginTop: '1rem' }}>
              <Link to="/">{t('deleteAccountLink.keep', 'Keep my account')}</Link>
            </p>
          </>
        )}

        {status === 'done' && scheduledFor && (
          <>
            <div className="alert alert-success">
              <Trans i18nKey="deleteAccountLink.scheduled" values={{ date: longDate(scheduledFor) }} components={{ strong: <strong /> }}>
                Your account will be deleted on <strong>{'{{date}}'}</strong>.
              </Trans>
            </div>
            <p>{t('deleteAccountLink.changeMind', 'Changed your mind? Log in before then and choose Cancel deletion in Settings.')}</p>
            <p style={{ textAlign: 'center' }}>
              <Link to="/login">{t('deleteAccountLink.logIn', 'Log in')}</Link>
            </p>
          </>
        )}

        {status === 'invalid' && (
          <>
            <div className="alert alert-error">
              {t('deleteAccountLink.invalid', 'This link no longer works. The links in our emails work for 14 days.')}
            </div>
            <p>{t('deleteAccountLink.useSettings', 'You can still delete your account from Settings after you log in.')}</p>
            <p style={{ textAlign: 'center' }}>
              <Link to="/login">{t('deleteAccountLink.logIn', 'Log in')}</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default DeleteAccountLink;

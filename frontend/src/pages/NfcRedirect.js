import { useEffect, useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { resolveNfcRack } from '../api/racks';
import { buildRackUrl } from '../utils/rackNavigation';

function NfcRedirect() {
  const { t } = useTranslation();
  const { rackId } = useParams();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const rackNavPref = user?.preferences?.rackNavigation || 'auto';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await resolveNfcRack(apiFetch, rackId);
        const data = await res.json();
        if (!res.ok) {
          if (!cancelled) setError(data.error || t('nfc.rackNotFound'));
          return;
        }
        if (!cancelled) {
          const url = buildRackUrl(data.cellarId, {
            rackId: data.rackId,
            inRoom: data.inRoom,
            preference: rackNavPref,
          });
          navigate(url, { replace: true });
        }
      } catch {
        if (!cancelled) setError(t('nfc.networkError'));
      }
    })();
    return () => { cancelled = true; };
  }, [rackId, apiFetch, navigate, t, rackNavPref]);

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p className="alert alert-error">{error}</p>
        <button className="btn btn-primary" onClick={() => navigate('/cellars', { replace: true })}>
          {t('nfc.goToCellars')}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
      <p>{t('nfc.redirecting')}</p>
    </div>
  );
}

export default NfcRedirect;

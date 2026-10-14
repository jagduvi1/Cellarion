import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getOwnerInquiry } from '../api/ownerInquiries';
import OwnerInquiryCard from '../components/bottle/OwnerInquiryCard';
import './CuratorQuestion.css';

/**
 * What a curator-question notification opens (support ticket 2026-10-14).
 *
 * The notification used to link straight to the bottle the question was sent
 * about, and that link went dead once the bottle or its cellar was deleted.
 * Now it opens this page, which asks the server for a bottle page of the wine
 * the member can open NOW and goes there (the question card renders on it).
 * With no bottle of the wine left, the question shows here on its own, still
 * answerable — the card is keyed by the wine, not the bottle.
 */
export default function CuratorQuestion() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [state, setState] = useState({ status: 'loading' }); // loading | standalone | gone | error
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    (async () => {
      try {
        const res = await getOwnerInquiry(apiFetch, id);
        if (!active) return;
        if (res.status === 404) { setState({ status: 'gone' }); return; }
        const data = await res.json().catch(() => ({}));
        if (!active) return;
        if (!res.ok || !data.inquiry) { setState({ status: 'error' }); return; }
        if (data.inquiry.link) { navigate(data.inquiry.link, { replace: true }); return; }
        setState({ status: 'standalone', inquiry: data.inquiry });
      } catch {
        if (active) setState({ status: 'error' });
      }
    })();
    return () => { active = false; };
  }, [apiFetch, id, navigate, attempt]);

  if (state.status === 'loading') {
    return <div className="curator-question-page"><p className="loading">{t('common.loading', 'Loading…')}</p></div>;
  }

  if (state.status === 'error') {
    return (
      <div className="curator-question-page">
        <p className="error-message" role="alert">{t('curatorQuestion.loadError', 'Could not load the question.')}</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setAttempt((n) => n + 1)}>
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  if (state.status === 'gone') {
    return (
      <div className="curator-question-page">
        <h1>{t('curatorQuestion.goneTitle', 'This question is closed')}</h1>
        <p>{t('curatorQuestion.gone', 'The curators have closed this question, or it was not addressed to you. Nothing is needed from you.')}</p>
        <Link to="/cellars" className="btn btn-secondary btn-small">{t('curatorQuestion.toCellars', 'Go to your cellars')}</Link>
      </div>
    );
  }

  const { inquiry } = state;
  const wineLabel = inquiry.wine ? [inquiry.wine.producer, inquiry.wine.name].filter(Boolean).join(' — ') : '';
  return (
    <div className="curator-question-page">
      <h1>{t('curatorQuestion.title', 'A curator’s question')}</h1>
      {wineLabel && <p className="curator-question-wine"><strong>{wineLabel}</strong></p>}
      <p className="curator-question-hint">
        {t('curatorQuestion.noBottle', 'You have no bottle of this wine in Cellarion any more. If you remember the label, or still have a photo of it, you can answer here.')}
      </p>
      {inquiry.wine?._id && <OwnerInquiryCard apiFetch={apiFetch} wineId={inquiry.wine._id} />}
      {inquiry.responded && !inquiry.curatorReply && (
        <p className="curator-question-answered" role="status">
          {t('curatorQuestion.answered', 'You answered this question. Thank you — the curators will take it from here.')}
        </p>
      )}
    </div>
  );
}

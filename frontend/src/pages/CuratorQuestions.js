import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getMyOwnerInquiries } from '../api/ownerInquiries';
import { formatVintage } from '../utils/vintage';
import OwnerInquiryCard from '../components/bottle/OwnerInquiryCard';
import { AnsweredQuestion } from './CuratorQuestion';
import './CuratorQuestion.css';

/**
 * Every curator question addressed to the member, in one place. Answering
 * means walking to the bottle and reading its label, so the questions still
 * waiting for an answer are grouped by the cellar the member's bottle is in;
 * the ones they answered follow, with where each one stands. A single
 * question opens on CuratorQuestion.js (`/questions/:id`), which goes on to
 * the bottle page.
 */
export default function CuratorQuestions() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [state, setState] = useState({ status: 'loading' }); // loading | ready | error
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Each run owns its flag: a retry or leaving the page retires the earlier
    // request, so its late answer never replaces a newer one.
    let active = true;
    setState({ status: 'loading' });
    (async () => {
      try {
        const res = await getMyOwnerInquiries(apiFetch);
        const data = res.ok ? await res.json().catch(() => null) : null;
        if (!active) return;
        if (!Array.isArray(data?.inquiries)) { setState({ status: 'error' }); return; }
        setState({ status: 'ready', inquiries: data.inquiries });
      } catch {
        if (active) setState({ status: 'error' });
      }
    })();
    return () => { active = false; };
  }, [apiFetch, attempt]);

  if (state.status === 'loading') {
    return <div className="curator-question-page"><p className="loading">{t('common.loading', 'Loading…')}</p></div>;
  }

  if (state.status === 'error') {
    return (
      <div className="curator-question-page">
        <p className="error-message" role="alert">{t('curatorQuestions.loadError', 'Could not load your questions.')}</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setAttempt((n) => n + 1)}>
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  const waiting = state.inquiries.filter(isAnswerable);
  const answered = state.inquiries.filter((i) => i.responded).sort(newestFirst);
  const groups = groupByCellar(waiting);

  return (
    <div className="curator-question-page curator-questions-page">
      <h1>{t('curatorQuestions.title', 'Questions from the curators')}</h1>
      <p className="curator-questions-intro">
        {t('curatorQuestions.intro', 'When a wine’s record needs something only the label can tell, the curators ask its owners. Each question can be answered once.')}
      </p>

      {waiting.length === 0 && answered.length === 0 && (
        <div className="empty-state">
          <p>{t('curatorQuestions.empty', 'No questions from the curators right now.')}</p>
          <Link to="/cellars" className="btn btn-secondary btn-small">{t('curatorQuestion.toCellars', 'Go to your cellars')}</Link>
        </div>
      )}

      {waiting.length > 0 && (
        <section aria-labelledby="curator-questions-waiting">
          <h2 id="curator-questions-waiting">{t('curatorQuestions.waitingTitle', 'Waiting for your answer')}</h2>
          {groups.map((group) => (
            <div key={group.cellar ? group.cellar._id : 'none'}>
              <h3>{group.cellar ? group.cellar.name : t('curatorQuestions.noCellar', 'Not in any of your cellars')}</h3>
              <ul className="curator-questions-list">
                {group.rows.map((inquiry) => (
                  <QuestionItem key={inquiry._id} inquiry={inquiry} apiFetch={apiFetch} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {answered.length > 0 && (
        <section aria-labelledby="curator-questions-answered">
          <h2 id="curator-questions-answered">{t('curatorQuestions.answeredTitle', 'Answered')}</h2>
          <ul className="curator-questions-list">
            {answered.map((inquiry) => (
              <QuestionItem key={inquiry._id} inquiry={inquiry} apiFetch={apiFetch} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// The server's rule for a question the member can still answer (the card's
// form): not answered by them, and not resolved or closed.
const isAnswerable = (i) => !i.responded && (i.status === 'open' || i.status === 'answered');

const newestFirst = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);

// One group per cellar, by name; questions whose bottle is in none of the
// member's cellars come last. Grouped by id: two cellars may share a name.
function groupByCellar(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.cellar ? String(row.cellar._id) : '';
    if (!groups.has(key)) groups.set(key, { cellar: row.cellar || null, rows: [] });
    groups.get(key).rows.push(row);
  }
  for (const group of groups.values()) group.rows.sort(newestFirst);
  return [...groups.values()].sort((a, b) => {
    if (!a.cellar || !b.cellar) return (a.cellar ? 0 : 1) - (b.cellar ? 0 : 1);
    return a.cellar.name.localeCompare(b.cellar.name, undefined, { sensitivity: 'base' })
      || String(a.cellar._id).localeCompare(String(b.cellar._id));
  });
}

function QuestionItem({ inquiry, apiFetch }) {
  const { t } = useTranslation();
  const answerable = isAnswerable(inquiry);
  const wineLabel = inquiry.wine ? [inquiry.wine.producer, inquiry.wine.name].filter(Boolean).join(' — ') : '';
  // 'Unknown' is a stored code, not a vintage worth showing.
  const vintage = inquiry.vintage && String(inquiry.vintage).toLowerCase() !== 'unknown'
    ? formatVintage(inquiry.vintage, t)
    : '';
  // The card's own line says "you own a bottle of it"; with the bottle in
  // none of their cellars that may no longer be true.
  const intro = answerable && !inquiry.cellar
    ? t('curatorQuestions.introNoCellar', 'If you remember the label, or have a photo of it, you can answer here. Answering is optional; only registry curators see your answer.')
    : null;
  return (
    <li className="curator-questions-item">
      {(wineLabel || vintage) && (
        <p className="curator-question-wine">
          <strong>{wineLabel}</strong>{vintage && ` ${vintage}`}
        </p>
      )}
      {answerable || inquiry.curatorReply ? (
        <OwnerInquiryCard apiFetch={apiFetch} wineId={inquiry.wine?._id} inquiry={inquiry} intro={intro} />
      ) : (
        <AnsweredQuestion inquiry={inquiry} />
      )}
      {/* The question's own page goes on to a bottle of the wine the member can open now. */}
      <Link to={`/questions/${inquiry._id}`} className="curator-questions-open">
        {t('curatorQuestions.openBottle', 'Open the bottle')}
      </Link>
    </li>
  );
}

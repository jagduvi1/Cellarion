import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getMyOwnerInquiries, respondToOwnerInquiry } from '../../api/ownerInquiries';

/**
 * Curator question about THIS bottle's wine, addressed to the viewer — the
 * owner side of the owner-inquiry loop (backend routes/ownerInquiries.js).
 * Renders only when the mine endpoint returns an unanswered inquiry for the
 * wine; answering is single-shot (the server keeps answers immutable), and
 * "ignore" is the other valid response — no dismissal state needed. This is
 * a CONTENT card, not a bottle action, so it lives once in the page body
 * (the two-action-surfaces rule for header/mobile actions does not apply).
 */
function OwnerInquiryCard({ apiFetch, wineId }) {
  const { t } = useTranslation();
  const [inquiry, setInquiry] = useState(null);
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!wineId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await getMyOwnerInquiries(apiFetch, wineId);
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        // Already-answered inquiries stay server-side for the curator; the
        // card only exists while the viewer can still contribute.
        const open = (data.inquiries || []).find((i) => !i.responded);
        if (open) setInquiry(open);
      } catch {
        // Non-critical card — the bottle page works without it.
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, wineId]);

  if (!inquiry) return null;

  const submit = async (e) => {
    e.preventDefault();
    const text = answer.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await respondToOwnerInquiry(apiFetch, inquiry._id, text);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSent(true);
      } else {
        setError(data.error || t('bottleDetail.ownerInquiry.sendError', 'Could not send your answer — please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="card oi-card" style={{ padding: '1rem 1.25rem', borderLeft: '3px solid var(--color-primary, #7c2d3a)' }}>
      <h2 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>
        {t('bottleDetail.ownerInquiry.title', 'A curator has a question about this wine')}
      </h2>
      <p style={{ margin: '0 0 0.6rem', color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
        {t('bottleDetail.ownerInquiry.intro', 'You own a bottle of it, so you can check what research cannot. Answering is optional; only registry curators see your answer.')}
      </p>
      <blockquote style={{ margin: '0 0 0.75rem', padding: '0.5rem 0.75rem', background: 'var(--color-surface, rgba(0,0,0,0.04))', borderRadius: 'var(--radius-sm)', fontSize: '0.95rem' }}>
        {inquiry.question}
      </blockquote>

      {sent ? (
        <p role="status" style={{ margin: 0, fontWeight: 600 }}>
          {t('bottleDetail.ownerInquiry.thanks', 'Thank you — your answer was sent to the curators and helps keep the shared registry accurate.')}
        </p>
      ) : (
        <form onSubmit={submit}>
          {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t('bottleDetail.ownerInquiry.placeholder', 'e.g. The label says “E. Pira e Figli — Chiara Boschis” on the front.')}
            maxLength={1000}
            rows={3}
            disabled={sending}
            style={{ width: '100%', marginBottom: 8 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="submit" className="btn btn-primary btn-small" disabled={sending || !answer.trim()}>
              {sending
                ? t('bottleDetail.ownerInquiry.sending', 'Sending…')
                : t('bottleDetail.ownerInquiry.send', 'Send answer')}
            </button>
            <span style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
              {t('bottleDetail.ownerInquiry.oneShot', 'One answer per owner — it cannot be edited after sending.')}
            </span>
          </div>
        </form>
      )}
    </div>
  );
}

export default OwnerInquiryCard;

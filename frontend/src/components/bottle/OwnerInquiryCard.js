import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getMyOwnerInquiries, respondToOwnerInquiry } from '../../api/ownerInquiries';

/**
 * Curator question about THIS bottle's wine, addressed to the viewer — the
 * owner side of the owner-inquiry loop (backend routes/ownerInquiries.js).
 * Answering is single-shot (the server keeps answers immutable), and "ignore"
 * is the other valid response — no dismissal state needed. This is a CONTENT
 * card, not a bottle action, so it lives once in the page body (the
 * two-action-surfaces rule for header/mobile actions does not apply).
 *
 * Two states, in priority order:
 *   ASK    — an unanswered inquiry: the question and the answer form.
 *   REPLY  — one the viewer answered and a curator has since resolved WITH a
 *            reply. Before this the card simply vanished on resolve, so
 *            someone who walked to their shelf and read a back label for us
 *            got silence; the reply is why they would do it a second time.
 * An unanswered question outranks a reply — it is the one that still needs
 * them. Replies are transient by design: the server stops returning them 30
 * days after resolution.
 */
function OwnerInquiryCard({ apiFetch, wineId }) {
  const { t } = useTranslation();
  const [inquiry, setInquiry] = useState(null);
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  // Terminal 409 (already answered / inquiry closed) — the form hides so the
  // error message can't invite retries that only 409 again.
  const [closed, setClosed] = useState(false);
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
        const rows = data.inquiries || [];
        // A question they can still answer beats a reply they can only read.
        const open = rows.find((i) => !i.responded);
        const replied = rows.find((i) => i.responded && i.curatorReply);
        if (open || replied) setInquiry(open || replied);
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
        // 409 is terminal (already answered, or the inquiry closed) — hide the
        // form so the error can't invite retries that only 409 again.
        if (res.status === 409) setClosed(true);
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setSending(false);
    }
  };

  // The viewer answered and a curator has replied — read-only outcome card.
  const isReply = inquiry.responded && !!inquiry.curatorReply;

  const quoteStyle = {
    margin: '0 0 0.75rem', padding: '0.5rem 0.75rem',
    background: 'var(--color-surface, rgba(0,0,0,0.04))',
    borderRadius: 'var(--radius-sm)', fontSize: '0.95rem',
  };

  if (isReply) {
    return (
      <div className="card oi-card" style={{ padding: '1rem 1.25rem', borderLeft: '3px solid var(--color-primary, #7c2d3a)' }}>
        <h2 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>
          {t('bottleDetail.ownerInquiry.replyTitle', 'A curator replied about this wine')}
        </h2>
        <p style={{ margin: '0 0 0.6rem', color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
          {t('bottleDetail.ownerInquiry.replyIntro', 'You answered a question about this wine — here is what came of it. Thank you: the shared registry is more accurate because you checked.')}
        </p>
        <blockquote style={quoteStyle}>{inquiry.question}</blockquote>
        <p style={{ margin: '0 0 0.25rem', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
          {t('bottleDetail.ownerInquiry.yourAnswer', 'Your answer')}
        </p>
        <blockquote style={{ ...quoteStyle, fontSize: '0.9rem' }}>{inquiry.myResponse}</blockquote>
        <p style={{ margin: '0 0 0.25rem', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
          {t('bottleDetail.ownerInquiry.curatorReply', 'The curator’s reply')}
        </p>
        <blockquote style={{ ...quoteStyle, margin: 0, borderLeft: '2px solid var(--color-primary, #7c2d3a)' }}>
          {inquiry.curatorReply}
        </blockquote>
      </div>
    );
  }

  return (
    <div className="card oi-card" style={{ padding: '1rem 1.25rem', borderLeft: '3px solid var(--color-primary, #7c2d3a)' }}>
      <h2 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>
        {t('bottleDetail.ownerInquiry.title', 'A curator has a question about this wine')}
      </h2>
      <p style={{ margin: '0 0 0.6rem', color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
        {t('bottleDetail.ownerInquiry.intro', 'You own a bottle of it, so you can check what research cannot. Answering is optional; only registry curators see your answer.')}
      </p>
      <blockquote style={quoteStyle}>
        {inquiry.question}
      </blockquote>

      {sent ? (
        <p role="status" style={{ margin: 0, fontWeight: 600 }}>
          {t('bottleDetail.ownerInquiry.thanks', 'Thank you — your answer was sent to the curators and helps keep the shared registry accurate.')}
        </p>
      ) : closed ? (
        error && <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>
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

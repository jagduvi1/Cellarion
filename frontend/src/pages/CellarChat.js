import { useState, useRef, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { useAuth } from '../contexts/AuthContext';
import './CellarChat.css';

// ── Session storage keys ─────────────────────────────────────────────────────

const SESSION_MESSAGES_KEY = 'cellarChat.messages';
const SESSION_CONTEXT_KEY = 'cellarChat.wineContext';

// ── Starter prompts by category (i18n keys under cellarChat.*) ───────────────

const PROMPT_CATEGORIES = [
  {
    key: 'foodPairing',
    promptKeys: ['food1', 'food2', 'food3', 'food4'],
  },
  {
    key: 'occasion',
    promptKeys: ['occasion1', 'occasion2', 'occasion3', 'occasion4'],
  },
  {
    key: 'cellarCheck',
    promptKeys: ['cellar1', 'cellar2', 'cellar3', 'cellar4'],
  },
  {
    key: 'moodStyle',
    promptKeys: ['mood1', 'mood2', 'mood3', 'mood4'],
  },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function WineCard({ wine }) {
  const hasLink = wine.cellarId && wine.bottleId;
  const Wrapper = hasLink ? Link : 'div';
  const linkProps = hasLink
    ? { to: `/cellars/${wine.cellarId}/bottles/${wine.bottleId}`, state: { fromChat: true } }
    : {};

  return (
    <Wrapper className="cellar-chat__wine-card" aria-label={wine.grapes?.join(', ')} {...linkProps}>
      <div className="cellar-chat__wine-card-name">{wine.name}</div>
      <div className="cellar-chat__wine-card-meta">
        {wine.vintage} · {wine.producer}
      </div>
      {wine.region && (
        <div className="cellar-chat__wine-card-meta">{wine.region}</div>
      )}
      {hasLink && <div className="cellar-chat__wine-card-arrow">›</div>}
    </Wrapper>
  );
}

function ExpandedQueryHint({ text }) {
  const { t } = useTranslation();
  return (
    <div className="cellar-chat__expanded-query">
      <span className="cellar-chat__expanded-query-label">{t('cellarChat.searchingFor')}</span>
      <span className="cellar-chat__expanded-query-text">{text}</span>
    </div>
  );
}

function Message({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`cellar-chat__msg cellar-chat__msg--${isUser ? 'user' : 'assistant'}`}>
      <div className={`cellar-chat__bubble${msg.thinking ? ' cellar-chat__bubble--thinking' : ''}`}>
        {isUser || msg.thinking
          ? msg.text
          : <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{msg.text}</ReactMarkdown>
        }
      </div>
      {msg.expandedQuery && <ExpandedQueryHint text={msg.expandedQuery} />}
      {msg.wines?.length > 0 && (
        <div className="cellar-chat__wines">
          {msg.wines.map((w) => (
            <WineCard key={w.bottleId || w.wineDefinitionId} wine={w} />
          ))}
        </div>
      )}
    </div>
  );
}

function StarterPrompts({ onSelect, disabled }) {
  const { t } = useTranslation();
  const [openCategory, setOpenCategory] = useState(null);

  return (
    <div className="cellar-chat__starters">
      <div className="cellar-chat__starters-title">{t('cellarChat.tryAsking')}</div>
      <div className="cellar-chat__starters-categories">
        {PROMPT_CATEGORIES.map((cat) => (
          <div key={cat.key} className="cellar-chat__starter-cat">
            <button
              className={`cellar-chat__starter-cat-btn${openCategory === cat.key ? ' open' : ''}`}
              onClick={() => setOpenCategory(openCategory === cat.key ? null : cat.key)}
            >
              {t(`cellarChat.categories.${cat.key}`)}
            </button>
            {openCategory === cat.key && (
              <div className="cellar-chat__starter-prompts">
                {cat.promptKeys.map((p) => (
                  <button
                    key={p}
                    className="cellar-chat__prompt-chip"
                    onClick={() => { onSelect(t(`cellarChat.prompts.${p}`)); setOpenCategory(null); }}
                    disabled={disabled}
                  >
                    {t(`cellarChat.prompts.${p}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="cellar-chat__tip">
        <strong>{t('cellarChat.tipLabel')}</strong> {t('cellarChat.tipBody')}
        <br />
        <Trans i18nKey="cellarChat.tipExample" components={{ 1: <em />, 3: <em /> }} />
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CellarChat() {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const defaultCellarId = user?.preferences?.defaultCellarId || null;

  const [cellars, setCellars] = useState([]);
  const [selectedCellarIds, setSelectedCellarIds] = useState(
    () => defaultCellarId ? [defaultCellarId] : []
  );
  const [cellarPickerOpen, setCellarPickerOpen] = useState(false);

  // Fetch user's cellars for the selector
  useEffect(() => {
    apiFetch('/api/cellars')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.cellars) setCellars(data.cellars);
      })
      .catch(() => {});
  }, [apiFetch]);

  // Restore from sessionStorage on mount
  const [messages, setMessages] = useState(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_MESSAGES_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [wineContext, setWineContext] = useState(() => {
    try {
      return sessionStorage.getItem(SESSION_CONTEXT_KEY) || null;
    } catch { return null; }
  });

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [usage, setUsage] = useState(null);
  const bottomRef = useRef(null);

  // Persist conversation to sessionStorage
  useEffect(() => {
    try {
      const toSave = messages.filter(m => !m.thinking);
      sessionStorage.setItem(SESSION_MESSAGES_KEY, JSON.stringify(toSave));
      sessionStorage.setItem(SESSION_CONTEXT_KEY, wineContext || '');
    } catch { /* quota exceeded or private mode */ }
  }, [messages, wineContext]);

  useEffect(() => {
    apiFetch('/api/chat/usage')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setUsage(data); })
      .catch(() => {});
  }, [apiFetch]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const atLimit = usage && usage.limit !== -1 && usage.used >= usage.limit;

  // Build conversation history from messages state (text only, no wine cards / thinking)
  const buildHistory = useCallback(() =>
    messages
      .filter(m => !m.thinking)
      .map(m => ({ role: m.role, content: m.text })),
    [messages]
  );

  const send = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || loading || atLimit) return;

    const history = buildHistory();
    const hasHistory = history.length > 0;

    setError(null);
    setMessages(prev => [...prev, { role: 'user', text: trimmed }]);
    setInput('');
    setLoading(true);

    const thinkingText = hasHistory && wineContext
      ? t('cellarChat.thinking')
      : t('cellarChat.searchingCellar');
    setMessages(prev => [...prev, { role: 'assistant', text: thinkingText, thinking: true }]);

    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          useQueryExpansion: true,
          history,
          previousWines: wineContext,
          cellarIds: selectedCellarIds.length > 0 ? selectedCellarIds : [],
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessages(prev => prev.filter(m => !m.thinking));
        // Two kinds of 429: the daily/period quota carries used/limit in its
        // body; the per-minute burst limiter doesn't. Only lock the composer
        // for a real quota exhaustion — burst 429s just show the error above.
        if (res.status === 429 && data.limit != null && data.used != null) {
          setError(t(
            data.period === 'weekly' ? 'cellarChat.errorQuotaWeekly' : 'cellarChat.errorQuotaDaily',
            { count: data.limit }
          ));
          setUsage(prev => prev
            ? { ...prev, used: Math.max(data.used, data.limit), limit: data.limit, period: data.period || prev.period }
            : null);
        } else if (res.status === 429) {
          setError(t('cellarChat.errorBurst'));
        } else {
          setError(data.error || t('cellarChat.errorGeneric'));
        }
        return;
      }

      // Update usage
      if (data.used != null) {
        setUsage(prev => prev
          ? { ...prev, used: data.used, period: data.period || prev.period }
          : { used: data.used, limit: data.limit, plan: user?.plan || 'free', period: data.period || 'daily' }
        );
      }

      // Save wine context for follow-ups
      if (data.wineContext) setWineContext(data.wineContext);

      // Replace thinking bubble with final answer
      setMessages(prev => [
        ...prev.filter(m => !m.thinking),
        { role: 'assistant', text: data.answer || '', wines: data.wines || [], expandedQuery: data.expandedQuery || null },
      ]);
    } catch {
      setMessages(prev => prev.filter(m => !m.thinking));
      setError(t('cellarChat.errorNetwork'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    send(input);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const startNewChat = () => {
    setMessages([]);
    setWineContext(null);
    setError(null);
  };

  const usagePeriodLabel = usage?.period === 'weekly'
    ? t('cellarChat.usagePeriodWeek')
    : t('cellarChat.usagePeriodToday');
  const usageLabel = usage
    ? (usage.limit === -1 ? null : `${usage.used} / ${usage.limit} ${usagePeriodLabel}`)
    : null;

  return (
    <div className="cellar-chat">
      <div className="cellar-chat__header">
        <h1 className="cellar-chat__title">{t('cellarChat.title')}</h1>
        <div className="cellar-chat__header-controls">
          {messages.length > 0 && (
            <button
              className="cellar-chat__new-chat"
              onClick={startNewChat}
              disabled={loading}
              aria-label={t('cellarChat.newChatAria')}
            >
              {t('cellarChat.newChat')}
            </button>
          )}
          {usageLabel && (
            <span className={`cellar-chat__usage${atLimit ? ' at-limit' : ''}`}>
              {usageLabel}
            </span>
          )}
        </div>
      </div>

      {cellars.length > 1 && (
        <div className="cellar-chat__scope">
          <button
            type="button"
            className="cellar-chat__scope-btn"
            onClick={() => setCellarPickerOpen(o => !o)}
            aria-expanded={cellarPickerOpen}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M2 4h16M5 10h10M8 16h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            {selectedCellarIds.length === 0
              ? t('cellarChat.allCellars')
              : selectedCellarIds.length === 1
                ? (cellars.find(c => c._id === selectedCellarIds[0])?.name || t('cellarChat.selectedCellar'))
                : t('cellarChat.nCellars', { count: selectedCellarIds.length })}
          </button>
          {cellarPickerOpen && (
            <div className="cellar-chat__scope-dropdown">
              <label className="cellar-chat__scope-option">
                <input
                  type="checkbox"
                  checked={selectedCellarIds.length === 0}
                  onChange={() => setSelectedCellarIds([])}
                />
                <span>{t('cellarChat.allCellars')}</span>
              </label>
              {cellars.map(c => (
                <label key={c._id} className="cellar-chat__scope-option">
                  <input
                    type="checkbox"
                    checked={selectedCellarIds.includes(c._id)}
                    onChange={() => {
                      setSelectedCellarIds(prev => {
                        if (prev.includes(c._id)) {
                          const next = prev.filter(id => id !== c._id);
                          return next;
                        }
                        return [...prev, c._id];
                      });
                    }}
                  />
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="cellar-chat__messages">
        {messages.length === 0 ? (
          <StarterPrompts onSelect={send} disabled={loading} />
        ) : (
          messages.map((msg, i) => <Message key={i} msg={msg} />)
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="cellar-chat__error">{error}</div>}

      <form className="cellar-chat__form" onSubmit={handleSubmit}>
        <textarea
          className="cellar-chat__input"
          placeholder={atLimit
            ? (usage?.period === 'weekly' ? t('cellarChat.placeholderLimitWeekly') : t('cellarChat.placeholderLimitDaily'))
            : t('cellarChat.placeholder')}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={loading || atLimit}
          rows={1}
        />
        <button
          type="submit"
          className="cellar-chat__send"
          disabled={loading || !input.trim() || atLimit}
          aria-label={t('cellarChat.send')}
        >
          ↑
        </button>
      </form>
    </div>
  );
}

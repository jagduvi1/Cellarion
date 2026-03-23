import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAuth } from '../contexts/AuthContext';
import './CellarChat.css';

// ── Session storage keys ─────────────────────────────────────────────────────

const SESSION_MESSAGES_KEY = 'cellarChat.messages';
const SESSION_CONTEXT_KEY = 'cellarChat.wineContext';

// ── Starter prompts by category ──────────────────────────────────────────────

const PROMPT_CATEGORIES = [
  {
    label: 'Food pairing',
    prompts: [
      "I'm making lamb with rosemary tonight — what should I open?",
      "What pairs well with grilled salmon from my cellar?",
      "I'm having a cheese board with friends — what do you suggest?",
      "What goes with a rich beef stew?",
    ],
  },
  {
    label: 'Occasion',
    prompts: [
      "I need something special for a birthday dinner for two.",
      "We're celebrating an anniversary — what's the best bottle I have?",
      "Something easy and relaxed for a summer barbecue.",
      "What's a good bottle to bring as a gift?",
    ],
  },
  {
    label: 'Cellar check',
    prompts: [
      "What's drinking well in my cellar right now?",
      "Do I have anything that's past its peak and should drink soon?",
      "What's my most interesting bottle right now?",
      "Show me something I might have forgotten about.",
    ],
  },
  {
    label: 'Mood & style',
    prompts: [
      "I want something light and fresh for a weeknight.",
      "Something bold and tannic to go with a steak.",
      "I'm in the mood for something elegant and complex.",
      "What's a good summer evening wine from my cellar?",
    ],
  },
];

// ── SSE parser ───────────────────────────────────────────────────────────────

function parseSSEChunk(buffer) {
  const events = [];
  const lines = buffer.split('\n');
  let eventType = null;

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7);
    } else if (line.startsWith('data: ') && eventType) {
      try {
        events.push({ type: eventType, data: JSON.parse(line.slice(6)) });
      } catch { /* skip malformed */ }
      eventType = null;
    } else if (line === '') {
      eventType = null;
    }
  }

  return events;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function WineCard({ wine }) {
  return (
    <div className="cellar-chat__wine-card" aria-label={wine.grapes?.join(', ')}>
      <div className="cellar-chat__wine-card-name">{wine.name}</div>
      <div className="cellar-chat__wine-card-meta">
        {wine.vintage} · {wine.producer}
      </div>
      {wine.region && (
        <div className="cellar-chat__wine-card-meta">{wine.region}</div>
      )}
    </div>
  );
}

function ExpandedQueryHint({ text }) {
  return (
    <div className="cellar-chat__expanded-query">
      <span className="cellar-chat__expanded-query-label">Searching for</span>
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
          : <ReactMarkdown>{msg.text}</ReactMarkdown>
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
  const [openCategory, setOpenCategory] = useState(null);

  return (
    <div className="cellar-chat__starters">
      <div className="cellar-chat__starters-title">Try asking…</div>
      <div className="cellar-chat__starters-categories">
        {PROMPT_CATEGORIES.map((cat) => (
          <div key={cat.label} className="cellar-chat__starter-cat">
            <button
              className={`cellar-chat__starter-cat-btn${openCategory === cat.label ? ' open' : ''}`}
              onClick={() => setOpenCategory(openCategory === cat.label ? null : cat.label)}
            >
              {cat.label}
            </button>
            {openCategory === cat.label && (
              <div className="cellar-chat__starter-prompts">
                {cat.prompts.map((p) => (
                  <button
                    key={p}
                    className="cellar-chat__prompt-chip"
                    onClick={() => { onSelect(p); setOpenCategory(null); }}
                    disabled={disabled}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="cellar-chat__tip">
        <strong>Tip:</strong> describe food, occasion, or mood for the best results.
        <br />
        <em>"Grilled salmon with herb butter"</em> works much better than <em>"white wine"</em>.
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CellarChat() {
  const { apiFetch, user } = useAuth();

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

  const atLimit = usage && usage.used >= usage.limit;

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
      ? 'Thinking…'
      : 'Searching your cellar…';
    setMessages(prev => [...prev, { role: 'assistant', text: thinkingText, thinking: true }]);

    try {
      const res = await apiFetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          useQueryExpansion: true,
          history,
          previousWines: wineContext,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setMessages(prev => prev.filter(m => !m.thinking));
        setError(data.error || 'Something went wrong.');
        if (res.status === 429) {
          setUsage(prev => prev ? { ...prev, used: prev.limit } : null);
        }
        return;
      }

      // Replace thinking bubble with empty streaming bubble
      setMessages(prev => [
        ...prev.filter(m => !m.thinking),
        { role: 'assistant', text: '', wines: [], expandedQuery: null },
      ]);

      // Read SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let pendingUpdate = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on double newlines (SSE event boundary)
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // keep incomplete last part

        for (const part of parts) {
          const events = parseSSEChunk(part + '\n\n');
          for (const evt of events) {
            if (evt.type === 'usage') {
              setUsage(prev => prev
                ? { ...prev, used: evt.data.used, period: evt.data.period || prev.period }
                : { used: evt.data.used, limit: evt.data.limit, plan: user?.plan || 'free', period: evt.data.period || 'daily' }
              );
            } else if (evt.type === 'meta') {
              if (evt.data.wineContext) setWineContext(evt.data.wineContext);
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = {
                    ...last,
                    wines: evt.data.wines || [],
                    expandedQuery: evt.data.expandedQuery || null,
                  };
                }
                return updated;
              });
            } else if (evt.type === 'delta') {
              fullText += evt.data.text;
              // Batch UI updates with requestAnimationFrame
              if (!pendingUpdate) {
                pendingUpdate = true;
                const textSnapshot = fullText;
                requestAnimationFrame(() => {
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') {
                      updated[updated.length - 1] = { ...last, text: textSnapshot };
                    }
                    return updated;
                  });
                  pendingUpdate = false;
                });
              }
            } else if (evt.type === 'done') {
              // Final update with complete text
              const finalText = fullText;
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, text: finalText };
                }
                return updated;
              });
            } else if (evt.type === 'error') {
              setError(evt.data.error || 'Something went wrong.');
            }
          }
        }
      }

      // Ensure final text is set (in case rAF hasn't fired yet)
      if (fullText) {
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant' && last.text !== fullText) {
            updated[updated.length - 1] = { ...last, text: fullText };
          }
          return updated;
        });
      }
    } catch {
      setMessages(prev => prev.filter(m => !m.thinking));
      setError('Network error — please try again.');
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

  const usagePeriodLabel = usage?.period === 'weekly' ? 'this week' : 'today';
  const usageLabel = usage ? `${usage.used} / ${usage.limit} ${usagePeriodLabel}` : null;

  return (
    <div className="cellar-chat">
      <div className="cellar-chat__header">
        <h1 className="cellar-chat__title">Cellar Chat</h1>
        <div className="cellar-chat__header-controls">
          {messages.length > 0 && (
            <button
              className="cellar-chat__new-chat"
              onClick={startNewChat}
              disabled={loading}
              aria-label="Start a new conversation"
            >
              New chat
            </button>
          )}
          {usageLabel && (
            <span className={`cellar-chat__usage${atLimit ? ' at-limit' : ''}`}>
              {usageLabel}
            </span>
          )}
        </div>
      </div>

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
            ? (usage?.period === 'weekly' ? 'Weekly limit reached — try again in a few days' : 'Daily limit reached — resets at midnight UTC')
            : 'Ask about your cellar… (Enter to send, Shift+Enter for new line)'}
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
          aria-label="Send"
        >
          ↑
        </button>
      </form>
    </div>
  );
}

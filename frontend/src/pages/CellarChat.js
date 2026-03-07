import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './CellarChat.css';

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

// ── Sub-components ────────────────────────────────────────────────────────────

function WineCard({ wine }) {
  return (
    <div className="cellar-chat__wine-card" title={wine.grapes?.join(', ')}>
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
        {msg.text}
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

const EXPANSION_KEY = 'cellarChat.useQueryExpansion';

export default function CellarChat() {
  const { apiFetch, user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [usage, setUsage] = useState(null);
  const [useExpansion, setUseExpansion] = useState(() => {
    try { return localStorage.getItem(EXPANSION_KEY) !== 'false'; } catch { return true; }
  });
  const bottomRef = useRef(null);

  useEffect(() => {
    apiFetch('/api/chat/usage')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setUsage(data); })
      .catch(() => {});
  }, [apiFetch]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const toggleExpansion = () => {
    setUseExpansion(v => {
      try { localStorage.setItem(EXPANSION_KEY, String(!v)); } catch {}
      return !v;
    });
  };

  const atLimit = usage && usage.used >= usage.limit;

  const send = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || loading || atLimit) return;

    setError(null);
    setMessages(prev => [...prev, { role: 'user', text: trimmed }]);
    setInput('');
    setLoading(true);
    setMessages(prev => [...prev, { role: 'assistant', text: useExpansion ? 'Expanding your question…' : 'Searching your cellar…', thinking: true }]);

    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, useQueryExpansion: useExpansion }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessages(prev => prev.filter(m => !m.thinking));
        setError(data.error || 'Something went wrong.');
        if (res.status === 429) {
          setUsage(prev => prev ? { ...prev, used: prev.limit } : null);
        }
        return;
      }

      setMessages(prev => [
        ...prev.filter(m => !m.thinking),
        {
          role: 'assistant',
          text: data.answer,
          wines: data.wines || [],
          expandedQuery: data.expandedQuery || null,
        },
      ]);
      setUsage(prev => prev
        ? { ...prev, used: data.used }
        : { used: data.used, limit: data.limit, plan: user?.plan || 'free' }
      );
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

  const usageLabel = usage ? `${usage.used} / ${usage.limit} today` : null;

  return (
    <div className="cellar-chat">
      <div className="cellar-chat__header">
        <h1 className="cellar-chat__title">Cellar Chat</h1>
        <div className="cellar-chat__header-controls">
          <label className="cellar-chat__expansion-toggle" title="Smart query expansion rewrites your question into wine terminology before searching, improving matches for food or occasion questions.">
            <input
              type="checkbox"
              checked={useExpansion}
              onChange={toggleExpansion}
            />
            <span>Smart search</span>
          </label>
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
          placeholder={atLimit ? 'Daily limit reached — resets at midnight UTC' : 'Ask about your cellar… (Enter to send, Shift+Enter for new line)'}
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

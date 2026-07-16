import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { num, ago, StatusDot, PlanBadge, useApi } from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_MODELS = [
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    description: 'Fast & affordable — recommended for Cellar Chat',
    inputPrice: '$1.00',
    outputPrice: '$5.00',
    tier: 'economy',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Previous-generation Sonnet — high quality at standard price',
    inputPrice: '$3.00',
    outputPrice: '$15.00',
    tier: 'standard',
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    description: 'Near-Opus quality — recommended for wine identification & profiles ($2/$10 intro until Aug 2026)',
    inputPrice: '$3.00',
    outputPrice: '$15.00',
    tier: 'standard',
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    description: 'Most capable — best for complex palate matching',
    inputPrice: '$5.00',
    outputPrice: '$25.00',
    tier: 'premium',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Shared panel building blocks
// ─────────────────────────────────────────────────────────────────────────────

const tierColor = { economy: 'var(--sa-accent)', standard: 'var(--sa-accent2)', premium: '#c9a84c' };

const codeStyle = { background: 'var(--sa-bg)', padding: '1px 4px', borderRadius: 2 };

const modelRow = (m, groupName, checked, onChange, activeMark) => (
  <label
    key={m.id}
    style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '8px 12px',
      borderRadius: 4,
      border: `1px solid ${checked ? 'var(--sa-accent)' : 'var(--sa-border)'}`,
      background: checked ? 'rgba(123,158,136,0.06)' : 'transparent',
      cursor: 'pointer',
    }}
  >
    <input
      type="radio"
      name={groupName}
      value={m.id}
      checked={checked}
      onChange={onChange}
      style={{ marginTop: 2, accentColor: 'var(--sa-accent)', flexShrink: 0 }}
    />
    <div style={{ flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--sa-text)' }}>{m.name}</span>
        <span style={{ fontSize: 10, color: tierColor[m.tier], border: `1px solid ${tierColor[m.tier]}`, borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {m.tier}
        </span>
        {activeMark && <span style={{ fontSize: 10, color: 'var(--sa-accent)', marginLeft: 'auto' }}>● active</span>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 2 }}>{m.description}</div>
      <div style={{ fontSize: 10, color: 'var(--sa-text-dim)', fontFamily: 'monospace' }}>
        Input: {m.inputPrice} / M &nbsp;·&nbsp; Output: {m.outputPrice} / M tokens
      </div>
    </div>
  </label>
);

function ModelPickerPanel({ title, endpoint, groupName, intro, currentModel, defaultModel = 'claude-haiku-4-5-20251001', successMsg = 'Saved — takes effect immediately', apiFetch }) {
  const [selected, setSelected] = useState(currentModel || defaultModel);
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState(null);

  const isDirty = selected !== currentModel;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selected }),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: successMsg });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">{title}</span>
        <button className="sa-btn" onClick={save} disabled={saving || !isDirty}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          {intro}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {CHAT_MODELS.map(m => modelRow(
            m, groupName,
            selected === m.id,
            () => setSelected(m.id),
            m.id === currentModel
          ))}
        </div>
        {msg && (
          <div style={{ marginTop: 12, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}

function PromptPanel({ title, endpoint, intro, prompt, rows = 14, maxChars = 6000, successMsg = 'Saved — takes effect immediately', apiFetch }) {
  const [val, setVal] = useState(prompt || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: val }),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: successMsg });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">{title}</span>
        <button className="sa-btn" onClick={save} disabled={saving || !val.trim()}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 8 }}>
          {intro}
        </div>
        <textarea
          value={val}
          onChange={e => setVal(e.target.value)}
          rows={rows}
          style={{ width: '100%', background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '8px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical', boxSizing: 'border-box' }}
        />
        <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--sa-text-dim)' }}>{val.length} / {maxChars} chars</span>
          {msg && (
            <span style={{ fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-panels
// ─────────────────────────────────────────────────────────────────────────────

function ChatModelPanel({ currentModel, currentFallback, apiFetch }) {
  const [selected, setSelected]   = useState(currentModel || 'claude-haiku-4-5-20251001');
  const [fallback, setFallback]   = useState(currentFallback || 'none');
  const [saving, setSaving]       = useState(false);
  const [msg, setMsg]             = useState(null);

  const isDirty = selected !== currentModel || (fallback === 'none' ? null : fallback) !== currentFallback;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/superadmin/ai/chat-model', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selected,
          fallbackModel: fallback === 'none' ? null : fallback,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved — takes effect immediately' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Cellar Chat — AI Model</span>
        <button className="sa-btn" onClick={save} disabled={saving || !isDirty}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      <div className="sa-panel-body">

        {/* Primary */}
        <div style={{ fontSize: 10, color: 'var(--sa-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Primary model
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
          {CHAT_MODELS.map(m => modelRow(
            m, 'chatModel',
            selected === m.id,
            () => { setSelected(m.id); if (fallback === m.id) setFallback('none'); },
            m.id === currentModel
          ))}
        </div>

        {/* Fallback */}
        <div style={{ fontSize: 10, color: 'var(--sa-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Fallback model <span style={{ textTransform: 'none', letterSpacing: 0 }}>— used automatically on 529 overloaded</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 4, border: `1px solid ${fallback === 'none' ? 'var(--sa-accent)' : 'var(--sa-border)'}`, background: fallback === 'none' ? 'rgba(123,158,136,0.06)' : 'transparent', cursor: 'pointer' }}>
            <input type="radio" name="chatFallback" value="none" checked={fallback === 'none'} onChange={() => setFallback('none')} style={{ accentColor: 'var(--sa-accent)' }} />
            <span style={{ fontSize: 12, color: 'var(--sa-text-dim)' }}>None — no fallback</span>
          </label>
          {CHAT_MODELS.filter(m => m.id !== selected).map(m => modelRow(
            m, 'chatFallback',
            fallback === m.id,
            () => setFallback(m.id),
            m.id === currentFallback
          ))}
        </div>

        {msg && (
          <div style={{ marginTop: 12, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}

function SystemPromptPanel({ prompt, apiFetch }) {
  return (
    <PromptPanel
      title="Cellar Chat — System Prompt"
      endpoint="/api/superadmin/ai/system-prompt"
      intro="This prompt is sent to Claude before every chat message. Takes effect immediately on save."
      prompt={prompt}
      rows={10}
      maxChars={4000}
      apiFetch={apiFetch}
    />
  );
}

function LabelScanPromptPanel({ prompt, apiFetch }) {
  return (
    <PromptPanel
      title="Label Scan — AI Prompt"
      endpoint="/api/superadmin/ai/label-scan-prompt"
      intro="This prompt is sent to Claude when a user scans a wine label. It controls how wine data is extracted and inferred. Takes effect immediately on save."
      prompt={prompt}
      apiFetch={apiFetch}
    />
  );
}

function LabelScanModelPanel({ currentModel, apiFetch }) {
  return (
    <ModelPickerPanel
      title="Label Scan — AI Model"
      endpoint="/api/superadmin/ai/label-scan-model"
      groupName="labelScanModel"
      intro="Model used when scanning wine labels with the camera. Haiku is fast and cheap; Sonnet or Opus may read difficult labels more accurately."
      currentModel={currentModel}
      apiFetch={apiFetch}
    />
  );
}

function ImportLookupModelPanel({ currentModel, apiFetch }) {
  return (
    <ModelPickerPanel
      title="Import Lookup — AI Model"
      endpoint="/api/superadmin/ai/import-lookup-model"
      groupName="importLookupModel"
      intro="Model used to identify wines during bottle import when no match is found in the library."
      currentModel={currentModel}
      apiFetch={apiFetch}
    />
  );
}

function ImportLookupPromptPanel({ prompt, apiFetch }) {
  return (
    <PromptPanel
      title="Import Lookup — AI Prompt"
      endpoint="/api/superadmin/ai/import-lookup-prompt"
      intro={<>Prompt sent to Claude when a wine can't be found in the library during import. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{vintage}}'}</code>, <code style={codeStyle}>{'{{country}}'}</code> placeholders.</>}
      prompt={prompt}
      apiFetch={apiFetch}
    />
  );
}

function MaturitySuggestModelPanel({ currentModel, apiFetch }) {
  return (
    <ModelPickerPanel
      title="Maturity Suggest — AI Model"
      endpoint="/api/superadmin/ai/maturity-suggest-model"
      groupName="maturitySuggestModel"
      intro={'Model used when sommeliers click "Suggest" on the maturity queue to suggest drink window phases.'}
      currentModel={currentModel}
      apiFetch={apiFetch}
    />
  );
}

function MaturitySuggestPromptPanel({ prompt, apiFetch }) {
  return (
    <PromptPanel
      title="Maturity Suggest — AI Prompt"
      endpoint="/api/superadmin/ai/maturity-suggest-prompt"
      intro={<>Prompt sent to Claude when a sommelier asks AI to suggest drink window phases. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{vintage}}'}</code>, <code style={codeStyle}>{'{{country}}'}</code>, <code style={codeStyle}>{'{{region}}'}</code>, <code style={codeStyle}>{'{{appellation}}'}</code>, <code style={codeStyle}>{'{{type}}'}</code>, <code style={codeStyle}>{'{{grapes}}'}</code> placeholders.</>}
      prompt={prompt}
      apiFetch={apiFetch}
    />
  );
}

function MaturitySuggestPromptNvPanel({ prompt, apiFetch }) {
  return (
    <PromptPanel
      title="Maturity Suggest (Non-Vintage) — AI Prompt"
      endpoint="/api/superadmin/ai/maturity-suggest-prompt-nv"
      intro={<>Used instead of the prompt above when the wine is <strong>non-vintage (NV)</strong>. It must ask for the window as <strong>whole years after purchase</strong> (offsets like 0, 2, 5), not calendar years — that's how NV drink windows are stored. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{country}}'}</code>, <code style={codeStyle}>{'{{region}}'}</code>, <code style={codeStyle}>{'{{appellation}}'}</code>, <code style={codeStyle}>{'{{type}}'}</code>, <code style={codeStyle}>{'{{grapes}}'}</code> placeholders ({'{{vintage}}'} is not used for NV).</>}
      prompt={prompt}
      apiFetch={apiFetch}
    />
  );
}

function PriceSuggestModelPanel({ currentModel, apiFetch }) {
  return (
    <ModelPickerPanel
      title="Price Suggest — AI Model"
      endpoint="/api/superadmin/ai/price-suggest-model"
      groupName="priceSuggestModel"
      intro={'Model used when sommeliers click "Suggest" on the price queue to suggest market prices.'}
      currentModel={currentModel}
      apiFetch={apiFetch}
    />
  );
}

function PriceSuggestPromptPanel({ prompt, apiFetch }) {
  return (
    <PromptPanel
      title="Price Suggest — AI Prompt"
      endpoint="/api/superadmin/ai/price-suggest-prompt"
      intro={<>Prompt sent to Claude when a sommelier asks AI to suggest a market price. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{vintage}}'}</code>, <code style={codeStyle}>{'{{country}}'}</code>, <code style={codeStyle}>{'{{region}}'}</code>, <code style={codeStyle}>{'{{appellation}}'}</code>, <code style={codeStyle}>{'{{type}}'}</code>, <code style={codeStyle}>{'{{grapes}}'}</code> placeholders. If a wine has no cellar value, AI should return null for price.</>}
      prompt={prompt}
      apiFetch={apiFetch}
    />
  );
}

function EnrichmentModelPanel({ currentModel, apiFetch }) {
  return (
    <ModelPickerPanel
      title="Wine Enrichment — AI Model"
      endpoint="/api/superadmin/ai/enrichment-model"
      groupName="enrichmentModel"
      intro="Model used to generate each wine's AI tasting/style profile (body, tannin, flavours, food pairings, description). This is a knowledge-recall task — Sonnet is recommended over Haiku for richer, more accurate profiles."
      currentModel={currentModel}
      defaultModel="claude-sonnet-5"
      successMsg="Saved — takes effect on next enrichment run"
      apiFetch={apiFetch}
    />
  );
}

function EnrichmentPromptPanel({ prompt, apiFetch }) {
  return (
    <PromptPanel
      title="Wine Enrichment — AI Prompt"
      endpoint="/api/superadmin/ai/enrichment-prompt"
      intro={<>Prompt sent to Claude to generate each wine's tasting/style profile. Must request a JSON object with body, tannin, acidity, sweetness, flavors[], foodPairings[], description, confidence. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{region}}'}</code>, <code style={codeStyle}>{'{{grapes}}'}</code> (and country/appellation/classification/type/vintage) placeholders.</>}
      prompt={prompt}
      rows={16}
      successMsg="Saved — takes effect on next enrichment run"
      apiFetch={apiFetch}
    />
  );
}

function ChatLimitPanel({ limit, apiFetch }) {
  const [val, setVal] = useState(limit ?? 50);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/superadmin/ai/chat-limit', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: parseInt(val, 10) }),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Cellar Chat — Daily Limit</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          Max Cellar Chat questions per user per UTC day. Applies to everyone, regardless of plan. Use -1 for unlimited.
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <span className="sa-kv-key">Questions / day</span>
            <input
              type="number"
              min="-1"
              max="9999"
              value={val}
              onChange={e => setVal(e.target.value)}
              style={{ width: 70, background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 6px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12 }}
            />
          </div>
        </div>
        {msg && (
          <div style={{ marginTop: 10, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}

function ChatUsagePanel() {
  const { apiFetch } = useAuth();
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (d) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/superadmin/chat-usage?days=${d}&limit=100`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setRows(json.rows || []);
      setTotal(json.total || 0);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(days); }, [load, days]);

  const totals = rows.reduce(
    (acc, r) => ({ q: acc.q + r.questions, i: acc.i + r.inputTokens, o: acc.o + r.outputTokens }),
    { q: 0, i: 0, o: 0 }
  );

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Cellar Chat Usage — Per User</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="sa-input"
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            style={{ width: 120 }}
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button className="sa-btn" onClick={() => load(days)}>Refresh</button>
        </div>
      </div>
      <div className="sa-panel-body">
        {error && <div className="sa-error">{error}</div>}
        {loading ? (
          <div className="sa-loading">Loading usage data...</div>
        ) : rows.length === 0 ? (
          <div style={{ color: 'var(--sa-text-dim)', fontSize: 12, padding: '8px 0' }}>
            No chat usage data for this period.
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 12, display: 'flex', gap: 24, fontSize: 12, color: 'var(--sa-text-dim)' }}>
              <span><strong style={{ color: 'var(--sa-accent)' }}>{num(total)}</strong> active users</span>
              <span><strong style={{ color: 'var(--sa-text)' }}>{num(totals.q)}</strong> questions</span>
              <span><strong style={{ color: 'var(--sa-text)' }}>{num(totals.i + totals.o)}</strong> total tokens</span>
            </div>
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Plan</th>
                    <th>Questions</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Total tokens</th>
                    <th>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.userId}>
                      <td>
                        <div>{r.username}</div>
                        {r.email && <div style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{r.email}</div>}
                      </td>
                      <td><PlanBadge plan={r.plan} /></td>
                      <td style={{ color: 'var(--sa-accent)' }}>{num(r.questions)}</td>
                      <td>{num(r.inputTokens)}</td>
                      <td>{num(r.outputTokens)}</td>
                      <td style={{ fontWeight: 600 }}>{num(r.totalTokens)}</td>
                      <td style={{ color: 'var(--sa-text-dim)' }}>{r.lastActive || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main TabAI component
// ─────────────────────────────────────────────────────────────────────────────

export default function TabAI() {
  const { data, loading, error, reload } = useApi('/api/superadmin/ai');
  const { apiFetch } = useAuth();
  const [jobMode, setJobMode] = useState('incremental');
  const [jobBusy, setJobBusy] = useState(false);
  const [jobMsg, setJobMsg] = useState(null);
  const [enrichMode, setEnrichMode] = useState('incremental');
  const [enrichLimit, setEnrichLimit] = useState('');
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState(null);

  async function startJob() {
    setJobBusy(true); setJobMsg(null);
    try {
      // Content-Type header is required — without it Express's express.json()
      // skips parsing the body, so req.body.mode is undefined and the backend
      // silently defaults to 'incremental' regardless of the dropdown.
      const res = await apiFetch('/api/admin/ai/embed/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: jobMode }),
      });
      const body = await res.json().catch(() => ({}));
      setJobMsg({ ok: res.ok && !body.error, text: body.message || body.error || 'Job started' });
      reload();
    } catch (e) { setJobMsg({ ok: false, text: e.message || 'Error' }); }
    finally { setJobBusy(false); }
  }

  async function stopJob() {
    setJobBusy(true); setJobMsg(null);
    try {
      const res = await apiFetch('/api/admin/ai/embed/stop', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      setJobMsg({ ok: res.ok && !body.error, text: body.message || body.error || 'Stop requested' });
      reload();
    } catch (e) { setJobMsg({ ok: false, text: e.message || 'Error' }); }
    finally { setJobBusy(false); }
  }

  async function startEnrich() {
    setEnrichBusy(true); setEnrichMsg(null);
    try {
      const limitNum = parseInt(enrichLimit, 10);
      const payload = { mode: enrichMode };
      if (Number.isInteger(limitNum) && limitNum > 0) payload.limit = limitNum;
      const res = await apiFetch('/api/admin/ai/enrich/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      setEnrichMsg({ ok: res.ok && !body.error, text: body.message || body.error || 'Job started' });
      reload();
    } catch (e) { setEnrichMsg({ ok: false, text: e.message || 'Error' }); }
    finally { setEnrichBusy(false); }
  }

  async function stopEnrich() {
    setEnrichBusy(true); setEnrichMsg(null);
    try {
      const res = await apiFetch('/api/admin/ai/enrich/stop', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      setEnrichMsg({ ok: res.ok && !body.error, text: body.message || body.error || 'Stop requested' });
      reload();
    } catch (e) { setEnrichMsg({ ok: false, text: e.message || 'Error' }); }
    finally { setEnrichBusy(false); }
  }

  // Only block on loading/error before the first successful load — background
  // reloads (job start/stop, shell refresh) keep the panels mounted so
  // unsaved prompt drafts aren't wiped.
  if (loading) return <div className="sa-loading">Loading AI pipeline stats...</div>;
  if (error && !data) return <div className="sa-error">Error: {error}</div>;
  if (!data)   return null;

  const { configured, config, job, collection, embeddings } = data;
  const providers = data.providers || {};
  const openAiMode = providers.llm === 'openai' || providers.embedding === 'openai';
  const enrichJob = data.enrichmentJob || {};
  const enrichCoverage = data.enrichment || { totalWines: 0, enrichedWines: 0 };
  const enrichPct = enrichJob.total > 0 ? Math.round((enrichJob.done / enrichJob.total) * 100) : 0;
  const enrichRunning = enrichJob.status === 'running' || enrichJob.status === 'stopping';
  const coveragePct = enrichCoverage.totalWines > 0
    ? Math.round((enrichCoverage.enrichedWines / enrichCoverage.totalWines) * 100) : 0;

  const jobPct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const jobStatusColor =
    job.status === 'running'  ? 'warn' :
    job.status === 'done'     ? 'accent' :
    job.status === 'error'    ? 'danger' : '';
  const isRunning = job.status === 'running' || job.status === 'stopping';

  return (
    <>
      {error && (
        <div className="sa-error" style={{ marginBottom: 12, fontSize: 11 }}>
          Refresh failed: {error} — showing last loaded data
        </div>
      )}

      {/* API keys configured */}
      <div className="sa-services-grid" style={{ marginBottom: 16 }}>
        {[
          { name: 'Embeddings', ok: configured.voyageAI },
          { name: 'Qdrant (Vector DB)', ok: configured.qdrant },
          { name: 'LLM (AI Chat)', ok: configured.anthropic },
        ].map(s => (
          <div key={s.name} className="sa-service">
            <StatusDot status={s.ok ? 'ok' : 'not_configured'} />
            <div>
              <div className="sa-service-name">{s.name}</div>
              <div className="sa-service-status">{s.ok ? 'Configured' : 'Not configured'}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Self-hosted provider mode: model pickers below are env-governed and inert */}
      {openAiMode && (
        <div className="sa-error" style={{ marginBottom: 16, fontSize: 11 }}>
          {providers.llm === 'openai' && 'AI_PROVIDER=openai — chat/scan model settings below are ignored; the model comes from the AI_MODEL / AI_VISION_MODEL env vars. '}
          {providers.embedding === 'openai' && 'EMBEDDING_PROVIDER=openai — the embedding model comes from the EMBEDDING_MODEL env var. '}
          Prompts and all other settings still apply.
        </div>
      )}

      <div className="sa-grid-2">
        {/* AI Config */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">AI Config</span></div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Chat enabled</span>
                <span className={`sa-kv-val ${config.chatEnabled ? 'accent' : 'danger'}`}>
                  {config.chatEnabled ? 'YES' : 'NO'}
                </span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Embedding model</span>
                <span className="sa-kv-val">{config.embeddingModel}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Active vector index</span>
                <span className="sa-kv-val accent">wines_{config.vectorIndex}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Chat top-K (Qdrant)</span>
                <span className="sa-kv-val">{config.chatTopK}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Max results shown</span>
                <span className="sa-kv-val">{config.chatMaxResults}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Max response tokens</span>
                <span className="sa-kv-val">{config.chatMaxTokens || 800}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Max history turns</span>
                <span className="sa-kv-val">{config.chatMaxHistoryTurns || 10}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Chat model</span>
                <span className="sa-kv-val">{config.chatModel}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Fallback model</span>
                <span className="sa-kv-val">{config.chatModelFallback || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Maturity suggest model</span>
                <span className="sa-kv-val">{config.maturitySuggestModel}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Price suggest model</span>
                <span className="sa-kv-val">{config.priceSuggestModel}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Embed batch delay</span>
                <span className="sa-kv-val">{config.embeddingBatchDelayMs}ms</span>
              </div>
            </div>
          </div>
        </div>

        {/* Qdrant collection */}
        <div className="sa-panel">
          <div className="sa-panel-header">
            <span className="sa-panel-title">Qdrant Collection</span>
            <button className="sa-btn" onClick={reload}>Refresh</button>
          </div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Collection</span>
                <span className="sa-kv-val accent">{collection?.name || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Exists</span>
                <span className={`sa-kv-val ${collection?.exists ? 'accent' : 'danger'}`}>
                  {collection?.exists ? 'YES' : 'NO'}
                </span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Vectors stored</span>
                <span className="sa-kv-val">{num(collection?.vectorCount)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="sa-grid-2">
        {/* Embedding job status */}
        <div className="sa-panel">
          <div className="sa-panel-header">
            <span className="sa-panel-title">Embedding Job</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                value={jobMode}
                onChange={e => setJobMode(e.target.value)}
                disabled={isRunning || jobBusy}
                style={{ fontSize: 11, padding: '2px 4px', background: '#1a1a1a', color: '#ccc', border: '1px solid #444', borderRadius: 3 }}
              >
                <option value="incremental">Incremental</option>
                <option value="full">Full re-embed</option>
              </select>
              {!isRunning ? (
                <button className="sa-btn" onClick={startJob} disabled={jobBusy}>Start</button>
              ) : (
                <button className="sa-btn" onClick={stopJob} disabled={jobBusy}>Stop</button>
              )}
              <button className="sa-btn" onClick={reload}>Refresh</button>
            </div>
          </div>
          <div className="sa-panel-body">
            {jobMsg && <div className={jobMsg.ok ? 'sa-success' : 'sa-error'} style={{ marginBottom: 8, fontSize: 11 }}>{jobMsg.text}</div>}
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Status</span>
                <span className={`sa-kv-val ${jobStatusColor}`}>{job.status?.toUpperCase()}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Mode</span>
                <span className="sa-kv-val">{job.mode || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Model</span>
                <span className="sa-kv-val">{job.model || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Progress</span>
                <span className="sa-kv-val">{job.done}/{job.total}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Skipped</span>
                <span className="sa-kv-val">{num(job.skipped)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Errors</span>
                <span className={`sa-kv-val ${job.errors > 0 ? 'danger' : ''}`}>{num(job.errors)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Started</span>
                <span className="sa-kv-val mono">{job.startedAt ? ago(job.startedAt) : '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Finished</span>
                <span className="sa-kv-val mono">{job.finishedAt ? ago(job.finishedAt) : '—'}</span>
              </div>
            </div>
            {job.status === 'running' || job.status === 'stopping' ? (
              <div style={{ marginTop: 12 }}>
                <div className="sa-bar-label">
                  <span>Embedding progress</span>
                  <span>{jobPct}%</span>
                </div>
                <div className="sa-bar-track">
                  <div className="sa-bar-fill warn" style={{ width: `${jobPct}%` }} />
                </div>
              </div>
            ) : null}
            {job.lastError && (
              <div className="sa-error" style={{ marginTop: 10, fontSize: 11 }}>
                Last error: {job.lastError}
              </div>
            )}
          </div>
        </div>

        {/* WineEmbedding MongoDB stats */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">WineEmbeddings (MongoDB)</span></div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Total records</span>
                <span className="sa-kv-val accent">{num(embeddings.total)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Status: ok</span>
                <span className="sa-kv-val">{num(embeddings.byStatus?.ok || 0)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Status: error</span>
                <span className={`sa-kv-val ${embeddings.byStatus?.error > 0 ? 'danger' : ''}`}>
                  {num(embeddings.byStatus?.error || 0)}
                </span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Last embedded</span>
                <span className="sa-kv-val mono">{embeddings.lastEmbeddedAt ? ago(embeddings.lastEmbeddedAt) : '—'}</span>
              </div>
            </div>

            {embeddings.byModel?.length > 0 && (
              <>
                <div style={{ marginTop: 12, marginBottom: 6, fontSize: 10, color: 'var(--sa-text-dim)', letterSpacing: 1, textTransform: 'uppercase' }}>
                  By model / index
                </div>
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead>
                      <tr><th>Model</th><th>Index</th><th>Count</th></tr>
                    </thead>
                    <tbody>
                      {embeddings.byModel.map((row, i) => (
                        <tr key={i}>
                          <td>{row.model}</td>
                          <td style={{ color: 'var(--sa-accent)' }}>wines_{row.indexVersion}</td>
                          <td>{num(row.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* Wine enrichment (AI tasting/style profiles) */}
      <div className="sa-grid-2">
        <div className="sa-panel">
          <div className="sa-panel-header">
            <span className="sa-panel-title">Wine Enrichment Job</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                value={enrichMode}
                onChange={e => setEnrichMode(e.target.value)}
                disabled={enrichRunning || enrichBusy}
                style={{ fontSize: 11, padding: '2px 4px', background: '#1a1a1a', color: '#ccc', border: '1px solid #444', borderRadius: 3 }}
              >
                <option value="incremental">Incremental (missing only)</option>
                <option value="full">Full re-enrich</option>
              </select>
              <input
                type="number"
                min="1"
                placeholder="max (e.g. 5)"
                value={enrichLimit}
                onChange={e => setEnrichLimit(e.target.value)}
                disabled={enrichRunning || enrichBusy}
                title="Limit how many wines to enrich this run (blank = all). Use a small number for a cheap test."
                style={{ width: 80, fontSize: 11, padding: '2px 4px', background: '#1a1a1a', color: '#ccc', border: '1px solid #444', borderRadius: 3 }}
              />
              {!enrichRunning ? (
                <button className="sa-btn" onClick={startEnrich} disabled={enrichBusy}>Start</button>
              ) : (
                <button className="sa-btn" onClick={stopEnrich} disabled={enrichBusy}>Stop</button>
              )}
              <button className="sa-btn" onClick={reload}>Refresh</button>
            </div>
          </div>
          <div className="sa-panel-body">
            {enrichMsg && <div className={enrichMsg.ok ? 'sa-success' : 'sa-error'} style={{ marginBottom: 8, fontSize: 11 }}>{enrichMsg.text}</div>}
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Status</span>
                <span className={`sa-kv-val ${enrichJob.status === 'running' ? 'warn' : enrichJob.status === 'done' ? 'accent' : enrichJob.status === 'error' ? 'danger' : ''}`}>{(enrichJob.status || 'idle').toUpperCase()}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Mode</span>
                <span className="sa-kv-val">{enrichJob.mode || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Model</span>
                <span className="sa-kv-val">{enrichJob.model || config.enrichmentModel || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Progress</span>
                <span className="sa-kv-val">{enrichJob.done || 0}/{enrichJob.total || 0}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Enriched</span>
                <span className="sa-kv-val accent">{num(enrichJob.enriched || 0)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Skipped</span>
                <span className="sa-kv-val">{num(enrichJob.skipped || 0)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Errors</span>
                <span className={`sa-kv-val ${enrichJob.errors > 0 ? 'danger' : ''}`}>{num(enrichJob.errors || 0)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Started</span>
                <span className="sa-kv-val mono">{enrichJob.startedAt ? ago(enrichJob.startedAt) : '—'}</span>
              </div>
            </div>
            {enrichRunning && (
              <div style={{ marginTop: 12 }}>
                <div className="sa-bar-label"><span>Enrichment progress</span><span>{enrichPct}%</span></div>
                <div className="sa-bar-track"><div className="sa-bar-fill warn" style={{ width: `${enrichPct}%` }} /></div>
              </div>
            )}
            {enrichJob.lastError && (
              <div className="sa-error" style={{ marginTop: 10, fontSize: 11 }}>Last error: {enrichJob.lastError}</div>
            )}
          </div>
        </div>

        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">Profile Coverage</span></div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Wines with AI profile</span>
                <span className="sa-kv-val accent">{num(enrichCoverage.enrichedWines)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Total wines</span>
                <span className="sa-kv-val">{num(enrichCoverage.totalWines)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Coverage</span>
                <span className="sa-kv-val">{coveragePct}%</span>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="sa-bar-track"><div className="sa-bar-fill accent" style={{ width: `${coveragePct}%` }} /></div>
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--sa-text-dim)' }}>
              Enrichment writes each wine's AI tasting profile. After it runs, start an <strong>incremental</strong> embedding job to fold the new profiles into the search vectors.
            </div>
          </div>
        </div>
      </div>

      {/* Chat event log (errors / fallbacks) */}
      {data.chatEventLog?.length > 0 && (
        <div className="sa-panel" style={{ marginBottom: 16 }}>
          <div className="sa-panel-header">
            <span className="sa-panel-title">Chat Error Log</span>
            <span style={{ fontSize: 11, color: 'var(--sa-text-dim)' }}>Last {data.chatEventLog.length} events (in-memory, resets on restart)</span>
          </div>
          <div className="sa-panel-body">
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Phase</th>
                    <th>Primary model</th>
                    <th>Status</th>
                    <th>Error</th>
                    <th>Fallback</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {data.chatEventLog.map((e, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap' }}>{ago(e.timestamp)}</td>
                      <td>{e.phase}</td>
                      <td style={{ fontSize: 11 }}>{e.primaryModel}</td>
                      <td className={e.status >= 500 ? 'danger' : ''}>{e.status || '—'}</td>
                      <td style={{ fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.errorMessage || ''}>
                        {e.errorType || e.errorMessage || '—'}
                      </td>
                      <td style={{ fontSize: 11 }}>
                        {e.fallbackAttempted ? e.fallbackModel : <span style={{ color: 'var(--sa-text-dim)' }}>none</span>}
                      </td>
                      <td>
                        {e.fallbackResult === 'ok' && <span className="accent">OK</span>}
                        {e.fallbackResult === 'failed' && <span className="danger">FAILED</span>}
                        {!e.fallbackAttempted && <span style={{ color: 'var(--sa-text-dim)' }}>no fallback</span>}
                        {e.fallbackAttempted && !e.fallbackResult && <span style={{ color: 'var(--sa-text-dim)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      <ChatModelPanel currentModel={config.chatModel} currentFallback={config.chatModelFallback || null} apiFetch={apiFetch} />
      <SystemPromptPanel prompt={config.chatSystemPrompt || ''} apiFetch={apiFetch} />
      <LabelScanModelPanel currentModel={config.labelScanModel || 'claude-sonnet-5'} apiFetch={apiFetch} />
      <LabelScanPromptPanel prompt={config.labelScanPrompt || ''} apiFetch={apiFetch} />
      <ImportLookupModelPanel currentModel={config.importLookupModel || 'claude-sonnet-5'} apiFetch={apiFetch} />
      <ImportLookupPromptPanel prompt={config.importLookupPrompt || ''} apiFetch={apiFetch} />
      <MaturitySuggestModelPanel currentModel={config.maturitySuggestModel || 'claude-sonnet-5'} apiFetch={apiFetch} />
      <MaturitySuggestPromptPanel prompt={config.maturitySuggestPrompt || ''} apiFetch={apiFetch} />
      <MaturitySuggestPromptNvPanel prompt={config.maturitySuggestPromptNv || ''} apiFetch={apiFetch} />
      <PriceSuggestModelPanel currentModel={config.priceSuggestModel || 'claude-haiku-4-5-20251001'} apiFetch={apiFetch} />
      <PriceSuggestPromptPanel prompt={config.priceSuggestPrompt || ''} apiFetch={apiFetch} />
      <EnrichmentModelPanel currentModel={config.enrichmentModel || 'claude-sonnet-5'} apiFetch={apiFetch} />
      <EnrichmentPromptPanel prompt={config.enrichmentPrompt || ''} apiFetch={apiFetch} />
      <ChatLimitPanel limit={config.chatDailyLimit ?? 50} apiFetch={apiFetch} />
      <ChatUsagePanel />
    </>
  );
}

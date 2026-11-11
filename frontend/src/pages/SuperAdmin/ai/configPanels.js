// The configuration panels of SuperAdmin → AI: which model and which prompt
// each AI feature uses, and the switches that bound what the enrichment may
// spend. Most are a model picker or a prompt editor (./panelKit) pointed at
// one setting; the others carry their own form. Drawn by ../TabAI.js.

import { useState } from 'react';
import { superadminSetPromptCaching } from '../../../api/admin';
import { modelRow, ModelPickerPanel, PromptPanel } from './panelKit';
import { CHAT_MODELS, codeStyle } from './modelCatalog';

export function ChatModelPanel({ currentModel, currentFallback, apiFetch }) {
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

export function SystemPromptPanel({ prompt, maxChars = 4000, apiFetch }) {
  return (
    <PromptPanel
      title="Cellar Chat — System Prompt"
      endpoint="/api/superadmin/ai/system-prompt"
      intro="This prompt is sent to Claude before every chat message. Takes effect immediately on save."
      prompt={prompt}
      rows={10}
      maxChars={maxChars}
      apiFetch={apiFetch}
    />
  );
}

export function LabelScanPromptPanel({ prompt, maxChars, apiFetch }) {
  return (
    <PromptPanel
      title="Label Scan — AI Prompt"
      endpoint="/api/superadmin/ai/label-scan-prompt"
      intro="This prompt is sent to Claude when a user scans a wine label. It controls how wine data is extracted and inferred. Takes effect immediately on save."
      prompt={prompt}
      maxChars={maxChars}
      apiFetch={apiFetch}
    />
  );
}

export function ReceiptScanPromptPanel({ prompt, maxChars, apiFetch }) {
  return (
    <PromptPanel
      title="Receipt Scan — AI Prompt"
      endpoint="/api/superadmin/ai/receipt-scan-prompt"
      intro="Sent with the photos or PDF when a user scans a receipt on the import page. It reads the wine lines (text, quantity, price, shop, date) — identification happens afterwards in the import review. Uses the label scan model. Takes effect immediately on save."
      prompt={prompt}
      maxChars={maxChars}
      apiFetch={apiFetch}
    />
  );
}

export function LabelScanModelPanel({ currentModel, apiFetch }) {
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

export function ImportLookupModelPanel({ currentModel, apiFetch }) {
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

export function ImportLookupPromptPanel({ prompt, maxChars, apiFetch }) {
  return (
    <PromptPanel
      title="Import Lookup — AI Prompt"
      endpoint="/api/superadmin/ai/import-lookup-prompt"
      intro={<>Prompt sent to Claude when a wine can't be found in the library during import. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{vintage}}'}</code>, <code style={codeStyle}>{'{{country}}'}</code> placeholders.</>}
      prompt={prompt}
      maxChars={maxChars}
      apiFetch={apiFetch}
    />
  );
}

export function MaturitySuggestModelPanel({ currentModel, apiFetch }) {
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

export function MaturitySuggestPromptPanel({ prompt, maxChars, apiFetch }) {
  return (
    <PromptPanel
      title="Maturity Suggest — AI Prompt"
      endpoint="/api/superadmin/ai/maturity-suggest-prompt"
      intro={<>Prompt sent to Claude when a sommelier asks AI to suggest drink window phases. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{vintage}}'}</code>, <code style={codeStyle}>{'{{country}}'}</code>, <code style={codeStyle}>{'{{region}}'}</code>, <code style={codeStyle}>{'{{appellation}}'}</code>, <code style={codeStyle}>{'{{type}}'}</code>, <code style={codeStyle}>{'{{grapes}}'}</code> placeholders.</>}
      prompt={prompt}
      maxChars={maxChars}
      apiFetch={apiFetch}
    />
  );
}

export function MaturitySuggestPromptNvPanel({ prompt, maxChars, apiFetch }) {
  return (
    <PromptPanel
      title="Maturity Suggest (Non-Vintage) — AI Prompt"
      endpoint="/api/superadmin/ai/maturity-suggest-prompt-nv"
      intro={<>Used instead of the prompt above when the wine is <strong>non-vintage (NV)</strong>. It must ask for the window as <strong>whole years after purchase</strong> (offsets like 0, 2, 5), not calendar years — that's how NV drink windows are stored. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{country}}'}</code>, <code style={codeStyle}>{'{{region}}'}</code>, <code style={codeStyle}>{'{{appellation}}'}</code>, <code style={codeStyle}>{'{{type}}'}</code>, <code style={codeStyle}>{'{{grapes}}'}</code> placeholders ({'{{vintage}}'} is not used for NV).</>}
      prompt={prompt}
      maxChars={maxChars}
      apiFetch={apiFetch}
    />
  );
}

export function PriceSuggestModelPanel({ currentModel, apiFetch }) {
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

export function PriceSuggestPromptPanel({ prompt, maxChars, apiFetch }) {
  return (
    <PromptPanel
      title="Price Suggest — AI Prompt"
      endpoint="/api/superadmin/ai/price-suggest-prompt"
      intro={<>Prompt sent to Claude when a sommelier asks AI to suggest a market price. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{vintage}}'}</code>, <code style={codeStyle}>{'{{country}}'}</code>, <code style={codeStyle}>{'{{region}}'}</code>, <code style={codeStyle}>{'{{appellation}}'}</code>, <code style={codeStyle}>{'{{type}}'}</code>, <code style={codeStyle}>{'{{grapes}}'}</code> placeholders. If a wine has no cellar value, AI should return null for price.</>}
      prompt={prompt}
      maxChars={maxChars}
      apiFetch={apiFetch}
    />
  );
}

export function EnrichmentModelPanel({ currentModel, apiFetch }) {
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

export function EnrichmentPromptPanel({ prompt, maxChars, apiFetch }) {
  return (
    <PromptPanel
      title="Wine Enrichment — AI Prompt"
      endpoint="/api/superadmin/ai/enrichment-prompt"
      intro={<>Prompt sent to Claude to generate each wine's tasting/style profile. Must request a JSON object with body, tannin, acidity, sweetness, flavors[], foodPairings[], description, confidence. Use <code style={codeStyle}>{'{{name}}'}</code>, <code style={codeStyle}>{'{{producer}}'}</code>, <code style={codeStyle}>{'{{region}}'}</code>, <code style={codeStyle}>{'{{grapes}}'}</code> (and country/appellation/classification/type/vintage) placeholders.</>}
      prompt={prompt}
      maxChars={maxChars}
      rows={16}
      successMsg="Saved — takes effect on next enrichment run"
      apiFetch={apiFetch}
    />
  );
}

export function EnrichmentGatePanel({ floor, unknownBar, apiFetch }) {
  const [f, setF] = useState(floor ?? 0.4);
  const [u, setU] = useState(unknownBar ?? 0.55);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/superadmin/ai/enrichment-gate', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ floor: parseFloat(f), unknownBar: parseFloat(u) }),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved — applies to the next enrichment/hold decision' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  const numStyle = { width: 70, background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 6px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12 };
  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Enrichment — Publication Gate</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          Generated profiles below the floor are held for review instead of published; unknown-producer profiles hold below the higher bar. Calibrated 2026-08-18 on 5,836 profiles: 0.40 / 0.55 (0.45 held 1,158 — too aggressive).
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <span className="sa-kv-key">Confidence floor</span>
            <input type="number" min="0" max="1" step="0.05" value={f} onChange={e => setF(e.target.value)} style={numStyle} />
          </div>
          <div className="sa-kv-row">
            <span className="sa-kv-key">Unknown-producer bar</span>
            <input type="number" min="0" max="1" step="0.05" value={u} onChange={e => setU(e.target.value)} style={numStyle} />
          </div>
        </div>
        {msg && <div style={{ fontSize: 11, marginTop: 8, color: msg.ok ? 'var(--sa-green)' : 'var(--sa-red)' }}>{msg.text}</div>}
      </div>
    </div>
  );
}

// Who pays for a new wine's first profile. Adding a bottle fires one
// enrichment per newly-minted wine — at ~120 new wines a day that drip, not
// the admin batch runs, is the steady API spend.
export function EnrichmentOnAddPanel({ mode, maturitySuggest, priceSuggest, apiFetch }) {
  const [val, setVal] = useState(mode ?? 'sufficient');
  const [mat, setMat] = useState(maturitySuggest ?? true);
  const [price, setPrice] = useState(priceSuggest ?? true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/superadmin/ai/enrichment-on-add', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: val, sommMaturitySuggestEnabled: !!mat, sommPriceSuggestEnabled: !!price }),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved — applies immediately' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  const selStyle = { background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 6px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12 };
  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">AI Spend Controls</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          The paths that spend API credit without a user asking. Label scan, AI wine search and cellar chat are
          deliberately NOT here — they are the add-bottle experience and the product. Batch enrichment is separate and
          only runs when you start one. &ldquo;off&rdquo; means wine data is sommelier-owned: the AI writes no profile
          at all — not on add, not after an identity edit, not when a pending wine is completed or a draft is
          published — and releasing a held profile is refused (write it by hand instead, which also clears the hold).
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <span className="sa-kv-key">Enrich on bottle add</span>
            <select value={val} onChange={e => setVal(e.target.value)} style={selStyle}>
              <option value="always">always — enrich every new wine</option>
              <option value="sufficient">sufficient — only with a region/appellation and a grape or type</option>
              <option value="off">off — profiles come from the sommelier only</option>
            </select>
          </div>
          <div className="sa-kv-row">
            <span className="sa-kv-key">Sommelier drink-window suggestions</span>
            <input type="checkbox" checked={!!mat} onChange={e => setMat(e.target.checked)} />
          </div>
          <div className="sa-kv-row">
            <span className="sa-kv-key">Sommelier price suggestions</span>
            <input type="checkbox" checked={!!price} onChange={e => setPrice(e.target.checked)} />
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginTop: 10 }}>
          The two sommelier switches answer questions the curator already researches by hand while setting a window or
          a price — and they work on a flat-rate subscription, so turning these off moves the cost, not the work. Both
          return a clear &ldquo;turned off, research it yourself&rdquo; message rather than failing silently.
        </div>
        {msg && <div style={{ fontSize: 11, marginTop: 8, color: msg.ok ? 'var(--sa-green)' : 'var(--sa-red)' }}>{msg.text}</div>}
      </div>
    </div>
  );
}

export function EnrichmentSearchPanel({ enabled, dailyCap, apiFetch }) {
  const [on, setOn] = useState(enabled ?? true);
  const [cap, setCap] = useState(dailyCap ?? 5);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/superadmin/ai/enrichment-search', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!on, dailyCap: parseInt(cap, 10) }),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved — applies to the next enrichment' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  const numStyle = { width: 70, background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 6px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12 };
  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Enrichment — Web-Search Rescue (pilot)</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          A profile that would be HELD for low confidence gets one retry with Anthropic web search (max 2 searches, ~$0.01 each plus a second model call). The gate is the difficulty detector — ordinary wines never spend a search. Cap 0 or the switch off disables it; Anthropic provider only.
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <span className="sa-kv-key">Enabled</span>
            <input type="checkbox" checked={!!on} onChange={e => setOn(e.target.checked)} />
          </div>
          <div className="sa-kv-row">
            <span className="sa-kv-key">Searched retries per day</span>
            <input type="number" min="0" max="100" step="1" value={cap} onChange={e => setCap(e.target.value)} style={numStyle} />
          </div>
        </div>
        {msg && <div style={{ fontSize: 11, marginTop: 8, color: msg.ok ? 'var(--sa-green)' : 'var(--sa-red)' }}>{msg.text}</div>}
      </div>
    </div>
  );
}

export function PromptCachingPanel({ enabled, apiFetch }) {
  const [on, setOn] = useState(enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await superadminSetPromptCaching(apiFetch, on);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setMsg({ ok: false, text: d.error || `Save failed (HTTP ${res.status})` });
      } else {
        setMsg({ ok: true, text: 'Saved — applies to the next scan and import' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginBottom: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Prompt Caching — Label Scan &amp; Import</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          The label-scan instructions and the import lookup&rsquo;s fixed rules are marked for Anthropic&rsquo;s prompt cache, so a
          repeat call within the cache lifetime (1 hour for scans, 5 minutes for imports) pays 10% for them. This is a pure cost
          switch: the prompt the model reads is exactly the same with it on or off. Models only cache instructions above a
          minimum size (1,024 tokens on Sonnet 5, 4,096 on Haiku 4.5) — below it the switch has no effect.
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <span className="sa-kv-key">Enabled</span>
            <input type="checkbox" checked={!!on} onChange={e => setOn(e.target.checked)} />
          </div>
        </div>
        {msg && <div style={{ fontSize: 11, marginTop: 8, color: msg.ok ? 'var(--sa-green)' : 'var(--sa-red)' }}>{msg.text}</div>}
      </div>
    </div>
  );
}

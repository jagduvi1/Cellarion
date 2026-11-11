// The two panels most of the SuperAdmin AI settings are made of: one that
// picks a model and one that edits a prompt. Each saves its one setting to
// the endpoint it is given. modelRow is one model's row in a picker.

import { useState } from 'react';
import { CHAT_MODELS, tierColor } from './modelCatalog';

export const modelRow = (m, groupName, checked, onChange, activeMark) => (
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

export function ModelPickerPanel({ title, endpoint, groupName, intro, currentModel, defaultModel = 'claude-haiku-4-5-20251001', successMsg = 'Saved — takes effect immediately', apiFetch }) {
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

export function PromptPanel({ title, endpoint, intro, prompt, rows = 14, maxChars = 6000, successMsg = 'Saved — takes effect immediately', apiFetch }) {
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

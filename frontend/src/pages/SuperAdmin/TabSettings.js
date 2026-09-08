import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { adminGetRateLimits, adminSaveRateLimits, adminGetContactEmail, adminSaveContactEmail } from '../../api/admin';

const INPUT_STYLE = {
  width: 90,
  background: 'var(--sa-bg)',
  border: '1px solid var(--sa-border)',
  color: 'var(--sa-text)',
  padding: '2px 6px',
  borderRadius: 3,
  fontFamily: 'monospace',
  fontSize: 12,
};

// ms <-> minutes helpers — config stores ms; UI shows minutes for human-friendly editing
const msToMin = (ms) => String(Math.round(Number(ms) / 60000));
const minToMs = (min) => Math.round(Number(min) * 60000);

function NumberField({ label, hint, value, defaultValue, onChange, min, max, unit }) {
  return (
    <div className="sa-kv-row">
      <span className="sa-kv-key">
        {label}
        {defaultValue !== undefined && (
          <span style={{ marginLeft: 6, color: 'var(--sa-text-dim)', fontSize: 10 }}>
            (default: {defaultValue})
          </span>
        )}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={e => onChange(e.target.value)}
          style={INPUT_STYLE}
        />
        <span style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{unit}{hint ? ` — ${hint}` : ''}</span>
      </div>
    </div>
  );
}

function PanelShell({ title, intro, saving, onSave, msg, children }) {
  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">{title}</span>
        <button className="sa-btn" onClick={onSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        {intro && (
          <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>{intro}</div>
        )}
        <div className="sa-kv">{children}</div>
        {msg && (
          <div style={{ marginTop: 10, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}

// All three rate-limit panels share one /rate-limits load (fetched once in
// TabSettings and passed down) but PATCH only their own fields, so each Save
// button is independent. The backend's partial-update behaviour means an
// unsent group is left untouched.
function useRateLimits(apiFetch) {
  const [config,   setConfig]   = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [error,    setError]    = useState(null);

  useEffect(() => {
    adminGetRateLimits(apiFetch)
      .then(r => r.json())
      .then(d => { setConfig(d.config); setDefaults(d.defaults); })
      .catch(() => setError('Failed to load'));
  }, [apiFetch]);

  return { config, defaults, error };
}

function PerIpLimitsPanel({ apiFetch, config, defaults, error }) {
  const LIMITERS = [
    { key: 'api',   label: 'General API'  },
    { key: 'write', label: 'Write actions' },
    { key: 'auth',  label: 'Auth / login'  },
  ];
  const [form,   setForm]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  useEffect(() => {
    if (config) {
      setForm({ api: String(config.api.max), write: String(config.write.max), auth: String(config.auth.max) });
    }
  }, [config]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const res = await adminSaveRateLimits(apiFetch, {
        api:   { max: Number(form.api)   },
        write: { max: Number(form.write) },
        auth:  { max: Number(form.auth)  },
      });
      if (!res.ok) { const d = await res.json(); setMsg({ ok: false, text: d.error || 'Save failed' }); }
      else setMsg({ ok: true, text: 'Saved — takes effect immediately' });
    } catch { setMsg({ ok: false, text: 'Network error' }); }
    finally { setSaving(false); }
  };

  if (error)  return <div className="sa-panel" style={{ marginTop: 16, padding: 12, color: 'var(--sa-danger)' }}>{error}</div>;
  if (!form)  return <div className="sa-loading">Loading rate limits...</div>;

  return (
    <PanelShell
      title="Per-IP rate limits"
      intro="Maximum requests per 15-minute window per source IP. Behind Cloudflare the limit is keyed on the real visitor IP."
      saving={saving} onSave={save} msg={msg}
    >
      {LIMITERS.map(({ key, label }) => (
        <NumberField
          key={key}
          label={label}
          unit="req / 15 min"
          value={form[key]}
          defaultValue={defaults?.[key]?.max}
          onChange={v => setForm(f => ({ ...f, [key]: v }))}
          min={1} max={10000}
        />
      ))}
    </PanelShell>
  );
}

// The AI connector's own two-layer protocol limit (backend routes/mcp.js):
// hosted connectors (claude.ai, ChatGPT) call from a small shared IP pool, so
// /api/mcp is exempt from the per-IP limits above and throttled per USER
// instead, with a high per-IP guard against unauthenticated flooding. The
// on/off kill switches live on the Admin → AI Connector page; only the four
// numbers are edited here. PATCHes only
// { mcp: { userMax, ipMax, registerMax, oauthMax } } — the backend's
// field-level merge leaves the switches untouched.
function McpLimitsPanel({ apiFetch, config, defaults, error }) {
  const [form,   setForm]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  useEffect(() => {
    if (config) {
      setForm({
        userMax:     String(config.mcp?.userMax     ?? defaults?.mcp?.userMax     ?? ''),
        ipMax:       String(config.mcp?.ipMax       ?? defaults?.mcp?.ipMax       ?? ''),
        registerMax: String(config.mcp?.registerMax ?? defaults?.mcp?.registerMax ?? ''),
        oauthMax:    String(config.mcp?.oauthMax    ?? defaults?.mcp?.oauthMax    ?? ''),
      });
    }
  }, [config, defaults]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const res = await adminSaveRateLimits(apiFetch, {
        mcp: {
          userMax: Number(form.userMax),
          ipMax: Number(form.ipMax),
          registerMax: Number(form.registerMax),
          oauthMax: Number(form.oauthMax),
        },
      });
      if (!res.ok) { const d = await res.json(); setMsg({ ok: false, text: d.error || 'Save failed' }); }
      else setMsg({ ok: true, text: 'Saved — takes effect immediately' });
    } catch { setMsg({ ok: false, text: 'Network error' }); }
    finally { setSaving(false); }
  };

  if (error)  return null; // the Per-IP panel already shows the shared load error
  if (!form)  return <div className="sa-loading">Loading MCP limits...</div>;

  return (
    <PanelShell
      title="AI connector (MCP) limits"
      intro="The MCP endpoint is limited per USER, not per IP — hosted AI connectors share a small egress IP pool, so a per-IP bucket would let one chatty agent starve everyone. Keep the per-IP flood guard well above the per-user number. On/off switches are on Admin → AI Connector."
      saving={saving} onSave={save} msg={msg}
    >
      <NumberField
        label="Per-user requests"
        unit="req / 15 min"
        hint="fair share per account, across all their tokens and IPs"
        value={form.userMax}
        defaultValue={defaults?.mcp?.userMax}
        onChange={v => setForm(f => ({ ...f, userMax: v }))}
        min={10} max={100000}
      />
      <NumberField
        label="Per-IP flood guard"
        unit="req / 15 min"
        hint="pre-auth ceiling per source IP; bounds probing, not fairness"
        value={form.ipMax}
        defaultValue={defaults?.mcp?.ipMax}
        onChange={v => setForm(f => ({ ...f, ipMax: v }))}
        min={100} max={1000000}
      />
      <NumberField
        label="New connections"
        unit="registrations / hour / IP"
        hint="OAuth client registrations; every NEW connection needs one, and a whole platform's users share one egress IP"
        value={form.registerMax}
        defaultValue={defaults?.mcp?.registerMax}
        onChange={v => setForm(f => ({ ...f, registerMax: v }))}
        min={10} max={100000}
      />
      <NumberField
        label="OAuth sign-in flow"
        unit="req / 15 min / IP"
        hint="authorize, approve, token and revoke combined. Every connected client refreshes its token at least hourly and a whole platform does that from one egress IP — keep this high; too low disconnects people mid-conversation"
        value={form.oauthMax}
        defaultValue={defaults?.mcp?.oauthMax}
        onChange={v => setForm(f => ({ ...f, oauthMax: v }))}
        min={100} max={1000000}
      />
    </PanelShell>
  );
}

// Registry lockdown (L4) and Registry Bridge quotas. The distinct-wines cap is
// what tells a person browsing from a copier (limiters can't); the bridge
// group is what one self-hosted install may do per key per UTC day. PATCHes
// only { registryRead, bridge } — the backend merges field by field.
function RegistryLimitsPanel({ apiFetch, config, defaults, error }) {
  const [form,   setForm]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  useEffect(() => {
    if (config) {
      const rr = config.registryRead || {}; const drr = defaults?.registryRead || {};
      const b = config.bridge || {};        const db = defaults?.bridge || {};
      setForm({
        anonymousDailyDistinct: String(rr.anonymousDailyDistinct ?? drr.anonymousDailyDistinct ?? ''),
        memberAlertDistinct:    String(rr.memberAlertDistinct    ?? drr.memberAlertDistinct    ?? ''),
        searches:       String(b.searches       ?? db.searches       ?? ''),
        fetches:        String(b.fetches        ?? db.fetches        ?? ''),
        changeChecks:   String(b.changeChecks   ?? db.changeChecks   ?? ''),
        contributions:  String(b.contributions  ?? db.contributions  ?? ''),
        burstPerMinute: String(b.burstPerMinute ?? db.burstPerMinute ?? ''),
      });
    }
  }, [config, defaults]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const res = await adminSaveRateLimits(apiFetch, {
        registryRead: {
          anonymousDailyDistinct: Number(form.anonymousDailyDistinct),
          memberAlertDistinct: Number(form.memberAlertDistinct),
        },
        bridge: {
          searches: Number(form.searches),
          fetches: Number(form.fetches),
          changeChecks: Number(form.changeChecks),
          contributions: Number(form.contributions),
          burstPerMinute: Number(form.burstPerMinute),
        },
      });
      if (!res.ok) { const d = await res.json(); setMsg({ ok: false, text: d.error || 'Save failed' }); }
      else setMsg({ ok: true, text: 'Saved — takes effect on the next request' });
    } catch { setMsg({ ok: false, text: 'Network error' }); }
    finally { setSaving(false); }
  };

  if (error)  return null; // the Per-IP panel already shows the shared load error
  if (!form)  return <div className="sa-loading">Loading registry limits...</div>;

  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <PanelShell
      title="Shared registry and bridge"
      intro="Distinct wines per reader per UTC day is the copy detector: a person adding bottles reads tens, a copier reads thousands. Anonymous addresses over the cap are refused for the rest of the day; members, tokens and bridge keys over the alert level are only listed in the 05:15 readers report. The bridge quotas are per key per day; an owner's monthly import window multiplies the four daily ones by five. Keys and readers: Admin → Registry Bridge."
      saving={saving} onSave={save} msg={msg}
    >
      <NumberField
        label="Anonymous daily distinct cap"
        unit="wines / day / address"
        hint="refused above this for the rest of the day; sized far above real use"
        value={form.anonymousDailyDistinct}
        defaultValue={defaults?.registryRead?.anonymousDailyDistinct}
        onChange={set('anonymousDailyDistinct')}
        min={20} max={100000}
      />
      <NumberField
        label="Member alert level"
        unit="wines / day / reader"
        hint="signed-in users, tokens and bridge keys are reported above this, never refused"
        value={form.memberAlertDistinct}
        defaultValue={defaults?.registryRead?.memberAlertDistinct}
        onChange={set('memberAlertDistinct')}
        min={50} max={1000000}
      />
      <NumberField
        label="Bridge searches"
        unit="/ key / day"
        value={form.searches}
        defaultValue={defaults?.bridge?.searches}
        onChange={set('searches')}
        min={10} max={100000}
      />
      <NumberField
        label="Bridge wine fetches"
        unit="/ key / day"
        hint="one per wine copied into the install"
        value={form.fetches}
        defaultValue={defaults?.bridge?.fetches}
        onChange={set('fetches')}
        min={10} max={100000}
      />
      <NumberField
        label="Bridge change checks"
        unit="/ key / day"
        hint="the weekly refresh needs one"
        value={form.changeChecks}
        defaultValue={defaults?.bridge?.changeChecks}
        onChange={set('changeChecks')}
        min={1} max={1000}
      />
      <NumberField
        label="Bridge contributions"
        unit="/ key / day"
        hint="wine requests, corrections and values forwarded"
        value={form.contributions}
        defaultValue={defaults?.bridge?.contributions}
        onChange={set('contributions')}
        min={1} max={10000}
      />
      <NumberField
        label="Bridge burst"
        unit="req / minute / key"
        value={form.burstPerMinute}
        defaultValue={defaults?.bridge?.burstPerMinute}
        onChange={set('burstPerMinute')}
        min={5} max={10000}
      />
    </PanelShell>
  );
}

function AccountLockoutPanel({ apiFetch, config, defaults, error }) {
  const [form,   setForm]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  useEffect(() => {
    if (config?.accountLockout) {
      setForm({
        threshold:    String(config.accountLockout.threshold),
        windowMin:    msToMin(config.accountLockout.windowMs),
        durationMin:  msToMin(config.accountLockout.durationMs),
        emailDedupMin:msToMin(config.accountLockout.emailDedupMs),
      });
    }
  }, [config]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const res = await adminSaveRateLimits(apiFetch, {
        accountLockout: {
          threshold:    Number(form.threshold),
          windowMs:     minToMs(form.windowMin),
          durationMs:   minToMs(form.durationMin),
          emailDedupMs: minToMs(form.emailDedupMin),
        },
      });
      if (!res.ok) { const d = await res.json(); setMsg({ ok: false, text: d.error || 'Save failed' }); }
      else setMsg({ ok: true, text: 'Saved — takes effect immediately' });
    } catch { setMsg({ ok: false, text: 'Network error' }); }
    finally { setSaving(false); }
  };

  if (error) return null; // Per-IP panel already showed the error
  if (!form) return null;

  return (
    <PanelShell
      title="Account brute-force lockout"
      intro="Per-account counter — blocks credential-stuffing attacks that rotate IPs to bypass the per-IP auth limiter. Lockout is silent (no error revealing the lock to the attacker)."
      saving={saving} onSave={save} msg={msg}
    >
      <NumberField
        label="Failed attempts before lockout"
        unit="attempts"
        value={form.threshold}
        defaultValue={defaults?.accountLockout?.threshold}
        onChange={v => setForm(f => ({ ...f, threshold: v }))}
        min={3} max={1000}
      />
      <NumberField
        label="Counting window"
        unit="minutes"
        hint="attempts older than this don't count"
        value={form.windowMin}
        defaultValue={defaults?.accountLockout?.windowMs ? msToMin(defaults.accountLockout.windowMs) : undefined}
        onChange={v => setForm(f => ({ ...f, windowMin: v }))}
        min={1} max={1440}
      />
      <NumberField
        label="Lockout duration"
        unit="minutes"
        value={form.durationMin}
        defaultValue={defaults?.accountLockout?.durationMs ? msToMin(defaults.accountLockout.durationMs) : undefined}
        onChange={v => setForm(f => ({ ...f, durationMin: v }))}
        min={1} max={43200}
      />
      <NumberField
        label="Email notification dedupe"
        unit="minutes"
        hint="at most one lockout email per account per window (0 to disable dedupe)"
        value={form.emailDedupMin}
        defaultValue={defaults?.accountLockout?.emailDedupMs ? msToMin(defaults.accountLockout.emailDedupMs) : undefined}
        onChange={v => setForm(f => ({ ...f, emailDedupMin: v }))}
        min={0} max={43200}
      />
    </PanelShell>
  );
}

function ChatLimitsPanel({ apiFetch, config, defaults, error }) {
  const [form,   setForm]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  useEffect(() => {
    if (config?.chatBurst && config?.chatConcurrentStreams) {
      setForm({
        burstMax:      String(config.chatBurst.max),
        burstWindowMs: String(config.chatBurst.windowMs),
        concurrent:    String(config.chatConcurrentStreams.max),
      });
    }
  }, [config]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const res = await adminSaveRateLimits(apiFetch, {
        chatBurst:             { max: Number(form.burstMax), windowMs: Number(form.burstWindowMs) },
        chatConcurrentStreams: { max: Number(form.concurrent) },
      });
      if (!res.ok) { const d = await res.json(); setMsg({ ok: false, text: d.error || 'Save failed' }); }
      else setMsg({ ok: true, text: 'Saved — takes effect immediately' });
    } catch { setMsg({ ok: false, text: 'Network error' }); }
    finally { setSaving(false); }
  };

  if (error) return null;
  if (!form) return null;

  return (
    <PanelShell
      title="Cellar Chat abuse controls"
      intro="Per-user throttles on /api/chat — guards Anthropic spend against scripted bursts inside a single user's daily quota. The SSE per-stream timeout is hardcoded at 90s (not editable) as a system safety bound."
      saving={saving} onSave={save} msg={msg}
    >
      <NumberField
        label="Burst limit — requests"
        unit="requests per window"
        value={form.burstMax}
        defaultValue={defaults?.chatBurst?.max}
        onChange={v => setForm(f => ({ ...f, burstMax: v }))}
        min={1} max={1000}
      />
      <NumberField
        label="Burst limit — window"
        unit="milliseconds"
        hint="e.g. 60000 = 1 minute"
        value={form.burstWindowMs}
        defaultValue={defaults?.chatBurst?.windowMs}
        onChange={v => setForm(f => ({ ...f, burstWindowMs: v }))}
        min={10000} max={3600000}
      />
      <NumberField
        label="Max concurrent SSE streams per user"
        unit="streams"
        value={form.concurrent}
        defaultValue={defaults?.chatConcurrentStreams?.max}
        onChange={v => setForm(f => ({ ...f, concurrent: v }))}
        min={1} max={50}
      />
    </PanelShell>
  );
}

function AiBudgetPanel({ apiFetch, config, defaults, error }) {
  const [form,   setForm]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  useEffect(() => {
    if (config?.aiDailyBudget && config?.aiImportPerRequestCap && config?.aiGlobalDailyCap) {
      setForm({
        daily:      String(config.aiDailyBudget.max),
        importCap:  String(config.aiImportPerRequestCap.max),
        globalCap:  String(config.aiGlobalDailyCap.max),
      });
    }
  }, [config]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const res = await adminSaveRateLimits(apiFetch, {
        aiDailyBudget:         { max: Number(form.daily) },
        aiImportPerRequestCap: { max: Number(form.importCap) },
        aiGlobalDailyCap:      { max: Number(form.globalCap) },
      });
      if (!res.ok) { const d = await res.json(); setMsg({ ok: false, text: d.error || 'Save failed' }); }
      else setMsg({ ok: true, text: 'Saved — takes effect immediately' });
    } catch { setMsg({ ok: false, text: 'Network error' }); }
    finally { setSaving(false); }
  };

  if (error) return null;
  if (!form) return null;

  return (
    <PanelShell
      title="AI daily budget (spend cap)"
      intro="Shared Anthropic-call budget across label scan, text identify, AI info, import lookups and wine enrichment (chat has its own quota). When a user's budget runs out, imports degrade to fuzzy matching (never fail) and the single-shot AI endpoints return 429 until midnight UTC."
      saving={saving} onSave={save} msg={msg}
    >
      <NumberField
        label="Per-user daily AI calls"
        unit="calls / day"
        hint="0 = unlimited"
        value={form.daily}
        defaultValue={defaults?.aiDailyBudget?.max}
        onChange={v => setForm(f => ({ ...f, daily: v }))}
        min={0} max={1000000}
      />
      <NumberField
        label="AI lookups per import request"
        unit="calls / request"
        hint="frontend validates in batches of 25, so legit clients never hit this"
        value={form.importCap}
        defaultValue={defaults?.aiImportPerRequestCap?.max}
        onChange={v => setForm(f => ({ ...f, importCap: v }))}
        min={1} max={2000}
      />
      <NumberField
        label="Site-wide daily kill-switch"
        unit="calls / day"
        hint="total across all users; 0 = disabled"
        value={form.globalCap}
        defaultValue={defaults?.aiGlobalDailyCap?.max}
        onChange={v => setForm(f => ({ ...f, globalCap: v }))}
        min={0} max={10000000}
      />
    </PanelShell>
  );
}

function ContactEmailPanel({ apiFetch }) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    adminGetContactEmail(apiFetch)
      .then(r => r.json())
      .then(d => setValue(d.contactEmail || ''))
      .catch(() => setMsg({ ok: false, text: 'Failed to load' }));
  }, [apiFetch]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await adminSaveContactEmail(apiFetch, value.trim());
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
        <span className="sa-panel-title">Contact Email</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          Shown in support prompts across the app (e.g. the import page's "email us" notice).
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <span className="sa-kv-key">Contact address</span>
            <input
              type="email"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="support@example.com"
              style={{ background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 8px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12, width: 240 }}
            />
          </div>
        </div>
        {msg && <div style={{ marginTop: 8, fontSize: 11, color: msg.ok ? 'var(--sa-green)' : 'var(--sa-red)' }}>{msg.text}</div>}
      </div>
    </div>
  );
}

export default function TabSettings() {
  const { apiFetch } = useAuth();
  // Single /rate-limits fetch shared by the three rate-limit panels below.
  const rateLimits = useRateLimits(apiFetch);
  return (
    <>
      <ContactEmailPanel apiFetch={apiFetch} />
      <PerIpLimitsPanel apiFetch={apiFetch} {...rateLimits} />
      <McpLimitsPanel apiFetch={apiFetch} {...rateLimits} />
      <RegistryLimitsPanel apiFetch={apiFetch} {...rateLimits} />
      <AccountLockoutPanel apiFetch={apiFetch} {...rateLimits} />
      <ChatLimitsPanel apiFetch={apiFetch} {...rateLimits} />
      <AiBudgetPanel apiFetch={apiFetch} {...rateLimits} />
    </>
  );
}

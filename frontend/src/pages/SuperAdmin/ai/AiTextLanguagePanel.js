// SuperAdmin → AI: the language for the AI-written wine texts (backend
// utils/profileLanguage, PATCH /api/superadmin/ai/text-language). Off by
// default: the tasting profile is English only. With a language chosen, each
// new profile also carries its prose in that language, beside the English
// the registry keeps reading; the wine, bottle and vintage pages show it.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { superadminSetAiTextLanguage } from '../../../api/admin';
import { messageForResponse, friendlyError } from '../../../utils/friendlyError';

// A language under its own name, as the language menu lists it ("Deutsch"),
// with the code beside it; the code alone where the platform has no name.
function languageLabel(code) {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (name && name !== code) return `${name.charAt(0).toLocaleUpperCase(code)}${name.slice(1)} (${code})`;
  } catch { /* no name for this code */ }
  return code;
}

export default function AiTextLanguagePanel({ current, languages, apiFetch }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(current || '');
  const [selected, setSelected] = useState(current || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const codes = Array.isArray(languages) ? languages : [];

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await superadminSetAiTextLanguage(apiFetch, selected);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg({ ok: false, text: messageForResponse(res, body, undefined, t) });
      } else {
        const language = body?.aiTextLanguage || '';
        setSaved(language);
        setSelected(language);
        setMsg({
          ok: true,
          text: language
            ? t('adminAiLanguage.saved', 'Saved. New wine profiles are also written in this language.')
            : t('adminAiLanguage.savedOff', 'Saved. New wine profiles are written in English only.'),
        });
      }
    } catch (err) {
      setMsg({ ok: false, text: friendlyError(err, t) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginBottom: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">{t('adminAiLanguage.title', 'Language for AI-written wine texts')}</span>
        <button className="sa-btn" onClick={save} disabled={saving || selected === saved}>
          {saving ? t('adminAiLanguage.saving', 'Saving…') : t('adminAiLanguage.save', 'Save')}
        </button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 8 }}>
          {t('adminAiLanguage.intro', 'The AI can also write each wine\'s tasting note, flavours and food pairings in one of the app\'s languages. The English text stays as it is: search, matching and similar wines read it, and the Registry Bridge shares it. The wine, bottle and vintage pages show the translation.')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          {t('adminAiLanguage.help', 'Only new AI texts are written in this language. Existing wines keep their English text until their profile is written again. Wines from the Registry Bridge and profiles written by a curator always stay in English: this install never rewrites them.')}
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <label className="sa-kv-key" htmlFor="sa-ai-text-language">{t('adminAiLanguage.label', 'Language')}</label>
            <select id="sa-ai-text-language" value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">{t('adminAiLanguage.off', 'Off (English)')}</option>
              {codes.map((code) => <option key={code} value={code}>{languageLabel(code)}</option>)}
            </select>
          </div>
        </div>
        {msg && <div style={{ fontSize: 11, marginTop: 8, color: msg.ok ? 'var(--sa-green)' : 'var(--sa-red)' }}>{msg.text}</div>}
      </div>
    </div>
  );
}

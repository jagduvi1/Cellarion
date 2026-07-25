import { useTranslation } from 'react-i18next';
import { languageOptionsFor, HAS_BETA_LANGUAGES } from '../config/locales';

const WEBLATE_URL = 'https://hosted.weblate.org/projects/cellarion/';

/**
 * Interface-language picker.
 *
 * Offers every language with enough translated to be worth choosing, finished
 * or not. An unfinished one is labelled with how far along it is rather than
 * hidden: a translator has to be able to run the app in their own
 * work-in-progress, and a reader who would rather have 60 % of their own
 * language than 100 % English should be allowed to choose that. What
 * incompleteness never does is choose for them — automatic browser-language
 * detection skips beta languages entirely (src/i18n.js).
 */
export default function LanguagePicker({ id = 'language-select', value, onChange }) {
  const { t } = useTranslation();
  const options = languageOptionsFor(value);

  return (
    <>
      <select
        id={id}
        className="input settings-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(({ code, label, beta, percent }) => (
          <option key={code} value={code}>
            {beta
              ? t('settings.languageBetaOption', '{{language}} (beta · {{percent}}%)', {
                language: label,
                percent,
              })
              : label}
          </option>
        ))}
      </select>
      {HAS_BETA_LANGUAGES && (
        <p className="settings-hint">
          {t(
            'settings.languageBetaHint',
            'Beta languages are community translations still in progress — anything not translated yet stays in English.'
          )}
          {' '}
          <a href={WEBLATE_URL} target="_blank" rel="noopener noreferrer">
            {t('settings.languageContribute', 'Help finish yours')}
          </a>
        </p>
      )}
    </>
  );
}

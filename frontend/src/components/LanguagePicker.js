import { useTranslation } from 'react-i18next';
import { languageOptionsFor, HAS_BETA_LANGUAGES, HAS_UNREVIEWED_LANGUAGES } from '../config/locales';

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
/**
 * What the entry says about itself.
 *
 * A percentage is only informative while there are blanks left to fill. A
 * bulk-drafted language is 100% filled and 0% read, so "beta · 100%" would read
 * as a contradiction — what is actually missing there is a human's eyes, and
 * that is what the label says instead.
 */
const optionLabel = (t, { label, beta, unreviewed, percent }) => {
  if (beta && unreviewed) {
    return t('settings.languageBetaUnreviewedOption', '{{language}} (beta · unreviewed)', {
      language: label,
    });
  }
  if (beta) {
    return t('settings.languageBetaOption', '{{language}} (beta · {{percent}}%)', {
      language: label,
      percent,
    });
  }
  if (unreviewed) {
    return t('settings.languageUnreviewedOption', '{{language}} (unreviewed)', { language: label });
  }
  return label;
};

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
        {options.map(({ code, label, beta, unreviewed, percent }) => (
          <option key={code} value={code}>
            {optionLabel(t, { label, beta, unreviewed, percent })}
          </option>
        ))}
      </select>
      {(HAS_BETA_LANGUAGES || HAS_UNREVIEWED_LANGUAGES) && (
        <p className="settings-hint">
          {HAS_BETA_LANGUAGES && t(
            'settings.languageBetaHint',
            'Beta languages are community translations still in progress — anything not translated yet stays in English.'
          )}
          {HAS_BETA_LANGUAGES && HAS_UNREVIEWED_LANGUAGES && ' '}
          {HAS_UNREVIEWED_LANGUAGES && t(
            'settings.languageUnreviewedHint',
            '“Unreviewed” means the translation is complete but no native speaker has checked it yet — if something reads wrong, you can fix it.'
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

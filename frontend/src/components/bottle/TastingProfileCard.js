import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

/**
 * The wine's tasting profile (generated or curator-verified, vintage-neutral):
 * structure, flavours, the prose and the pairings — or an honest "not yet
 * assessed" when there is none. Shared by the bottle page and the vintage
 * page. `onReport` adds "Report tasting profile"; without it there is no
 * report action.
 */
export default function TastingProfileCard({ wine, onReport }) {
  const { t } = useTranslation();
  if (!wine) return null;

  // No published profile — an honest "not yet assessed" instead of a
  // silent blank (somm ticket 6a83e765 rollout note). Held-by-the-gate and
  // never-generated are deliberately indistinguishable here, so the card
  // can never leak WHY a profile is missing.
  if (!wine.aiProfile?.description) {
    return (
      <div className="bd-ai-profile card">
        <div className="bd-ai-profile__header">
          <h2>{t('bottleDetail.tastingProfile', 'Tasting profile')}</h2>
          <span className="bd-ai-tag" title={t('bottleDetail.profilePendingTitle', 'This wine has not been through assessment yet — profiles are generated and reviewed over time')}>
            {t('bottleDetail.profilePending', 'Not yet assessed')}
          </span>
        </div>
        <p style={{ color: 'var(--color-text-muted)', margin: 0, fontSize: '0.9rem' }}>
          {t('bottleDetail.profilePendingBody', 'This wine hasn’t been assessed yet. A tasting profile appears here once it has been.')}
        </p>
      </div>
    );
  }

  const ap = wine.aiProfile;
  const structure = [
    ap.body && `${ap.body}-bodied`,
    ap.tannin && `${ap.tannin} tannin`,
    ap.acidity && `${ap.acidity} acidity`,
    ap.sweetness,
  ].filter(Boolean);
  const flavours = ap.flavors || [];

  return (
    <div className="bd-ai-profile card">
      <div className="bd-ai-profile__header">
        <h2>{t('bottleDetail.tastingProfile', 'Tasting profile')}</h2>
        {/* Provenance is load-bearing (#985): never present AI-generated
            profile text as established fact. */}
        {ap.source === 'curator' ? (
          <span className="bd-ai-tag bd-ai-tag--curator" title={t('bottleDetail.provenanceCuratorTitle', 'A sommelier has verified this profile')}>
            {t('bottleDetail.provenanceCurator', 'Curator-verified')}
          </span>
        ) : (
          <span className="bd-ai-tag" title={t('bottleDetail.provenanceAiTitle', 'Written by AI from the wine’s identity — a starting point, not a fact')}>
            {t('bottleDetail.provenanceAi', 'AI-generated')}
          </span>
        )}
      </div>

      {structure.length > 0 && (
        <div className="bd-ai-group">
          <span className="bd-ai-group-label">{t('bottleDetail.structure', 'Structure')}</span>
          <div className="bd-ai-chips">
            {structure.map((c, i) => <span key={`s${i}`} className="bd-ai-chip bd-ai-chip--style">{c}</span>)}
          </div>
        </div>
      )}
      {flavours.length > 0 && (
        <div className="bd-ai-group">
          <span className="bd-ai-group-label">{t('bottleDetail.flavours', 'Flavours')}</span>
          <div className="bd-ai-chips">
            {flavours.map((f, i) => <span key={`f${i}`} className="bd-ai-chip">{f}</span>)}
          </div>
        </div>
      )}

      <div className="bd-ai-prose">
        <ReactMarkdown rehypePlugins={[rehypeSanitize]} disallowedElements={['img']} unwrapDisallowed>{ap.description}</ReactMarkdown>
      </div>

      {ap.foodPairings?.length > 0 && (
        <div className="bd-ai-pairings">
          <span className="bd-ai-pairings__label">{t('bottleDetail.pairsWith', 'Pairs with')}:</span>
          {ap.foodPairings.join(' · ')}
        </div>
      )}

      {onReport && (
        <div className="bd-report-wine">
          <button type="button" className="btn-report-wine" onClick={onReport}>
            {t('bottleDetail.reportTastingProfile', 'Report tasting profile')}
          </button>
        </div>
      )}
    </div>
  );
}

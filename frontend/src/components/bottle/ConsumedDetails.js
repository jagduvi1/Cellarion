import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import RatingDisplay from '../RatingDisplay';

const CONSUMED_REASON_ICONS = { drank: '\u{1F377}', gifted: '\u{1F381}', sold: '\u{1F4B0}', other: '\u{1F4E6}' };

function ConsumedDetails({ bottle }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const reason = bottle.consumedReason || bottle.status;
  const icon = CONSUMED_REASON_ICONS[reason] || '\u{1F4E6}';
  const consumedDate = bottle.consumedAt
    ? new Date(bottle.consumedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  return (
    <div className={`bd-consumed card bd-consumed--${reason}`}>
      <div className="bd-consumed__header">
        <span className="bd-consumed__icon">{icon}</span>
        <span className="bd-consumed__reason">
          {t(`history.reason_${reason}`, reason.charAt(0).toUpperCase() + reason.slice(1))}
        </span>
        {consumedDate && <span className="bd-consumed__date">{consumedDate}</span>}
      </div>
      {bottle.consumedRating && (
        <div className="bd-consumed__rating">
          <span className="bd-detail-label">{t('history.atConsumption', 'Rating at consumption')}</span>
          <RatingDisplay value={bottle.consumedRating} scale={bottle.consumedRatingScale || '5'} preferredScale={user?.preferences?.ratingScale} />
        </div>
      )}
      {bottle.consumedNote && (
        <p className="bd-consumed__note">"{bottle.consumedNote}"</p>
      )}
    </div>
  );
}

export default ConsumedDetails;

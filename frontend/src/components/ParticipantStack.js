import { useTranslation } from 'react-i18next';
import { isDeletedUser, authorDisplayName } from '../utils/deletedUser';
import './ParticipantStack.css';

// Overlapping avatar stack used on the discussion-detail header to show who
// else is in this conversation. The OP isn't shown here (the author byline
// already covers them); this is "X other voices in this thread."
//
// Up to 6 avatars are rendered overlapping; if there are more, a "+N" pill
// at the end signals the overflow. Hovering a chip shows the username.
export default function ParticipantStack({ participants, total }) {
  const { t } = useTranslation();
  if (!participants || participants.length === 0) return null;

  const overflow = Math.max(0, (total || participants.length) - participants.length);

  return (
    <div className="participant-stack" aria-label={t('discussions.participants', { count: total || participants.length })}>
      <span className="participant-stack__label">{t('discussions.alsoTalking')}</span>
      <ul className="participant-stack__list">
        {participants.map(p => {
          const deleted = isDeletedUser(p);
          const name = authorDisplayName(p, t, t('common.unknown'));
          const initial = deleted ? '?' : name.charAt(0).toUpperCase();
          return (
            <li
              key={p._id || p.username}
              className={`participant-stack__avatar ${deleted ? 'participant-stack__avatar--deleted' : ''}`}
              title={name}
            >
              {initial}
            </li>
          );
        })}
        {overflow > 0 && (
          <li className="participant-stack__overflow" title={t('discussions.moreParticipants', { count: overflow })}>
            +{overflow}
          </li>
        )}
      </ul>
    </div>
  );
}

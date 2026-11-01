import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { bottleNoticeName } from './BottleUndoNotice';
import { glassesLeft, drinkByDate, freshnessStatus } from '../utils/openBottle';
import { useBackHere } from '../utils/useBackHere';
import './OpenNowStrip.css';

/**
 * "Open now" at the top of the cellar's bottle list: every bottle in view
 * that is open (Coravin, recorked, …), most urgent first as the server sends
 * them, so it gets finished — and rated — before it turns. Each one leads to
 * its page, where "Finish bottle…" logs it; the way back is this list.
 * Renders nothing when no bottle is open.
 */
export default function OpenNowStrip({ bottles }) {
  const { t, i18n } = useTranslation();
  const backHere = useBackHere('cellar');
  if (!Array.isArray(bottles) || bottles.length === 0) return null;

  const dateFmt = (d) => d.toLocaleDateString(i18n.language || undefined, { month: 'short', day: 'numeric' });

  return (
    <section className="open-now" aria-labelledby="open-now-title">
      <h2 id="open-now-title" className="open-now-title">
        <span aria-hidden="true">🍷</span> {t('openNow.title', 'Open now')}
      </h2>
      <ul className="open-now-list">
        {bottles.map((b) => {
          const status = freshnessStatus(b) || 'ok';
          const deadline = drinkByDate(b);
          return (
            <li key={b._id}>
              <Link
                to={`/cellars/${b.cellar}/bottles/${b._id}`}
                state={backHere}
                className={`open-now-item open-now-item--${status}`}
              >
                <span className="open-now-name">{bottleNoticeName(b) || t('openNow.unnamed', 'Open bottle')}</span>
                <span className="open-now-meta">
                  {status === 'past'
                    ? t('openBottle.pastWindow', 'Past its window — drink now')
                    : t('openNow.meta', '≈ {{glasses}} glasses · drink by {{date}}', {
                      glasses: glassesLeft(b),
                      date: deadline ? dateFmt(deadline) : '',
                    })}
                  {b.cellarName ? ` · ${b.cellarName}` : ''}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

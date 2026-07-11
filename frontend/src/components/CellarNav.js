import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import './CellarNav.css';

/**
 * Shared cellar view switcher — the same strip on every cellar page so users
 * can hop between views (bottles, racks, 3D room, history, cellar book)
 * without going back through the cellar landing first. Grew out of the menu
 * cleanup: destinations live here, actions live in the ⋮ menu.
 *
 * `active`   — 'bottles' | 'racks' | 'room' | 'history' | 'book'
 * `children` — optional custom leading tabs; when present the built-in
 *              "Bottles" link is omitted (CellarDetail injects its in-page
 *              Bottles/Overview toggle instead).
 */
function CellarNav({ cellarId, active, children }) {
  const { t } = useTranslation();

  const views = [
    ...(children ? [] : [{ key: 'bottles', to: `/cellars/${cellarId}`, label: t('cellarDetail.tabBottles') }]),
    { key: 'racks', to: `/cellars/${cellarId}/racks`, label: t('cellarDetail.racks') },
    { key: 'room', to: `/cellars/${cellarId}/room`, label: t('cellarDetail.roomView', 'Room View') },
    { key: 'history', to: `/cellars/${cellarId}/history`, label: t('cellarDetail.history') },
    { key: 'book', to: `/cellars/${cellarId}/book`, label: t('cellarBook.linkBtn', 'Cellar Book') },
  ];

  return (
    <nav className="cellar-nav" aria-label={t('cellarNav.aria', 'Cellar views')}>
      {children}
      {views.map(v => (
        <Link
          key={v.key}
          to={v.to}
          className={`cellar-nav-tab ${active === v.key ? 'active' : ''}`}
          aria-current={active === v.key ? 'page' : undefined}
        >
          {v.label}
        </Link>
      ))}
    </nav>
  );
}

export default CellarNav;

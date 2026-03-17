import { useNavigate, Link } from 'react-router-dom';
import AuthImage from './AuthImage';

/**
 * Renders a single bottle in either list or card (grid) view.
 * Props: bottle, rackMap, cellarId, viewMode ('list' | 'card')
 */
function BottleCard({ bottle, rackMap, cellarId, viewMode }) {
  const navigate = useNavigate();
  const rackInfo = rackMap.get(bottle._id);
  const imgSrc = bottle.wineDefinition?.image || bottle.pendingImageUrl;
  const credit = bottle.wineDefinition?.imageCredit;
  const isPending = !bottle.wineDefinition && !!bottle.pendingWineRequest;
  const displayName = bottle.wineDefinition?.name || bottle.pendingWineRequest?.wineName || 'Unknown Wine';
  const displayProducer = bottle.wineDefinition?.producer || bottle.pendingWineRequest?.producer;

  const handleClick = () => navigate(`/cellars/${cellarId}/bottles/${bottle._id}`);
  const handleKey = e => e.key === 'Enter' && handleClick();

  if (viewMode === 'card') {
    return (
      <div
        className="bottle-grid-card"
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={handleKey}
      >
        <div className="bottle-grid-image-wrap">
          {imgSrc ? (
            <>
              <AuthImage
                src={imgSrc}
                alt={displayName}
                className="bottle-grid-image"
                loading="lazy"
                onError={e => { e.target.style.display = 'none'; }}
              />
              {credit && <span className="img-credit-tooltip">{credit}</span>}
            </>
          ) : (
            <div className={`bottle-grid-placeholder ${bottle.wineDefinition?.type}`} />
          )}
        </div>
        <div className="bottle-grid-info">
          <div className="bottle-grid-name">{displayName}</div>
          <div className="bottle-grid-producer">{displayProducer}</div>
          <div className="bottle-grid-meta">
            {bottle.vintage && <span className="bottle-vintage">{bottle.vintage}</span>}
            {bottle.wineDefinition?.region?.name && (
              <span className="bottle-grid-region">{bottle.wineDefinition.region.name}</span>
            )}
          </div>
          <div className="bottle-badges">
            {isPending && (
              <span className="pending-wine-badge">Pending review</span>
            )}
            {rackInfo && (
              <Link
                to={`/cellars/${cellarId}/racks?highlight=${bottle._id}`}
                className="rack-badge"
                onClick={e => e.stopPropagation()}
              >
                <span aria-hidden="true">📍</span> {rackInfo.rackName}
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  // list view (default)
  return (
    <div
      className="bottle-card"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={handleKey}
    >
      {imgSrc ? (
        <div className="bottle-img-wrap">
          <AuthImage
            src={imgSrc}
            alt={displayName}
            className="bottle-wine-image"
            loading="lazy"
            onError={e => { e.target.style.display = 'none'; }}
          />
          {credit && <span className="img-credit-tooltip">{credit}</span>}
        </div>
      ) : (
        <div className={`bottle-wine-placeholder ${bottle.wineDefinition?.type}`} />
      )}

      <div className="bottle-info">
        <div className="bottle-name">{displayName}</div>
        <div className="bottle-meta">
          <span className="bottle-producer">{displayProducer}</span>
          {bottle.vintage && <span className="bottle-vintage">{bottle.vintage}</span>}
        </div>
        <div className="bottle-badges">
          {isPending && (
            <span className="pending-wine-badge">Pending review</span>
          )}
          {rackInfo && (
            <Link
              to={`/cellars/${cellarId}/racks?highlight=${bottle._id}`}
              className="rack-badge"
              onClick={e => e.stopPropagation()}
            >
              📍 {rackInfo.rackName}
            </Link>
          )}
        </div>
      </div>

      <span className="bottle-chevron" aria-hidden="true">›</span>
    </div>
  );
}

export default BottleCard;

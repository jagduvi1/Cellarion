import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import worldData from 'world-atlas/countries-110m.json';
import { NUM_TO_A2 } from '../../utils/isoCountryCodes';

function getCountryFill(count, maxCount) {
  if (!count || count === 0) return '#161f1c';
  const t = maxCount > 1 ? Math.log(count) / Math.log(maxCount) : 1;
  const r = Math.round(38  + t * (123 - 38));
  const g = Math.round(61  + t * (158 - 61));
  const b = Math.round(50  + t * (136 - 50));
  return `rgb(${r},${g},${b})`;
}

// Memoized map paths: re-renders only when byCode/maxCount change, NOT when the
// parent's hover state updates — so moving the pointer between countries no
// longer reconciles all ~177 <Geography> elements (hover highlight is CSS-driven
// via style.hover; onHover only feeds the parent's info bar).
const MapPaths = memo(function MapPaths({ byCode, maxCount, onHover }) {
  return (
    <ComposableMap
      width={800}
      height={400}
      projection="geoEqualEarth"
      projectionConfig={{ scale: 155 }}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      <Geographies geography={worldData}>
        {({ geographies }) =>
          geographies.map(geo => {
            const alpha2  = NUM_TO_A2[String(geo.id)];
            const data    = alpha2 ? byCode[alpha2] : null;
            const fill    = getCountryFill(data?.count, maxCount);
            const hasData = !!data;

            return (
              <Geography
                key={geo.rsmKey}
                geography={geo}
                fill={fill}
                stroke="#0a1512"
                strokeWidth={0.35}
                onMouseEnter={() => hasData && onHover(data)}
                onMouseLeave={() => onHover(null)}
                style={{
                  default: { outline: 'none', transition: 'fill 0.1s' },
                  hover:   { fill: hasData ? '#9bbfa8' : '#1e2e28', outline: 'none', cursor: 'default' },
                  pressed: { outline: 'none' },
                }}
              />
            );
          })
        }
      </Geographies>
    </ComposableMap>
  );
});

function WorldMapChart({ byCountry }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(null);

  const { byCode, maxCount, unmappedCount } = useMemo(() => {
    const codes = {};
    for (const c of byCountry) {
      if (c.code) codes[c.code] = c;
    }
    const max = byCountry.length > 0 ? Math.max(...byCountry.map(c => c.count)) : 1;
    const mapped = byCountry.filter(c => c.code).length;
    return { byCode: codes, maxCount: max, unmappedCount: byCountry.length - mapped };
  }, [byCountry]);

  return (
    <div className="worldmap-wrap">
      <div className="worldmap-info-bar">
        {hovered ? (
          <>
            <span className="worldmap-info-name">{hovered.name}</span>
            <span className="worldmap-info-count">
              {t('statistics.worldMap.bottle', { count: hovered.count })}
            </span>
          </>
        ) : (
          <span className="worldmap-info-hint">{t('statistics.worldMap.hoverHint')}</span>
        )}
      </div>

      <MapPaths byCode={byCode} maxCount={maxCount} onHover={setHovered} />

      <div className="worldmap-legend">
        <div className="worldmap-legend-scale">
          <span>1</span>
          <div className="worldmap-legend-gradient" />
          <span>{maxCount.toLocaleString()}</span>
          <span className="worldmap-legend-unit">{t('statistics.worldMap.legendUnit')}</span>
        </div>
        {unmappedCount > 0 && (
          <span className="worldmap-legend-note">
            {t('statistics.worldMap.unmapped', { count: unmappedCount })}
          </span>
        )}
      </div>
    </div>
  );
}

export default WorldMapChart;

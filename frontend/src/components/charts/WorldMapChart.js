import { useState } from 'react';
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

function WorldMapChart({ byCountry }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(null);

  const byCode = {};
  for (const c of byCountry) {
    if (c.code) byCode[c.code] = c;
  }

  const maxCount = byCountry.length > 0 ? Math.max(...byCountry.map(c => c.count)) : 1;
  const mappedCount  = byCountry.filter(c => c.code).length;
  const unmappedCount = byCountry.length - mappedCount;

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
                  onMouseEnter={() => hasData && setHovered(data)}
                  onMouseLeave={() => setHovered(null)}
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

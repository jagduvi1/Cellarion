import { GLASS_LABEL } from '../utils/wineListSections';
import './WineListMenu.css';

// Same palettes as the PDF generator (backend/src/services/wineListPdf.js)
const COLOR_SCHEMES = {
  classic:  { heading: '#2c1810', subheading: '#5c3a2e', text: '#333333', accent: '#8b0000', line: '#cccccc', bg: '#fdfbf7' },
  modern:   { heading: '#1a1a2e', subheading: '#16213e', text: '#2d2d2d', accent: '#0f3460', line: '#e0e0e0', bg: '#ffffff' },
  elegant:  { heading: '#2c2c2c', subheading: '#555555', text: '#444444', accent: '#8b6914', line: '#d4c5a9', bg: '#fbf9f4' },
  minimal:  { heading: '#000000', subheading: '#666666', text: '#333333', accent: '#999999', line: '#eeeeee', bg: '#ffffff' },
};

/**
 * Restaurant-facing wine list rendering — shared by the public /menu/:token
 * page and the editor's live preview tab.
 */
function WineListMenu({ branding = {}, layout = {}, language = 'en', sections = [], logoSrc = null }) {
  const scheme = COLOR_SCHEMES[layout.colorScheme] || COLOR_SCHEMES.classic;
  const currencySymbol = layout.currencySymbol || '$';
  const glassLabel = GLASS_LABEL[language] || GLASS_LABEL.en;
  const fontFamily = layout.fontFamily === 'sans-serif'
    ? "'Helvetica Neue', Helvetica, Arial, sans-serif"
    : "Georgia, 'Times New Roman', serif";

  const style = {
    '--wlm-heading': scheme.heading,
    '--wlm-subheading': scheme.subheading,
    '--wlm-text': scheme.text,
    '--wlm-accent': scheme.accent,
    '--wlm-line': scheme.line,
    '--wlm-bg': scheme.bg,
    fontFamily,
  };

  // A wine can be glass-only (no bottle price) — render whichever prices exist
  const renderPrice = (wine) => {
    const parts = [];
    if (wine.price != null) parts.push(`${currencySymbol}${Math.round(wine.price)}`);
    if (wine.glassPrice != null) parts.push(`${currencySymbol}${Math.round(wine.glassPrice)} ${glassLabel}`);
    return parts.length ? parts.join(' / ') : null;
  };

  return (
    <div className="wlm" style={style}>
      <header className="wlm-header">
        {logoSrc && <img src={logoSrc} alt="" className="wlm-logo" />}
        {branding.restaurantName && <h1 className="wlm-restaurant">{branding.restaurantName}</h1>}
        {branding.tagline && <p className="wlm-tagline">{branding.tagline}</p>}
        <div className="wlm-rule" />
      </header>

      {sections.map((section, i) => (
        <section key={i} className="wlm-section">
          <h2 className="wlm-section-title">{section.title}</h2>
          <ul className="wlm-wines">
            {section.wines.map((wine, j) => {
              const sizeSuffix = wine.bottleSize && wine.bottleSize !== '750ml' ? ` (${wine.bottleSize})` : '';
              const grapes = (wine.grapes || []).slice(0, 3).join(', ');
              const producerRegion = [wine.producer, wine.region].filter(Boolean).join(' — ');
              const details = [producerRegion, grapes].filter(Boolean).join(' · ');
              const priceText = renderPrice(wine);
              return (
                <li key={wine.key || j} className="wlm-wine">
                  <div className="wlm-wine-row">
                    <span className="wlm-wine-name">
                      {wine.name}, {wine.vintage || 'NV'}{sizeSuffix}
                    </span>
                    <span className="wlm-wine-dots" aria-hidden="true" />
                    {priceText && <span className="wlm-wine-price">{priceText}</span>}
                  </div>
                  {details && <div className="wlm-wine-details">{details}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {branding.footerText && <footer className="wlm-footer">{branding.footerText}</footer>}
    </div>
  );
}

export default WineListMenu;

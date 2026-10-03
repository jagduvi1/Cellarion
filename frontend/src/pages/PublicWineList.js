import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import WineListMenu from '../components/WineListMenu';
import SITE_URL from '../config/siteUrl';
import { track } from '../utils/track';
import './PublicWineList.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

// Guest-facing strings follow the LIST's language (set by the restaurant),
// not the viewer's app locale — guests don't have one.
const STRINGS = {
  en: { pdf: 'Download PDF', notFound: 'This wine list is not available.', madeWith: 'Made with Cellarion', cta: 'Create your own wine cellar — free' },
  sv: { pdf: 'Ladda ner PDF', notFound: 'Den här vinlistan är inte tillgänglig.', madeWith: 'Skapad med Cellarion', cta: 'Skapa din egen vinkällare — gratis' },
  fr: { pdf: 'Télécharger le PDF', notFound: "Cette carte des vins n'est pas disponible.", madeWith: 'Créée avec Cellarion', cta: 'Créez votre propre cave — gratuit' },
  de: { pdf: 'PDF herunterladen', notFound: 'Diese Weinkarte ist nicht verfügbar.', madeWith: 'Erstellt mit Cellarion', cta: 'Eigenen Weinkeller anlegen — kostenlos' },
  es: { pdf: 'Descargar PDF', notFound: 'Esta carta de vinos no está disponible.', madeWith: 'Creada con Cellarion', cta: 'Crea tu propia bodega — gratis' },
  it: { pdf: 'Scarica PDF', notFound: 'Questa carta dei vini non è disponibile.', madeWith: 'Creata con Cellarion', cta: 'Crea la tua cantina — gratis' },
};

// The footer link back to Cellarion. Tagged so a signup that starts here is
// counted as "shared-list" on the admin stats (utils/signupSource), the same
// channel a visitor who lands on a list and signs up in-app is filed under.
const MADE_WITH_URL = `${SITE_URL.replace(/\/$/, '')}/?utm_source=shared-list&utm_medium=referral`;

function PublicWineList() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/wine-lists/public/${token}`);
        if (!res.ok) throw new Error('not found');
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (loading) {
    return <div className="pwl-status">…</div>;
  }

  if (error || !data) {
    return <div className="pwl-status">{STRINGS.en.notFound}</div>;
  }

  const t = STRINGS[data.language] || STRINGS.en;
  const pdfUrl = `${API_BASE}/api/wine-lists/public/${token}/pdf`;
  const logoSrc = data.branding?.logoUrl ? `${API_BASE}/api/uploads/${data.branding.logoUrl}` : null;
  const title = data.branding?.restaurantName
    ? `${data.branding.restaurantName} — ${data.name}`
    : data.name;

  return (
    <div className="pwl-page">
      <Helmet>
        <title>{title}</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <WineListMenu
        branding={data.branding}
        layout={data.layout}
        language={data.language}
        sections={data.sections}
        logoSrc={logoSrc}
      />
      <div className="pwl-actions">
        <a className="pwl-pdf-link" href={pdfUrl} target="_blank" rel="noopener noreferrer">
          {t.pdf}
        </a>
      </div>
      <p className="pwl-made-with">
        {t.madeWith} ·{' '}
        <a href={MADE_WITH_URL} onClick={() => track('shared-list-cta')}>
          {t.cta}
        </a>
      </p>
    </div>
  );
}

export default PublicWineList;

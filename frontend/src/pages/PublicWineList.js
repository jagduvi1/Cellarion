import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import WineListMenu from '../components/WineListMenu';
import './PublicWineList.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

// Guest-facing strings follow the LIST's language (set by the restaurant),
// not the viewer's app locale — guests don't have one.
const STRINGS = {
  en: { pdf: 'Download PDF', notFound: 'This wine list is not available.' },
  sv: { pdf: 'Ladda ner PDF', notFound: 'Den här vinlistan är inte tillgänglig.' },
  fr: { pdf: 'Télécharger le PDF', notFound: "Cette carte des vins n'est pas disponible." },
  de: { pdf: 'PDF herunterladen', notFound: 'Diese Weinkarte ist nicht verfügbar.' },
  es: { pdf: 'Descargar PDF', notFound: 'Esta carta de vinos no está disponible.' },
  it: { pdf: 'Scarica PDF', notFound: 'Questa carta dei vini non è disponibile.' },
};

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
    </div>
  );
}

export default PublicWineList;

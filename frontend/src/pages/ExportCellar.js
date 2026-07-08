import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { listCellars } from '../api/cellars';
import { getExportSummary, downloadDataExport, downloadFullExport } from '../api/cellarExport';
import { downloadBlobObject } from '../utils/downloadBlob';

/**
 * The single "Take your cellars with you" export page. Reached from the cellar
 * ⋮ menu (pre-scoped to that cellar via ?cellar=<id>) and from Settings (all
 * cellars). Shows a live summary of exactly what the export contains, then lets
 * the user download it as JSON (data only) or a ZIP (data + their own images).
 *
 * Anti-lock-in: the export is import-ready into any Cellarion instance and
 * includes bottles, racks, the 3D room layout, reviews and the sommelier
 * maturity (drink-window) data for each wine.
 */
function slugify(name) {
  return (name || 'cellar').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'cellar';
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return '< 0.1 MB';
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function ExportCellar() {
  const { apiFetch } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [ownedCellars, setOwnedCellars] = useState([]);
  const [scope, setScope] = useState(searchParams.get('cellar') || 'all');
  const [summary, setSummary] = useState(null);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [summaryError, setSummaryError] = useState(null);
  const [downloading, setDownloading] = useState(null); // 'data' | 'full' | null
  const [error, setError] = useState(null);

  // Owned cellars for the scope dropdown.
  useEffect(() => {
    let active = true;
    listCellars(apiFetch)
      .then(res => (res.ok ? res.json() : { cellars: [] }))
      .then(data => {
        if (!active) return;
        setOwnedCellars((data.cellars || []).filter(c => c.userRole === 'owner'));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [apiFetch]);

  const loadSummary = useCallback(() => {
    let active = true;
    setLoadingSummary(true);
    setSummaryError(null);
    getExportSummary(apiFetch, scope)
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!active) return;
        if (!res.ok) {
          // The backend reports "no owned cellar in this selection" as a 404
          // (a brand-new user always hits this) — show the friendly empty
          // state instead of a raw error.
          if (res.status === 404) { setSummary({ cellarCount: 0 }); return; }
          setSummary(null); setSummaryError(data.error || 'Could not read this selection'); return;
        }
        setSummary(data);
      })
      .catch(() => { if (active) setSummaryError('Could not read this selection'); })
      .finally(() => { if (active) setLoadingSummary(false); });
    return () => { active = false; };
  }, [apiFetch, scope]);

  useEffect(() => loadSummary(), [loadSummary]);

  const onScopeChange = (next) => {
    setScope(next);
    setError(null);
    const params = new URLSearchParams(searchParams);
    if (next === 'all') params.delete('cellar'); else params.set('cellar', next);
    setSearchParams(params, { replace: true });
  };

  const scopeLabel = useMemo(() => {
    if (scope === 'all') return 'all-cellars';
    return slugify(ownedCellars.find(c => c._id === scope)?.name);
  }, [scope, ownedCellars]);

  const imageLocked = !!summary?.imageExportLocked;
  const hasImages = (summary?.imageCount || 0) > 0;

  const handleDownload = async (withImages) => {
    setDownloading(withImages ? 'full' : 'data');
    setError(null);
    try {
      const res = withImages ? await downloadFullExport(apiFetch, scope) : await downloadDataExport(apiFetch, scope);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429 && data.nextAvailableAt) {
          throw new Error(`Full exports with images are limited to once per week. You can do this again on ${formatDate(data.nextAvailableAt)}.`);
        }
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      downloadBlobObject(blob, `cellarion-${scopeLabel}-export.${withImages ? 'zip' : 'json'}`);
      // The ZIP consumes the weekly allowance — refresh so the lock reflects it.
      if (withImages) loadSummary();
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading(null);
    }
  };

  const noCellars = !loadingSummary && !summaryError && summary && summary.cellarCount === 0;

  return (
    <div className="container" style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h1>Take your cellars with you</h1>
      <p className="settings-hint">
        Export your bottles, rack placements, 3D room layout, reviews and the maturity
        (drink-window) data — in a format you can import into any Cellarion instance.
        Your data is yours; we never lock it in.
      </p>

      <div className="card settings-card">
        <div className="form-group">
          <label htmlFor="export-scope-select">Cellar</label>
          <select
            id="export-scope-select"
            className="input settings-select"
            value={scope}
            onChange={e => onScopeChange(e.target.value)}
          >
            <option value="all">All my cellars</option>
            {ownedCellars.map(c => (
              <option key={c._id} value={c._id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Total export summary (hidden when there is nothing to export yet) */}
        {!noCellars && (
          <div className="card" style={{ marginTop: '1rem', padding: '1rem', background: 'var(--surface-2, #f7f7f8)' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>This export contains</div>
            {loadingSummary ? (
              <div className="settings-hint">Calculating…</div>
            ) : summaryError ? (
              <div className="alert alert-error">{summaryError}</div>
            ) : summary ? (
              <ul style={{ margin: 0, paddingLeft: '1.1rem', lineHeight: 1.8 }}>
                <li>{summary.cellarCount} cellar{summary.cellarCount === 1 ? '' : 's'} · {summary.bottleCount} bottles · {summary.rackCount} racks</li>
                <li>{summary.layoutCount > 0 ? `${summary.layoutCount} 3D room layout${summary.layoutCount === 1 ? '' : 's'}` : 'No 3D room layout'}</li>
                <li>{summary.reviewCount} reviews · {summary.maturityCount} maturity window{summary.maturityCount === 1 ? '' : 's'}</li>
                <li>{summary.imageCount} of your images{summary.imageCount > 0 ? ` (~${formatBytes(summary.imageBytes)})` : ''}</li>
              </ul>
            ) : null}
          </div>
        )}

        {noCellars ? (
          <p className="settings-hint" style={{ marginTop: '1rem' }}>
            You don't have any cellars to export yet. <Link to="/cellars">Create one first</Link>.
          </p>
        ) : (
          <>
            <div className="settings-actions" style={{ marginTop: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <button
                className="btn btn-secondary"
                onClick={() => handleDownload(false)}
                disabled={downloading !== null || loadingSummary || !!summaryError}
              >
                {downloading === 'data' ? 'Preparing…' : 'Download data (JSON)'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => handleDownload(true)}
                disabled={downloading !== null || loadingSummary || !!summaryError || imageLocked || !hasImages}
                title={imageLocked && summary?.nextAvailableAt ? `Available again on ${formatDate(summary.nextAvailableAt)}` : undefined}
              >
                {downloading === 'full' ? 'Building archive…' : 'Download data + images (ZIP)'}
              </button>
            </div>

            <p className="settings-hint" style={{ marginTop: '0.75rem' }}>
              {imageLocked && summary?.nextAvailableAt
                ? `You've already downloaded images recently. The image archive is available again on ${formatDate(summary.nextAvailableAt)}.`
                : !hasImages
                  ? 'This selection has no images you uploaded, so only the JSON is available. The JSON download has no limit.'
                  : 'The image archive can be large, so it is limited to once per week. The JSON download has no limit.'}
            </p>
            {error && <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>{error}</div>}
          </>
        )}
      </div>

      <p className="settings-hint" style={{ marginTop: '1rem' }}>
        Moving in from another Cellarion instance? <Link to="/import-cellar">Import a cellar export</Link> to
        recreate your cellars, bottles and images here.
      </p>
    </div>
  );
}

export default ExportCellar;

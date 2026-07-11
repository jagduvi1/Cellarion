import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { listCellars } from '../api/cellars';
import { previewCellarImport, runCellarImport } from '../api/cellarImport';

/**
 * Import a Cellarion cellar export (.json or .zip).
 * - Each cellar in the export gets an editable target name.
 * - If the name matches an existing cellar → warn + require confirm (overwrite,
 *   full replace). If changed/new → a new cellar is created.
 * - The .zip variant also re-attaches the images the user uploaded themselves.
 */
function ImportCellar() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const navigate = useNavigate();

  const [ownedNames, setOwnedNames] = useState(new Set()); // lowercased existing cellar names
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null); // { cellars:[...], hasImageFiles }
  const [names, setNames] = useState({});       // sourceName -> target name
  const [confirms, setConfirms] = useState({});  // sourceName -> bool (overwrite confirmed)
  // Lowercased target names the server refused with 409 "not confirmed" —
  // forces the confirm checkbox even when our owned-names snapshot is stale.
  const [forcedOverwrites, setForcedOverwrites] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // Owned cellar names drive the overwrite warnings. Re-fetched after every
  // successful import and on reset, so re-importing the same file (or a cellar
  // created in another tab) still shows the confirm checkbox instead of
  // dead-ending on the backend's 409.
  const refreshOwnedNames = useCallback(async () => {
    try {
      const res = await listCellars(apiFetch);
      const data = res.ok ? await res.json() : { cellars: [] };
      const owned = (data.cellars || []).filter(c => c.userRole === 'owner');
      setOwnedNames(new Set(owned.map(c => c.name.toLowerCase())));
    } catch { /* keep the previous snapshot */ }
  }, [apiFetch]);

  useEffect(() => { refreshOwnedNames(); }, [refreshOwnedNames]);

  const handleFile = async (f) => {
    setFile(f); setError(null); setResult(null); setPreview(null);
    if (!f) return;
    setBusy(true);
    try {
      const res = await previewCellarImport(apiFetch, f);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('importCellar.errorReadFile'));
      setPreview(data);
      const initNames = {}; const initConfirms = {};
      data.cellars.forEach(c => { initNames[c.sourceName] = c.defaultTargetName; initConfirms[c.sourceName] = false; });
      setNames(initNames); setConfirms(initConfirms); setForcedOverwrites(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Live per-cellar status as the user edits target names.
  const rows = useMemo(() => {
    if (!preview) return [];
    const seen = new Map(); // lowercased target -> first source (dup detection)
    return preview.cellars.map(c => {
      const targetName = (names[c.sourceName] ?? c.defaultTargetName ?? '').trim();
      const lc = targetName.toLowerCase();
      const willOverwrite = !!targetName && (
        ownedNames.has(lc) ||
        forcedOverwrites.has(lc) ||
        // Server-computed flag from the preview — authoritative for the
        // unedited default name even if our owned-names snapshot is stale.
        (!!c.willOverwrite && lc === (c.defaultTargetName || '').trim().toLowerCase())
      );
      const dup = lc && seen.has(lc);
      if (lc) seen.set(lc, c.sourceName);
      return { ...c, targetName, willOverwrite, dup };
    });
  }, [preview, names, ownedNames, forcedOverwrites]);

  const blocking = useMemo(() => {
    for (const r of rows) {
      if (!r.targetName) return t('importCellar.blockingNeedName');
      if (r.dup) return t('importCellar.blockingDupName', { name: r.targetName });
      if (r.willOverwrite && !confirms[r.sourceName]) return t('importCellar.blockingConfirmOverwrite', { name: r.targetName });
    }
    return null;
  }, [rows, confirms, t]);

  const handleImport = async () => {
    setBusy(true); setError(null);
    try {
      const targets = {};
      rows.forEach(r => { targets[r.sourceName] = { targetName: r.targetName, confirmOverwrite: !!confirms[r.sourceName] }; });
      const res = await runCellarImport(apiFetch, file, targets);
      const data = await res.json();
      if (!res.ok) {
        // Overwrite refused (409): our owned-names snapshot was stale. Force
        // the confirm checkbox for that target and refresh the snapshot so
        // the user can confirm and retry instead of dead-ending.
        if (res.status === 409 && data.needsConfirm) {
          setForcedOverwrites(prev => new Set(prev).add(String(data.needsConfirm).toLowerCase()));
          refreshOwnedNames();
        }
        throw new Error(data.error || t('importCellar.errorImportFailed'));
      }
      setResult(data.results || []);
      refreshOwnedNames();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(null); setPreview(null); setNames({}); setConfirms({});
    setForcedOverwrites(new Set()); setResult(null); setError(null);
    refreshOwnedNames();
  };

  return (
    <div className="container" style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h1>{t('importCellar.title')}</h1>
      <p className="settings-hint">
        <Trans
          i18nKey="importCellar.intro"
          components={{ 1: <strong />, 3: <strong />, 5: <strong />, 7: <strong /> }}
        />
      </p>

      {/* Result view */}
      {result && (
        <div className="card settings-card">
          <h2 className="settings-section-title">{t('importCellar.resultTitle')}</h2>
          {result.map((r, i) => (
            <div key={i} style={{ marginBottom: '1rem' }}>
              <strong>{r.targetName}</strong>{' '}
              <span className="badge" style={{ background: r.mode === 'overwrite' ? '#b45309' : '#15803d', color: '#fff', padding: '0.1rem 0.5rem', borderRadius: 4, fontSize: '0.8rem' }}>
                {r.mode === 'overwrite' ? t('importCellar.modeReplaced') : t('importCellar.modeCreated')}
              </span>
              <ul style={{ marginTop: '0.5rem' }}>
                <li>{t('importCellar.resultBottlesRacks', { bottles: r.bottlesCreated, racks: r.racksCreated })}{r.layoutImported ? t('importCellar.resultLayoutSuffix') : ''}</li>
                <li>{t('importCellar.resultImagesAdded', { count: r.imagesAttached })}{r.imagesDeduped ? t('importCellar.resultImagesDeduped', { count: r.imagesDeduped }) : ''}</li>
                {r.reviewsCreated ? <li>{t('importCellar.resultReviews', { count: r.reviewsCreated })}</li> : null}
                {r.maturityCreated ? <li>{t('importCellar.resultMaturity', { count: r.maturityCreated })}</li> : null}
                {r.winesCreated ? <li>{t('importCellar.resultWines', { count: r.winesCreated })}</li> : null}
                {r.wineRequests ? <li>{t('importCellar.resultWineRequests', { count: r.wineRequests })}</li> : null}
                {r.unplaced?.length ? <li>{t('importCellar.resultUnplaced', { count: r.unplaced.length })}</li> : null}
                {r.errors?.length ? <li>{t('importCellar.resultErrors', { count: r.errors.length })}</li> : null}
              </ul>
            </div>
          ))}
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={() => navigate('/cellars')}>{t('importCellar.goToCellars')}</button>
            <button className="btn btn-secondary" onClick={reset}>{t('importCellar.importAnother')}</button>
          </div>
        </div>
      )}

      {/* Upload + review */}
      {!result && (
        <div className="card settings-card">
          <div className="form-group">
            <label htmlFor="import-file">{t('importCellar.fileLabel')}</label>
            <input
              id="import-file"
              type="file"
              accept=".json,.zip,application/json,application/zip"
              className="input"
              onChange={e => handleFile(e.target.files?.[0] || null)}
              disabled={busy}
            />
          </div>

          {busy && !preview && <p className="settings-hint">{t('importCellar.readingFile')}</p>}

          {preview && (
            <>
              {!preview.hasImageFiles && rows.some(r => r.imageCount > 0) && (
                <div className="alert" style={{ marginBottom: '1rem' }}>
                  <Trans
                    i18nKey="importCellar.dataOnlyWarning"
                    values={{ count: rows.reduce((n, r) => n + r.imageCount, 0) }}
                    components={{ 1: <strong /> }}
                  />
                </div>
              )}

              {rows.map(r => (
                <div key={r.sourceName} className="form-group" style={{ borderTop: '1px solid var(--color-border, #ddd)', paddingTop: '0.75rem' }}>
                  <label htmlFor={`name-${r.sourceName}`}>{t('importCellar.importAsLabel', { name: r.sourceName })}</label>
                  <input
                    id={`name-${r.sourceName}`}
                    type="text"
                    className="input"
                    value={names[r.sourceName] ?? ''}
                    maxLength={100}
                    onChange={e => setNames(prev => ({ ...prev, [r.sourceName]: e.target.value }))}
                  />
                  <div className="settings-hint" style={{ marginTop: '0.35rem' }}>
                    {t('importCellar.statsBottlesRacks', { bottles: r.bottleCount, racks: r.rackCount })}{r.imageCount ? t('importCellar.statsImages', { count: r.imageCount }) : ''}{r.maturityCount ? t('importCellar.statsMaturity', { count: r.maturityCount }) : ''}
                  </div>
                  {r.dup && <div className="alert alert-error" style={{ marginTop: '0.5rem' }}>{t('importCellar.dupTargetName')}</div>}
                  {r.willOverwrite ? (
                    <div className="alert alert-error" style={{ marginTop: '0.5rem' }}>
                      <Trans
                        i18nKey="importCellar.overwriteWarning"
                        values={{ name: r.targetName }}
                        components={{ 1: <strong />, 3: <strong /> }}
                      />
                      <label style={{ display: 'block', marginTop: '0.5rem' }}>
                        <input
                          type="checkbox"
                          checked={!!confirms[r.sourceName]}
                          onChange={e => setConfirms(prev => ({ ...prev, [r.sourceName]: e.target.checked }))}
                        />{' '}
                        {t('importCellar.overwriteConfirm', { name: r.targetName })}
                      </label>
                    </div>
                  ) : (
                    <div className="settings-hint" style={{ marginTop: '0.35rem', color: '#15803d' }}>
                      {t('importCellar.willCreateNew')}
                    </div>
                  )}
                </div>
              ))}

              {error && <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>{error}</div>}
              {blocking && <div className="settings-hint" style={{ marginTop: '0.5rem' }}>{blocking}</div>}

              <div className="settings-actions" style={{ marginTop: '1rem' }}>
                <button className="btn btn-primary" onClick={handleImport} disabled={busy || !!blocking}>
                  {busy ? t('importCellar.importing') : t('importCellar.importButton')}
                </button>
                <button className="btn btn-secondary" onClick={reset} disabled={busy}>{t('importCellar.cancel')}</button>
              </div>
            </>
          )}

          {error && !preview && <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>{error}</div>}
        </div>
      )}

      <p className="settings-hint" style={{ marginTop: '1rem' }}>
        <Trans
          i18nKey="importCellar.noExportYet"
          components={{ 1: <Link to="/settings" /> }}
        />
      </p>
    </div>
  );
}

export default ImportCellar;

import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  const { apiFetch } = useAuth();
  const navigate = useNavigate();

  const [ownedNames, setOwnedNames] = useState(new Set()); // lowercased existing cellar names
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null); // { cellars:[...], hasImageFiles }
  const [names, setNames] = useState({});       // sourceName -> target name
  const [confirms, setConfirms] = useState({});  // sourceName -> bool (overwrite confirmed)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let active = true;
    listCellars(apiFetch)
      .then(res => (res.ok ? res.json() : { cellars: [] }))
      .then(data => {
        if (!active) return;
        const owned = (data.cellars || []).filter(c => c.userRole === 'owner');
        setOwnedNames(new Set(owned.map(c => c.name.toLowerCase())));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [apiFetch]);

  const handleFile = async (f) => {
    setFile(f); setError(null); setResult(null); setPreview(null);
    if (!f) return;
    setBusy(true);
    try {
      const res = await previewCellarImport(apiFetch, f);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not read the file');
      setPreview(data);
      const initNames = {}; const initConfirms = {};
      data.cellars.forEach(c => { initNames[c.sourceName] = c.defaultTargetName; initConfirms[c.sourceName] = false; });
      setNames(initNames); setConfirms(initConfirms);
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
      const willOverwrite = !!targetName && ownedNames.has(lc);
      const dup = lc && seen.has(lc);
      if (lc) seen.set(lc, c.sourceName);
      return { ...c, targetName, willOverwrite, dup };
    });
  }, [preview, names, ownedNames]);

  const blocking = useMemo(() => {
    for (const r of rows) {
      if (!r.targetName) return 'Every cellar needs a name.';
      if (r.dup) return `Two cellars would import to the same name "${r.targetName}".`;
      if (r.willOverwrite && !confirms[r.sourceName]) return `Confirm the overwrite of "${r.targetName}".`;
    }
    return null;
  }, [rows, confirms]);

  const handleImport = async () => {
    setBusy(true); setError(null);
    try {
      const targets = {};
      rows.forEach(r => { targets[r.sourceName] = { targetName: r.targetName, confirmOverwrite: !!confirms[r.sourceName] }; });
      const res = await runCellarImport(apiFetch, file, targets);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setResult(data.results || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { setFile(null); setPreview(null); setNames({}); setConfirms({}); setResult(null); setError(null); };

  return (
    <div className="container" style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h1>Import a cellar</h1>
      <p className="settings-hint">
        Import a Cellarion export — the <strong>.json</strong> (bottles, racks &amp; placements) or the
        <strong> .zip</strong> (which also restores the images you uploaded yourself). Keep a cellar's name
        to <strong>replace</strong> that cellar, or change it to <strong>create a new one</strong>.
      </p>

      {/* Result view */}
      {result && (
        <div className="card settings-card">
          <h2 className="settings-section-title">Import complete</h2>
          {result.map((r, i) => (
            <div key={i} style={{ marginBottom: '1rem' }}>
              <strong>{r.targetName}</strong>{' '}
              <span className="badge" style={{ background: r.mode === 'overwrite' ? '#b45309' : '#15803d', color: '#fff', padding: '0.1rem 0.5rem', borderRadius: 4, fontSize: '0.8rem' }}>
                {r.mode === 'overwrite' ? 'replaced' : 'created'}
              </span>
              <ul style={{ marginTop: '0.5rem' }}>
                <li>{r.bottlesCreated} bottles, {r.racksCreated} racks{r.layoutImported ? ', 3D room layout' : ''}</li>
                <li>{r.imagesAttached} images added{r.imagesDeduped ? `, ${r.imagesDeduped} reused (already on file)` : ''}</li>
                {r.reviewsCreated ? <li>{r.reviewsCreated} reviews restored</li> : null}
                {r.maturityCreated ? <li>{r.maturityCreated} maturity windows added</li> : null}
                {r.winesCreated ? <li>{r.winesCreated} new wines added to the registry</li> : null}
                {r.wineRequests ? <li>{r.wineRequests} wines submitted for review (couldn't auto-create)</li> : null}
                {r.unplaced?.length ? <li>{r.unplaced.length} bottles couldn't be placed in a rack slot</li> : null}
                {r.errors?.length ? <li>{r.errors.length} rows skipped (errors)</li> : null}
              </ul>
            </div>
          ))}
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={() => navigate('/cellars')}>Go to my cellars</button>
            <button className="btn btn-secondary" onClick={reset}>Import another</button>
          </div>
        </div>
      )}

      {/* Upload + review */}
      {!result && (
        <div className="card settings-card">
          <div className="form-group">
            <label htmlFor="import-file">Export file</label>
            <input
              id="import-file"
              type="file"
              accept=".json,.zip,application/json,application/zip"
              className="input"
              onChange={e => handleFile(e.target.files?.[0] || null)}
              disabled={busy}
            />
          </div>

          {busy && !preview && <p className="settings-hint">Reading file…</p>}

          {preview && (
            <>
              {!preview.hasImageFiles && rows.some(r => r.imageCount > 0) && (
                <div className="alert" style={{ marginBottom: '1rem' }}>
                  This is a data-only export — the bottles reference {rows.reduce((n, r) => n + r.imageCount, 0)} images,
                  but image files aren't included. Upload the <strong>.zip</strong> export to restore images.
                </div>
              )}

              {rows.map(r => (
                <div key={r.sourceName} className="form-group" style={{ borderTop: '1px solid var(--border, #ddd)', paddingTop: '0.75rem' }}>
                  <label htmlFor={`name-${r.sourceName}`}>Cellar "{r.sourceName}" → import as</label>
                  <input
                    id={`name-${r.sourceName}`}
                    type="text"
                    className="input"
                    value={names[r.sourceName] ?? ''}
                    maxLength={100}
                    onChange={e => setNames(prev => ({ ...prev, [r.sourceName]: e.target.value }))}
                  />
                  <div className="settings-hint" style={{ marginTop: '0.35rem' }}>
                    {r.bottleCount} bottles · {r.rackCount} racks{r.imageCount ? ` · ${r.imageCount} images` : ''}{r.maturityCount ? ` · ${r.maturityCount} maturity windows` : ''}
                  </div>
                  {r.dup && <div className="alert alert-error" style={{ marginTop: '0.5rem' }}>Duplicate target name in this import.</div>}
                  {r.willOverwrite ? (
                    <div className="alert alert-error" style={{ marginTop: '0.5rem' }}>
                      ⚠ A cellar named <strong>{r.targetName}</strong> already exists. Importing will
                      <strong> permanently replace its entire contents</strong> (bottles, racks &amp; your images in it).
                      <label style={{ display: 'block', marginTop: '0.5rem' }}>
                        <input
                          type="checkbox"
                          checked={!!confirms[r.sourceName]}
                          onChange={e => setConfirms(prev => ({ ...prev, [r.sourceName]: e.target.checked }))}
                        />{' '}
                        Yes, replace the existing "{r.targetName}".
                      </label>
                    </div>
                  ) : (
                    <div className="settings-hint" style={{ marginTop: '0.35rem', color: '#15803d' }}>
                      Will create a new cellar.
                    </div>
                  )}
                </div>
              ))}

              {error && <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>{error}</div>}
              {blocking && <div className="settings-hint" style={{ marginTop: '0.5rem' }}>{blocking}</div>}

              <div className="settings-actions" style={{ marginTop: '1rem' }}>
                <button className="btn btn-primary" onClick={handleImport} disabled={busy || !!blocking}>
                  {busy ? 'Importing…' : 'Import'}
                </button>
                <button className="btn btn-secondary" onClick={reset} disabled={busy}>Cancel</button>
              </div>
            </>
          )}

          {error && !preview && <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>{error}</div>}
        </div>
      )}

      <p className="settings-hint" style={{ marginTop: '1rem' }}>
        Don't have an export yet? Create one from <Link to="/settings">Settings → Take your cellars with you</Link>.
      </p>
    </div>
  );
}

export default ImportCellar;

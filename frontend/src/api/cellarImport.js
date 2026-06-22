// Client for the Cellarion-format cellar importer (/api/cellar-import).
// Sends the export file (.json or .zip) as multipart/form-data; apiFetch leaves
// the Content-Type to the browser so the multipart boundary is set correctly.

export const previewCellarImport = (apiFetch, file) => {
  const fd = new FormData();
  fd.append('file', file);
  return apiFetch('/api/cellar-import/preview', { method: 'POST', body: fd });
};

// targets: { [sourceName]: { targetName, confirmOverwrite } }
export const runCellarImport = (apiFetch, file, targets) => {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('targets', JSON.stringify(targets || {}));
  return apiFetch('/api/cellar-import', { method: 'POST', body: fd });
};

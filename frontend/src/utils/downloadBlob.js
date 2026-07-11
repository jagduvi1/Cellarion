export default function downloadBlob(content, filename, type = 'application/json') {
  const blob = new Blob([content], { type });
  downloadBlobObject(blob, filename);
}

export function downloadBlobObject(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Attach to the DOM before clicking (some browsers, notably Firefox, ignore
  // click() on a detached anchor) and defer the revoke so the browser has
  // finished reading the blob for large GDPR/cellar exports.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function downloadBlob(content, filename, type = 'application/json') {
  const blob = new Blob([content], { type });
  downloadBlobObject(blob, filename);
}

export function downloadBlobObject(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

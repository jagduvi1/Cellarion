// Fitting a wine request's photo under the server's cap.
//
// A request stores its photo inline, as a data URL, and the server refuses
// anything over 500,000 characters (backend services/accountOps). The form
// prefers the background-removed preview, which the server returns as a PNG
// with transparency — at 900 px that PNG often ran past the cap, and the
// request failed with a generic "could not submit". WebP keeps the
// transparency at a fraction of the size; JPEG (on white) is the fallback for
// a browser that cannot encode WebP. Quality steps down first, then the size.

export const REQUEST_IMAGE_MAX_CHARS = 480000; // a margin under the server's 500,000
const MAX_EDGE = 900;
const QUALITIES = [0.85, 0.72, 0.6];
const EDGES = [MAX_EDGE, 720, 560];

/**
 * The first encoding that fits: every WebP quality and size first, so a
 * cut-out keeps its transparency whenever any WebP fits, then the same steps
 * as JPEG. `render(edge, type, quality)` returns a data URL (or null);
 * `maxChars` is the cap. Returns the data URL, or null when nothing fits.
 * Pure apart from `render`, so the choice is testable without a canvas.
 */
export async function fitDataUrl(render, { maxChars = REQUEST_IMAGE_MAX_CHARS } = {}) {
  types: for (const type of ['image/webp', 'image/jpeg']) {
    for (const edge of EDGES) {
      for (const quality of QUALITIES) {
        const out = await render(edge, type, quality);
        if (typeof out !== 'string') continue;
        // A browser without a WebP encoder silently returns PNG: no WebP
        // step will do better, so go straight to JPEG.
        if (!out.startsWith(`data:${type};`)) continue types;
        if (out.length <= maxChars) return out;
      }
    }
  }
  return null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image could not be read'));
    img.src = src;
  });
}

/**
 * A canvas renderer for fitDataUrl from a data URL or a File. Transparent
 * pixels become white for JPEG (which has no alpha); WebP keeps them.
 */
export async function canvasRenderer(source) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = await loadImage(url);
    return (edge, type, quality) => {
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w > edge || h > edge) {
        if (w > h) { h = Math.round((h * edge) / w); w = edge; } else { w = Math.round((w * edge) / h); h = edge; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL(type, quality);
    };
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

/**
 * The request photo to send: the background-removed preview when there is
 * one, otherwise the chosen file — fitted under the cap. Null when no
 * encoding fits (the form then says the photo is too large and sends nothing).
 */
export async function requestImageFor({ preview, file }) {
  const source = preview || file;
  if (!source) return null;
  const render = await canvasRenderer(source);
  return fitDataUrl(render);
}

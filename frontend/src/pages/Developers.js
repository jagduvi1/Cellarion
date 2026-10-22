import { useEffect, useRef, useState } from 'react';
import SEOHead from '../components/SEOHead';
import { useTheme } from '../contexts/ThemeContext';
import './Developers.css';

/*
 * /developers — the API guide and reference. Everything on it comes from the
 * server's OpenAPI document (GET /api/openapi.json, backend/src/openapi/):
 * the guide is its description, the reference its operations. Redoc renders
 * it; crawlers get the same document as HTML from /api/og/developers.
 *
 * English only, like the Privacy Policy: the document is the contract, and
 * it is written once.
 *
 * Redoc is vendored, not an npm dependency (scripts/vendor-redoc.mjs): the
 * page needs one file and the package brings ~100. The path carries the
 * version because nginx caches every .js for a year. It loads only here.
 */
export const REDOC_VERSION = '2.5.4';
// sha256 of the patched bundle, printed by scripts/vendor-redoc.mjs.
export const REDOC_SHA256 = '3069c824f8f876f24fedbc2e98885921b250f5b20e540e435f60fa430f9a1f04';
export const REDOC_SRC = `/developers/redoc/${REDOC_VERSION}/redoc.standalone.js`;
export const SPEC_URL = '/api/openapi.json';

/**
 * Load the viewer once per page life. A script tag already on its way is
 * joined, not duplicated; a failed one is removed, so a later visit retries.
 */
function loadRedoc() {
  if (window.Redoc) return Promise.resolve(window.Redoc);
  return new Promise((resolve, reject) => {
    let script = document.head.querySelector(`script[src="${REDOC_SRC}"]`);
    if (script && script.dataset.loaded) {
      reject(new Error('viewer missing'));
      return;
    }
    if (!script) {
      script = document.createElement('script');
      script.src = REDOC_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', () => {
      script.dataset.loaded = '1';
      if (window.Redoc) resolve(window.Redoc);
      else reject(new Error('viewer missing'));
    }, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('viewer did not load'));
    }, { once: true });
  });
}

const cssVar = (name, fallback) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

/** Redoc's options, its colours and fonts taken from the app's theme tokens. */
export function redocOptions() {
  const primary = cssVar('--color-primary', '#7A1E2D');
  const text = cssVar('--color-text', '#2B2B2B');
  const textSecondary = cssVar('--color-text-secondary', '#5A5A5A');
  const border = cssVar('--color-border', '#E4E0DC');
  const surface = cssVar('--color-surface', '#FFFFFF');
  const surfaceHover = cssVar('--color-surface-hover', '#F5F2EF');
  const body = cssVar('--font-body', 'system-ui, sans-serif');
  const heading = cssVar('--font-heading', 'Georgia, serif');
  return {
    // Its search runs in a blob: worker, which the CSP blocks; the reference
    // is short enough to need none.
    disableSearch: true,
    hideDownloadButton: false,
    expandResponses: '200,202',
    pathInMiddlePanel: true,
    requiredPropsFirst: true,
    jsonSampleExpandLevel: 3,
    nativeScrollbars: true,
    // A function, read on every scroll: the navbar's height changes (the
    // install prompt above it comes and goes), a selector is measured once.
    scrollYOffset: () => {
      const navbar = document.querySelector('.navbar');
      return navbar ? navbar.getBoundingClientRect().bottom : 0;
    },
    theme: {
      colors: {
        primary: { main: primary },
        text: { primary: text, secondary: textSecondary },
        border: { dark: border, light: border },
      },
      typography: {
        fontFamily: body,
        headings: { fontFamily: heading, fontWeight: '600' },
        code: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          color: primary,
          backgroundColor: surfaceHover,
        },
        links: { color: primary, visited: primary, hover: primary },
      },
      schema: { nestedBackground: surfaceHover, typeNameColor: textSecondary, typeTitleColor: textSecondary },
      sidebar: { backgroundColor: surface, textColor: text, activeTextColor: primary },
    },
  };
}

/**
 * Leaving the page. Redoc cannot be unmounted: its store keeps a scroll
 * listener on window that rewrites the address (history.replaceState with a
 * #section) on whatever page comes next, wiping React Router's state. So the
 * page is a hard boundary: the next page is loaded fresh, which discards
 * Redoc with the old document. Only when the path really changed — React's
 * development double-mount unmounts on the same path.
 */
export function leaveDevelopers(loc = window.location) {
  if (!/^\/developers\/?$/.test(loc.pathname)) loc.replace(loc.href);
}

export default function Developers() {
  const { theme } = useTheme();
  const container = useRef(null);
  const firstTheme = useRef(theme);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    loadRedoc()
      .then((Redoc) => {
        if (cancelled || !container.current) return;
        // Redoc calls back with the error when the document did not load.
        Redoc.init(SPEC_URL, redocOptions(), container.current, (err) => {
          if (!cancelled) setState(err ? 'error' : 'ready');
        });
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => {
      cancelled = true;
      leaveDevelopers();
    };
  }, []);

  // A theme switch reloads the page in the new colours (a second Redoc.init
  // would leave the first instance's listeners behind). After the theme
  // provider has stored the choice, which runs after this effect.
  useEffect(() => {
    if (theme === firstTheme.current) return undefined;
    const t = setTimeout(() => window.location.reload(), 0);
    return () => clearTimeout(t);
  }, [theme]);

  return (
    <div className="developers-page">
      <SEOHead
        title="Cellarion API: developer guide and reference"
        description="Build on your own Cellarion wine cellar data: a stable REST API with personal API tokens, a one-call inventory with ETag caching, live update events, and an OpenAPI 3.1 reference."
        path="/developers"
        ogType="article"
        hreflang="none"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: 'Cellarion API: developer guide and reference',
          inLanguage: 'en',
          about: { '@type': 'WebAPI', name: 'Cellarion API' },
        }}
      />
      {state !== 'ready' && (
        <div className="developers-status" role="status">
          <h1>Cellarion API</h1>
          {state === 'loading' && <p>Loading the guide and reference…</p>}
          {state === 'error' && (
            <p>The reference viewer could not be loaded. Reload the page, or read the API description directly.</p>
          )}
          <p>
            <a href={SPEC_URL} download="cellarion-openapi.json">Download the OpenAPI 3.1 document</a>
          </p>
        </div>
      )}
      <div ref={container} className="developers-redoc" />
    </div>
  );
}

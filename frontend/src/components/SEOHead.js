import { Helmet } from 'react-helmet-async';
import SITE_URL from '../config/siteUrl';

const DEFAULT_IMAGE = `${SITE_URL}/cellarion-logo.jpg`;

// Single source of truth for public-page SEO meta. Each public page passes its variable
// bits and gets a complete Helmet block (canonical, OG, Twitter, hreflang, JSON-LD) with
// no opportunity to forget a tag.
//
// Auth-only pages must not use this — they aren't crawler-reachable and adding canonicals
// to them would leak personal-data URLs to anyone who scrapes the rendered HTML.
export default function SEOHead({
  title,
  description,
  path = '/',
  image,
  ogType = 'website',
  twitterCard = 'summary_large_image',
  jsonLd,
  language,
  hreflang = 'public',
  articleMeta,
}) {
  const url = path.startsWith('http') ? path : `${SITE_URL}${path}`;
  const imageUrl = image || DEFAULT_IMAGE;

  return (
    <Helmet>
      {language && <html lang={language} />}
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta property="og:type" content={ogType} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={imageUrl} />
      <meta property="og:url" content={url} />
      <meta property="og:site_name" content="Cellarion" />
      <meta name="twitter:card" content={twitterCard} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={imageUrl} />
      <link rel="canonical" href={url} />
      {hreflang === 'public' && (
        <>
          <link rel="alternate" hrefLang="en" href={url} />
          <link rel="alternate" hrefLang="sv" href={url} />
          <link rel="alternate" hrefLang="x-default" href={url} />
        </>
      )}
      {articleMeta?.publishedTime && (
        <meta property="article:published_time" content={articleMeta.publishedTime} />
      )}
      {articleMeta?.modifiedTime && (
        <meta property="article:modified_time" content={articleMeta.modifiedTime} />
      )}
      {jsonLd && (
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      )}
    </Helmet>
  );
}

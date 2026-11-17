import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { getBlogPost } from '../api/blog';
import { getDiscussions } from '../api/discussions';
import { useAuth } from '../contexts/AuthContext';
import SEOHead from '../components/SEOHead';
import SITE_URL from '../config/siteUrl';
import { isTranslation, languageName, nativeLanguageName } from '../utils/blogLanguage';
import './Blog.css';

/**
 * The line that leads from one version of a post to the others. A translation
 * says what it was translated from and links the original; an original lists
 * its translations, each named in its own language. Nothing for a post in one
 * language. The crawler page carries the same line (backend routes/og/blog.js).
 */
export function PostLanguages({ post, alternates, uiLanguage, t }) {
  if (!Array.isArray(alternates) || alternates.length < 2) return null;
  if (isTranslation(post)) {
    const original = alternates.find((a) => a.original);
    if (!original) return null;
    return (
      <p className="blog-article-languages">
        {t('blog.translatedFrom', { language: languageName(original.language, uiLanguage) })}{' '}
        <Link to={`/blog/${original.slug}`} hrefLang={original.language}>{t('blog.readOriginal')}</Link>
      </p>
    );
  }
  const others = alternates.filter((a) => a.slug !== post.slug);
  return (
    <p className="blog-article-languages">
      {t('blog.alsoIn')}{' '}
      {others.map((a, i) => (
        <span key={a.slug}>
          {i > 0 && ' · '}
          <Link to={`/blog/${a.slug}`} hrefLang={a.language} lang={a.language}>{nativeLanguageName(a.language)}</Link>
        </span>
      ))}
    </p>
  );
}

function BlogPost() {
  const { t, i18n } = useTranslation();
  const { slug } = useParams();
  const { apiFetch, user } = useAuth();
  const [post, setPost] = useState(null);
  // Every published version of this post, for the language line and the
  // hreflang links ([] for a post in one language).
  const [alternates, setAlternates] = useState([]);
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchPost() {
      setLoading(true);
      try {
        const res = await getBlogPost(apiFetch, slug);
        const data = await res.json();
        if (!cancelled) {
          setPost(data.post);
          setAlternates(Array.isArray(data.alternates) ? data.alternates : []);
        }
      } catch {
        if (!cancelled) setError(t('blog.postNotFound'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPost();
    return () => { cancelled = true; };
  }, [apiFetch, slug, t]);

  // Threads for THIS post, fetched once the post id is known. Failure is
  // silent on purpose: the discussion list is an extra, and an unreachable
  // community endpoint must never stop the article rendering.
  useEffect(() => {
    if (!post?._id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await getDiscussions(apiFetch, `blogPost=${post._id}&limit=10`);
        const data = await res.json();
        if (!cancelled && res.ok) setThreads(data.discussions || []);
      } catch { /* no threads shown */ }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, post?._id]);

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  };

  if (loading) return <div className="blog-loading">{t('blog.loading')}</div>;
  if (error || !post) return (
    <div className="blog-error">
      <p>{error || t('blog.postNotFound')}</p>
      <Link to="/blog" className="btn btn-secondary">{t('blog.backToList')}</Link>
    </div>
  );

  const metaTitle = post.metaTitle || post.title;
  const metaDescription = post.metaDescription || post.excerpt || `${post.title} — Cellarion Blog`;

  const postUrl = `${SITE_URL}/blog/${post.slug}`;

  // JSON-LD structured data for SEO
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: post.title,
        description: metaDescription,
        datePublished: post.publishedAt,
        dateModified: post.updatedAt,
        author: post.author?.username
          ? { '@type': 'Person', name: post.author.username }
          : { '@type': 'Organization', name: 'Cellarion', url: SITE_URL },
        publisher: {
          '@type': 'Organization',
          name: 'Cellarion',
          url: SITE_URL,
          logo: { '@type': 'ImageObject', url: `${SITE_URL}/cellarion-logo.jpg` }
        },
        mainEntityOfPage: {
          '@type': 'WebPage',
          '@id': postUrl
        },
        ...(post.coverImage ? { image: post.coverImage } : {})
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: t('blog.title'),
            item: `${SITE_URL}/blog`
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: post.title,
            item: postUrl
          }
        ]
      }
    ]
  };

  return (
    <div className="blog-post-page">
      <SEOHead
        title={`${metaTitle} — Cellarion Blog`}
        description={metaDescription}
        path={`/blog/${post.slug}`}
        // A post's languages are its own versions, each at its own address,
        // not the app's languages at this one (SEOHead).
        hreflang={alternates.length > 1
          ? alternates.map((a) => ({ lang: a.language, path: `/blog/${a.slug}` }))
          : 'none'}
        image={post.coverImage || undefined}
        ogType="article"
        jsonLd={jsonLd}
        articleMeta={{
          publishedTime: post.publishedAt,
          modifiedTime: post.updatedAt,
        }}
      />

      <nav className="blog-breadcrumb">
        <Link to="/blog">{t('blog.title')}</Link>
        <span className="blog-breadcrumb-sep">/</span>
        <span>{post.title}</span>
      </nav>

      <article className="blog-article">
        {post.coverImage && (
          <div className="blog-article-cover">
            <img src={post.coverImage} alt={post.title} />
          </div>
        )}

        <header className="blog-article-header">
          <h1>{post.title}</h1>
          <div className="blog-article-meta">
            <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
            {post.author && (
              <span className="blog-article-author">
                {t('blog.by')} {post.author.username}
              </span>
            )}
          </div>
          <PostLanguages post={post} alternates={alternates} uiLanguage={i18n?.language} t={t} />
          {post.tags?.length > 0 && (
            <div className="blog-article-tags">
              {post.tags.map(tag => (
                <Link key={tag} to={`/blog?tag=${tag}`} className="blog-card-tag">
                  {tag}
                </Link>
              ))}
            </div>
          )}
        </header>

        <div
          className="blog-article-content"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(post.content) }}
        />
      </article>

      {/* "Discuss this post" instead of a comment section. A thread lands in
          the existing community, which already
          has moderation, reports and the GDPR export/erasure cascade — a
          bespoke comment model would have had to re-earn all three, and would
          have been a second community surface next to a quiet first one. */}
      <section className="blog-discuss">
        <h2>{t('blog.discussTitle')}</h2>
        <p>{t('blog.discussIntro')}</p>
        {threads.length > 0 && (
          <ul className="blog-discuss-list">
            {threads.map((d) => (
              <li key={d._id}>
                <Link to={`/community/discussions/${d.slug || d._id}`}>{d.title}</Link>
                {d.replyCount > 0 && <span className="blog-discuss-count"> · {d.replyCount}</span>}
              </li>
            ))}
          </ul>
        )}
        {user ? (
          <Link
            className="btn btn-secondary"
            to="/community/discussions"
            // Route state, matching the wine page's existing "start a
            // discussion about this wine" CTA — it opens the create modal
            // prefilled instead of inventing a second creation surface.
            state={{ newDiscussionBlogPost: { _id: post._id, title: post.title } }}
          >
            {t('blog.discussStart')}
          </Link>
        ) : (
          // Signed-out readers are most of a blog's traffic, so say what to do
          // rather than showing a button that bounces them to a login wall.
          <p className="blog-discuss-signedout">{t('blog.discussSignedOut')}</p>
        )}
      </section>

      <div className="blog-post-footer">
        <Link to="/blog" className="btn btn-secondary">{t('blog.backToList')}</Link>
      </div>
    </div>
  );
}

// One post's page, keyed by its address. Going from one post to another (Back
// and Forward do it without leaving the app) starts a fresh page: no "not
// found" and no thread list of the post before.
function BlogPostPage() {
  const { slug } = useParams();
  return <BlogPost key={slug} />;
}

export default BlogPostPage;

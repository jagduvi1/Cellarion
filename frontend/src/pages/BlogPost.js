import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { getBlogPost } from '../api/blog';
import { useAuth } from '../contexts/AuthContext';
import './Blog.css';

function BlogPost() {
  const { t } = useTranslation();
  const { slug } = useParams();
  const { apiFetch } = useAuth();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchPost() {
      setLoading(true);
      try {
        const res = await getBlogPost(apiFetch, slug);
        const data = await res.json();
        if (!cancelled) setPost(data.post);
      } catch {
        if (!cancelled) setError(t('blog.postNotFound'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPost();
    return () => { cancelled = true; };
  }, [apiFetch, slug, t]);

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

  // JSON-LD structured data for SEO
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: metaDescription,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    author: {
      '@type': 'Organization',
      name: 'Cellarion',
      url: 'https://cellarion.app'
    },
    publisher: {
      '@type': 'Organization',
      name: 'Cellarion',
      url: 'https://cellarion.app'
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `https://cellarion.app/blog/${post.slug}`
    }
  };
  if (post.coverImage) {
    jsonLd.image = post.coverImage;
  }

  return (
    <div className="blog-post-page">
      <Helmet>
        <title>{metaTitle} — Cellarion Blog</title>
        <meta name="description" content={metaDescription} />
        <meta property="og:type" content="article" />
        <meta property="og:title" content={metaTitle} />
        <meta property="og:description" content={metaDescription} />
        {post.coverImage && <meta property="og:image" content={post.coverImage} />}
        <meta property="og:url" content={`https://cellarion.app/blog/${post.slug}`} />
        <meta property="article:published_time" content={post.publishedAt} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={metaTitle} />
        <meta name="twitter:description" content={metaDescription} />
        {post.coverImage && <meta name="twitter:image" content={post.coverImage} />}
        <link rel="canonical" href={`https://cellarion.app/blog/${post.slug}`} />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>

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
          dangerouslySetInnerHTML={{ __html: post.content }}
        />
      </article>

      <div className="blog-post-footer">
        <Link to="/blog" className="btn btn-secondary">{t('blog.backToList')}</Link>
      </div>
    </div>
  );
}

export default BlogPost;

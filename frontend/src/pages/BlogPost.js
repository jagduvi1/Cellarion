import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { getBlogPost } from '../api/blog';
import { useAuth } from '../contexts/AuthContext';
import SEOHead from '../components/SEOHead';
import SITE_URL from '../config/siteUrl';
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

      <div className="blog-post-footer">
        <Link to="/blog" className="btn btn-secondary">{t('blog.backToList')}</Link>
      </div>
    </div>
  );
}

export default BlogPost;

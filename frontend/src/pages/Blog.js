import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getBlogPosts, getBlogTags } from '../api/blog';
import { useAuth } from '../contexts/AuthContext';
import { markBlogSeen } from '../hooks/useUnreadBlog';
import SEOHead from '../components/SEOHead';
import SITE_URL from '../config/siteUrl';
import './Blog.css';

function Blog() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [posts, setPosts] = useState([]);
  const [tags, setTags] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const page = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const activeTag = searchParams.get('tag') || '';

  const fetchPosts = useCallback(async () => {
    setLoading(true);
    try {
      // apiFetch doesn't throw on non-2xx — an error body ({error}) has no
      // posts array, and rendering would crash on posts.length.
      const res = await getBlogPosts(apiFetch, { page, tag: activeTag || undefined });
      const data = await res.json();
      if (!res.ok) {
        setPosts([]);
        return;
      }
      setPosts(data.posts || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, page, activeTag]);

  const fetchTags = useCallback(async () => {
    try {
      const res = await getBlogTags(apiFetch);
      const data = await res.json();
      setTags(res.ok ? (data.tags || []) : []);
    } catch {
      setTags([]);
    }
  }, [apiFetch]);

  useEffect(() => { fetchPosts(); }, [fetchPosts]);
  useEffect(() => { fetchTags(); }, [fetchTags]);

  // Opening the index counts as reading the list — that is what the nav badge
  // claims to track. Fires once on mount rather than per page/tag change, so
  // paging through the archive doesn't keep rewriting the timestamp.
  useEffect(() => { markBlogSeen(); }, []);

  const setPage = (p) => {
    const params = new URLSearchParams(searchParams);
    params.set('page', p);
    setSearchParams(params);
  };

  const setTag = (tag) => {
    const params = new URLSearchParams();
    if (tag) params.set('tag', tag);
    setSearchParams(params);
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  };

  const blogJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: `${t('blog.title')} — Cellarion`,
        description: 'News, tips, and updates from the Cellarion team.',
        url: `${SITE_URL}/blog`,
        isPartOf: { '@type': 'WebSite', '@id': `${SITE_URL}/#website` }
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: t('blog.title'), item: `${SITE_URL}/blog` }
        ]
      }
    ]
  };

  return (
    <div className="blog-page">
      <SEOHead
        title={`${t('blog.title')} — Cellarion`}
        description="News, tips, and updates from the Cellarion team. Learn about wine cellar management, drink windows, and getting the most from your collection."
        path="/blog"
        jsonLd={blogJsonLd}
      />

      <header className="blog-header">
        <h1>{t('blog.title')}</h1>
        <p className="blog-subtitle">{t('blog.subtitle')}</p>
      </header>

      {tags.length > 0 && (
        <div className="blog-tags">
          <button
            className={`blog-tag ${!activeTag ? 'active' : ''}`}
            onClick={() => setTag('')}
          >
            {t('blog.allPosts')}
          </button>
          {tags.map(tag => (
            <button
              key={tag}
              className={`blog-tag ${activeTag === tag ? 'active' : ''}`}
              onClick={() => setTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="blog-loading">{t('blog.loading')}</div>
      ) : posts.length === 0 ? (
        <div className="blog-empty">{t('blog.noPosts')}</div>
      ) : (
        <>
          <div className="blog-grid">
            {posts.map(post => (
              <article key={post._id} className="blog-card">
                <Link to={`/blog/${post.slug}`} className="blog-card-link">
                  {post.coverImage && (
                    <div className="blog-card-image">
                      <img src={post.coverImage} alt={post.title} loading="lazy" />
                    </div>
                  )}
                  <div className="blog-card-body">
                    <div className="blog-card-meta">
                      <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
                      {post.author && <span className="blog-card-author">{post.author.username}</span>}
                    </div>
                    <h2 className="blog-card-title">{post.title}</h2>
                    {post.excerpt && <p className="blog-card-excerpt">{post.excerpt}</p>}
                    {post.tags?.length > 0 && (
                      <div className="blog-card-tags">
                        {post.tags.map(tag => (
                          <span key={tag} className="blog-card-tag">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </Link>
              </article>
            ))}
          </div>

          {pages > 1 && (
            <div className="blog-pagination">
              <button
                className="btn btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                {t('blog.prev')}
              </button>
              <span className="blog-pagination-info">
                {t('blog.pageOf', { page, pages })}
              </span>
              <button
                className="btn btn-secondary"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                {t('blog.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default Blog;

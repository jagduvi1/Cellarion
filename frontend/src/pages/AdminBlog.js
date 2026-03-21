import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getAdminBlogPosts, deleteBlogPost } from '../api/blog';
import Modal from '../components/Modal';
import './AdminBlog.css';

function AdminBlog() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const navigate = useNavigate();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchPosts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAdminBlogPosts(apiFetch, { page, status: statusFilter || undefined });
      const data = await res.json();
      setPosts(data.posts);
      setPages(data.pages);
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, page, statusFilter]);

  useEffect(() => { fetchPosts(); }, [fetchPosts]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteBlogPost(apiFetch, deleteTarget._id);
      setDeleteTarget(null);
      fetchPosts();
    } catch {
      alert(t('blog.admin.deleteFailed'));
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  };

  return (
    <div className="admin-blog-page">
      <div className="admin-blog-header">
        <h1>{t('blog.admin.title')}</h1>
        <button className="btn btn-primary" onClick={() => navigate('/admin/blog/new')}>
          {t('blog.admin.newPost')}
        </button>
      </div>

      <div className="admin-blog-filters">
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="">{t('blog.admin.allStatuses')}</option>
          <option value="draft">{t('blog.admin.draft')}</option>
          <option value="published">{t('blog.admin.published')}</option>
        </select>
      </div>

      {loading ? (
        <div className="blog-loading">{t('blog.loading')}</div>
      ) : posts.length === 0 ? (
        <div className="blog-empty">{t('blog.admin.noPosts')}</div>
      ) : (
        <div className="admin-blog-table-wrap">
          <table className="admin-blog-table">
            <thead>
              <tr>
                <th>{t('blog.admin.titleCol')}</th>
                <th>{t('blog.admin.status')}</th>
                <th>{t('blog.admin.author')}</th>
                <th>{t('blog.admin.date')}</th>
                <th>{t('blog.admin.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {posts.map(post => (
                <tr key={post._id}>
                  <td className="admin-blog-title-cell">
                    <span className="admin-blog-post-title">{post.title}</span>
                    <span className="admin-blog-slug">/{post.slug}</span>
                  </td>
                  <td>
                    <span className={`admin-blog-status admin-blog-status--${post.status}`}>
                      {post.status === 'published' ? t('blog.admin.published') : t('blog.admin.draft')}
                    </span>
                  </td>
                  <td>{post.author?.username || '—'}</td>
                  <td>{formatDate(post.status === 'published' ? post.publishedAt : post.updatedAt)}</td>
                  <td className="admin-blog-actions">
                    <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/admin/blog/${post._id}`)}>
                      {t('blog.admin.edit')}
                    </button>
                    {post.status === 'published' && (
                      <button className="btn btn-sm btn-secondary" onClick={() => navigate(`/blog/${post.slug}`)}>
                        {t('blog.admin.view')}
                      </button>
                    )}
                    <button className="btn btn-sm btn-danger" onClick={() => setDeleteTarget(post)}>
                      {t('blog.admin.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="blog-pagination">
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            {t('blog.prev')}
          </button>
          <span className="blog-pagination-info">{t('blog.pageOf', { page, pages })}</span>
          <button className="btn btn-secondary" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
            {t('blog.next')}
          </button>
        </div>
      )}

      {deleteTarget && (
        <Modal title={t('blog.admin.confirmDelete')} onClose={() => setDeleteTarget(null)}>
          <p>{t('blog.admin.confirmDeleteMsg', { title: deleteTarget.title })}</p>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{t('blog.admin.cancel')}</button>
            <button className="btn btn-danger" onClick={handleDelete}>{t('blog.admin.delete')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default AdminBlog;

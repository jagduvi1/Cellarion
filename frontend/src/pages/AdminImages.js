import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './AdminImages.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function AdminImages() {
  const { token } = useAuth();
  const [images, setImages] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('processed');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [assignWineId, setAssignWineId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const limit = 20;

  useEffect(() => {
    fetchImages();
  }, [statusFilter, page, token]);

  const fetchImages = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit });
      if (statusFilter) params.append('status', statusFilter);

      const res = await fetch(`/api/admin/images?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setImages(data.images);
        setTotal(data.total);
      }
    } catch (err) {
      console.error('Failed to fetch images:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/images/${selected._id}/approve`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setSelected(data.image);
        fetchImages();
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/images/${selected._id}/reject`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setSelected(data.image);
        fetchImages();
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAssignToWine = async () => {
    if (!selected) return;
    const wineDefId = assignWineId || selected.wineDefinition?._id;
    if (!wineDefId) {
      setError('Please enter a wine definition ID');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/images/${selected._id}/assign-to-wine`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ wineDefinitionId: wineDefId })
      });
      const data = await res.json();
      if (res.ok) {
        setSelected(data.image);
        fetchImages();
        setAssignWineId('');
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  const statusLabels = [
    { value: 'processed', label: 'Ready for Review' },
    { value: 'uploaded', label: 'Uploading' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: '', label: 'All' }
  ];

  return (
    <div className="admin-images-page">
      <div className="page-header">
        <h1>Admin: Image Review</h1>
        <span className="image-count">{total} image{total !== 1 ? 's' : ''}</span>
      </div>

      <div className="admin-layout">
        {/* Left panel: image list */}
        <div className="images-panel">
          <div className="panel-filters">
            {statusLabels.map(s => (
              <button
                key={s.value || 'all'}
                className={`filter-btn ${statusFilter === s.value ? 'active' : ''}`}
                onClick={() => { setStatusFilter(s.value); setPage(1); }}
              >
                {s.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="loading">Loading...</div>
          ) : images.length === 0 ? (
            <div className="empty-state"><p>No images found</p></div>
          ) : (
            <>
              <div className="images-list">
                {images.map(img => (
                  <div
                    key={img._id}
                    className={`image-item ${selected?._id === img._id ? 'active' : ''}`}
                    onClick={() => { setSelected(img); setError(null); setAssignWineId(''); }}
                  >
                    <div className="image-item-thumb">
                      <img
                        src={`${API_URL}${img.processedUrl || img.originalUrl}`}
                        alt="Bottle"
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    </div>
                    <div className="image-item-info">
                      <div className="image-item-header">
                        <span className="image-item-wine">
                          {img.wineDefinition?.name || img.bottle?.wineDefinition?.name || 'No wine linked'}
                        </span>
                        <span className={`status-badge status-${img.status}`}>{img.status}</span>
                      </div>
                      <div className="image-item-meta">
                        <span>By: {img.uploadedBy?.username}</span>
                        <span>{new Date(img.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="pagination">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage(p => p - 1)}
                  >
                    Previous
                  </button>
                  <span>Page {page} of {totalPages}</span>
                  <button
                    disabled={page >= totalPages}
                    onClick={() => setPage(p => p + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right panel: detail & actions */}
        <div className="action-panel">
          {!selected ? (
            <div className="empty-state"><p>Select an image to review</p></div>
          ) : (
            <div>
              <div className="image-detail card">
                <h2>Image Detail</h2>

                <div className="image-comparison">
                  <div className="image-compare-item">
                    <h3>Original</h3>
                    <img
                      src={`${API_URL}${selected.originalUrl}`}
                      alt="Original"
                      className="detail-image"
                    />
                  </div>
                  {selected.processedUrl && (
                    <div className="image-compare-item">
                      <h3>Background Removed</h3>
                      <div className="processed-image-container">
                        <img
                          src={`${API_URL}${selected.processedUrl}`}
                          alt="Processed"
                          className="detail-image"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="image-meta">
                  <p><strong>Status:</strong> <span className={`status-badge status-${selected.status}`}>{selected.status}</span></p>
                  <p><strong>Uploaded by:</strong> {selected.uploadedBy?.username}</p>
                  <p><strong>Date:</strong> {new Date(selected.createdAt).toLocaleString()}</p>
                  {selected.wineDefinition && (
                    <p><strong>Wine:</strong> {selected.wineDefinition.name} ({selected.wineDefinition.producer})</p>
                  )}
                  {selected.reviewedBy && (
                    <p><strong>Reviewed by:</strong> {selected.reviewedBy.username} on {new Date(selected.reviewedAt).toLocaleString()}</p>
                  )}
                  {selected.assignedToWine && (
                    <p className="assigned-badge">Assigned as official wine image</p>
                  )}
                </div>
              </div>

              {error && <div className="alert alert-error">{error}</div>}

              {/* Actions for processed/uploaded images */}
              {['processed', 'uploaded'].includes(selected.status) && (
                <div className="review-actions card">
                  <h3>Review Actions</h3>
                  <div className="form-actions">
                    <button
                      onClick={handleApprove}
                      className="btn btn-success"
                      disabled={submitting}
                    >
                      {submitting ? 'Processing...' : 'Approve'}
                    </button>
                    <button
                      onClick={handleReject}
                      className="btn btn-danger"
                      disabled={submitting}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}

              {/* Assign to wine for approved images */}
              {selected.status === 'approved' && !selected.assignedToWine && (
                <div className="assign-panel card">
                  <h3>Assign to Wine</h3>
                  <p className="help-text">
                    Set this image as the official image for a wine definition.
                  </p>
                  {selected.wineDefinition ? (
                    <p>
                      Linked wine: <strong>{selected.wineDefinition.name}</strong> ({selected.wineDefinition.producer})
                    </p>
                  ) : (
                    <div className="form-group">
                      <label>Wine Definition ID</label>
                      <input
                        type="text"
                        value={assignWineId}
                        onChange={(e) => setAssignWineId(e.target.value)}
                        placeholder="Paste wine definition ID"
                      />
                    </div>
                  )}
                  <button
                    onClick={handleAssignToWine}
                    className="btn btn-primary"
                    disabled={submitting}
                  >
                    {submitting ? 'Assigning...' : 'Assign as Official Image'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminImages;

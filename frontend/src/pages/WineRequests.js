import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './WineRequests.css';

function WineRequests() {
  const { token } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    wineName: '',
    sourceUrl: '',
    image: ''
  });

  useEffect(() => {
    fetchRequests();
  }, [token]);

  const fetchRequests = async () => {
    try {
      const res = await fetch('/api/wine-requests', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setRequests(data.requests);
      }
    } catch (err) {
      console.error('Failed to fetch requests:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/wine-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(formData)
      });
      if (res.ok) {
        setFormData({ wineName: '', sourceUrl: '', image: '' });
        setShowForm(false);
        fetchRequests();
      }
    } catch (err) {
      alert('Failed to submit request');
    }
  };

  return (
    <div className="wine-requests-page">
      <div className="page-header">
        <h1>My Wine Requests</h1>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? 'Cancel' : '+ New Request'}
        </button>
      </div>

      {showForm && (
        <div className="card">
          <h2>Request a New Wine</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Wine Name *</label>
              <input
                type="text"
                value={formData.wineName}
                onChange={(e) => setFormData({ ...formData, wineName: e.target.value })}
                required
                placeholder="Full wine name"
              />
            </div>
            <div className="form-group">
              <label>Source URL *</label>
              <input
                type="url"
                value={formData.sourceUrl}
                onChange={(e) => setFormData({ ...formData, sourceUrl: e.target.value })}
                required
                placeholder="https://..."
              />
            </div>
            <div className="form-group">
              <label>Image URL (Optional)</label>
              <input
                type="url"
                value={formData.image}
                onChange={(e) => setFormData({ ...formData, image: e.target.value })}
                placeholder="https://..."
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-success">Submit Request</button>
              <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="loading">Loading requests...</div>
      ) : requests.length === 0 ? (
        <div className="empty-state">
          <p>You haven't submitted any wine requests yet.</p>
        </div>
      ) : (
        <div className="requests-list">
          {requests.map(request => (
            <div key={request._id} className="request-card">
              <div className="request-header">
                <h3>{request.wineName}</h3>
                <span className={`status-badge status-${request.status}`}>
                  {request.status}
                </span>
              </div>
              <p><strong>Source:</strong> <a href={request.sourceUrl} target="_blank" rel="noopener noreferrer">
                {request.sourceUrl}
              </a></p>
              {request.status === 'resolved' && request.linkedWineDefinition && (
                <div className="resolution">
                  <strong>Linked to:</strong> {request.linkedWineDefinition.name} by {request.linkedWineDefinition.producer}
                </div>
              )}
              {request.adminNotes && (
                <div className="admin-notes">
                  <strong>Admin Notes:</strong> {request.adminNotes}
                </div>
              )}
              <div className="request-footer">
                <small>Submitted {new Date(request.createdAt).toLocaleDateString()}</small>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default WineRequests;

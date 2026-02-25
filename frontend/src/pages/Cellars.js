import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { usePlan } from '../contexts/AuthContext';
import { formatLimit } from '../config/plans';
import CellarColorPicker from '../components/CellarColorPicker';
import './Cellars.css';

function Cellars() {
  const { token } = useAuth();
  const { plan, config } = usePlan();
  const [cellars, setCellars] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [limitError, setLimitError] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newCellar, setNewCellar] = useState({ name: '', description: '', color: null });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchCellars();
  }, [token]);

  const fetchCellars = async () => {
    try {
      const res = await fetch('/api/cellars', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setCellars(data.cellars);
      } else {
        setError(data.error || 'Failed to load cellars');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  // Number of owned cellars (not shared ones)
  const ownedCellars = cellars.filter(c => c.userRole === 'owner');
  const atLimit = config.maxCellars !== -1 && ownedCellars.length >= config.maxCellars;

  const handleCreateCellar = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setLimitError(null);

    try {
      const res = await fetch('/api/cellars', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(newCellar)
      });

      const data = await res.json();
      if (res.ok) {
        setCellars([data.cellar, ...cellars]);
        setNewCellar({ name: '', description: '', color: null });
        setShowCreateForm(false);
      } else if (res.status === 403 && data.limitReached === 'cellars') {
        setLimitError(data);
        setShowCreateForm(false);
      } else {
        setError(data.error || 'Failed to create cellar');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return <div className="loading">Loading cellars...</div>;
  }

  return (
    <div className="cellars-page">
      <div className="page-header">
        <h1>My Cellars</h1>
        <button
          onClick={() => {
            setLimitError(null);
            setShowCreateForm(!showCreateForm);
          }}
          className="btn btn-primary"
        >
          {showCreateForm ? 'Cancel' : '+ New Cellar'}
        </button>
      </div>

      {/* Plan limit upgrade prompt — only after the button is clicked */}
      {((showCreateForm && atLimit) || limitError) && (
        <div className="plan-limit-notice">
          <span className="plan-limit-notice__icon">🔒</span>
          <div>
            <strong>Cellar limit reached</strong>
            <p>
              Your <strong>{plan.charAt(0).toUpperCase() + plan.slice(1)}</strong> plan allows{' '}
              <strong>{formatLimit(config.maxCellars)} cellar{config.maxCellars === 1 ? '' : 's'}</strong>.
              Contact an admin to upgrade your plan and create more cellars.
            </p>
          </div>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {showCreateForm && !atLimit && (
        <div className="card create-form">
          <h2>Create New Cellar</h2>
          <form onSubmit={handleCreateCellar}>
            <div className="form-group">
              <label>Cellar Name *</label>
              <input
                type="text"
                value={newCellar.name}
                onChange={(e) => setNewCellar({ ...newCellar, name: e.target.value })}
                required
                placeholder="e.g., Main Cellar"
              />
            </div>
            <div className="form-group">
              <label>Description</label>
              <textarea
                value={newCellar.description}
                onChange={(e) => setNewCellar({ ...newCellar, description: e.target.value })}
                placeholder="Optional description"
                rows="3"
              />
            </div>
            <div className="form-group">
              <label>Color</label>
              <CellarColorPicker
                value={newCellar.color}
                onChange={color => setNewCellar({ ...newCellar, color })}
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating...' : 'Create Cellar'}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {cellars.length === 0 ? (
        <div className="empty-state">
          <p>You don't have any cellars yet.</p>
          <p>Create your first cellar to start tracking your wine collection!</p>
        </div>
      ) : (
        <div className="cellars-grid">
          {cellars.map(cellar => (
            <Link
              key={cellar._id}
              to={`/cellars/${cellar._id}`}
              className="cellar-card"
              style={{ borderLeft: `3px solid ${cellar.userColor || 'transparent'}` }}
            >
              <div className="cellar-card-header">
                <h3>{cellar.name}</h3>
                {cellar.userRole && cellar.userRole !== 'owner' && (
                  <span className={`role-badge role-badge--${cellar.userRole}`}>
                    {cellar.userRole === 'editor' ? 'Edit' : 'View'}
                  </span>
                )}
              </div>
              {cellar.description && <p className="description">{cellar.description}</p>}
              <div className="cellar-footer">
                <span className="view-link">View Cellar →</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default Cellars;

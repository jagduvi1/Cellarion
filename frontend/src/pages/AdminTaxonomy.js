import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './AdminTaxonomy.css';

function AdminTaxonomy() {
  const { token } = useAuth();
  const [activeTab, setActiveTab] = useState('countries');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formData, setFormData] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState(null);
  const [allCountries, setAllCountries] = useState([]);

  const endpoints = {
    countries: '/api/admin/taxonomy/countries',
    regions: '/api/admin/taxonomy/regions',
    grapes: '/api/admin/taxonomy/grapes'
  };

  useEffect(() => {
    fetchItems();
    setShowForm(false);
    setFormData({});
  }, [activeTab, token]);

  // Pre-load countries for the region form dropdown
  useEffect(() => {
    const fetchCountries = async () => {
      try {
        const res = await fetch('/api/admin/taxonomy/countries', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) setAllCountries(data.countries || []);
      } catch (err) {
        console.error('Failed to load countries for dropdown', err);
      }
    };
    fetchCountries();
  }, [token]);

  const fetchItems = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoints[activeTab], {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setItems(data.countries || data.regions || data.grapes || []);
      }
    } catch (err) {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(endpoints[activeTab], {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(formData)
      });
      const data = await res.json();
      if (res.ok) {
        setShowForm(false);
        setFormData({});
        fetchItems();
      } else {
        setError(data.error || 'Failed to create');
      }
    } catch (err) {
      setError('Network error');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this item?')) return;
    try {
      const res = await fetch(`${endpoints[activeTab]}/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        fetchItems();
      } else {
        alert(data.error || 'Failed to delete');
      }
    } catch (err) {
      alert('Network error');
    }
  };

  const renderForm = () => {
    if (activeTab === 'countries') {
      return (
        <>
          <div className="form-group">
            <label>Country Name *</label>
            <input
              type="text"
              value={formData.name || ''}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
            />
          </div>
          <div className="form-group">
            <label>ISO Code (2-letter)</label>
            <input
              type="text"
              value={formData.code || ''}
              onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
              maxLength="2"
              placeholder="FR"
            />
          </div>
        </>
      );
    }

    if (activeTab === 'regions') {
      return (
        <>
          <div className="form-group">
            <label>Region Name *</label>
            <input
              type="text"
              value={formData.name || ''}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
            />
          </div>
          <div className="form-group">
            <label>Country *</label>
            <select
              value={formData.country || ''}
              onChange={(e) => setFormData({ ...formData, country: e.target.value })}
              required
            >
              <option value="">Select a country</option>
              {allCountries.map(c => (
                <option key={c._id} value={c._id}>{c.name}</option>
              ))}
            </select>
          </div>
        </>
      );
    }

    if (activeTab === 'grapes') {
      return (
        <>
          <div className="form-group">
            <label>Grape Name *</label>
            <input
              type="text"
              value={formData.name || ''}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
            />
          </div>
          <div className="form-group">
            <label>Synonyms (comma-separated)</label>
            <input
              type="text"
              value={formData.synonymsText || ''}
              onChange={(e) => setFormData({
                ...formData,
                synonymsText: e.target.value,
                synonyms: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
              })}
              placeholder="Cab Sauv, CS"
            />
          </div>
        </>
      );
    }
  };

  const renderItem = (item) => {
    if (activeTab === 'countries') {
      return <span>{item.name} {item.code && `(${item.code})`}</span>;
    }
    if (activeTab === 'regions') {
      return <span>{item.name} — {item.country?.name || 'Unknown country'}</span>;
    }
    if (activeTab === 'grapes') {
      return <span>{item.name} {item.synonyms?.length > 0 && <em>({item.synonyms.join(', ')})</em>}</span>;
    }
  };

  return (
    <div className="admin-taxonomy-page">
      <div className="page-header">
        <h1>Admin: Taxonomy Management</h1>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? 'Cancel' : `+ Add ${activeTab.slice(0, -1)}`}
        </button>
      </div>

      <div className="tabs">
        {['countries', 'regions', 'grapes'].map(tab => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {showForm && (
        <div className="card create-form">
          <h2>Add {activeTab.slice(0, -1)}</h2>
          <form onSubmit={handleCreate}>
            {renderForm()}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">Create</button>
              <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="loading">Loading...</div>
      ) : (
        <div className="items-list">
          {items.length === 0 ? (
            <div className="empty-state"><p>No {activeTab} added yet.</p></div>
          ) : (
            items.map(item => (
              <div key={item._id} className="taxonomy-item">
                <span>{renderItem(item)}</span>
                <button
                  onClick={() => handleDelete(item._id)}
                  className="btn btn-danger btn-small"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default AdminTaxonomy;

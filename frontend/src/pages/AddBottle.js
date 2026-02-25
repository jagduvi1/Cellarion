import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { CURRENCIES } from '../config/currencies';
import { monthToLastDay } from '../utils/drinkStatus';
import ImageUpload from '../components/ImageUpload';
import './AddBottle.css';

function AddBottle() {
  const { id: cellarId } = useParams();
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(1); // 1 = select wine, 2 = enter details
  const [wines, setWines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedWine, setSelectedWine] = useState(null);
  const [numBottles, setNumBottles] = useState(1);
  const [bottleData, setBottleData] = useState({
    vintage: '',
    price: '',
    currency: user?.preferences?.currency || 'USD',
    bottleSize: '750ml',
    purchaseDate: '',
    purchaseLocation: '',
    purchaseUrl: '',
    notes: '',
    rating: '',
    drinkFrom: '',
    drinkBefore: ''
  });
  const [uploadedImages, setUploadedImages] = useState([]);

  // Load recent wines on mount so list isn't blank before typing
  useEffect(() => {
    loadRecentWines();
  }, []);

  useEffect(() => {
    if (search.length > 0) {
      searchWines();
    } else {
      loadRecentWines();
    }
  }, [search]);

  const loadRecentWines = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/wines?sort=-createdAt&limit=12');
      const data = await res.json();
      if (res.ok) setWines(data.wines);
    } catch (err) {
      console.error('Failed to load recent wines:', err);
    } finally {
      setLoading(false);
    }
  };

  const searchWines = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/wines?search=${encodeURIComponent(search)}&limit=20`);
      const data = await res.json();
      if (res.ok) {
        setWines(data.wines);
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectWine = (wine) => {
    setSelectedWine(wine);
    setStep(2);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    try {
      const payload = {
        cellar: cellarId,
        wineDefinition: selectedWine._id,
        ...bottleData,
        price: bottleData.price ? parseFloat(bottleData.price) : undefined,
        rating: bottleData.rating ? parseInt(bottleData.rating) : undefined,
        drinkFrom:   bottleData.drinkFrom   ? `${bottleData.drinkFrom}-01`          : undefined,
        drinkBefore: bottleData.drinkBefore ? monthToLastDay(bottleData.drinkBefore) : undefined,
      };

      // Create N individual bottle records
      const createdBottles = [];
      for (let i = 0; i < numBottles; i++) {
        const res = await fetch('/api/bottles', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Failed to add bottle');
          return;
        }
        createdBottles.push(data.bottle);
      }

      // Link uploaded images to the first bottle
      if (uploadedImages.length > 0 && createdBottles.length > 0) {
        fetch('/api/images/link-to-bottle', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            bottleId: createdBottles[0]._id,
            imageIds: uploadedImages.map(img => img._id)
          })
        }).catch(err => console.error('Failed to link images:', err));
      }
      navigate(`/cellars/${cellarId}`);
    } catch (err) {
      setError('Network error');
    }
  };

  return (
    <div className="add-bottle-page">
      <div className="page-header">
        <div>
          <Link to={`/cellars/${cellarId}`} className="back-link">← Back to Cellar</Link>
          <h1>Add Bottle</h1>
        </div>
      </div>

      <div className="steps-indicator">
        <div className={`step ${step >= 1 ? 'active' : ''}`}>
          <div className="step-number">1</div>
          <span>Select Wine</span>
        </div>
        <div className="step-divider"></div>
        <div className={`step ${step >= 2 ? 'active' : ''}`}>
          <div className="step-number">2</div>
          <span>Bottle Details</span>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {step === 1 && (
        <div className="card">
          <h2>Search for a Wine</h2>
          <div className="search-section">
            <input
              type="text"
              placeholder="Search by wine name or producer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="search-input-large"
              autoFocus
            />
            <p className="help-text">
              Can't find your wine? <Link to="/wine-requests">Request a new wine</Link>
            </p>
          </div>

          {loading && <p>Searching...</p>}

          {loading && wines.length === 0 && <p className="loading">Loading...</p>}

          {!loading && wines.length === 0 && (
            <div className="empty-state">
              <p>{search.length > 2 ? 'No wines matched your search.' : 'No wines in the registry yet.'}</p>
            </div>
          )}

          {wines.length > 0 && (
            <>
              {search.length <= 2 && (
                <p className="wines-list-label">Recently added wines — or start typing to search</p>
              )}
              <div className="wines-list">
                {wines.map(wine => (
                  <div key={wine._id} className="wine-row" onClick={() => handleSelectWine(wine)}>
                    {wine.image ? (
                      <img
                        src={wine.image}
                        alt={wine.name}
                        className="wine-row-image"
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    ) : (
                      <div className={`wine-row-placeholder ${wine.type}`}></div>
                    )}
                    <div className="wine-info">
                      <h3>{wine.name}</h3>
                      <p className="producer">{wine.producer}</p>
                      <div className="wine-meta">
                        <span>{wine.country?.name}</span>
                        {wine.region && <span>• {wine.region.name}</span>}
                        <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>
                      </div>
                    </div>
                    <button className="btn btn-primary btn-small">Select</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {step === 2 && selectedWine && (
        <div className="card">
          <div className="selected-wine">
            <h3>Selected Wine</h3>
            <div className="wine-summary">
              {selectedWine.image && (
                <img
                  src={selectedWine.image}
                  alt={selectedWine.name}
                  className="selected-wine-image"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              )}
              <div>
                <strong>{selectedWine.name}</strong>
                <span> by {selectedWine.producer}</span>
              </div>
              <button onClick={() => setStep(1)} className="btn btn-secondary btn-small">
                Change Wine
              </button>
            </div>
          </div>

          <h2>Bottle Details</h2>
          <form onSubmit={handleSubmit}>
            <div className="grid-2">
              <div className="form-group">
                <label>Vintage *</label>
                <input
                  type="text"
                  value={bottleData.vintage}
                  onChange={(e) => setBottleData({ ...bottleData, vintage: e.target.value })}
                  placeholder="e.g., 2015 or NV"
                  required
                />
              </div>

              <div className="form-group">
                <label>Number of bottles *</label>
                <input
                  type="number"
                  value={numBottles}
                  onChange={(e) => setNumBottles(Math.max(1, parseInt(e.target.value) || 1))}
                  min="1"
                  required
                />
              </div>

              <div className="form-group">
                <label>Price</label>
                <input
                  type="number"
                  step="0.01"
                  value={bottleData.price}
                  onChange={(e) => setBottleData({ ...bottleData, price: e.target.value })}
                  placeholder="0.00"
                />
              </div>

              <div className="form-group">
                <label>Currency</label>
                <select
                  value={bottleData.currency}
                  onChange={(e) => setBottleData({ ...bottleData, currency: e.target.value })}
                >
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label>Bottle Size</label>
                <select
                  value={bottleData.bottleSize}
                  onChange={(e) => setBottleData({ ...bottleData, bottleSize: e.target.value })}
                >
                  <option>375ml (Half)</option>
                  <option>750ml (Standard)</option>
                  <option>1.5L (Magnum)</option>
                  <option>3L (Double Magnum)</option>
                </select>
              </div>

              <div className="form-group">
                <label>Rating (1-5)</label>
                <select
                  value={bottleData.rating}
                  onChange={(e) => setBottleData({ ...bottleData, rating: e.target.value })}
                >
                  <option value="">Not rated</option>
                  <option value="5">⭐⭐⭐⭐⭐ (5 stars)</option>
                  <option value="4">⭐⭐⭐⭐ (4 stars)</option>
                  <option value="3">⭐⭐⭐ (3 stars)</option>
                  <option value="2">⭐⭐ (2 stars)</option>
                  <option value="1">⭐ (1 star)</option>
                </select>
              </div>

              <div className="form-group">
                <label>Purchase Date</label>
                <input
                  type="date"
                  value={bottleData.purchaseDate}
                  onChange={(e) => setBottleData({ ...bottleData, purchaseDate: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Purchase Location</label>
                <input
                  type="text"
                  value={bottleData.purchaseLocation}
                  onChange={(e) => setBottleData({ ...bottleData, purchaseLocation: e.target.value })}
                  placeholder="Store or location"
                />
              </div>

              <div className="form-group">
                <label>Purchase URL</label>
                <input
                  type="url"
                  value={bottleData.purchaseUrl}
                  onChange={(e) => setBottleData({ ...bottleData, purchaseUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>
            </div>

            <div className="form-group">
              <label>Notes</label>
              <textarea
                value={bottleData.notes}
                onChange={(e) => setBottleData({ ...bottleData, notes: e.target.value })}
                placeholder="Tasting notes, storage conditions, etc."
                rows="4"
              />
            </div>

            <div className="form-group drink-window-section">
              <label>Drink Window (optional)</label>
              <p className="help-text">
                Set when this bottle should be drunk. You can set one or both dates.
                If you add multiple bottles, each gets its own drink window later.
              </p>
              <div className="drink-window-fields">
                <div>
                  <label className="sublabel">Drink From</label>
                  <input
                    type="month"
                    value={bottleData.drinkFrom}
                    onChange={(e) => setBottleData({ ...bottleData, drinkFrom: e.target.value })}
                  />
                </div>
                <div>
                  <label className="sublabel">Drink Before</label>
                  <input
                    type="month"
                    value={bottleData.drinkBefore}
                    onChange={(e) => setBottleData({ ...bottleData, drinkBefore: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="form-group">
              <label>Bottle Photos</label>
              <p className="help-text">
                Take a photo or upload an image. Background will be automatically removed.
              </p>
              <ImageUpload
                wineDefinitionId={selectedWine?._id}
                onUploadComplete={(img) => setUploadedImages(prev => [...prev, img])}
              />
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-success">
                Add Bottle to Cellar
              </button>
              <button
                type="button"
                onClick={() => navigate(`/cellars/${cellarId}`)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default AddBottle;

import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { CURRENCIES } from '../config/currencies';
import { monthToLastDay } from '../utils/drinkStatus';
import ImageUpload from '../components/ImageUpload';
import './AddBottle.css';

function AddBottle() {
  const { t } = useTranslation();
  const { id: cellarId } = useParams();
  const { apiFetch, user } = useAuth();
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

  useEffect(() => {
    if (search.length > 0) {
      searchWines();
    } else {
      setWines([]);
    }
  }, [search]);

  const searchWines = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/wines?search=${encodeURIComponent(search)}&limit=10`);
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
        const res = await apiFetch('/api/bottles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        apiFetch('/api/images/link-to-bottle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
          <Link to={`/cellars/${cellarId}`} className="back-link">{t('addBottle.backToCellar')}</Link>
          <h1>{t('addBottle.title')}</h1>
        </div>
      </div>

      <div className="steps-indicator">
        <div className={`step ${step >= 1 ? 'active' : ''}`}>
          <div className="step-number">1</div>
          <span>{t('addBottle.stepSelectWine')}</span>
        </div>
        <div className="step-divider"></div>
        <div className={`step ${step >= 2 ? 'active' : ''}`}>
          <div className="step-number">2</div>
          <span>{t('addBottle.stepBottleDetails')}</span>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {step === 1 && (
        <div className="card">
          <h2>{t('addBottle.searchForWine')}</h2>
          <div className="search-section">
            <input
              type="text"
              placeholder={t('addBottle.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="search-input-large"
              autoFocus
            />
            <p className="help-text">
              {t('addBottle.cantFindWine')} <Link to="/wine-requests">{t('addBottle.requestNewWine')}</Link>
            </p>
          </div>

          {loading && <p>{t('addBottle.searching')}</p>}

          {loading && wines.length === 0 && <p className="loading">{t('common.loading')}</p>}

          {!loading && wines.length === 0 && (
            <div className="empty-state">
              <p>{search.length > 0 ? t('addBottle.noWinesMatched') : t('addBottle.startTyping')}</p>
            </div>
          )}

          {wines.length > 0 && (
            <>
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
                    <button className="btn btn-primary btn-small">{t('addBottle.selectBtn')}</button>
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
            <h3>{t('addBottle.selectedWine')}</h3>
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
                {t('addBottle.changeWine')}
              </button>
            </div>
          </div>

          <h2>{t('addBottle.bottleDetails')}</h2>
          <form onSubmit={handleSubmit}>
            <div className="grid-2">
              <div className="form-group">
                <label>{t('common.vintage')} *</label>
                <input
                  type="text"
                  value={bottleData.vintage}
                  onChange={(e) => setBottleData({ ...bottleData, vintage: e.target.value })}
                  placeholder={t('addBottle.vintagePlaceholder')}
                  required
                />
              </div>

              <div className="form-group">
                <label>{t('addBottle.numberOfBottles')}</label>
                <input
                  type="number"
                  value={numBottles}
                  onChange={(e) => setNumBottles(Math.max(1, parseInt(e.target.value) || 1))}
                  min="1"
                  required
                />
              </div>

              <div className="form-group">
                <label>{t('common.price')}</label>
                <input
                  type="number"
                  step="0.01"
                  value={bottleData.price}
                  onChange={(e) => setBottleData({ ...bottleData, price: e.target.value })}
                  placeholder="0.00"
                />
              </div>

              <div className="form-group">
                <label>{t('common.currency')}</label>
                <select
                  value={bottleData.currency}
                  onChange={(e) => setBottleData({ ...bottleData, currency: e.target.value })}
                >
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label>{t('addBottle.bottleSize')}</label>
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
                <label>{t('addBottle.ratingLabel')}</label>
                <select
                  value={bottleData.rating}
                  onChange={(e) => setBottleData({ ...bottleData, rating: e.target.value })}
                >
                  <option value="">{t('common.noRating')}</option>
                  <option value="5">⭐⭐⭐⭐⭐ (5 stars)</option>
                  <option value="4">⭐⭐⭐⭐ (4 stars)</option>
                  <option value="3">⭐⭐⭐ (3 stars)</option>
                  <option value="2">⭐⭐ (2 stars)</option>
                  <option value="1">⭐ (1 star)</option>
                </select>
              </div>

              <div className="form-group">
                <label>{t('addBottle.purchaseDate')}</label>
                <input
                  type="date"
                  value={bottleData.purchaseDate}
                  onChange={(e) => setBottleData({ ...bottleData, purchaseDate: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>{t('addBottle.purchaseLocation')}</label>
                <input
                  type="text"
                  value={bottleData.purchaseLocation}
                  onChange={(e) => setBottleData({ ...bottleData, purchaseLocation: e.target.value })}
                  placeholder={t('addBottle.purchaseLocationPlaceholder')}
                />
              </div>

              <div className="form-group">
                <label>{t('addBottle.purchaseUrl')}</label>
                <input
                  type="url"
                  value={bottleData.purchaseUrl}
                  onChange={(e) => setBottleData({ ...bottleData, purchaseUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>
            </div>

            <div className="form-group">
              <label>{t('common.notes')}</label>
              <textarea
                value={bottleData.notes}
                onChange={(e) => setBottleData({ ...bottleData, notes: e.target.value })}
                placeholder={t('addBottle.notesPlaceholder')}
                rows="4"
              />
            </div>

            <div className="form-group drink-window-section">
              <label>{t('addBottle.drinkWindow')}</label>
              <p className="help-text">
                {t('addBottle.drinkWindowHint')}
              </p>
              <div className="drink-window-fields">
                <div>
                  <label className="sublabel">{t('addBottle.drinkFrom')}</label>
                  <input
                    type="month"
                    value={bottleData.drinkFrom}
                    onChange={(e) => setBottleData({ ...bottleData, drinkFrom: e.target.value })}
                  />
                </div>
                <div>
                  <label className="sublabel">{t('addBottle.drinkBefore')}</label>
                  <input
                    type="month"
                    value={bottleData.drinkBefore}
                    onChange={(e) => setBottleData({ ...bottleData, drinkBefore: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="form-group">
              <label>{t('addBottle.bottlePhotos')}</label>
              <p className="help-text">
                {t('addBottle.photosHint')}
              </p>
              <ImageUpload
                wineDefinitionId={selectedWine?._id}
                onUploadComplete={(img) => setUploadedImages(prev => [...prev, img])}
              />
              <p className="image-public-notice">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }}>
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {t('addBottle.photosNotice')}
              </p>
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-success">
                {t('addBottle.addBottleBtn')}
              </button>
              <button
                type="button"
                onClick={() => navigate(`/cellars/${cellarId}`)}
                className="btn btn-secondary"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default AddBottle;

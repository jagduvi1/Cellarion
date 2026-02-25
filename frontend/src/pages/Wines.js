import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import ImageGallery from '../components/ImageGallery';
import './Wines.css';

function WineCardImage({ wine }) {
  const [hasGallery, setHasGallery] = useState(null);

  if (hasGallery === false) {
    // No uploaded images — show default image or placeholder
    if (wine.image) {
      return (
        <img
          src={wine.image}
          alt={wine.name}
          className="wine-image"
          onError={(e) => { e.target.style.display = 'none'; }}
        />
      );
    }
    return (
      <div className={`wine-image-placeholder ${wine.type}`}>
        <span>{wine.type}</span>
      </div>
    );
  }

  return (
    <div className="wine-card-gallery">
      <ImageGallery
        wineDefinitionId={wine._id}
        size="medium"
        onEmpty={() => setHasGallery(false)}
      />
      {hasGallery === null && (
        <div className={`wine-image-placeholder ${wine.type}`}>
          <span>{wine.type}</span>
        </div>
      )}
    </div>
  );
}

function Wines() {
  const { token, user } = useAuth();
  const isPrivileged = user?.roles?.includes('admin') || user?.roles?.includes('somm');

  const [wines, setWines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({
    type: '',
    sort: 'name'
  });

  useEffect(() => {
    if (search.length > 0 || isPrivileged) {
      fetchWines();
    } else {
      setWines([]);
    }
  }, [search, filters]);

  const fetchWines = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.append('search', search);
      if (filters.type) params.append('type', filters.type);
      params.append('sort', filters.sort);
      params.append('limit', '50');

      const res = await fetch(`/api/wines?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setWines(data.wines);
      }
    } catch (err) {
      console.error('Failed to fetch wines:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="wines-page">
      <div className="page-header">
        <h1>Wine Registry</h1>
        <p>Browse all available wines in the registry</p>
      </div>

      <div className="filters-bar">
        <input
          type="text"
          placeholder="Search wines or producers..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
        />
        <select
          value={filters.type}
          onChange={(e) => setFilters({ ...filters, type: e.target.value })}
        >
          <option value="">All Types</option>
          <option value="red">Red</option>
          <option value="white">White</option>
          <option value="rosé">Rosé</option>
          <option value="sparkling">Sparkling</option>
          <option value="dessert">Dessert</option>
          <option value="fortified">Fortified</option>
        </select>
        <select
          value={filters.sort}
          onChange={(e) => setFilters({ ...filters, sort: e.target.value })}
        >
          <option value="name">Name A-Z</option>
          <option value="-name">Name Z-A</option>
          <option value="producer">Producer A-Z</option>
          <option value="-createdAt">Recently Added</option>
        </select>
      </div>

      {!loading && (
        <p className="results-count">
          {wines.length} {wines.length === 1 ? 'wine' : 'wines'} found
        </p>
      )}

      {loading ? (
        <div className="loading">Loading wines...</div>
      ) : wines.length === 0 ? (
        <div className="empty-state">
          <p>{search.length === 0 && !isPrivileged ? 'Enter a search term to browse wines.' : 'No wines found matching your criteria.'}</p>
        </div>
      ) : (
        <div className="wines-grid">
          {wines.map(wine => (
            <div key={wine._id} className="wine-card">
              <WineCardImage wine={wine} />
              <div className="wine-card-body">
                <div className="wine-header">
                  <h3>{wine.name}</h3>
                  <span className={`wine-type ${wine.type}`}>{wine.type}</span>
                </div>
                <p className="producer">{wine.producer}</p>
                <div className="wine-details">
                  <div><strong>Country:</strong> {wine.country?.name || 'Unknown'}</div>
                  {wine.region && <div><strong>Region:</strong> {wine.region.name}</div>}
                  {wine.appellation && <div><strong>Appellation:</strong> {wine.appellation}</div>}
                  {wine.grapes?.length > 0 && (
                    <div><strong>Grapes:</strong> {wine.grapes.map(g => g.name).join(', ')}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Wines;

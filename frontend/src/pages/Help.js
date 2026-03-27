import { useState, useEffect } from 'react';
import { getHelpContent } from '../api/help';
import './Help.css';

function Help() {
  const [content, setContent] = useState(null);
  const [search, setSearch] = useState('');
  const [openSection, setOpenSection] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getHelpContent()
      .then(data => setContent(data))
      .catch(() => setError('Could not load help content.'));
  }, []);

  if (error) {
    return (
      <div className="help-page">
        <div className="help-container">
          <h1>Help</h1>
          <p className="alert alert-error">{error}</p>
        </div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="help-page">
        <div className="help-container">
          <h1>Help</h1>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  const filtered = search.trim()
    ? content.sections.filter(s => {
        const q = search.toLowerCase();
        return (
          s.title.toLowerCase().includes(q) ||
          s.summary.toLowerCase().includes(q) ||
          s.details.some(d => d.toLowerCase().includes(q))
        );
      })
    : content.sections;

  const toggleSection = (id) => {
    setOpenSection(prev => prev === id ? null : id);
  };

  return (
    <div className="help-page">
      <div className="help-container">
        <div className="help-header">
          <h1>Help & Features</h1>
          <p className="help-subtitle">
            Everything you need to know about using Cellarion.
          </p>
          <input
            className="help-search"
            type="text"
            placeholder="Search help topics..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="help-sections">
          {filtered.length === 0 && (
            <p className="help-no-results">No matching topics found. Try a different search term.</p>
          )}

          {filtered.map(section => {
            const isOpen = openSection === section.id || search.trim().length > 0;

            return (
              <div key={section.id} className={`help-section ${isOpen ? 'help-section--open' : ''}`}>
                <button
                  className="help-section-header"
                  onClick={() => toggleSection(section.id)}
                  aria-expanded={isOpen}
                >
                  <div className="help-section-header-text">
                    <h2>{section.title}</h2>
                    <p>{section.summary}</p>
                  </div>
                  <svg
                    className="help-section-chevron"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {isOpen && (
                  <div className="help-section-body">
                    <ul>
                      {section.details.map((detail, i) => (
                        <li key={i}>{detail}</li>
                      ))}
                    </ul>
                    {section.route && (
                      <a href={section.route} className="help-section-link">
                        Go to {section.title} &rarr;
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default Help;

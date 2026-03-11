import { useState } from 'react';
import Modal from './Modal';
import { submitWineReport } from '../api/support';
import { useAuth } from '../contexts/AuthContext';
import './ReportWineModal.css';

const REASONS = [
  { value: 'wrong_info', label: 'Wrong information (name, producer, region, etc.)' },
  { value: 'duplicate', label: 'Duplicate wine entry' },
  { value: 'inappropriate', label: 'Inappropriate content' },
  { value: 'other', label: 'Other' },
];

function ReportWineModal({ wine, onClose }) {
  const { apiFetch } = useAuth();
  const [form, setForm] = useState({ reason: 'wrong_info', details: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleChange = (e) => {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
    setError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    setSubmitting(true);
    setError(null);
    try {
      const res = await submitWineReport(apiFetch, {
        wineDefinitionId: wine._id,
        reason: form.reason,
        details: form.details || undefined,
      });
      const data = await res.json();
      if (!res.ok) return setError(data.error || 'Failed to submit report');
      setSuccess(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <Modal title="Report Submitted" onClose={onClose}>
        <div className="report-wine-success">
          <p>Thank you for your report. Our team will review it shortly.</p>
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Report Wine" onClose={onClose}>
      <p className="report-wine-subtitle">
        Reporting: <strong>{wine.name}{wine.producer ? ` — ${wine.producer}` : ''}</strong>
      </p>
      <form onSubmit={handleSubmit} className="report-wine-form">
        <label>
          Reason
          <select name="reason" value={form.reason} onChange={handleChange}>
            {REASONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </label>

        <label>
          Details <span className="optional">(optional)</span>
          <textarea
            name="details"
            value={form.details}
            onChange={handleChange}
            placeholder="Provide any additional information that will help us investigate…"
            rows={4}
            maxLength={2000}
          />
          <span className="char-count">{form.details.length}/2000</span>
        </label>

        {error && <p className="report-wine-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn-danger" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit Report'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default ReportWineModal;

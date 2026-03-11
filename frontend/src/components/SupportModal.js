import { useState } from 'react';
import Modal from './Modal';
import { submitSupportTicket } from '../api/support';
import { useAuth } from '../contexts/AuthContext';
import './SupportModal.css';

const CATEGORIES = [
  { value: 'bug', label: 'Bug Report' },
  { value: 'help', label: 'Help / Question' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'other', label: 'Other' },
];

function SupportModal({ onClose }) {
  const { apiFetch } = useAuth();
  const [form, setForm] = useState({ category: 'bug', subject: '', message: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleChange = (e) => {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
    setError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.subject.trim()) return setError('Subject is required');
    if (!form.message.trim()) return setError('Message is required');

    setSubmitting(true);
    setError(null);
    try {
      const res = await submitSupportTicket(apiFetch, form);
      const data = await res.json();
      if (!res.ok) return setError(data.error || 'Failed to submit ticket');
      setSuccess(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <Modal title="Support Request Sent" onClose={onClose}>
        <div className="support-modal-success">
          <p>Your ticket has been submitted. An admin will respond shortly.</p>
          <p>You can track your tickets under <strong>Support</strong> in the menu.</p>
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Contact Support" onClose={onClose}>
      <form onSubmit={handleSubmit} className="support-modal-form">
        <label>
          Category
          <select name="category" value={form.category} onChange={handleChange}>
            {CATEGORIES.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>

        <label>
          Subject
          <input
            type="text"
            name="subject"
            value={form.subject}
            onChange={handleChange}
            placeholder="Brief summary of your issue"
            maxLength={200}
          />
        </label>

        <label>
          Message
          <textarea
            name="message"
            value={form.message}
            onChange={handleChange}
            placeholder="Describe your issue or question in detail..."
            rows={6}
            maxLength={5000}
          />
          <span className="char-count">{form.message.length}/5000</span>
        </label>

        {error && <p className="support-modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send Ticket'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default SupportModal;

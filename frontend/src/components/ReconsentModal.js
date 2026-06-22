import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import Modal from './Modal';
import { useAuth } from '../contexts/AuthContext';

/**
 * Shown when the signed-in user accepted an older privacy-policy version than the
 * current one (User.requiresPolicyReconsent === true, derived server-side). It
 * surfaces the updated terms and asks the user to review and acknowledge the
 * update — a transparency prompt, not consent to any optional feature. It is
 * intentionally non-dismissible (no close button, backdrop is a no-op, focus is
 * trapped) so the update isn't ignored; acknowledging clears the flag (the
 * refreshed user unmounts this modal). Logging out also removes it.
 *
 * Rendered globally from AppRoutes. Suppressed on /privacy so the user can read
 * the full policy the modal links to without it being covered.
 */
export default function ReconsentModal() {
  const { user, acceptPolicy, logout } = useAuth();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!user || !user.requiresPolicyReconsent) return null;
  // Let the user actually read the policy the modal links to.
  if (location.pathname === '/privacy') return null;

  const handleAccept = async () => {
    setSubmitting(true);
    setError('');
    const res = await acceptPolicy();
    if (!res.success) {
      setError(res.error || 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
    // On success the user refreshes with requiresPolicyReconsent === false and
    // this component unmounts — no further state changes needed.
  };

  return (
    <Modal title="We've updated our Privacy Policy" onClose={() => {}} trapFocus>
      <p>
        We've updated our Privacy Policy, including the third-party services that help run
        Cellarion. Please review and acknowledge the update to continue.
      </p>
      <p>
        Read the full policy:{' '}
        <Link to="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</Link>.
      </p>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={logout} disabled={submitting}>
          Log out
        </button>
        <button type="button" className="btn-primary" onClick={handleAccept} disabled={submitting}>
          {submitting ? 'Saving…' : 'I acknowledge the updated policy'}
        </button>
      </div>
    </Modal>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { deleteCellar } from '../api/cellars';
import Modal from './Modal';

export function DeleteCellarModal({ cellar, onDeleted, onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [typed, setTyped]   = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError]   = useState(null);

  const confirmed = typed === cellar.name;

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await deleteCellar(apiFetch, cellar._id);
      const data = await res.json();
      if (res.ok) {
        onDeleted();
      } else {
        setError(data.error || 'Failed to delete cellar');
        setDeleting(false);
      }
    } catch {
      setError('Network error');
      setDeleting(false);
    }
  };

  return (
    <Modal title={t('cellarDetail.deleteCellarTitle')} onClose={onClose}>
      <p className="delete-warning">
        This will delete <strong>{cellar.name}</strong> and all its racks.<br />
        {t('cellarDetail.bottlesPreserved')}
      </p>
      <p className="delete-recovery">
        {t('cellarDetail.deleteRecovery')}
      </p>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="form-group">
        <label>Type <strong>{cellar.name}</strong> to confirm</label>
        <input
          type="text"
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder={cellar.name}
          autoFocus
        />
      </div>
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button
          className="btn btn-danger"
          onClick={handleDelete}
          disabled={!confirmed || deleting}
        >
          {deleting ? t('cellarDetail.deleting') : t('cellarDetail.deleteCellarTitle')}
        </button>
      </div>
    </Modal>
  );
}

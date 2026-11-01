import { useTranslation } from 'react-i18next';
import { takeOutByDefault } from '../../utils/openBottle';
import './TakeOutOfRackChoice.css';

/**
 * "Take it out of the rack" in the open dialogs (bottle page, racks, room),
 * shown only for a bottle that sits in a rack. Its starting value follows the
 * chosen method (utils/openBottle takeOutByDefault) until the user ticks or
 * unticks it — the dialog keeps that state.
 */
export default function TakeOutOfRackChoice({ checked, onChange, disabled }) {
  const { t } = useTranslation();
  return (
    <label className="bd-open-takeout">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>
        <strong>{t('openBottle.takeOut', 'Take it out of the rack')}</strong>
        <small>{t('openBottle.takeOutHint', 'Frees its slot while it stands open. Undo puts it back.')}</small>
      </span>
    </label>
  );
}

/**
 * The dialog state behind the choice: the method's default until the user
 * touches the box, then their own answer for as long as the dialog is open.
 */
export function takeOutState(method, touched) {
  return touched === null ? takeOutByDefault(method) : touched;
}

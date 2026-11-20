import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import DialogBox from '../DialogBox';
import { afterPopupEntryGone } from '../../utils/useBackToClose';

/**
 * The two dialogs that can follow an add: the custom fields the server did
 * not save (the bottles were added), and the offer to place the new bottles
 * in a rack. The page owns when each shows and what closing it does.
 *
 * An add started from an empty rack slot (the racks page's "Add a new bottle
 * here", router state `placeAt`) does not ask: the new bottles go straight to
 * the racks page, the first into that slot (pages/CellarRacks.js). The racks
 * page takes the add page's place in the history, so Back from the rack never
 * lands on the emptied form.
 */
export default function AddBottleDialogs({
  customFieldNotice, setCustomFieldNotice, finishAdd, t, placePrompt, leavePlacePrompt, navigate,
  cellarId,
}) {
  const placeAt = useLocation().state?.placeAt || null;
  useEffect(() => {
    if (!placePrompt || !placeAt) return;
    navigate(`/cellars/${cellarId}/racks?rack=${encodeURIComponent(placeAt.rackId)}`, { replace: true, state: { placeQueue: placePrompt.ids, placeAt } });
  }, [placePrompt, placeAt, cellarId, navigate]);

  return (
    <>
      {/* A custom field the server refused. The bottles were added — say so
          plainly, name what was dropped, and carry on. */}
      {customFieldNotice && (
        <div className="modal-overlay">
          <DialogBox
            className="modal-box"
            onClose={() => { setCustomFieldNotice(null); afterPopupEntryGone(finishAdd); }}
            label={t('addBottle.customFieldsNotSaved', 'Some custom fields were not saved')}
          >
            <h2>{t('addBottle.customFieldsNotSaved', 'Some custom fields were not saved')}</h2>
            <p>{t('addBottle.customFieldsNotSavedBody', 'The bottles were added. These fields were not — you can add them on the bottle page.')}</p>
            <ul>
              {customFieldNotice.map(w => <li key={w}>{w}</li>)}
            </ul>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => { setCustomFieldNotice(null); afterPopupEntryGone(finishAdd); }}
              >
                {t('common.close')}
              </button>
            </div>
          </DialogBox>
        </div>
      )}

      {/* Post-add placing offer — skippable, never blocking */}
      {placePrompt && !placeAt && (
        <div className="modal-overlay" onClick={leavePlacePrompt}>
          <DialogBox
            className="modal-box"
            onClick={e => e.stopPropagation()}
            onClose={leavePlacePrompt}
            label={t('addBottle.placePrompt.title', { count: placePrompt.count })}
          >
            <h2>{t('addBottle.placePrompt.title', { count: placePrompt.count })}</h2>
            <p>{t('addBottle.placePrompt.body')}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={leavePlacePrompt}>
                {t('addBottle.placePrompt.notNow')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="place-now"
                onClick={() => navigate(`/cellars/${cellarId}/racks`, { state: { placeQueue: placePrompt.ids } })}
              >
                {t('addBottle.placePrompt.placeNow')}
              </button>
            </div>
          </DialogBox>
        </div>
      )}
    </>
  );
}

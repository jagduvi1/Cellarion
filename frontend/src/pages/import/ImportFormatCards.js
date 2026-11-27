import { useTranslation } from 'react-i18next';

// The upload step's list of the files the importer reads.
export default function ImportFormatCards() {
  const { t } = useTranslation();
  return (
      <div className="import-instructions">
        <h3>{t('importBottles.upload.supportedFormats')}</h3>
        <div className="format-cards">
          <div className="format-card">
            <strong>{t('importBottles.upload.cellarionTitle')}</strong>
            <p>{t('importBottles.upload.cellarionDesc')}</p>
          </div>
          <div className="format-card">
            <strong>{t('importBottles.upload.vivinoTitle')}</strong>
            <p>{t('importBottles.upload.vivinoDesc')}</p>
          </div>
          <div className="format-card">
            <strong>{t('importBottles.upload.cellartrackerTitle')}</strong>
            <p>{t('importBottles.upload.cellartrackerDesc')}</p>
          </div>
          <div className="format-card">
            <strong>{t('importBottles.upload.oenoTitle')}</strong>
            <p>{t('importBottles.upload.oenoDesc')}</p>
          </div>
          <div className="format-card">
            <strong>{t('importBottles.upload.plocTitle')}</strong>
            <p>{t('importBottles.upload.plocDesc')}</p>
          </div>
          <div className="format-card">
            <strong>{t('importBottles.upload.genericTitle')}</strong>
            <p>{t('importBottles.upload.genericDesc')}</p>
          </div>
        </div>
      </div>
  );
}

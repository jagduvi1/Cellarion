const mongoose = require('mongoose');

/**
 * Status report written by the backup job (scripts/backup/backup.sh) after each
 * run. A single document (_id: 'latest'). The app only READS this so SuperAdmin
 * can show that backups exist and are fresh — it deliberately never touches the
 * backup repository or its credentials (backups stay isolated from the app).
 */
const backupStatusSchema = new mongoose.Schema({
  _id: { type: String, default: 'latest' },
  status: { type: String, enum: ['ok', 'failed'] },
  lastRunAt: { type: Date },
  durationSec: { type: Number },
  snapshotCount: { type: Number },
  latestSnapshotTime: { type: Date },
  repoSizeBytes: { type: Number },
  host: { type: String },
  repo: { type: String },         // sanitized repo label (no secrets)
  error: { type: String },
}, { collection: 'backupstatuses', strict: false, versionKey: false });

module.exports = mongoose.model('BackupStatus', backupStatusSchema);

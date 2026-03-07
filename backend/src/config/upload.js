const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = '/app/uploads';
const ORIGINALS_DIR = path.join(UPLOAD_DIR, 'originals');
const PROCESSED_DIR = path.join(UPLOAD_DIR, 'processed');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, ORIGINALS_DIR);
  },
  filename: (req, file, cb) => {
    const uuid = crypto.randomUUID();
    const mimeToExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
    const ext = mimeToExt[file.mimetype] || '.jpg';
    cb(null, `${uuid}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, and WebP images are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

module.exports = {
  upload,
  UPLOAD_DIR,
  ORIGINALS_DIR,
  PROCESSED_DIR
};

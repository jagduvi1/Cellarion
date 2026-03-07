const fs = require('fs');
const path = require('path');
const { PROCESSED_DIR } = require('../config/upload');
const BottleImage = require('../models/BottleImage');

const REMBG_URL = process.env.REMBG_URL || 'http://rembg:5000';
const UPLOADS_ROOT = '/app/uploads';

function safeUploadPath(relativePart) {
  const resolved = path.resolve(UPLOADS_ROOT, relativePart);
  if (!resolved.startsWith(UPLOADS_ROOT + path.sep) && resolved !== UPLOADS_ROOT) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

async function processImage(imageId) {
  const image = await BottleImage.findById(imageId);
  if (!image || image.status !== 'uploaded') return;

  // Mark as processing
  image.status = 'processing';
  await image.save();

  try {
    // Read original file from disk
    const originalPath = safeUploadPath(image.originalUrl.replace('/api/uploads/', ''));
    const fileBuffer = fs.readFileSync(originalPath);

    // Build multipart form data using Node 20 built-in fetch
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
    formData.append('image', blob, 'input.jpg');

    const response = await fetch(`${REMBG_URL}/remove-bg`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120000) // 2 min timeout
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`rembg returned ${response.status}: ${errText}`);
    }

    // Save processed PNG
    const resultBuffer = Buffer.from(await response.arrayBuffer());
    const basename = path.basename(image.originalUrl, path.extname(image.originalUrl));
    const processedFilename = `${basename}.png`;
    const processedPath = path.join(PROCESSED_DIR, processedFilename);

    fs.writeFileSync(processedPath, resultBuffer);

    // Update document
    image.processedUrl = `/api/uploads/processed/${processedFilename}`;
    image.status = 'processed';
    await image.save();

    console.log(`Image ${imageId} processed successfully`);
  } catch (error) {
    console.error(`Image processing failed for ${imageId}:`, error.message);
    // Revert to uploaded so it can be retried
    image.status = 'uploaded';
    await image.save();
  }
}

async function reprocessAllImages() {
  const images = await BottleImage.find({
    status: { $in: ['processed', 'approved'] },
    originalUrl: { $exists: true }
  });

  console.log(`Re-processing ${images.length} images...`);

  for (const image of images) {
    try {
      const originalPath = safeUploadPath(image.originalUrl.replace('/api/uploads/', ''));
      if (!fs.existsSync(originalPath)) {
        console.log(`Skipping ${image._id}: original file not found`);
        continue;
      }

      const fileBuffer = fs.readFileSync(originalPath);
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
      formData.append('image', blob, 'input.jpg');

      const response = await fetch(`${REMBG_URL}/remove-bg`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(120000)
      });

      if (!response.ok) {
        console.log(`Skipping ${image._id}: rembg error ${response.status}`);
        continue;
      }

      const resultBuffer = Buffer.from(await response.arrayBuffer());
      const basename = path.basename(image.originalUrl, path.extname(image.originalUrl));
      const processedFilename = `${basename}.png`;
      const processedPath = path.join(PROCESSED_DIR, processedFilename);

      fs.writeFileSync(processedPath, resultBuffer);
      image.processedUrl = `/api/uploads/processed/${processedFilename}`;
      await image.save();

      console.log(`Re-processed ${image._id} successfully`);
    } catch (error) {
      console.error(`Re-process failed for ${image._id}:`, error.message);
    }
  }

  console.log('Re-processing complete');
}

module.exports = { processImage, reprocessAllImages };

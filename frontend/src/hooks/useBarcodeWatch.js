import { useEffect, useRef } from 'react';
import { normalizeBarcode } from '../utils/barcode';

/**
 * Watch a live <video> for a retail barcode while `active`, and report the
 * first one read reliably — the same code in two consecutive frames — once.
 *
 * Decoding uses the browser's own BarcodeDetector where it exists (Chrome and
 * Edge on Android, Chrome on macOS), and otherwise the ZXing JavaScript decoder
 * (Safari, Firefox, Windows), loaded only the first time the camera opens on
 * such a browser. Plain JavaScript, no WebAssembly, so the site's
 * Content-Security-Policy stays as it is.
 *
 * Nothing leaves the device here: frames are decoded locally and only the
 * resulting code is handed to `onDetect`.
 *
 * @param {React.RefObject<HTMLVideoElement>} videoRef
 * @param {{ active: boolean, onDetect: (code: string) => void }} options
 */

const INTERVAL_MS = 450;
const FRAMES_TO_CONFIRM = 2;
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const JS_MAX_WIDTH = 960; // frames are scaled down before the JS decoder reads them

async function createNativeDetector() {
  const BD = typeof window !== 'undefined' ? window.BarcodeDetector : undefined;
  if (!BD) return null;
  try {
    const supported = typeof BD.getSupportedFormats === 'function' ? await BD.getSupportedFormats() : NATIVE_FORMATS;
    const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
    if (formats.length === 0) return null;
    const detector = new BD({ formats });
    return { detect: async (video) => (await detector.detect(video)).map((r) => r.rawValue) };
  } catch {
    return null;
  }
}

// Only the EAN/UPC reader and the four pieces it needs, imported by path:
// the library's index pulls in every symbology (QR, PDF417, Aztec, …) and
// weighs ~450 KB; this subset is a fraction of that.
async function createJsDetector() {
  const [
    { default: MultiFormatUPCEANReader },
    { default: BinaryBitmap },
    { default: HybridBinarizer },
    { HTMLCanvasElementLuminanceSource },
    { default: DecodeHintType },
    { default: BarcodeFormat },
  ] = await Promise.all([
    import('@zxing/library/esm/core/oned/MultiFormatUPCEANReader'),
    import('@zxing/library/esm/core/BinaryBitmap'),
    import('@zxing/library/esm/core/common/HybridBinarizer'),
    import('@zxing/library/esm/browser/HTMLCanvasElementLuminanceSource'),
    import('@zxing/library/esm/core/DecodeHintType'),
    import('@zxing/library/esm/core/BarcodeFormat'),
  ]);
  const hints = new Map([
    [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]],
    // Also tries the frame turned 90°: barcodes on bottles often run vertically.
    [DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new MultiFormatUPCEANReader(hints);
  const canvas = document.createElement('canvas');
  return {
    detect: async (video) => {
      const scale = Math.min(1, JS_MAX_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
      const bitmap = new BinaryBitmap(new HybridBinarizer(new HTMLCanvasElementLuminanceSource(canvas)));
      try {
        return [reader.decode(bitmap, hints).getText()];
      } catch {
        return []; // nothing readable in this frame
      } finally {
        reader.reset();
      }
    },
  };
}

export async function createBarcodeDetector() {
  return (await createNativeDetector()) || createJsDetector();
}

export default function useBarcodeWatch(videoRef, { active, onDetect }) {
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer = null;
    let detector = null;
    let last = null;
    let streak = 0;

    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      try {
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
          if (!detector) detector = await createBarcodeDetector();
          if (stopped) return;
          const code = (await detector.detect(video)).map(normalizeBarcode).find(Boolean) || null;
          if (code && code === last) streak += 1;
          else { last = code; streak = code ? 1 : 0; }
          if (code && streak >= FRAMES_TO_CONFIRM) {
            stopped = true;
            if (onDetectRef.current) onDetectRef.current(code);
            return;
          }
        }
      } catch {
        // A frame that cannot be read: try the next one. A decoder that
        // cannot load at all (offline, blocked chunk): stop watching — the
        // label scan works exactly as before without it.
        if (!detector) return;
      }
      if (!stopped) timer = setTimeout(tick, INTERVAL_MS);
    };

    timer = setTimeout(tick, INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, videoRef]);
}

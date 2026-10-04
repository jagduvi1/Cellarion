/**
 * The add-bottle camera's barcode watcher.
 *
 * WHY THIS TEST EXISTS:
 * It runs on every frame while the label camera is open, so it must report a
 * code only once it is read reliably (twice in a row, checksum-valid), only
 * once per opening, and stop the moment the camera closes — a watcher that
 * kept polling, or fired on a one-frame misread, would jump the user to the
 * wrong wine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useBarcodeWatch from './useBarcodeWatch';

const video = { readyState: 4, videoWidth: 1280, videoHeight: 720 };
const videoRef = { current: video };

let reads;
beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  window.BarcodeDetector = class {
    static getSupportedFormats() { return Promise.resolve(['ean_13', 'qr_code']); }
    detect() { const next = reads.shift(); return Promise.resolve(next ? [{ rawValue: next }] : []); }
  };
});
afterEach(() => {
  vi.useRealTimers();
  delete window.BarcodeDetector;
});

const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('useBarcodeWatch', () => {
  it('reports a valid code once it has been read in two consecutive frames', async () => {
    reads = ['4006381333931', '4006381333931', '4006381333931'];
    const onDetect = vi.fn();
    renderHook(() => useBarcodeWatch(videoRef, { active: true, onDetect }));

    await advance(500);
    expect(onDetect).not.toHaveBeenCalled(); // one frame is not enough
    await advance(500);
    expect(onDetect).toHaveBeenCalledWith('4006381333931');
    await advance(2000);
    expect(onDetect).toHaveBeenCalledTimes(1); // once per opening
  });

  it('ignores a misread and a code that changes between frames', async () => {
    reads = ['4006381333932', '4006381333932', '4006381333931', '0036000291452', '036000291452'];
    const onDetect = vi.fn();
    renderHook(() => useBarcodeWatch(videoRef, { active: true, onDetect }));
    await advance(450 * 6);
    // UPC-A read as 12 digits then 13: both normalise to the same EAN-13.
    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(onDetect).toHaveBeenCalledWith('0036000291452');
  });

  it('does nothing while inactive and stops when the camera closes', async () => {
    reads = ['4006381333931', '4006381333931'];
    const onDetect = vi.fn();
    const { rerender } = renderHook(({ active }) => useBarcodeWatch(videoRef, { active, onDetect }), { initialProps: { active: false } });
    await advance(2000);
    expect(onDetect).not.toHaveBeenCalled();
    expect(reads).toHaveLength(2); // never polled

    rerender({ active: true });
    await advance(500);
    rerender({ active: false });
    await advance(2000);
    expect(onDetect).not.toHaveBeenCalled();
  });
});

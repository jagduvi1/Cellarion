import io
import os
import threading
import numpy as np
import onnxruntime as ort
from flask import Flask, request, send_file, jsonify
from rembg import remove
from rembg.sessions.u2net import U2netSession
from PIL import Image

# Defense-in-depth against decompression-bomb images: cap decoded pixels so a
# small compressed payload can't expand to hundreds of millions of pixels and
# exhaust memory / tie up this single-worker service. ~8000x8000 matches the
# backend's MAX_PIXELS. PIL raises DecompressionBombError above 2x this, caught
# by the handler below and returned as an error rather than crashing the worker.
Image.MAX_IMAGE_PIXELS = 64_000_000

app = Flask(__name__)

# One u2net session for the life of the worker. Given no session, rembg's
# remove() builds a fresh ONNX Runtime session on every call, and of its own
# default model (bria-rmbg), which the image does not carry. It is built on the
# first photo, never at import, so /health still answers while the model
# cannot be read, and a failed build is not kept, so the next photo tries
# again. The lock only guards the build, for a gunicorn started with --threads;
# ONNX Runtime allows concurrent run() calls on one session.
_session = None
_session_lock = threading.Lock()


def _build_session():
    # The options rembg's new_session('u2net') uses, minus ONNX Runtime's CPU
    # memory arena: a kept session would hold the arena's peak (~500 MB) for
    # good, leaving the worker at ~1.37 GiB of its 1536M cap. Without it each
    # run frees its working memory, and the output is the same.
    opts = ort.SessionOptions()
    opts.enable_cpu_mem_arena = False
    if 'OMP_NUM_THREADS' in os.environ:
        threads = int(os.environ['OMP_NUM_THREADS'])
        opts.inter_op_num_threads = threads
        opts.intra_op_num_threads = threads
    return U2netSession('u2net', opts)


def get_session():
    global _session
    if _session is None:
        with _session_lock:
            if _session is None:
                _session = _build_session()
    return _session


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"})


@app.route('/remove-bg', methods=['POST'])
def remove_bg():
    if 'image' not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    input_file = request.files['image']
    input_bytes = input_file.read()

    try:
        # Check if the image already has a transparent background.
        # If >5% of pixels are already transparent, skip rembg and use as-is.
        pre = Image.open(io.BytesIO(input_bytes)).convert("RGBA")
        pre_alpha = np.array(pre)[:, :, 3]
        already_transparent = (pre_alpha < 10).mean() > 0.05

        if already_transparent:
            output_bytes = input_bytes
        else:
            output_bytes = remove(input_bytes, session=get_session())

        # Auto-crop transparent borders so the bottle fills the image.
        # Use a numpy alpha-threshold (>10) to ignore the near-invisible fringe
        # pixels that rembg leaves at the original image edges — these inflate
        # PIL's getbbox() to nearly full-image dimensions.
        img = Image.open(io.BytesIO(output_bytes)).convert("RGBA")
        arr = np.array(img)
        alpha = arr[:, :, 3]
        mask = alpha > 10
        rows = np.any(mask, axis=1)
        cols = np.any(mask, axis=0)

        if rows.any():
            rmin, rmax = np.where(rows)[0][[0, -1]]
            cmin, cmax = np.where(cols)[0][[0, -1]]
            cropped = img.crop((cmin, rmin, cmax + 1, rmax + 1))

            # Add 12% padding around the tight crop so the subject fills
            # ~88% of the canvas in both dimensions regardless of aspect ratio.
            # No fixed minimum — the subject itself dictates the canvas size,
            # ensuring wide and tall subjects both appear large in the card.
            pad_x = int(cropped.width * 0.12)
            pad_y = int(cropped.height * 0.12)
            out_w = cropped.width + 2 * pad_x
            out_h = cropped.height + 2 * pad_y

            canvas = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
            paste_x = (out_w - cropped.width) // 2
            paste_y = (out_h - cropped.height) // 2
            canvas.paste(cropped, (paste_x, paste_y))

            buf = io.BytesIO()
            canvas.save(buf, format='PNG')
            buf.seek(0)
            return send_file(buf, mimetype='image/png', download_name='output.png')

        return send_file(
            io.BytesIO(output_bytes),
            mimetype='image/png',
            download_name='output.png'
        )
    except Exception as err:
        # Say why in the log: a bare 500 hid a model the runtime user could
        # not read (2026-10-20). The error only, never the image.
        app.logger.error("remove-bg failed: %s: %s", type(err).__name__, str(err)[:300])
        return jsonify({"error": "Image processing failed"}), 500

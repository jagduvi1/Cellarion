import io
import numpy as np
from flask import Flask, request, send_file, jsonify
from rembg import remove
from PIL import Image

app = Flask(__name__)


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
        output_bytes = remove(input_bytes)

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

            # Add 5% padding around the tight crop
            pad_x = int(cropped.width * 0.05)
            pad_y = int(cropped.height * 0.05)
            out_w = cropped.width + 2 * pad_x
            out_h = cropped.height + 2 * pad_y

            # Enforce a minimum canvas (300×600) so bottles always render
            # at a decent size regardless of how far away the photo was taken
            out_w = max(out_w, 300)
            out_h = max(out_h, 600)

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
    except Exception as e:
        return jsonify({"error": str(e)}), 500

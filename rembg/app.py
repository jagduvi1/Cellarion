import io
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

        # Auto-crop transparent borders so the bottle fills the image
        img = Image.open(io.BytesIO(output_bytes)).convert("RGBA")
        bbox = img.getbbox()  # bounding box of non-transparent pixels
        if bbox:
            cropped = img.crop(bbox)
            # Add 5% padding on each side
            pad_x = int(cropped.width * 0.05)
            pad_y = int(cropped.height * 0.05)
            padded = Image.new("RGBA",
                (cropped.width + 2 * pad_x, cropped.height + 2 * pad_y),
                (0, 0, 0, 0))
            padded.paste(cropped, (pad_x, pad_y))
            buf = io.BytesIO()
            padded.save(buf, format='PNG')
            buf.seek(0)
            return send_file(buf, mimetype='image/png', download_name='output.png')

        return send_file(
            io.BytesIO(output_bytes),
            mimetype='image/png',
            download_name='output.png'
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

FROM python:3.11-slim

WORKDIR /app

# Install system deps for Pillow and curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the u2net model so container startup is fast
RUN python -c "from rembg import new_session; new_session('u2net')"

COPY app.py .

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--timeout", "120", "--workers", "1", "app:app"]

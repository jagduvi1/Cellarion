# Digest-pinned (security audit L-11); Dependabot's docker ecosystem bumps it.
FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93

WORKDIR /app

# Install system deps for Pillow and curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user. rembg decodes untrusted user images (Pillow), so a
# decoder RCE must not land as root in-container. gunicorn binds :5000 (a
# non-privileged port), so no extra capability is needed.
RUN useradd --create-home --uid 10001 appuser
ENV U2NET_HOME=/home/appuser/.u2net

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the u2net model so container startup is fast. Land it in the
# non-root user's model dir (U2NET_HOME) so it is readable at runtime.
RUN mkdir -p $U2NET_HOME && python -c "from rembg import new_session; new_session('u2net')"

COPY app.py .

# Hand /app and the model cache to the runtime user, then drop privileges.
RUN chown -R appuser:appuser /app $U2NET_HOME
USER appuser

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--timeout", "120", "--workers", "1", "app:app"]

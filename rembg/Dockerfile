# Digest-pinned (security audit L-11); Dependabot's docker ecosystem bumps it.
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170

WORKDIR /app

# Install system deps for Pillow and curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user. rembg decodes untrusted user images (Pillow), so a
# decoder RCE must not land as root in-container. gunicorn binds :5000 (a
# non-privileged port), so no extra capability is needed.
RUN useradd --create-home --uid 10001 appuser
# The model lives outside any home directory, readable by every user, so the
# image also runs under a uid it was not built for (a NAS app platform runs
# each container as its own user — TrueNAS uses 568). It used to sit in
# /home/appuser (mode 0700): any other user could not read it, rembg tried to
# download it again, and every background removal failed (tested 2026-10-20).
ENV U2NET_HOME=/opt/u2net

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the u2net model so container startup is fast.
RUN mkdir -p $U2NET_HOME && python -c "from rembg import new_session; new_session('u2net')" \
 && chmod -R a+rX $U2NET_HOME

COPY app.py .

# What the runtime writes goes to /tmp, writable whatever the uid: numba's JIT
# cache (pymatting) and gunicorn's control socket, which lives under HOME.
# appuser stays the default user, so `docker run` and the compose file run it
# exactly as before.
ENV NUMBA_CACHE_DIR=/tmp/numba-cache \
    HOME=/tmp

# Hand /app to the runtime user, then drop privileges.
RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--timeout", "120", "--workers", "1", "app:app"]

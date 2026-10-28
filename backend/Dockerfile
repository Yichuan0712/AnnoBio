# One of these runs per invited researcher (see hub/containers.py), each with its own named
# volume at /app/backend/data — the same data/ layout as the desktop app, just container-per-
# user instead of process-per-desktop-install. Never expose this image's port directly to the
# internet; it has no auth of its own (see Phase 2 note in the plan) and is meant to be reached
# only through the Hub's authenticated reverse proxy on the shared Docker network.
FROM python:3.12-slim

WORKDIR /app/backend

# Hosted workspaces offer online database APIs; large downloadable snapshots are desktop-only.
ENV ANNOBIO_ENABLE_DATA_LAKE=0

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    # textgrad is deliberately not in requirements.txt (see its comment there) — installed the
    # same reduced-dependency way the desktop setup documents.
    && pip install --no-cache-dir --no-deps textgrad==0.1.8 \
    && pip install --no-cache-dir platformdirs diskcache

COPY . .
RUN chmod +x entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

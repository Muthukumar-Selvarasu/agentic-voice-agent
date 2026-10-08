FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY livekit/requirements.txt livekit/requirements.txt
COPY livekit/package.json livekit/package-lock.json livekit/
RUN pip install --no-cache-dir -r livekit/requirements.txt \
    && npm --prefix livekit ci --omit=dev

COPY pipeline pipeline
COPY knowledge knowledge
COPY livekit livekit

ENV TELEMETRY_INCLUDE_CONTENT=false
ENV TTS_BACKEND=provider

CMD ["python", "livekit/talk_server.py"]

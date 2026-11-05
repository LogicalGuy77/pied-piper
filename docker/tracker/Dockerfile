# The tracker, plus iproute2 so the test can add Wi-Fi delay to its link.
# The repo is mounted at /app, so no code is copied into the image.
FROM node:22.23.2-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

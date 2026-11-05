# A mock phone: headless Chromium behind a Playwright browser server. The test
# script on the host connects to it and opens the swarm page inside the
# container, so the page's traffic leaves from this container's own IP.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iputils-ping && rm -rf /var/lib/apt/lists/*
WORKDIR /phone
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.56.1
EXPOSE 3000
CMD ["npx", "playwright", "run-server", "--port", "3000", "--host", "0.0.0.0"]

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb xauth ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /test
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY test.mjs ./
ENV DISPLAY=:99
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp & sleep 1; exec node test.mjs"]

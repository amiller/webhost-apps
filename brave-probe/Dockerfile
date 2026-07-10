# Real Brave (not chromium) + Playwright driver. Deploy via runtime=image.
FROM mirror.gcr.io/library/node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg fonts-liberation \
 && curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
      https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" \
      > /etc/apt/sources.list.d/brave-browser-release.list \
 && apt-get update && apt-get install -y --no-install-recommends brave-browser \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null 2>&1 && npm i playwright@1.49.0 >/dev/null 2>&1
COPY server.mjs ./
ENV PROBE_SECRET="" BRAVE_PATH=/usr/bin/brave-browser PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]

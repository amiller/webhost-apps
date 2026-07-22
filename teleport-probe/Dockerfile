# Playwright image ships chromium + deps. If docker build can't reach mcr,
# repoint FROM to a mirror (see deploy.sh note). Pin matches installed playwright.
FROM mcr.microsoft.com/playwright:v1.49.0-noble
WORKDIR /app
RUN npm init -y >/dev/null 2>&1 && npm i playwright@1.49.0 >/dev/null 2>&1
COPY probe-core.mjs server.mjs ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]

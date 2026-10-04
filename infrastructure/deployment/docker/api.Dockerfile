FROM node:24-bookworm-slim AS node
FROM python:3.13-slim-bookworm AS runtime
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/apps/api PLAYWRIGHT_BROWSERS_PATH=/ms-playwright ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY scripts/assistant-design-check.ts ./scripts/assistant-design-check.ts
COPY apps/web/package.json ./apps/web/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/mcp-server/package.json ./apps/mcp-server/package.json
RUN npm ci --ignore-scripts && node node_modules/playwright/cli.js install --with-deps chromium && chmod -R a+rX /ms-playwright && npm cache clean --force
COPY apps/api/requirements.txt ./apps/api/requirements.txt
RUN pip install --no-cache-dir -r apps/api/requirements.txt
COPY apps/api/deckastra_api ./apps/api/deckastra_api
COPY agents ./agents
COPY integrations ./integrations
COPY infrastructure/database ./infrastructure/database
COPY infrastructure/deployment/verify_database.py ./infrastructure/deployment/verify_database.py
RUN useradd --uid 10001 --create-home deckastra && mkdir /tmp/deckastra && chown deckastra:deckastra /tmp/deckastra
USER deckastra
ENV HOME=/home/deckastra DECKASTRA_EXPORT_DIR=/tmp/deckastra
EXPOSE 8080
CMD ["python", "-m", "deckastra_api.cloud_entrypoint"]

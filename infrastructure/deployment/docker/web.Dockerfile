FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.base.json ./
COPY infrastructure/deployment/public-auth.json ./infrastructure/deployment/public-auth.json
COPY packages ./packages
COPY apps ./apps
RUN npm ci --ignore-scripts
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DECKASTRA_CLOUD
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_PUBLIC_DECKASTRA_CLOUD=${NEXT_PUBLIC_DECKASTRA_CLOUD}
RUN node -e 'const c=require("./infrastructure/deployment/public-auth.json")[process.env.NEXT_PUBLIC_DECKASTRA_CLOUD]; if(!c || c.apiUrl !== process.env.NEXT_PUBLIC_API_URL) throw new Error("Web build requires matching cloud project and API URL")'
RUN npm run build --workspace @deckastra/web
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
USER node
EXPOSE 8080
CMD ["sh", "-c", "node node_modules/next/dist/bin/next start apps/web --hostname 0.0.0.0 --port ${PORT:-8080}"]

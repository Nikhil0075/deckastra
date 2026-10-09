FROM golang:1.24.8-bookworm AS build
RUN git clone --depth 1 --branch RELEASE.2025-10-15T17-29-55Z https://github.com/minio/minio.git /src/minio \
    && cd /src/minio && go build -trimpath -o /out/minio .
RUN git clone --depth 1 --branch RELEASE.2025-08-13T08-35-41Z https://github.com/minio/mc.git /src/mc \
    && cd /src/mc && go build -trimpath -o /out/mc .

FROM debian:bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/minio /out/mc /usr/local/bin/
COPY --from=build /src/minio/LICENSE /usr/share/doc/minio/LICENSE
COPY --from=build /src/mc/LICENSE /usr/share/doc/mc/LICENSE

FROM base AS server
ENTRYPOINT ["minio"]
CMD ["server", "/data"]

FROM base AS client
ENTRYPOINT ["mc"]

# ngdpbase with the accounting add-on: the wrapper image of ngdpbase's add-on guide
# (docs/guides/addons-developer-guide.md, section 12). One image for Docker and Kubernetes.
#
#   docker build -f deploy/Dockerfile -t ngdp-accounting:dev .
#
# The add-on is TypeScript; the runtime image has no npm, so it is compiled in a
# build stage against the same ngdpbase it will run on, then copied to
# /app/addons/accounting, where the default addons-path (./addons) finds it and
# its imports (../../dist/..., express) resolve to ngdpbase's own copies.

# renovate: datasource=docker depName=ghcr.io/jwilleke/ngdpbase
ARG NGDPBASE_VERSION=5.8.0

FROM ghcr.io/jwilleke/ngdpbase:${NGDPBASE_VERSION} AS ngdpbase

FROM node:24-alpine AS build
WORKDIR /build
COPY --from=ngdpbase /app/dist ./dist
COPY --from=ngdpbase /app/node_modules ./node_modules
COPY addons/accounting/package.json addons/accounting/package-lock.json addons/accounting/
RUN cd addons/accounting && npm ci --ignore-scripts
COPY addons/accounting addons/accounting
RUN cd addons/accounting && npx tsc -p tsconfig.json \
 && rm -rf node_modules __tests__ .tsbuildinfo \
 && find . -name '*.ts' -delete && find . -name '*.js.map' -delete

FROM ngdpbase
LABEL org.opencontainers.image.title="ngdp-accounting"
LABEL org.opencontainers.image.source="https://github.com/jwilleke/ngdp-accounting-addons"
COPY --from=build /build/addons/accounting /app/addons/accounting
WORKDIR /app

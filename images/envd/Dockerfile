# E2B's envd, built unmodified from a pinned upstream commit. Apache-2.0: the
# license ships next to the binary.
ARG ENVD_VERSION=envd-v0.6.13
ARG ENVD_COMMIT=2acf2d51bd1e2fe146914f24c44f7ee07d2213c5

FROM golang:1.27.4 AS builder
ARG ENVD_VERSION
ARG ENVD_COMMIT
RUN git clone -q --depth 1 --branch "${ENVD_VERSION}" https://github.com/e2b-dev/runtime.git /src/runtime \
 && cd /src/runtime \
 && test "$(git rev-parse HEAD)" = "${ENVD_COMMIT}" || (echo "envd tag ${ENVD_VERSION} is not commit ${ENVD_COMMIT}" >&2; exit 1)
WORKDIR /src/runtime/packages/envd
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOWORK=off GOTOOLCHAIN=auto \
    go build -ldflags="-s -w" -trimpath -o /out/envd . \
 && cp /src/runtime/LICENSE /out/LICENSE

FROM scratch
COPY --from=builder /out/envd /envd
COPY --from=builder /out/LICENSE /LICENSE

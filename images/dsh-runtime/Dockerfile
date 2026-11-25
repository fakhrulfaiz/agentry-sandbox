# DeepSeek Harness's remote helper (the `dsh-ssh` helper, node-script launch) and
# its PTC worker, with a Node runtime, installed unmodified from npm under
# /opt/agentry/dsh. The service injects this tree into every sandbox, like envd,
# so the Agentry API can run DSH's own remote file, process, terminal and
# run_code providers against any glibc image.
ARG DSH_VERSION=0.2.2-rc.1
ARG NODE_VERSION=24.21.0

FROM debian:bookworm-slim AS builder
ARG TARGETARCH
ARG DSH_VERSION
ARG NODE_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3 make g++ \
 && apt-get clean
# TARGETARCH is amd64 or arm64; Node names them x64 and arm64.
RUN NODE_ARCH=$([ "${TARGETARCH}" = "arm64" ] && echo arm64 || echo x64) \
 && mkdir -p /opt/agentry/dsh \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    | tar -xJ -C /tmp \
 && mv "/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}" /tmp/node \
 && cp /tmp/node/bin/node /opt/agentry/dsh/node \
 && cp /tmp/node/LICENSE /opt/agentry/dsh/NODE-LICENSE
ENV PATH=/tmp/node/bin:$PATH
WORKDIR /opt/agentry/dsh
RUN printf '{"name":"agentry-dsh-runtime","private":true,"type":"module"}\n' > package.json \
 && npm install --no-audit --no-fund --omit=dev --foreground-scripts \
      "@deepseek-ai/dsh-ssh@${DSH_VERSION}" "@deepseek-ai/dsh-ptc-runtime-node@${DSH_VERSION}" \
 && (npm rebuild --foreground-scripts node-pty koffi @deepseek-ai/dsh-subprocess-local || true) \
 && ./node -e "require('node-pty'); console.log('node-pty ok')"
RUN H=node_modules/@deepseek-ai/dsh-ssh/lib/helper.js B=node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js \
 && test -f "$H" && test -f "$B" \
 && printf '{"version":"%s","node":"/opt/agentry/dsh/node","helper":"/opt/agentry/dsh/%s","helperHash":"%s","bootstrapPath":"/opt/agentry/dsh/%s","bootstrapHash":"%s"}\n' \
      "${DSH_VERSION}" "$H" "$(sha256sum "$H" | cut -d' ' -f1)" "$B" "$(sha256sum "$B" | cut -d' ' -f1)" > manifest.json \
 && cat manifest.json \
 && chmod -R a+rX,go-w /opt/agentry/dsh

FROM scratch
COPY --from=builder /opt/agentry/dsh /opt/agentry/dsh

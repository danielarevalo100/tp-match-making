# syntax=docker/dockerfile:1

FROM node:24-trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl unzip python3 python3-venv make g++ libev-dev

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

RUN python3 -m venv /opt/cqlsh && /opt/cqlsh/bin/pip install --no-cache-dir cqlsh==6.2.2
RUN npm install -g --prefix /opt/mongosh mongosh@2.13.0
RUN curl -fsSL -o /tmp/cypher-shell.zip https://dist.neo4j.org/cypher-shell/cypher-shell-5.26.32.zip \
  && unzip -q /tmp/cypher-shell.zip -d /tmp/cypher-shell \
  && mv /tmp/cypher-shell/cypher-shell-5.26.32 /opt/cypher-shell

FROM node:24-trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 libev4 redis-tools openjdk-21-jre-headless

COPY --from=build /opt/cqlsh /opt/cqlsh
COPY --from=build /opt/mongosh /opt/mongosh
COPY --from=build /opt/cypher-shell /opt/cypher-shell
ENV PATH=/opt/cqlsh/bin:/opt/mongosh/bin:/opt/cypher-shell/bin:$PATH
ENV LANG=C.UTF-8
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
ENV HOME=/home/node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/main.mjs"]

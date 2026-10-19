FROM docker:26.1.4-cli AS docker-cli
FROM node:20.15.1-bookworm-slim
# Debian bookworm's docker.io CLI predates --mount volume-subpath.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/templates ./templates
COPY backend/scripts/copy-templates.mjs ./scripts/copy-templates.mjs
COPY backend/migrations ./migrations
COPY backend/docker-entrypoint.sh ./docker-entrypoint.sh
RUN npm run build && chmod +x ./docker-entrypoint.sh
RUN mkdir -p dist/migrations && cp migrations/001_initial.sql dist/migrations/001_initial.sql
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]

FROM node:20.15.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY backend/docker-entrypoint.sh ./docker-entrypoint.sh
RUN npm run build && chmod +x ./docker-entrypoint.sh
RUN mkdir -p dist/migrations && cp migrations/001_initial.sql dist/migrations/001_initial.sql
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]

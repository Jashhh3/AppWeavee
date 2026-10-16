FROM node:20-bookworm-slim AS backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build
FROM node:20-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
FROM nginx:1.27-alpine
COPY --from=frontend /app/frontend/dist /usr/share/nginx/html
EXPOSE 80

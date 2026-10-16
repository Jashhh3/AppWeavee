FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json .nvmrc .env.example ./
COPY src ./src
COPY tests ./tests
RUN npm run build
EXPOSE 3000
CMD ["npm","start"]

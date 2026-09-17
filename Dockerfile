# Ripcord — tek konteyner: supervisor → anchor (child) + cüzdan (child)
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Cüzdan bundle'ı (Stellar Wallets Kit) imaj kurulurken derlenir
RUN npm run build:wallets && npm prune --omit=dev
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 ANCHOR_PORT=4200
EXPOSE 8080
CMD ["node", "src/supervisor.js"]

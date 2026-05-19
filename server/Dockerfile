# NovaCentral API — Node 20 (production)
FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 5000

# Railway and other platforms inject PORT; default matches server.js
ENV PORT=5000

CMD ["node", "--expose-gc", "--max-old-space-size=1024", "src/server.js"]

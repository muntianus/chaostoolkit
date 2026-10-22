FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4060

COPY package.json ./
COPY index.js ./index.js
COPY src ./src
COPY experiments ./experiments
COPY demo ./demo

EXPOSE 4060

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4060/health || exit 1

USER node

CMD ["node", "src/server.js"]

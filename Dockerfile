# Dockerfile for Vibbit Managed Backend

FROM node:20-alpine
WORKDIR /app

COPY apps/backend/package*.json apps/backend/
RUN cd apps/backend && npm install --omit=dev

COPY package.json /app/package.json
COPY apps/backend/ ./apps/backend/
COPY shared/ ./shared/
COPY work.js /app/work.js

EXPOSE 8787
ENV PORT=8787
ENV NODE_ENV=production

CMD ["node", "apps/backend/src/server.mjs"]

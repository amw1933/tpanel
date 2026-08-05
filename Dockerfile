FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY lib ./lib
COPY server ./server
COPY agent ./agent
COPY web ./web

ENV NODE_ENV=production
EXPOSE 8080 9000 8090
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]

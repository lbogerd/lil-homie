FROM node:22.23.1-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY server.js ./
COPY public ./public
USER node
ENV NODE_ENV=production PORT=3000 BIND_HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]

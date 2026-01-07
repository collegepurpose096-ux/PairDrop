FROM node:20-alpine

WORKDIR /home/node/app

# Install wget for healthcheck
RUN apk add --no-cache wget

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV WS_FALLBACK=false
ENV RTC_CONFIG='{"sdpSemantics":"unified-plan","iceServers":[]}'

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000 || exit 1

CMD ["npm", "start"]

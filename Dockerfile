FROM node:20-alpine
WORKDIR /app

# ffmpeg is used to normalize uploaded audio to 8kHz mono WAV
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]

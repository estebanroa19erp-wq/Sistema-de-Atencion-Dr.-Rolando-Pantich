FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY bot/package*.json ./
RUN npm ci
COPY bot/ .
RUN mkdir -p /data
EXPOSE 3850
CMD ["node", "rolo-bot.js"]

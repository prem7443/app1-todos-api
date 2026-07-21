FROM node:22-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npx prisma generate
RUN addgroup --system app && adduser --system --ingroup app app
USER app
EXPOSE 3001
CMD ["node", "src/index.js"]

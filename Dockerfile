FROM node:22-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN npm install
COPY . .
RUN npm run build
CMD ["node", "dist/index.js"]

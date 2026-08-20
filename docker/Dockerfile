FROM mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:af843e6c2a9ad4df5daa8a68268fb59d28ab5ef55203f67c1573e4d0e154e176

ENV STW_DATA_DIR=/data
ENV STW_HOST=0.0.0.0
ENV STW_PORT=8098
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY bridge ./bridge
RUN npm ci --omit=dev
EXPOSE 8098
CMD ["node", "--experimental-strip-types", "--experimental-sqlite", "/app/bridge/src/main.ts"]

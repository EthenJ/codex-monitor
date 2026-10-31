FROM node:24-bookworm-slim
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci && npm install -g @openai/codex@0.166.0
COPY tsconfig.json ./
COPY src ./src
COPY tests/node ./tests/node
RUN npm run build
ENV CODEX_MONITOR_TEST_NATIVE=1
# Run with --network none. The fixture provider uses only container loopback.
CMD ["node", "--test", "--test-timeout=25000", "tests/node/network.test.mjs"]

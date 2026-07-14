# Allarop — körs via tsx (ingen separat build). Node 22 har inbyggd fetch.
# Debian-bas (glibc) krävs för cloakbrowser:s stealth-Chromium (Alpine/musl funkar ej).
FROM node:22-bookworm-slim

# Chromium-runtime-beroenden för cloakbrowser (stealth-browser för Cloudflare-/bot-
# skyddade hus, t.ex. Blinto — Node-fetch och curl fingeravtrycks och blockas).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation fonts-noto-color-emoji \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libx11-6 libxcb1 \
      libxext6 libxi6 libxtst6 libxshmfence1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installera beroenden INKL optional (cloakbrowser). Ladda sedan ned stealth-
# Chromium vid build så imagen är självförsörjande (annars sker det vid första pollen).
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
ENV CLOAKBROWSER_CACHE=/app/.cloakbrowser
RUN node -e "import('cloakbrowser').then(m=>m.ensureBinary()).then(()=>console.log('chromium ready')).catch(e=>{console.error(e);process.exit(1)})"

# Källkod (schema.sql ligger under src/db och kopieras med).
COPY tsconfig.json ./
COPY src ./src
COPY web ./web

# Bilder speglas hit; montera en volym på /app/data i compose.
RUN mkdir -p /app/data/images
ENV IMAGE_DIR=/app/data/images

# Entrypoint = CLI; compose väljer subkommando (poll/api/db-init/ingest-once).
ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
CMD ["poll"]

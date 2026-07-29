# Chromium isolé dans sa propre image, comme runner/ — jamais dans l'image
# Django (cf. CLAUDE.md, contrainte 2 vCPU/16 Go). Image officielle Playwright :
# Node + navigateurs déjà installés, aucun `playwright install` au build.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js session.js capture-script.js ./

EXPOSE 4300
CMD ["node", "server.js"]

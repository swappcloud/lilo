FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium chromium-sandbox pulseaudio-utils python3 python3-gi python3-gi-cairo gir1.2-webkit2-4.1 \
    xvfb xauth xdotool dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/lilo/packages/daemon-browser-host
COPY packages/daemon-browser-host/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY packages/daemon-browser-host/src ./src
COPY .tmp/daemon-voice/voice.js ./voice.js
COPY packages/phone-login/driver.js /opt/lilo/packages/phone-login/driver.js
COPY packages/phone-login/observer.js /opt/lilo/packages/phone-login/observer.js
USER node
ENV LILO_BROWSER_DATA_DIR=/data LILO_BROWSER_BIND=0.0.0.0 LILO_BROWSER_PORT=8790 LILO_BROWSER_TOKEN_FILE=/run/lilo/browser-token
CMD ["node", "src/server.mjs"]

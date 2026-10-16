FROM apify/actor-node:20

COPY package*.json ./
RUN npm --quiet set progress=false \
  && npm install --omit=dev --no-audit --no-fund \
  && npm install --no-save --no-audit --no-fund apify@3

COPY . ./

CMD ["node", "actor.js"]

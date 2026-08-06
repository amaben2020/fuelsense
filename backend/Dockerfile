FROM node:20-alpine

WORKDIR /app

# Dev dependencies are NOT omitted on purpose: the server runs through `tsx`,
# which is a devDependency. `npm install --omit=dev` deletes the very binary the
# container starts with, so the image builds fine and then fails at run time —
# the same trap documented in README-EC2-SIMPLE.md for the EC2 host.
COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

EXPOSE 5027 5001

# `npm start` runs dist/server.js, which nothing in this image ever builds.
# Running the TypeScript entrypoint directly matches how the EC2 systemd unit
# starts it, so the container and the server behave identically.
CMD ["node_modules/.bin/tsx", "src/server.ts"]

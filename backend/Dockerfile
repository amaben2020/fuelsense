FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 5027 5001

CMD ["npm", "start"]

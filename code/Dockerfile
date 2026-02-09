FROM node:18-slim

WORKDIR /app

# Copiar package.json e instalar dependências
COPY package.json ./
RUN npm install --production

# Copiar código
COPY . .

EXPOSE 3000

CMD ["node", "src/server.js"]

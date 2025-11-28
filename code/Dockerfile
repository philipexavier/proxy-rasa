FROM node:18-slim

WORKDIR /app

# Instalar dependências essenciais
RUN apt-get update && apt-get install -y \
    bash curl git && \
    rm -rf /var/lib/apt/lists/*

# Copiar package.json e instalar dependências
COPY package.json ./
RUN npm install --production

# Copiar código
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]

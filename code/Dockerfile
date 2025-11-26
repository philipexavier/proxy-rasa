FROM node:18

WORKDIR /app

# Copia primeiro o package.json para cache de dependências
COPY package*.json ./

# Instala dependências
RUN npm install

# Copia todo o código
COPY . .

# Porta interna — NÃO mexer
EXPOSE 3000

# Start
CMD ["node", "index.js"]

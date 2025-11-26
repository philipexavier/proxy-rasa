# Rasa OpenAI Proxy

Proxy compatível com a API de Chat Completions da OpenAI.
Permite que o Chatwoot Captain use Rasa como LLM.

## Estrutura

code/ → usados na build do Docker e na execução  
tests/ → scripts para testar o endpoint localmente

## Rodar local

cd code  
npm install  
node index.js

Endpoint:  
POST http://localhost:3000/v1/chat/completions

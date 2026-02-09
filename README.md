# Proxy OpenAI-compatible para Jurema 7B

Proxy HTTP compatível com o endpoint `POST /v1/chat/completions` da API OpenAI, traduzindo mensagens para o formato esperado por um modelo local (ex.: Jurema 7B) e retornando a resposta no formato OpenAI.

## Recursos

- ✅ Compatível com OpenAI Chat Completions
- ✅ Conversão automática de `messages` para prompt ChatML
- ✅ Timeout configurável
- ✅ Streaming simples (SSE)
- ✅ Logging estruturado (Pino)
- ✅ Middleware de API Key (Authorization: Bearer)

## Estrutura

```
code/
  src/
    server.js
    routes/chat.js
    services/llm.js
    utils/prompt.js
    middleware/auth.js
  Dockerfile
  package.json
```

## Variáveis de ambiente

| Variável | Descrição | Default |
| --- | --- | --- |
| `LLM_URL` | URL do endpoint local de geração (ex.: `http://local-llm:8000/generate`) | `http://local-llm:8000/generate` |
| `LLM_MODEL` | Nome do modelo padrão | `jurema-7b` |
| `API_KEY` | API Key para autenticação via header `Authorization: Bearer` | vazio (desabilitado) |
| `PORT` | Porta do servidor | `3000` |
| `LLM_TIMEOUT_MS` | Timeout do request ao LLM em ms | `30000` |
| `LOG_LEVEL` | Nível de log do Pino | `info` |

## Execução local

```bash
cd code
npm install
npm start
```

Endpoint:
```
POST http://localhost:3000/v1/chat/completions
```

## Exemplo de requisição

```json
{
  "model": "jurema-7b",
  "messages": [
    {"role": "system", "content": "Você é um assistente útil."},
    {"role": "user", "content": "Explique o que é Rasa."}
  ],
  "temperature": 0.7,
  "max_tokens": 512,
  "stream": false
}
```

## docker-compose (exemplo)

Veja `docker-compose.example.yml` na raiz do projeto para referência.

## Prompt para Jurema 7B

Se o template exato do modelo não for conhecido, o proxy usa ChatML genérico (compatível com Llama-like):

```
<|system|>
Você é um assistente útil.
<|user|>
Pergunta
<|assistant|>
```

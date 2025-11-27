import express from 'express';
import fetch from 'node-fetch';
import { validateOpenAIRequest } from './validator.js';
import { normalizeRasaResponse } from './adapters/rasa-to-captain.js';

const app = express();
app.use(express.json());

const RASA_URL = process.env.RASA_URL || 'http://rede_andrade_rasa-server:5005/webhooks/rest/webhook';
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || null;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DEFAULT_MODEL = 'rasa-proxy';

/* -------------------------------------------------
   Helper que o Captain PRECISA: 
   transforma QUALQUER OBJETO em STRING JSON válida
--------------------------------------------------*/
function asCaptainJSON(obj) {
  try {
    return JSON.stringify(obj || { reasoning: "", response: "" });
  } catch (e) {
    return JSON.stringify({
      reasoning: "",
      response: "Erro ao processar resposta.",
      error: e.message,
    });
  }
}

function joinMessages(messages) {
  return messages
    .map((m) => {
      const role = (m.role || 'user').toLowerCase();
      return `[${role.toUpperCase()}]\n${m.content}`;
    })
    .join('\n\n');
}

function detectOperationFromSystem(systemContent) {
  if (!systemContent) return null;
  const s = systemContent.toLowerCase();
  if (s.includes('summarize')) return 'summarize';
  if (s.includes('rephrase')) return 'rephrase';
  if (s.includes('fix') || s.includes('grammar')) return 'fix_spelling_grammar';
  if (s.includes('shorten')) return 'shorten';
  if (s.includes('expand')) return 'expand';
  if (s.includes('friendly')) return 'make_friendly';
  if (s.includes('formal')) return 'make_formal';
  if (s.includes('simplify')) return 'simplify';
  if (s.includes('reply')) return 'reply_suggestion';
  if (s.includes('label')) return 'label_suggestion';
  return null;
}

function isCaptainRequest(messages) {
  const sys = messages.find((m) => m.role === 'system')?.content || '';
  return sys.includes('[Identity]') && sys.includes('[Task]');
}

function extractiveSummary(text, maxSentences = 3) {
  if (!text) return '';
  text = text.replace(/\r/g, ' ').replace(/\n+/g, ' ').trim();
  const sentences = text.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter((s) => s.trim().length > 20);
  const usable = filtered.length ? filtered : sentences;
  return usable.slice(0, maxSentences).join(' ').trim();
}

async function callLocalLLM(prompt) {
  if (!LOCAL_LLM_URL) return { ok: false };
  try {
    const resp = await fetch(LOCAL_LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!resp.ok) return { ok: false };
    const j = await resp.json();
    return { ok: true, raw: j };
  } catch {
    return { ok: false };
  }
}

async function callRasa(prompt, sender = 'captain') {
  try {
    if (LOCAL_LLM_URL) {
      const local = await callLocalLLM(prompt);
      if (local.ok && local.raw) return { ok: true, raw: local.raw };
    }

    const resp = await fetch(RASA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender, message: prompt }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('Rasa error:', text);
      return { ok: false };
    }

    return { ok: true, raw: await resp.json() };
  } catch (err) {
    console.error('Error calling Rasa:', err);
    return { ok: false };
  }
}

/* -------------------------------------------------
   AQUI é onde corrigimos TUDO
   Sempre devolver string JSON no content
--------------------------------------------------*/
function buildOpenAIResponse(content, model) {
  const safeContent =
    typeof content === 'object'
      ? asCaptainJSON(content)
      : (content?.toString()?.trim() || 'OK');

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: safeContent,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: safeContent.length,
      total_tokens: safeContent.length,
    },
  };
}

/* -------------------------------------------------
   ENDPOINT PRINCIPAL
--------------------------------------------------*/
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const validation = validateOpenAIRequest(req.body);
    if (!validation.ok) {
      return res.status(400).json(validation.error);
    }

    const { messages, model } = req.body;

    // CAPTAIN MODE
    if (isCaptainRequest(messages)) {
      console.log('⚡ Captain request detected');

      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const userText = lastUser?.content || '';

      const rasaResult = await callRasa(userText);
      const raw = rasaResult.ok ? rasaResult.raw : { response: 'Erro ao obter resposta.' };

      const captainPayload = normalizeRasaResponse(raw);

      return res.json(
        buildOpenAIResponse(
          {
            reasoning: captainPayload.reasoning || "",
            response: captainPayload.response || "",
            stop: captainPayload.stop || false,
            sources: captainPayload.sources || null,
          },
          model
        )
      );
    }

    // NORMAL MODE
    const systemMsg = messages.find((m) => m.role === 'system');
    const systemContent = systemMsg?.content || null;
    const operation = detectOperationFromSystem(systemContent);
    const convoText = joinMessages(messages.filter((m) => m.role !== 'system'));

    console.info('Proxy operation:', operation || 'default');

    if (operation === 'summarize') {
      const resp = await callRasa(`OPERATION: summarize\n\n${convoText}`);
      const normalized = resp.ok ? normalizeRasaResponse(resp.raw) : null;

      return res.json(
        buildOpenAIResponse(
          normalized?.response || extractiveSummary(convoText),
          model
        )
      );
    }

    if (operation) {
      const resp = await callRasa(`OPERATION: ${operation}\n\n${convoText}`);
      const normalized = resp.ok ? normalizeRasaResponse(resp.raw) : null;

      return res.json(
        buildOpenAIResponse(
          normalized?.response || convoText,
          model
        )
      );
    }

    // DEFAULT MODE
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastText = lastUser?.content || convoText;

    const rasaResp = await callRasa(lastText);

    const normalized = rasaResp.ok ? normalizeRasaResponse(rasaResp.raw) : null;

    return res.json(
      buildOpenAIResponse(
        normalized?.response || '',
        model
      )
    );

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({
      error: { message: err.message, type: 'internal_error' },
    });
  }
});

app.listen(PORT, () =>
  console.log(`Rasa Proxy listening on port ${PORT}`)
);

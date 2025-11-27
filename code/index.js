import express from 'express';
import fetch from 'node-fetch';
import { validateOpenAIRequest } from './validator.js';
import { normalizeRasaResponse } from './adapters/rasa-to-captain.js';

const app = express();
app.use(express.json());

const RASA_URL = process.env.RASA_URL || 'http://rede_andrade_rasa-server:5005/webhooks/rest/webhook';
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || null; // ex: http://local-llm:5000/generate
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DEFAULT_MODEL = 'rasa-proxy';

// Helpers (mantidos)
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

// Call local LLM (optional)
async function callLocalLLM(prompt) {
  if (!LOCAL_LLM_URL) return { ok: false };
  try {
    const resp = await fetch(LOCAL_LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error('Local LLM error:', resp.status, text);
      return { ok: false };
    }
    const j = await resp.json();
    // assume j has shape { content: "...", ... } or string
    return { ok: true, raw: j };
  } catch (err) {
    console.error('Error calling local LLM:', err);
    return { ok: false };
  }
}

// Call Rasa
async function callRasa(prompt, sender = 'captain') {
  try {
    // Primeiro: se LOCAL_LLM estiver configurado e for apropriado, podemos preferir ele para
    // respostas rápidas/local-first. Aqui opt-in via env var.
    if (LOCAL_LLM_URL) {
      const local = await callLocalLLM(prompt);
      if (local.ok && local.raw) {
        return { ok: true, raw: local.raw };
      }
    }

    const resp = await fetch(RASA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender, message: prompt }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('Rasa error:', resp.status, text);
      return { ok: false };
    }

    const j = await resp.json();
    // Rasa REST webhook normally returns array of messages [{ "recipient_id":..., "text": "..." }, ...]
    // ou if custom action uses dispatcher.utter_message(json_message: obj) -> it might return that object in 'custom' fields.
    return { ok: true, raw: j };
  } catch (err) {
    console.error('Error calling Rasa:', err);
    return { ok: false };
  }
}

function buildOpenAIResponse(textOrObject, model) {
  // if textOrObject is an object we want assistant.content to be that object (captain mode)
  if (typeof textOrObject === 'object' && textOrObject !== null) {
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
            content: textOrObject,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: JSON.stringify(textOrObject).length,
        total_tokens: JSON.stringify(textOrObject).length,
      },
    };
  }

  const text = textOrObject || '';
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
          content: text,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: text.length,
      total_tokens: text.length,
    },
  };
}

// Endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const validation = validateOpenAIRequest(req.body);
    if (!validation.ok) {
      return res.status(400).json(validation.error);
    }

    const { messages, model } = req.body;

    // Captain mode
    if (isCaptainRequest(messages)) {
      console.log('⚡ Captain request detected');

      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const userText = lastUser?.content || '';

      const rasaResult = await callRasa(userText);

      let raw = null;
      if (rasaResult.ok && rasaResult.raw) {
        raw = rasaResult.raw;
      } else {
        raw = { response: 'Desculpe, não consegui obter uma resposta agora.' };
      }

      // Normalize usando adapter
      const captainPayload = normalizeRasaResponse(raw);

      // DO NOT stringify the captainPayload — Chatwoot expects content AS OBJECT
      return res.json(buildOpenAIResponse(captainPayload, model));
    }

    // Normal mode
    const systemMsg = messages.find((m) => m.role === 'system');
    const systemContent = systemMsg?.content || null;
    const operation = detectOperationFromSystem(systemContent);
    const convoText = joinMessages(messages.filter((m) => m.role !== 'system'));

    console.info('Proxy operation:', operation || 'default');

    if (operation === 'summarize') {
      const rasaPrompt = `OPERATION: summarize\n\n${convoText}`;
      const rasaResp = await callRasa(rasaPrompt);

      if (rasaResp.ok && rasaResp.raw) {
        // try normalize -> if object returns response field, otherwise try to join strings
        const normalized = normalizeRasaResponse(rasaResp.raw);
        return res.json(buildOpenAIResponse(normalized.response, model));
      }

      const fallback = extractiveSummary(convoText);
      return res.json(buildOpenAIResponse(fallback, model));
    }

    if (operation && operation !== 'summarize') {
      const rasaPrompt = `OPERATION: ${operation}\n\n${convoText}`;
      const rasaResp = await callRasa(rasaPrompt);

      if (rasaResp.ok && rasaResp.raw) {
        const normalized = normalizeRasaResponse(rasaResp.raw);
        return res.json(buildOpenAIResponse(normalized.response, model));
      }

      return res.json(buildOpenAIResponse(convoText, model));
    }

    // default: last user message
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastText = lastUser?.content || convoText;
    const rasaResp = await callRasa(lastText);

    if (rasaResp.ok && rasaResp.raw) {
      const normalized = normalizeRasaResponse(rasaResp.raw);
      return res.json(buildOpenAIResponse(normalized.response, model));
    }

    return res.json(buildOpenAIResponse('', model));
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({
      error: { message: err.message, type: 'internal_error' },
    });
  }
});

app.listen(PORT, () => console.log(`Rasa Proxy listening on port ${PORT}`));

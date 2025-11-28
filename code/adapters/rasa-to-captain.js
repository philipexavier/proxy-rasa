/**
 * Adapter Rasa → Captain (ESM)
 * Versão FINAL — completa, resiliente e compatível com Captain Assistants + Copilot Threads.
 * Suporta: intents, entities, PT-BR fix, reply_suggestions, label, areas, tags,
 * actions custom, multi-mensagens, e fallback profundo.
 */

function fixPortuguese(text) {
  if (!text) return "";
  return text
    .replace(/\s+/g, " ")
    .replace(/\bcekin\b/gi, "check-in")
    .replace(/\bchekin\b/gi, "check-in")
    .replace(/\bdezembo\b/gi, "dezembro")
    .replace(/\.{2,}/g, ".")
    .trim();
}

// Extrai texto de QUALQUER mensagem Rasa
function extractText(m) {
  if (!m) return null;

  if (typeof m === "string") return m;
  if (typeof m.text === "string") return m.text;
  if (typeof m.message === "string") return m.message;

  // Custom Actions
  if (m.custom) {
    if (typeof m.custom.text === "string") return m.custom.text;
    if (typeof m.custom.message === "string") return m.custom.message;
    return JSON.stringify(m.custom);
  }

  // Rich content
  if (m.buttons || m.image || m.attachment || m.payload) {
    return JSON.stringify({
      buttons: m.buttons,
      image: m.image,
      attachment: m.attachment,
      payload: m.payload
    });
  }

  return null;
}

export function normalizeRasaResponse(rawResp = null) {
  // Caso nulo
  if (!rawResp) {
    return {
      reasoning: "",
      response: "Não consegui processar agora.",
      stop: false
    };
  }

  // ARRAY → rest webhook responses
  if (Array.isArray(rawResp)) {
    const texts = rawResp.map(extractText).filter(Boolean).join("\n\n");

    const intent = rawResp[0]?.intent?.name || null;
    const entities = rawResp.flatMap((m) => m?.entities || []).filter(Boolean);

    return {
      reasoning: "",
      response: fixPortuguese(texts),
      stop: false,
      metadata: {
        intent,
        entities
      }
    };
  }

  // STRING → pode ser JSON
  if (typeof rawResp === "string") {
    const trimmed = rawResp.trim();
    try {
      return normalizeRasaResponse(JSON.parse(trimmed));
    } catch {
      return {
        reasoning: "",
        response: fixPortuguese(trimmed),
        stop: false
      };
    }
  }

  // OBJETO
  if (typeof rawResp === "object") {
    const base =
      rawResp.response ||
      rawResp.output ||
      rawResp.content ||
      rawResp.text ||
      (Array.isArray(rawResp.texts) ? rawResp.texts.join("\n\n") : "") ||
      "";

    const entities =
      rawResp.entities ||
      rawResp.metadata?.entities ||
      [];

    const intent =
      rawResp.intent?.name ||
      rawResp.metadata?.intent ||
      null;

    // reply_suggestions unificados
    const replySuggestions = [];

    if (rawResp.reply_suggestions) replySuggestions.push(...rawResp.reply_suggestions);
    if (rawResp.replySuggestions) replySuggestions.push(...rawResp.replySuggestions);
    if (rawResp.reply_suggestion) replySuggestions.push(rawResp.reply_suggestion);

    // limpa valores undefined
    const finalReplies = replySuggestions.filter(Boolean);

    const final = {
      reasoning: rawResp.reasoning || rawResp.explanation || "",
      response: fixPortuguese(String(base || "")),
      stop: !!rawResp.stop,

      // Captain fields
      reply_suggestions: finalReplies.length ? finalReplies : [],
      label: rawResp.label_suggestion || rawResp.label || null,

      sources: rawResp.sources || rawResp.metadata?.sources || null,

      metadata: {
        intent,
        entities,
        tags: rawResp.tags || rawResp.auto_tags || rawResp.metadata?.tags || null,
        areas: rawResp.areas || rawResp.metadata?.areas || null
      },

      // raw para debug
      raw: rawResp
    };

    return final;
  }

  // fallback final
  return {
    reasoning: "",
    response: fixPortuguese(String(rawResp)),
    stop: false
  };
}

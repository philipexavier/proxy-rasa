/**
 * Adapter Rasa → Captain (ESM)
 * Versão revisada: suporta intents, entities, PT-BR fix, reply_suggestion,
 * reply_suggestions, label_suggestion, metadata, fallback robusto,
 * custom fields das actions e normalização hardening.
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

function extractTextFromMessage(m) {
  if (!m) return null;

  if (typeof m === "string") return m;
  if (typeof m.text === "string") return m.text;
  if (typeof m.message === "string") return m.message;

  // Rasa custom actions
  if (m.custom) {
    if (typeof m.custom.text === "string") return m.custom.text;
    if (typeof m.custom.message === "string") return m.custom.message;
    return JSON.stringify(m.custom);
  }

  // Buttons / images / payloads → stringify
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

export function normalizeRasaResponse(rawResp) {
  if (!rawResp) {
    return {
      reasoning: "",
      response: "Não consegui processar agora.",
      stop: false
    };
  }

  // ARRAY → respostas múltiplas do webhook
  if (Array.isArray(rawResp)) {
    const texts = rawResp
      .map((m) => extractTextFromMessage(m))
      .filter(Boolean)
      .join("\n\n");

    const intent = rawResp[0]?.intent?.name || null;
    const entities = rawResp.flatMap((m) => m?.entities || []).filter(Boolean);

    return {
      reasoning: "",
      response: fixPortuguese(texts),
      stop: false,
      metadata: { intent, entities }
    };
  }

  // STRING (pode ser JSON)
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

    const entities = rawResp.entities || rawResp.metadata?.entities || [];
    const intent = rawResp.intent?.name || rawResp.metadata?.intent || null;

    return {
      reasoning: rawResp.reasoning || rawResp.explanation || "",
      response: fixPortuguese(base.toString()),
      stop: !!rawResp.stop,

      // unified suggestion fields
      reply_suggestion:
        rawResp.reply_suggestion || rawResp.replySuggestions || null,
      reply_suggestions:
        rawResp.reply_suggestions ||
        rawResp.replySuggestions ||
        (rawResp.reply_suggestion ? [rawResp.reply_suggestion] : []),

      label_suggestion: rawResp.label_suggestion || rawResp.label || null,

      sources: rawResp.sources || rawResp.metadata?.sources || null,

      metadata: {
        intent,
        entities,
        tags: rawResp.tags || rawResp.auto_tags || null,
        areas: rawResp.areas || null
      },

      raw: rawResp
    };
  }

  // fallback genérico
  return {
    reasoning: "",
    response: fixPortuguese(String(rawResp)),
    stop: false
  };
}

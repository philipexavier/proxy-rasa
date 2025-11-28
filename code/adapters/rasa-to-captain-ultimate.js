// adapters/rasa-to-captain.js
/**
 * Versão definitiva: intents, entities, PT-BR fix, reply_suggestion,
 * label_suggestion, tags, areas, reasoning, sources e fallback robusto.
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

export function normalizeRasaResponse(rawResp) {
  if (!rawResp) {
    return {
      reasoning: "",
      response: "Não consegui processar agora.",
      stop: false
    };
  }

  // ARRAY → mensagens do Rasa
  if (Array.isArray(rawResp)) {
    const texts = rawResp
      .map((m) => {
        if (!m) return null;
        if (typeof m === "string") return m;
        return m.text || m.message || null;
      })
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

  // STRING → pode ser JSON ou texto puro
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

    return {
      reasoning: rawResp.reasoning || rawResp.explanation || "",
      response: fixPortuguese(base.toString()),
      stop: !!rawResp.stop,
      reply_suggestion: !!rawResp.reply_suggestion,
      label_suggestion: !!rawResp.label_suggestion,
      sources: rawResp.sources || rawResp.metadata?.sources || null,
      metadata: {
        intent: rawResp.intent?.name || null,
        entities: rawResp.entities || null,
        tags: rawResp.tags || rawResp.auto_tags || null,
        areas: rawResp.areas || null
      },
      raw: rawResp
    };
  }

  // fallback total
  return {
    reasoning: "",
    response: fixPortuguese(String(rawResp)),
    stop: false
  };
}

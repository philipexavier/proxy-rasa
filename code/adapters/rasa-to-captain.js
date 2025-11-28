/**
 * Adapter Rasa → Captain (ESM)
 * Versão FINAL — ultra estável, resiliente e compatível 100% com Captain Assistants e Copilot Threads.
 * Suporta intents, entities, PT-BR fix, reply_suggestions, label, areas, tags,
 * actions custom, rich content, multi-mensagens e fallback profundo.
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

// Extrai texto de QUALQUER formato enviado pelo Rasa
function extractText(m) {
  if (!m) return null;

  if (typeof m === "string") return m;
  if (typeof m.text === "string") return m.text;
  if (typeof m.message === "string") return m.message;

  // Custom Action
  if (m.custom) {
    if (typeof m.custom.text === "string") return m.custom.text;
    if (typeof m.custom.message === "string") return m.custom.message;
    return JSON.stringify(m.custom);
  }

  // Rich content (botões, imagens, payloads etc.)
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
  // Nada retornado → fallback
  if (!rawResp) {
    return {
      reasoning: "",
      response: "Não consegui processar agora.",
      stop: false
    };
  }

  // ---------------------
  // 1) ARRAY (REST webhook)
  // ---------------------
  if (Array.isArray(rawResp)) {
    const texts = rawResp.map(extractText).filter(Boolean).join("\n\n");

    const intent = rawResp[0]?.intent?.name || null;
    const entities = rawResp.flatMap((m) => m?.entities || []).filter(Boolean);

    const final = {
      reasoning: "",
      response: fixPortuguese(texts || "Desculpe, não tenho uma resposta agora."),
      stop: false,
      metadata: {
        intent,
        entities
      }
    };

    // Blindagem: nunca deixa response vazio
    if (!final.response.trim()) {
      final.response = "Desculpe, não tenho uma resposta agora.";
    }

    return final;
  }

  // ---------------------
  // 2) STRING (pode ser JSON)
  // ---------------------
  if (typeof rawResp === "string") {
    const trimmed = rawResp.trim();

    // Se for JSON dentro de string
    try {
      return normalizeRasaResponse(JSON.parse(trimmed));
    } catch {
      return {
        reasoning: "",
        response: fixPortuguese(trimmed || "Desculpe, não tenho uma resposta agora."),
        stop: false
      };
    }
  }

  // ---------------------
  // 3) OBJETO
  // ---------------------
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

    // Unificar reply_suggestions
    const replySuggestions = [];

    if (rawResp.reply_suggestions) replySuggestions.push(...rawResp.reply_suggestions);
    if (rawResp.replySuggestions) replySuggestions.push(...rawResp.replySuggestions);
    if (rawResp.reply_suggestion) replySuggestions.push(rawResp.reply_suggestion);

    const finalReplies = replySuggestions
      .filter(Boolean) // remove undefined / null
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v))); // Captain exige string

    const final = {
      reasoning: rawResp.reasoning || rawResp.explanation || "",
      response: fixPortuguese(String(base || "")),
      stop: !!rawResp.stop,

      // CAMPOS DO CAPTAIN
      reply_suggestions: finalReplies,
      label: rawResp.label_suggestion || rawResp.label || null,
      sources: rawResp.sources || rawResp.metadata?.sources || null,

      metadata: {
        intent,
        entities,
        tags: rawResp.tags || rawResp.auto_tags || rawResp.metadata?.tags || null,
        areas: rawResp.areas || rawResp.metadata?.areas || null
      },

      raw: rawResp
    };

    // Blindagem 1 — evita crash por response vazio
    if (!final.response || !final.response.trim()) {
      final.response = "Desculpe, não tenho uma resposta agora.";
    }

    // Blindagem 2 — label sempre string ou null
    if (final.label && typeof final.label !== "string") {
      final.label = String(final.label);
    }

    // Blindagem 3 — reply suggestions sempre array de strings
    if (!Array.isArray(final.reply_suggestions)) {
      final.reply_suggestions = [];
    }

    return final;
  }

  // ---------------------
  // 4) Fallback absoluto
  // ---------------------
  return {
    reasoning: "",
    response: fixPortuguese(String(rawResp) || "Desculpe, não tenho uma resposta agora."),
    stop: false
  };
}

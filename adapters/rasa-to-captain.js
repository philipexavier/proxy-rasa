// adapters/rasa-to-captain.js
/**
 * Normaliza várias formas de resposta vindas do Rasa / ferramentas / LLM
 * para o formato esperado pelo Capitain (choices[0].message.content === OBJECT).
 */

export function normalizeRasaResponse(rawResp) {
  // rawResp pode ser:
  // - null/undefined
  // - array (mensagens do rasa)
  // - objeto { response, output, texts, content, sources, stop, ... }
  // - string (texto ou JSON stringificado)
  if (!rawResp) {
    return { reasoning: '', response: 'Desculpe, não consegui obter uma resposta agora.', stop: false };
  }

  // Array -> juntar textos
  if (Array.isArray(rawResp)) {
    const texts = rawResp
      .map((m) => {
        if (!m) return null;
        if (typeof m === 'string') return m;
        if (m.text) return m.text;
        if (m.message) return m.message;
        // se for objeto complexo, stringify para debug
        return JSON.stringify(m);
      })
      .filter(Boolean);
    return { reasoning: '', response: texts.join('\n\n'), stop: false };
  }

  // Se for string -> tentar parse JSON, se falhar, é texto simples
  if (typeof rawResp === 'string') {
    const trimmed = rawResp.trim();
    // tentativa de JSON
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeRasaResponse(parsed);
    } catch (e) {
      return { reasoning: '', response: trimmed, stop: false };
    }
  }

  // Agora rawResp é objeto
  if (typeof rawResp === 'object') {
    // Possíveis campos: response, output, content, texts, texts[], message, reasoning, stop, sources
    const responseText =
      rawResp.response ||
      rawResp.output ||
      rawResp.content ||
      (Array.isArray(rawResp.texts) ? rawResp.texts.join('\n\n') : null) ||
      (rawResp.text ? rawResp.text : null);

    const reasoning = rawResp.reasoning || rawResp.explanation || '';
    const stop = !!rawResp.stop;
    const reply_suggestion = !!rawResp.reply_suggestion;
    const sources = rawResp.sources || rawResp.metadata?.sources || null;
    const agent_name = rawResp.agent_name || rawResp.agent || null;

    return {
      reasoning: reasoning,
      response: (responseText || '').toString(),
      stop,
      reply_suggestion,
      sources,
      agent_name,
      raw: rawResp, // opcional para debug/observabilidade
    };
  }

  // fallback
  return { reasoning: '', response: String(rawResp), stop: false };
}

const DEFAULT_SYSTEM_PROMPT = "Você é um assistente útil.";

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    return JSON.stringify(content);
  }
  return "";
}

function convertMessagesToPrompt(messages = []) {
  const chunks = [];
  const hasSystem = messages.some((msg) => msg.role === "system");

  if (!hasSystem) {
    chunks.push(`<|system|>\n${DEFAULT_SYSTEM_PROMPT}`);
  }

  messages.forEach((msg) => {
    const role = msg.role === "assistant" ? "assistant" : msg.role === "system" ? "system" : "user";
    const content = normalizeContent(msg.content);
    if (!content) return;
    chunks.push(`<|${role}|>\n${content}`);
  });

  chunks.push("<|assistant|>");

  return chunks.join("\n");
}

export { convertMessagesToPrompt };

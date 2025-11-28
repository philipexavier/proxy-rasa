// validator.js
// Simple OpenAI-like body validator

export function validateOpenAIRequest(body) {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { error: { message: "Body missing", type: "invalid_request_error" } }
    };
  }

  if (!body.model || typeof body.model !== "string") {
    return {
      ok: false,
      error: { error: { message: "Missing model", type: "invalid_request_error" } }
    };
  }

  if (!Array.isArray(body.messages)) {
    return {
      ok: false,
      error: { error: { message: "messages must be array", type: "invalid_request_error" } }
    };
  }

  if (body.messages.length === 0) {
    return {
      ok: false,
      error: { error: { message: "messages empty", type: "invalid_request_error" } }
    };
  }

  return { ok: true };
}

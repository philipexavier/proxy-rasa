export function validateOpenAIRequest(body) {
  if (!body || typeof body !== "object") {
    return fail("Invalid request body");
  }

  if (!body.model || typeof body.model !== "string") {
    return fail("Missing or invalid field: model");
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return fail("Field 'messages' must be an array");
  }

  if (body.messages.length === 0) {
    return fail("Field 'messages' must not be empty");
  }

  for (const m of body.messages) {
    if (!m.role || !m.content) {
      return fail(
        "Each message must contain 'role' and 'content'"
      );
    }

    if (!["user", "assistant", "system"].includes(m.role)) {
      return fail(
        `Invalid role '${m.role}'. Allowed: user, assistant, system`
      );
    }

    if (typeof m.content !== "string") {
      return fail("Message content must be a string");
    }
  }

  return { ok: true };
}

function fail(message) {
  return {
    ok: false,
    error: {
      error: {
        message,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    },
  };
}

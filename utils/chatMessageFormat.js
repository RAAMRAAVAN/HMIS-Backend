const FILE_PREFIX = "__CHAT_FILE__:";
const CALL_PREFIX = "__CHAT_CALL__:";

export function serializeChatBody({ text = "", messageType = "text", file = null, call = null }) {
  if (messageType === "file" && file) {
    return `${FILE_PREFIX}${JSON.stringify({
      text: text || file.originalName || file.name || "",
      file,
    })}`;
  }

  if (messageType === "call" && call) {
    return `${CALL_PREFIX}${JSON.stringify({
      text: text || "Call",
      call,
    })}`;
  }

  return text || "";
}

export function parseChatBody(body) {
  if (typeof body !== "string") {
    return { text: "", messageType: "text", file: null };
  }

  if (!body.startsWith(FILE_PREFIX)) {
    if (!body.startsWith(CALL_PREFIX)) {
      return { text: body, messageType: "text", file: null, call: null };
    }

    try {
      const parsedCall = JSON.parse(body.slice(CALL_PREFIX.length));
      return {
        text: parsedCall?.text || "Call",
        messageType: "call",
        file: null,
        call: parsedCall?.call || null,
      };
    } catch {
      return { text: "Call", messageType: "text", file: null, call: null };
    }
  }

  try {
    const parsed = JSON.parse(body.slice(FILE_PREFIX.length));
    return {
      text: parsed?.text || "",
      messageType: "file",
      file: parsed?.file || null,
      call: null,
    };
  } catch {
    return { text: "", messageType: "text", file: null, call: null };
  }
}

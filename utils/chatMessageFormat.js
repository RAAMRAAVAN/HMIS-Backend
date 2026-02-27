const FILE_PREFIX = "__CHAT_FILE__:";

export function serializeChatBody({ text = "", messageType = "text", file = null }) {
  if (messageType === "file" && file) {
    return `${FILE_PREFIX}${JSON.stringify({
      text: text || file.originalName || file.name || "",
      file,
    })}`;
  }

  return text || "";
}

export function parseChatBody(body) {
  if (typeof body !== "string") {
    return { text: "", messageType: "text", file: null };
  }

  if (!body.startsWith(FILE_PREFIX)) {
    return { text: body, messageType: "text", file: null };
  }

  try {
    const parsed = JSON.parse(body.slice(FILE_PREFIX.length));
    return {
      text: parsed?.text || "",
      messageType: "file",
      file: parsed?.file || null,
    };
  } catch {
    return { text: "", messageType: "text", file: null };
  }
}

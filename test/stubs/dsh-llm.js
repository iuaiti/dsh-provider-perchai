export class LlmAdapter {
  async chat() {
    throw new Error("stub adapter");
  }
}

export class LlmError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function ToolCallId(id) {
  return id;
}

export const ReasoningEffortId = class ReasoningEffortId {};
export const CONTEXT_WINDOW_EXCEEDED_CODE = "LLM_CONTEXT_WINDOW_EXCEEDED";
export const EMPTY_RESPONSE_CODE = "LLM_EMPTY_RESPONSE";
export const INVALID_CREDENTIAL_CODE = "LLM_INVALID_CREDENTIAL";
export const QUOTA_EXCEEDED_CODE = "LLM_QUOTA_EXCEEDED";

export function attributionHeaders() {
  return {};
}

export function contentHasImage() {
  return false;
}

export function isContextWindowExceededError() {
  return false;
}

export function isQuotaExceededError() {
  return false;
}

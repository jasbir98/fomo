/**
 * crypto.randomUUID() requires a secure context (HTTPS or localhost), so it
 * throws/is undefined when the LAN dev server is opened over plain HTTP on a
 * phone. This falls back to crypto.getRandomValues, then Math.random.
 */
export function uuid(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const randomPart = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(2)), (n) =>
        n.toString(36)
      ).join("")
    : Math.random().toString(36).slice(2);

  return `${Date.now().toString(36)}-${randomPart}`;
}

/**
 * Minimal client-side helpers for Google Identity Services (GIS) sign-in —
 * see app/signin/page.tsx for the flow this backs.
 *
 * Nonce handling follows Supabase's documented GIS + `signInWithIdToken`
 * pattern: generate a random raw nonce, hand GIS the SHA-256 hex digest of
 * it (so the ID token's `nonce` claim never carries the raw value), and pass
 * the RAW nonce to `signInWithIdToken`, which hashes it the same way and
 * compares against the token's claim server-side.
 */

/** Cryptographically random 32-byte nonce, hex-encoded. */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex digest of `value`, via the browser's SubtleCrypto — no extra dependency. */
export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface GoogleIdCredentialResponse {
  credential: string;
}

/**
 * Ambient shape of the bits of `window.google.accounts.id` this app calls.
 * No official `@types` package is installed for GIS; kept intentionally
 * narrow to just what app/signin/page.tsx uses — see Google's Identity
 * Services docs for the full API.
 */
export interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleIdCredentialResponse) => void;
    nonce: string;
    use_fedcm_for_prompt?: boolean;
    ux_mode?: "popup" | "redirect";
    itp_support?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: "standard" | "icon";
      theme?: "outline" | "filled_blue" | "filled_black";
      size?: "large" | "medium" | "small";
      text?: "signin_with" | "signup_with" | "continue_with" | "signin";
      shape?: "rectangular" | "pill" | "circle" | "square";
      logo_alignment?: "left" | "center";
      width?: number;
    }
  ): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: GoogleAccountsId;
      };
    };
  }
}

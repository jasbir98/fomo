"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Script from "next/script";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { AuthError } from "@supabase/supabase-js";
import { Button, FomoLogo, Input } from "@/components/ui";
import { FomoPeek, SigninSkyline } from "@/components/onboarding/Characters";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { safeNext } from "@/lib/auth/safe-next";
import { publicNextOrHome } from "@/lib/auth/public-next";
import { signinReasonCopy } from "@/lib/auth/signin-reason";
import { generateNonce, sha256Hex } from "@/lib/auth/google-identity";

// Set in .env.local / Vercel — see this file's Google sign-in block below.
// Left unset, the Google button falls back to the existing
// `signInWithOAuth` redirect flow unchanged (see `signInWithProvider`).
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

// Apple sign-in isn't configured in Supabase yet — showing the button would
// send users into a raw "provider is not enabled" error. Flip this back to
// `true` once Supabase has Apple set up; the button/handler code underneath
// is untouched, just gated on this constant.
const APPLE_SIGNIN_ENABLED = false;

// Supabase's raw AuthError messages are usually fine, but a few common OTP
// failures read as backend jargon — friendlier copy for those, message text
// as a fallback for everything else (codes aren't populated on every error).
function friendlyOtpError(err: AuthError): string {
  switch (err.code) {
    case "otp_expired":
      return "That code has expired or is wrong. Request a new one and try again.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "Too many attempts — wait a moment before requesting another code.";
    default:
      break;
  }
  if (/expired|invalid/i.test(err.message) && /token|otp|code/i.test(err.message)) {
    return "That code has expired or is wrong. Request a new one and try again.";
  }
  if (/rate limit/i.test(err.message)) {
    return "Too many attempts — wait a moment before requesting another code.";
  }
  return err.message;
}

const RESEND_COOLDOWN_SECONDS = 60; // matches Supabase's default 1 email / 60s rate limit
// Supabase's OTP code length is a server-side project setting
// (GOTRUE_MAILER_OTP_LENGTH) that varies by project — some are provisioned
// with 6 digits, others with 8. Never hardcode a specific length here: doing
// so either truncates a longer code before it reaches verifyOtp (silent,
// confusing failure) or rejects a shorter one. Accept any reasonable numeric
// code and let Supabase's own verifyOtp call be the source of truth.
const OTP_MIN_LENGTH = 6;
const OTP_MAX_LENGTH = 10;

type Step = "email" | "code";

/** Google's four-colour "G" — brand guidelines want it on a white button. */
function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function AppleLogo() {
  return (
    <svg viewBox="0 0 384 512" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

function SigninContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextParam = safeNext(searchParams.get("next"));
  const reasonCopy = signinReasonCopy(searchParams.get("reason"));

  function handleNotNow() {
    router.push(publicNextOrHome(searchParams.get("next")));
  }

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set once from the `?error=auth_callback` query param `app/auth/callback/route.ts`
  // redirects with on a failed OAuth exchange. Cleared as soon as the user
  // retries anything, so it never lingers past the attempt it describes.
  const [callbackError, setCallbackError] = useState<string | null>(() =>
    searchParams.get("error") === "auth_callback"
      ? "Sign-in didn't complete — please try again."
      : null,
  );
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<"google" | "apple" | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Google Identity Services (GIS) sign-in — runs on our own origin (no
  // "continue to <project>.supabase.co" account chooser). `gisLoaded` flips
  // once the GSI script has executed; `gisFailed` covers both a script load
  // error and the script loading but `window.google` never materializing
  // (ad blockers commonly do the latter) — either way we fall back to the
  // existing signInWithOAuth redirect button below.
  const [gisLoaded, setGisLoaded] = useState(false);
  const [gisFailed, setGisFailed] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement>(null);
  // The raw nonce for the in-flight GIS attempt — stashed here so the
  // credential callback (registered once, at `initialize` time) can read
  // whatever nonce was actually handed to Google for that attempt.
  const googleNonceRef = useRef<string | null>(null);
  // `google.accounts.id.initialize`'s `callback` is registered once and
  // never re-registered on re-render, so it closes over stale state if it
  // reads component state directly. Route it through a ref that's kept
  // current every render instead.
  const handleGoogleCredentialRef = useRef<(token: string) => void>(() => {});

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, []);

  // Kept current every render so the GIS callback (below) always sees the
  // latest `nextParam` / setter identities without re-initializing GIS.
  useEffect(() => {
    handleGoogleCredentialRef.current = async (token: string) => {
      const rawNonce = googleNonceRef.current;
      if (!rawNonce) return;
      setError(null);
      setCallbackError(null);
      setOauthLoading("google");
      try {
        const supabase = supabaseBrowserAuth();
        const { error: idTokenError } = await supabase.auth.signInWithIdToken({
          provider: "google",
          token,
          nonce: rawNonce,
        });
        if (idTokenError) {
          setError(idTokenError.message);
          setOauthLoading(null);
          return;
        }
        // Same post-sign-in navigation as the OTP/OAuth paths — the
        // `on_auth_user_created` DB trigger (supabase/add_auth_identity.sql)
        // creates the `profiles` row server-side on first sign-in, same as
        // for OAuth/OTP, so there's nothing else to replicate client-side.
        window.location.assign(nextParam);
      } catch (err) {
        console.error("[signin] signInWithIdToken failed", err);
        setError("Couldn't sign in with Google. Try again.");
        setOauthLoading(null);
      }
    };
  });

  // Initializes GIS and renders Google's own button once the GSI script has
  // loaded. Only runs when NEXT_PUBLIC_GOOGLE_CLIENT_ID is set — otherwise
  // the hand-off-free OAuth redirect button below is the only Google option.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !gisLoaded) return;
    const google = window.google;
    if (!google?.accounts?.id) {
      // Script tag loaded but the API never showed up — blocked by an
      // extension, or Google's own outage. Fall back to the redirect button.
      // Deferred a tick: setting state synchronously inside an effect body
      // (rather than in response to an external event) risks cascading
      // renders — see react-hooks/set-state-in-effect.
      queueMicrotask(() => setGisFailed(true));
      return;
    }
    let cancelled = false;
    (async () => {
      const rawNonce = generateNonce();
      const hashedNonce = await sha256Hex(rawNonce);
      if (cancelled) return;
      googleNonceRef.current = rawNonce;
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => {
          void handleGoogleCredentialRef.current(response.credential);
        },
        nonce: hashedNonce,
        use_fedcm_for_prompt: true,
        ux_mode: "popup",
        itp_support: true,
      });
      if (googleButtonRef.current) {
        const width = Math.round(googleButtonRef.current.getBoundingClientRect().width) || 320;
        google.accounts.id.renderButton(googleButtonRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gisLoaded]);

  function startCooldown() {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    cooldownTimer.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          if (cooldownTimer.current) clearInterval(cooldownTimer.current);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  async function sendCode() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your email first.");
      return;
    }
    setError(null);
    setCallbackError(null);
    setSending(true);
    try {
      const supabase = supabaseBrowserAuth();
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          shouldCreateUser: true,
          // Only used if the email template sends a link instead of (or as
          // well as) the code — e.g. Supabase's default "Confirm signup"
          // template for brand-new accounts. The callback verifies it and
          // lands the user on `next`, so a clicked link still signs them in.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextParam)}`,
        },
      });
      if (otpError) {
        setError(friendlyOtpError(otpError));
        return;
      }
      setStep("code");
      startCooldown();
    } catch (err) {
      console.error("[signin] signInWithOtp failed", err);
      setError("Couldn't send a code. Try again.");
    } finally {
      setSending(false);
    }
  }

  async function verifyCode() {
    const trimmedCode = code.trim();
    if (trimmedCode.length < OTP_MIN_LENGTH) {
      setError("Enter the code from your email.");
      return;
    }
    setError(null);
    setCallbackError(null);
    setVerifying(true);
    try {
      const supabase = supabaseBrowserAuth();
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: trimmedCode,
        type: "email",
      });
      if (verifyError) {
        setError(friendlyOtpError(verifyError));
        return;
      }
      window.location.assign(nextParam);
    } catch (err) {
      console.error("[signin] verifyOtp failed", err);
      setError("That code didn't work. Try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function signInWithProvider(provider: "google" | "apple") {
    setError(null);
    setCallbackError(null);
    setOauthLoading(provider);
    try {
      const supabase = supabaseBrowserAuth();
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextParam)}`;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });
      if (oauthError) {
        setError(oauthError.message);
        setOauthLoading(null);
      }
      // On success the browser navigates away to the provider — no further
      // state update needed here.
    } catch (err) {
      console.error(`[signin] signInWithOAuth(${provider}) failed`, err);
      setError("Couldn't start sign-in. Try again.");
      setOauthLoading(null);
    }
  }

  return (
    <div className="flex min-h-dvh w-full flex-col bg-background pb-safe">
      <header className="relative overflow-hidden bg-gradient-to-b from-primary to-[#1b365d] px-6 pt-safe text-center">
        <div className="relative z-10 flex items-center justify-center gap-2 pt-8">
          <FomoLogo tone="dark" size={30} />
        </div>
        <h1 className="relative z-10 mt-6 text-headline-md text-on-primary">
          {step === "email" ? "Edinburgh’s on tonight" : "Check your email"}
        </h1>
        <p className="relative z-10 mt-1 text-body-md text-on-primary/75">
          {step === "email" ? "Sign in so you don’t miss it." : `We sent a code to ${email.trim()}.`}
        </p>
        <div className="pointer-events-none -mx-6 mt-2 h-36">
          <SigninSkyline />
        </div>
      </header>

      <main className="relative z-10 mx-auto -mt-8 flex w-full max-w-sm flex-1 flex-col px-4">
        <div className="relative flex flex-col gap-5 rounded-3xl bg-surface-container-lowest px-5 pt-10 pb-6 shadow-[0_12px_40px_-12px_rgba(0,32,70,0.25)]">
          <div className="absolute -top-[61px] left-1/2 h-[68px] w-28 -translate-x-1/2">
            <FomoPeek mood={step === "email" ? "grin" : "wow"} />
          </div>
          {reasonCopy && step === "email" ? (
            <p className="text-center text-label-md font-medium text-secondary">{reasonCopy}</p>
          ) : null}
          <p className="text-center text-body-md text-on-surface-variant">
            {step === "email"
              ? "One-time code by email. No password."
              : "Enter it below to finish signing in."}
          </p>

        {callbackError ? (
          <p
            role="alert"
            className="rounded-lg bg-error-container/40 px-4 py-3 text-center text-body-md text-error"
          >
            {callbackError}
          </p>
        ) : null}

        {step === "email" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
          >
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error ?? undefined}
            />
            <Button type="submit" variant="orange" fullWidth size="md" disabled={sending}>
              {sending ? "Sending…" : "Email me a code"}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              verifyCode();
            }}
          >
            <Input
              label="Verification code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={OTP_MAX_LENGTH}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, OTP_MAX_LENGTH))}
              error={error ?? undefined}
            />
            <Button type="submit" variant="orange" fullWidth size="md" disabled={verifying}>
              {verifying ? "Verifying…" : "Verify code"}
            </Button>
            <div className="flex items-center justify-between text-label-md">
              <button
                type="button"
                className="text-on-surface-variant underline disabled:no-underline disabled:opacity-50"
                disabled={cooldown > 0 || sending}
                onClick={sendCode}
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
              </button>
              <button
                type="button"
                className="text-on-surface-variant"
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError(null);
                }}
              >
                Use a different email
              </button>
            </div>
          </form>
        )}

        <div className="flex items-center gap-3 py-2">
          <div className="h-px flex-1 bg-outline-variant" />
          <span className="text-label-md text-on-surface-variant">or</span>
          <div className="h-px flex-1 bg-outline-variant" />
        </div>

        <div className="flex flex-col gap-3">
          {GOOGLE_CLIENT_ID ? (
            <>
              <Script
                src="https://accounts.google.com/gsi/client"
                strategy="afterInteractive"
                onLoad={() => setGisLoaded(true)}
                onError={() => setGisFailed(true)}
              />
              {gisFailed ? (
                <>
                  <p className="text-center text-label-sm text-on-surface-variant">
                    Google sign-in didn&rsquo;t load — continuing with redirect.
                  </p>
                  <button
                    type="button"
                    onClick={() => signInWithProvider("google")}
                    disabled={oauthLoading !== null}
                    className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-[#dadce0] bg-white text-label-md font-medium text-[#1f1f1f] shadow-sm transition-all hover:bg-[#f8faff] hover:shadow active:bg-[#eef3fd] disabled:pointer-events-none disabled:opacity-40"
                  >
                    <GoogleLogo />
                    {oauthLoading === "google" ? "Redirecting…" : "Continue with Google"}
                  </button>
                </>
              ) : (
                // Google's own official button, rendered by GIS into this
                // container — not hand-drawn, per Google's brand guidelines.
                // Height/visuals come entirely from renderButton's options
                // above; the flex wrapper just centers it at full width.
                <div ref={googleButtonRef} className="flex h-12 w-full items-center justify-center" />
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => signInWithProvider("google")}
              disabled={oauthLoading !== null}
              className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-[#dadce0] bg-white text-label-md font-medium text-[#1f1f1f] shadow-sm transition-all hover:bg-[#f8faff] hover:shadow active:bg-[#eef3fd] disabled:pointer-events-none disabled:opacity-40"
            >
              <GoogleLogo />
              {oauthLoading === "google" ? "Redirecting…" : "Continue with Google"}
            </button>
          )}
          {APPLE_SIGNIN_ENABLED ? (
            <button
              type="button"
              onClick={() => signInWithProvider("apple")}
              disabled={oauthLoading !== null}
              className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-xl bg-black text-label-md font-medium text-white shadow-sm transition-all hover:bg-[#1f1f1f] active:bg-[#333] disabled:pointer-events-none disabled:opacity-40"
            >
              <AppleLogo />
              {oauthLoading === "apple" ? "Redirecting…" : "Continue with Apple"}
            </button>
          ) : null}
        </div>

        <p className="mt-2 text-center text-label-sm text-on-surface-variant">
          By continuing you agree to our{" "}
          <Link href="/terms" className="underline underline-offset-2">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline underline-offset-2">
            Privacy Policy
          </Link>
          .
        </p>

        <button
          type="button"
          onClick={handleNotNow}
          className="mt-1 text-center text-label-md font-medium text-on-surface-variant underline underline-offset-2"
        >
          Not now — keep browsing
        </button>
        </div>
      </main>
    </div>
  );
}

export default function SigninPage() {
  return (
    <Suspense fallback={null}>
      <SigninContent />
    </Suspense>
  );
}

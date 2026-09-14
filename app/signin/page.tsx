"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AuthError } from "@supabase/supabase-js";
import { Button, Input } from "@/components/ui";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { safeNext } from "@/lib/auth/safe-next";

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

function SigninContent() {
  const searchParams = useSearchParams();
  const nextParam = safeNext(searchParams.get("next"));

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

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, []);

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
    <div className="flex min-h-dvh w-full flex-col bg-background px-6 pt-safe pb-safe">
      <div className="flex items-center justify-center gap-2 pt-10 pb-8">
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="10" className="fill-primary" />
          <path
            d="M0 10C0 15.5228 4.47715 20 10 20C15.5228 20 20 15.5228 20 10H0Z"
            className="fill-secondary-container"
          />
        </svg>
        <span className="text-headline-sm text-on-surface">
          Fomo<span className="text-secondary-container">.</span>
        </span>
      </div>

      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 pb-10">
        <div className="text-center">
          <h1 className="mb-2 text-headline-md text-on-surface">
            {step === "email" ? "Sign in" : "Check your email"}
          </h1>
          <p className="text-body-md text-on-surface-variant">
            {step === "email"
              ? "We'll email you a one-time code — no password."
              : `Enter the code we sent to ${email.trim()}.`}
          </p>
        </div>

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
          <Button
            variant="outline"
            fullWidth
            size="md"
            onClick={() => signInWithProvider("google")}
            disabled={oauthLoading !== null}
          >
            {oauthLoading === "google" ? "Redirecting…" : "Continue with Google"}
          </Button>
          <Button
            variant="outline"
            fullWidth
            size="md"
            onClick={() => signInWithProvider("apple")}
            disabled={oauthLoading !== null}
          >
            {oauthLoading === "apple" ? "Redirecting…" : "Continue with Apple"}
          </Button>
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

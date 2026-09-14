# Supabase auth email templates

Fomo signs people in with a 6-digit email code (`signInWithOtp` → `verifyOtp` in
`app/signin/page.tsx`). Supabase picks the email template by account state:

| Who | Template Supabase sends |
|---|---|
| Brand-new email (first sign-in) | **Confirm signup** |
| Existing account | **Magic Link** |

Supabase's default **Confirm signup** template only contains a link, which is
why new users sometimes get "a verification link" instead of a code. Both
templates must show the code.

## Where

Supabase Dashboard → Authentication → Emails → Templates (the same project for
local and production).

## Confirm signup

Subject: `Your Fomo sign-in code`

```html
<h2>Your Fomo code</h2>
<p>Enter this code in Fomo to finish signing in:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">{{ .Token }}</p>
<p>It expires soon. If you didn't try to sign in, you can ignore this email.</p>
<p style="color:#666;font-size:13px">Or open this link on the same device:
<a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email">sign in to Fomo</a></p>
```

## Magic Link

Subject: `Your Fomo sign-in code`

```html
<h2>Your Fomo code</h2>
<p>Enter this code in Fomo to sign in:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">{{ .Token }}</p>
<p>It expires soon. If you didn't try to sign in, you can ignore this email.</p>
<p style="color:#666;font-size:13px">Or open this link:
<a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email">sign in to Fomo</a></p>
```

The optional link goes through `app/auth/callback/route.ts`, which verifies the
`token_hash` server-side, so it also works when opened from a phone's mail app.
It uses `{{ .SiteURL }}`, so set **Authentication → URL Configuration → Site
URL** to the deployed address, not `http://localhost:3000`, or links from
production emails will point at localhost.

## Related settings

- Authentication → Sign In / Providers → Email: keep **Email OTP** enabled.
  The code length there (6–10 digits) is accepted by the sign-in form.
- Authentication → Emails → SMTP: the built-in sender is rate-limited (a few
  emails per hour). Configure a custom SMTP provider before real users sign up.

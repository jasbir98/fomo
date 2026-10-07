# Fomo: pre-marketing fixes (identity + launch misses) and marketing plan

## Context
Fomo is live at askfomo.com. Before pushing it to everyone, the user found that:
- Supabase shows an empty Display name for most users.
- Google sign-in photos don't show inside Fomo.

They asked for those fixes, plus a sweep for similar misses, and a marketing plan. The desktop work is merged (#1), and #2 is open with the follow-ups.

Root causes, from code read on 2026-10-05:
- **Name:** nothing ever writes a name. Email-code sign-up never asks for one, and `handle_new_user()` only inserts `user_id` into `profiles`. The profile page reads only `profiles.display_name`, so even Google users see their email prefix.
- **Photo, three causes:**
  - The Google photo is read only on `/profile`.
  - Header and side nav always draw a `person` icon, because `useSignedIn()` returns a boolean.
  - On `/profile`, `cdnResize` (`lib/image/cdn.ts:236-241`) *appends* `=w224-h224-c` to Google avatar URLs, which already end in `=s96-c`. The resulting URL is very likely invalid, and `onError` silently falls back to the icon. Not yet confirmed: my read-only probe of real avatar URLs was blocked. I'll confirm in the browser with a Google sign-in on the dev server instead.

## A. Name + photo (Sonnet builds, I review)
1. **`lib/image/cdn.ts`:** for googleusercontent, replace any trailing size segment, `=s\d+(-[a-z0-9-]*)?` or `=w\d+-h\d+(…)?`, instead of appending. Add a `npx tsx --test` case for `=s96-c` → `=w224-h224-c`.
2. **New `lib/auth/identity.ts`:**
   - `displayNameOf(profile, user)`: `profiles.display_name` → `user_metadata.full_name`/`name` → email prefix.
   - `avatarUrlOf(profile, user)`: `profiles.avatar_url` → `user_metadata.avatar_url`/`picture`.
   - `initialsOf(name)`.
3. **New `lib/auth/useCurrentUser.ts`:** the client hook behind `useSignedIn()` (`lib/useSaved.ts:177`), exposing `{ user, name, avatarUrl }` via `onAuthStateChange`. `useSignedIn()` stays as a thin wrapper.
4. **Header and side nav:** `components/shell/AppHeader.tsx:193`, and the profile item in `components/shell/SideNav.tsx:162`, show the photo (SmartImage, 32px), falling back to initials and then the icon.
5. **`app/(shell)/profile/page.tsx`:**
   - Use the helpers.
   - Make the name editable inline (pencil → input → Save). It writes `profiles.display_name` via `upsertProfile` (`lib/db/profile.ts:26`) *and* `auth.updateUser({ data: { full_name } })`, so the Supabase dashboard fills too.
   - Make the camera button aware of the Google photo ("Change photo", with no "Remove" for the Google one).
6. **Email sign-ups:** after the first successful code verify in `app/signin/page.tsx`, when the user is new and has no name, show one optional "What should we call you?" field with Skip. Same write as step 5. Your decision: optional prompt, shown once, with Skip.
7. **SQL for you to run, `supabase/sync_profile_identity.sql`:**
   - `handle_new_user()` also copies `raw_user_meta_data` `full_name`/`name` and `avatar_url`/`picture` into `profiles`.
   - A one-off backfill for existing users, which only fills null fields and never overwrites an uploaded photo.

## B. Other misses found (sweep of app/ + components/)
**P0 (fix before any push):**
- **Live legal pages:** `/privacy` (`app/privacy/page.tsx:38`) and `/terms` (`app/terms/page.tsx:33`) show the literal text `{{OPERATOR_NAME}}`. Replace it with **"Jasbir Singh (sole trader)"**, your decision, and remove the template notes at the top of both files.
- **Sign-in emails (dashboard, you):** Supabase's built-in sender allows only a few emails per hour, so a launch spike means "never got my code". Set custom SMTP to Resend (`hello@askfomo.com`, already verified). Also check that the Confirm signup and Magic Link templates from `docs/auth-email-templates.md` are pasted in, and that Site URL = `https://askfomo.com`.

**P1 code (Sonnet/Haiku):**
- **Account deletion:** stays by email request, your decision. Add a visible "Delete my account" mailto row in Profile → Account settings, subject prefilled. When requests come in, deleting the user in the Supabase dashboard cascades all their data (checked: 13 tables cascade, tips `set null`); remove their `avatars/<uid>/` folder by hand.
- **Push copy:** hide `profile/page.tsx:516` "Push alerts … coming soon" instead of showing it.
- **Link previews (Haiku):** link-preview metadata layouts for `/place/[id]` (copy `happening/[id]/layout.tsx`, `generateMetadata` + fallback image) and for `/deals`, `/whats-on`, `/free`, `/book-early`, `/explore`, `/saved` (static title/description like `weekend/layout.tsx`).
- **Share tracking (Haiku):** `components/ui/ShareButton.tsx` adds `utm_source=share&utm_medium=native|copy`, so word of mouth shows up in PostHog.
- **Feedback:** add a "Send feedback" row in Profile, and a feedback link on `app/error.tsx`.
- **Analytics:** `signin_completed` gets `is_new_user` (created_at within 60s) to count real sign-ups.

**P1 checks (you, dashboards):**
- `NEXT_PUBLIC_POSTHOG_KEY`, `RESEND_API_KEY` and `FOMO_FROM_EMAIL` are set in Vercel *production*.
- The `tips` table exists in prod.
- Google OAuth consent screen shows the Fomo name and logo.

## C. Marketing plan (delivered in chat after approval; also saved as `docs/launch/marketing-plan.md`)
Builds on `docs/launch/launch-kit.md` (IG first 9 posts, soft-launch DM, Reddit post, society/venue DMs, QR posters, the £50 boost rule, Mom Test calls) and `docs/content-loop.md` (weekly IG carousel + Fomo Friday from the DB).

- **Positioning:** "Everything free and cheap on in Edinburgh this week, in one place."
  - Wedge: students and under-30s.
  - Proof point: specific prices (£1 Traverse, £4 cinema), never "deals and events".
  - Differentiator to demo: Ask Fomo ("cheap date night in Leith on Friday" → answers on a map).
- **Goal before scale:** weekly retention, not followers.
  - North star: weekly active planners, meaning people who save or click out in a week.
  - Gate: about 25% of week-1 users come back in week 4 before spending money.
- **Timing hooks (Oct–Dec 2026):**
  - Halloween and Bonfire Night (5 Nov).
  - "Skint November", when student loans run thin.
  - Reading weeks.
  - Christmas markets and free festive things (late Nov).
  - Exam-season study spots and cheap eats (Dec).
- **Channels, ranked for a 5–15 h/week founder:**
  1. **Instagram @askfomo (core):**
     - Thursday carousel ("Edinburgh on £10 this weekend").
     - 2 Reels a week.
     - Daily Story deal with a link sticker and poll.
     - Formats that work for local accounts: street vox-pop "best cheap thing in Edinburgh?", "I tried every £5 lunch deal", "free things when it's raining", "a pub quiz every night", "date night under £20".
     - Measure saves and shares, not likes.
  2. **TikTok:** repost the same Reels. It's where students discover things, at zero extra cost.
  3. **Reddit r/Edinburgh:**
     - A weekly value-first "free & cheap this weekend" list (check the rules and ask the mods about a recurring thread).
     - Answer every "what to do" or "cheap food" question with the list and a link only when relevant.
     - Never just post the link.
  4. **WhatsApp / group chats:**
     - The Fomo Insiders community.
     - Make the share button the growth loop: "send to the group chat" CTA on /weekend and detail pages.
  5. **Student unions and societies:**
     - EUSA/Teviot, Napier, Heriot-Watt, QMU newsletters; 5 society DMs a week.
     - One campus ambassador per uni (free perks, or a pizza budget).
     - QR posters where allowed.
  6. **Venues:**
     - Tell every listed venue it's featured (DM template exists).
     - Give them a "Find us on Fomo" story asset. Venues reshare, which is free reach to local audiences.
  7. **Local press and newsletters:** a founder story ("Edinburgh grad builds app for skint students") pitched to Edinburgh Live, Edinburgh Evening News, The Edinburgh Reporter, The Skinny, Secret Edinburgh, and student papers (The Student, The Tab Edinburgh).
  8. **SEO (slow, compounding):** /weekend, /free and /deals metadata (B above) targets "free things to do in Edinburgh this weekend".
  9. **X:** low priority for this audience. Use it only for build-in-public and the founder network, not acquisition.
- **Launch sequence:**
  - This week: fixes A+B and 5 user calls.
  - Next Thursday: wider launch (Insiders forward to group chats + the Reddit list + IG launch carousel).
  - Week 3: £50 boost on the best organic post.
  - Then the weekly rhythm.
- **Weekly rhythm (about 6 h):**
  - Mon: metrics and 1 user call (`scripts/weekly-metrics.mjs`).
  - Tue: 5 society/venue DMs.
  - Wed: `ig-carousel.mjs` + film 2 Reels.
  - Thu: post the carousel + Reddit list.
  - Fri: Fomo Friday email.
  - Daily: one Story (10 min) and reply to comments within 2 h.
- **Don't:**
  - Paid ads before retention.
  - Buying followers.
  - Link-dumping in subreddits or Facebook groups.
  - Posting full-price things (it breaks the promise).

## Delegation
- **Sonnet:** A1–A6 (one agent), plus the Profile rows (feedback, delete-by-email) and the push copy.
- **Haiku:** metadata layouts, ShareButton UTM, error-page feedback link.
- **Main:** the SQL file, the review of every diff, browser verification, and writing the marketing doc.

## Verification
- `npx tsc --noEmit`, `eslint`, `npx tsx --test` (cdn rewrite test), and `npm run build`.
- **Browser (dev):**
  - Sign in with Google: the photo shows in the header, side nav and Profile, and the network tab shows a 200 for the googleusercontent URL.
  - Edit the name on Profile: it persists after reload, and `user_metadata.full_name` is set.
  - Email sign-in as a new user: the name prompt appears and can be skipped.
  - Phone layout unchanged at 375px.
- **Link previews:** `curl` the HTML head of `/place/<id>` and `/deals` for `og:title`.
- **After you run the SQL:** existing Google users show a name and photo; the Supabase dashboard Display name fills for anyone who sets a name.

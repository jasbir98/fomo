# What sits behind sign-in

## Context
Fomo lets visitors browse everything signed out. Only `/profile` is gated in `proxy.ts`, plus Save and the 4th Ask Fomo question. Personalisation works signed out through localStorage (`fomo:prefs`, `fomo:affinity`), so signing in offers very little. The user wants For you and the other recommendation features to need an account. Discovery content still has to stay open, because Google search (the sitemap lists every content page) and Instagram links (to `/for-you` and `/weekend`) are the growth channels.

**Rule:** what Edinburgh has on stays public. Anything that knows *you* (your taste, your saves, your alerts) or costs us per use needs an account.

### Final split

| Area | Signed out | Needs sign-in |
|---|---|---|
| Feed, What's on, Weekend, Deals, Free, Book early | Full lists, neutral order | Taste ranking, "You qualify" badges, What's on "For you" sort |
| Detail pages (happening, event, place), share, .ics | Public (SEO, shared links) | — |
| **For you** | Teaser: top 2 hand-picks plus a sign-in card | The full page: every pick, "More for you" recs |
| Make Fomo yours (prefs sheet) | Shown. They can answer, then sign in to see the result | Prefs take effect |
| Save / Saved | Tap goes to sign-in (as now) | Yes (as now) |
| Notify me (Book early alerts) | Tap goes to sign-in (today it fails with "Couldn't turn on alerts") | Yes |
| Ask Fomo | 3 questions a day, no history (unchanged) | 30 a day, history, answers that use your taste |
| Explore map + "On Fomo" search | Public | Google Places suggestions (today they fail silently with a 401) |
| Search, Tip us off, Fomo Friday email signup | Public | — |
| Profile | — | Yes (as now) |

### What's enforced where
- **Already enforced on the server:** saves, alerts and push need a session (`proxy.ts` returns 401, plus RLS). Prefs live in the account's own `user_metadata`. Chat limits are counted per user or per IP in `app/api/chat/route.ts`, and Google autocomplete needs a session.
- **Today the browser is the only gate, and it can be bypassed:** the full hand-pick list. `finds` RLS (`supabase/add_finds.sql`, not yet run) grants SELECT to `anon`, and the anon key ships in the page, so anyone can read every pick through Supabase REST or `/api/finds`. Change 6a moves this gate to the server.
- **Fine to leave in the browser:** "More for you" and the taste ranking only re-order the public feed. Someone who bypasses them gets content that is already on Deals and What's on.

`proxy.ts` and `lib/auth/public-next.ts` don't change, because no new page is redirected.

## Changes

**1. One sign-in helper.** Move the private `sendToSignIn` out of `lib/useSaved.ts:93` into `lib/auth/send-to-signin.ts` as `sendToSignIn(reason, nextOverride?)`. `useSaved` keeps calling it with `"save"`. It also fires `track("signin_prompt_clicked", { reason })` so the wall can be measured.

**2. Sign-in reasons.** In `lib/auth/signin-reason.ts`, add `for_you`, `personalise`, `notify` and `places` to `REASON_COPY`. Each gets short, dash-free copy, e.g. "Sign in to see all of this week's picks and what's matched to you."

**3. Personalisation reads as neutral when signed out.**
- In `lib/personalise/usePrefs.ts`, the hook returns `DEFAULT_PREFS` while `signedIn !== true`. Keep the existing localStorage → `user_metadata` merge on sign-in, so earlier visitors don't lose their answers. A signed-out `dismiss()` still records `done` locally, so the Home banner can be hidden.
- `lib/personalise/useEffectiveWho.ts` returns `[]` when signed out. This removes taste ranking from Home, Deals and What's on, and removes the "You qualify" chips from `FeedListCard`, `VenueDealCard` and `TodaysDealsStrip`. No per-component edits are needed.
- In `lib/personalise/affinity.ts`, the affinity read that `score.ts` uses returns `{}` when signed out. `components/ui/ShareButton.tsx` records affinity only when signed in, as `SaveButton` already does.

**4. Make Fomo yours: answer first, then sign in.** Signed-out visitors still see Home's banner and the For you prompt, and can fill in the sheet. Their answers go to localStorage as they do today, but the answers change nothing yet: `usePrefs` stays neutral while signed out. The sheet's last step becomes "Sign in to see your picks" (`sendToSignIn("personalise", "/for-you")`). The existing merge in `usePrefs.ts` copies the answers into `user_metadata` on sign-in, so they land on a personalised For you. Asking for the account after someone has answered converts better than asking before. Signed in, the sheet is unchanged.

**5. What's on "For you" sort chip** (`app/(shell)/whats-on/page.tsx`). Signed out, tapping it calls `sendToSignIn("for_you")` instead of toggling.

**6. For you teaser** (`app/(shell)/for-you/FindsClient.tsx`). Use `useSignedIn()` from `lib/useSaved.ts`, and add a new `components/finds/ForYouLocked.tsx`.
- `null`: show the top 2 picks in neutral order, and a skeleton where the sign-in card goes. This keeps the server HTML useful for Google and hydration-safe.
- `false`: show the same 2 picks, then the locked card ("N more picks this week, plus things matched to you", with a Sign in button → `sendToSignIn("for_you")`, keeping `?tab=`), then `SubscribeCard` as the no-account option. No Deals/Events switch and no recs. Fires `track("signin_prompt_shown", { reason: "for_you" })`.
- `true`: the current page, unchanged.

**6a. Server-side gate for the picks.**
- Edit `supabase/add_finds.sql` before it runs: the `read_live` policy becomes `to authenticated` only, so the anon key can't read `finds`.
- `lib/finds/load.ts` reads through `supabaseAdmin` (server-only). It gets a `limit` parameter.
- `app/(shell)/for-you/page.tsx` server-renders only the 2 teaser picks. It stays static (`revalidate = 120`).
- `app/api/finds/route.ts` checks the session with `supabaseServer().auth.getUser()`. Signed out, it returns the 2 teaser picks; signed in, it returns every pick. It stays in `PUBLIC_API_PREFIXES`.
- The "Picked for you" badge store (`lib/finds/useFinds.ts`) fetches only when signed in, so feed cards can't reveal the list.
- `scripts/finds.ts`, Fomo Friday and the IG carousel use the service role, so they're unaffected.

**7. Notify me** (`components/happenings/BookEarlyCard.tsx`). Signed out, `onNotify` calls `sendToSignIn("notify")` before the push permission prompt.

**8. Explore Google suggestions** (`components/explore/SearchAutocomplete.tsx`). Signed out, skip the `/api/places/autocomplete` fetch and show one row instead: "Sign in to search every place on Google Maps", which calls `sendToSignIn("places")`. "On Fomo" matches still work.

**9. Ask Fomo.** No limit changes. Check that `app/api/chat/route.ts` reads the account's `fomo_who` and prefs only for a signed-in user. Fix it if anonymous requests can pass prefs in.

**10. Docs + memory.** Save this plan to `docs/plans/2026-10-13-login-wall.md` and add a row to `docs/README.md` (plus any to-dos). Update the `fomo-pmf-plan` memory: the gating model is now "content public, personal needs account".

Work on a new branch `login-wall` off `desktop-parity`, which has the latest For you code. Commit, push, and open a PR.

## Verification
- `npx tsc --noEmit`, `npm run lint`, and `npx tsx --test lib/personalise/*.test.ts lib/finds/*.test.ts`. Add a test that `buildForYou` gets neutral prefs when signed out, if the gate sits in a pure function.
- Signed-out walkthrough in the preview (dev server):
  - `/for-you` shows 2 picks and a sign-in card.
  - Home, Deals and What's on show no "You qualify" chips. With a `fomo:prefs` value seeded in localStorage, the order still matches neutral.
  - The "Make Fomo yours" banner, the What's on chip, Book early "Notify me" and an Explore search each land on `/signin?reason=…&next=…` with the right copy.
  - The network tab shows no `/api/places/autocomplete` call.
  - Ask Fomo still answers 3 questions.
  - Bypass check: signed out, `curl /api/finds` returns 2 items. After the edited `add_finds.sql` runs, a Supabase REST call `GET /rest/v1/finds` with the anon key returns `[]`.
- Signed in: needs a real Google or email sign-in, which I can't do. The signed-in path is unchanged code, so after the PR preview deploys, check `/for-you` and the badges on your own account.

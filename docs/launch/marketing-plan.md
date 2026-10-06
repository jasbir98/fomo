# Fomo marketing plan (Oct–Dec 2026)

This is the strategy. The copy-paste material is in [launch-kit.md](launch-kit.md), and the weekly content machine is in [../content-loop.md](../content-loop.md).

## 1. Positioning

**One line:** Everything free and cheap on in Edinburgh this week, in one place.

**Who it's for first:** students and under-30s in Edinburgh who have little money and big fomo. Everyone else is a bonus. Don't broaden the message until this group retains.

**Why Fomo wins:**
- **Specific prices, not vague "deals":** £1 Traverse tickets, £4 cinema night, free comedy at Monkey Barrel. Every post names a price and a day.
- **"You qualify":** student, EH-postcode, under-26 and over-60 deals people don't know they're eligible for.
- **Ask Fomo:** "cheap date night in Leith on Friday" gets an answer, shown on a map. Nobody else locally does this, so it's the demo for every Reel.
- **Fresh daily:** the Thursday weekend list is new every week, which gives people a reason to come back.

**Never:**
- Post or promote full-price things. It breaks the promise.
- Call it "an events app". Call it "the cheap stuff in Edinburgh".

## 2. What success looks like (measure before you spend)

**North star:** weekly active planners, meaning people who save something or click out to tickets or a deal in a given week. These are PostHog's `save_added` and `outbound_clicked` events.

| Check | Healthy | Where |
|---|---|---|
| Week-1 → week-4 return | ≥ 25% | PostHog retention |
| Visitors who save or click out | ≥ 30% | PostHog funnel |
| Sign-ins per week (`signin_completed`, `is_new_user`) | growing week on week | PostHog |
| Best channel | highest planners per hour spent | UTM `utm_source` |
| Fomo Friday open rate | ≥ 40% | Resend |

**Rules:**
- No paid ads until week-4 return is at least about 25%. Paying to fill a leaky bucket is wasted money.
- Run `node --env-file=.env.local scripts/weekly-metrics.mjs` every Monday.

## 3. Calendar hooks (plan posts around these)

| When | Hook |
|---|---|
| Every Thu | "Edinburgh on £10 this weekend" (carousel + Reddit list) |
| Mid–late Oct | Free things when it's raining; Halloween on a budget |
| Sat 31 Oct | Halloween nights under £10 |
| Thu 5 Nov | Bonfire Night: free fireworks and where to watch |
| November | "Skint November", student loans running out: £5 lunches, free nights in town |
| Mid-Nov onwards | Christmas markets, free festive lights and events |
| Late Nov | St Andrew's Day: check Historic Environment Scotland free-entry offers |
| December | Exam season: free study spots, cheap eats, cheap things to do with family visiting |
| Late Dec | Hogmanay on a budget |

## 4. Channels, ranked for 5–15 hours a week

### 1. Instagram @askfomo (core, about 3 h a week)

**Every week:**
- **Thursday carousel:** generate it with `scripts/ig-carousel.mjs`.
- **Two Reels.**
- **One Story a day:** "deal of the day" with a link sticker and a "Would you go?" poll.

**Reel formats that work for local accounts:**
- **Street vox-pop:** "What's the best cheap thing to do in Edinburgh?" Film on the Meadows, Bristo Square or Leith Walk. This is the single best format for local growth.
- **"I tried…":** every £5 lunch deal on Nicolson St; the £4 cinema night; a free comedy night.
- **Lists with a face:** "3 free things to do this weekend", 15–25 s, text on screen, subtitles always on.
- **Ask Fomo screen recordings:** type a real question and show the answers landing on the map.

**Getting reach:**
- **First frame:** the hook as text, plus a price ("£1 theatre?!").
- **Posting time:** 12:00–13:00 or 19:00–21:00.
- **Captions:** end with "Send this to the group chat 💬" (shares) and "Save for the weekend 🔖" (saves).
- **Collabs:** use Collab posts with venues and societies so the post shows on both accounts.
- **Judge posts by saves and shares, not likes.**

### 2. TikTok (about 15 min a week extra)

Post the same Reels, without the Instagram watermark. Students discover things here more than anywhere. It's the same work for double the reach.

### 3. Reddit r/Edinburgh (about 45 min a week)

- **Read the rules first.** Message the mods to offer a weekly "Free & cheap things on this weekend" list. A mod-approved recurring thread is gold.
- **What a post is:** a genuinely useful list of 8–10 items with prices and days. Put the Fomo link once, at the bottom (template in the launch kit).
- **Answer questions:** reply to every "what's on / cheap food / things to do" question with a real answer. Link Fomo only when it's actually useful.
- **Never:**
  - Post a bare link.
  - Use several accounts.
  - Ask people to upvote.
- **Also try:** r/EdinburghUni (if active) and r/Scotland, but only for big lists like "free things to do in Edinburgh this winter".

### 4. WhatsApp and group chats (the growth loop)

- **Fomo Insiders WhatsApp community:**
  - Post the weekend list every Thursday.
  - Ask insiders to forward it to one group chat.
  - Thank people by name when they send a tip.
- **The product is the loop:** every shared link is tagged with `utm_source=share`. Watch that number. If it grows week on week, word of mouth is working.

### 5. Students' unions and societies (about 1.5 h a week)

- **Who:** Edinburgh University Students' Association (Teviot, Potterrow), Napier Students' Association, Heriot-Watt Union, Queen Margaret University SU. Ask for a slot in their newsletter or "what's on" posts.
- **Societies:**
  - DM 5 a week (template in the launch kit).
  - Offer to list their events for free, and give each one a tagged link.
- **Campus ambassadors:** one per university.
  - The offer: free perks or a small pizza budget, a "Fomo ambassador" Story highlight, and their own UTM link.
  - What they do: share the Thursday list in their course and society group chats.
- **Posters:** QR posters only where they're allowed: union boards and libraries. Use "Never miss £1 theatre again."

### 6. Venues (about 30 min a week)

- **Tell featured venues:** message every venue whose deal is on Fomo (template in the launch kit) and give them a ready-made "Find us on Fomo" Story image. Venues love free promotion and reshare to exactly the right local audience.
- **Get deals early:** ask featured venues to send you deals before anyone else. This becomes a supply advantage over time.

### 7. Local press and newsletters (one push, then occasionally)

**The pitch:** "Edinburgh founder builds a free app so students stop missing £1 theatre and free comedy." Lead with a hard number: "X free and cheap things on this week".

**Pitch it to:**
- Edinburgh Live
- Edinburgh Evening News
- The Edinburgh Reporter
- The Skinny
- Secret Edinburgh
- Edinburgh-focused newsletters
- Student papers: The Student, The Tab Edinburgh

**When to send it:** just before a calendar hook (Bonfire Night, Christmas markets) when they need list content anyway.

### 8. Search (slow, compounding)

- **What already ranks:** /weekend, /free, /deals, /whats-on and every detail page have proper titles and previews.
- **What to target:** "free things to do in Edinburgh", "cheap things to do in Edinburgh this weekend" and "student discounts Edinburgh".
- **How:** keep those pages fresh. Freshness is the advantage.

### 9. X (low priority)

Not where Edinburgh students find plans. Use it only for building in public (screenshots, numbers, lessons) and the founder network. Spend no more than 15 min a week.

## 5. Launch sequence

1. **This week (5–9 Oct):**
   - Ship the pre-launch fixes.
   - In the dashboards: set up custom SMTP for sign-in emails, and check PostHog and Resend in production.
   - Do 5 user calls using the Mom Test questions in the launch kit.
   - Start the Insiders WhatsApp community with 20–30 friends.
2. **Thu 15 Oct, wider launch:**
   - Instagram launch carousel (pin it).
   - The Reddit weekend list.
   - Insiders forward the launch message to their group chats.
   - First society DMs.
3. **Weeks 2–4:**
   - The weekly rhythm below.
   - Ambassadors at 2 universities.
   - Pitch press before Bonfire Night.
4. **Week 3 onwards:**
   - Put the £50 boost on the best organic post (most saves and shares), for ages 18–30 within 10 km of Edinburgh, sending people to `/weekend?utm_source=ig_paid`.
   - Only continue if `ig_paid` users save or click out at least as well as organic ones.

## 6. Weekly rhythm (about 6 hours)

| Day | Task | Time |
|---|---|---|
| Mon | `weekly-metrics.mjs`, PostHog check, 1 user call | 1 h |
| Tue | 5 society or venue DMs, reply to tips | 45 min |
| Wed | `ig-carousel.mjs`, film and edit 2 Reels | 2 h |
| Thu | Post the carousel, Reddit list, Insiders post | 45 min |
| Fri | Fomo Friday email (dry run → test → `--send`) | 30 min |
| Daily | One Story; reply to comments and DMs within 2 h | 10 min |

## 7. Don't

- Run paid ads before retention.
- Buy followers or engagement pods.
- Link-dump in subreddits or Facebook groups.
- Post anything that isn't free or cheap.
- Post screenshots of other accounts' content.
- Promise deals you haven't checked that week.

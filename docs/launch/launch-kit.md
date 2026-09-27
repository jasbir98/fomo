# Fomo v1 launch kit (Edinburgh)

Copy-paste material for the soft launch (Thu 1 Oct) and the wider launch (Thu 8 Oct).

Every link carries UTM tags so PostHog can show which channel works. Keep the tags when you edit a link.

---

## 1. Instagram

**Account type:** Professional → Creator (free; unlocks insights and link stickers)

**Name field:** `Fomo · Edinburgh for less` (the name field is searchable, so the keywords matter)

**Bio:**
```
Free & cheap things to do in Edinburgh 🏴󠁧󠁢󠁳󠁣󠁴󠁿
Student deals · pub quizzes · free comedy
New picks every Thursday ↓
```

**Link:** `https://askfomo.com/weekend?utm_source=instagram&utm_medium=bio`

**Highlights** (make a cover for each from the mascot on navy):
- **This weekend:** re-share each Thursday's carousel.
- **Student deals**
- **Free stuff**
- **How to use:** save, deals, "You qualify".

### The first 9 posts (one a day from Mon 28 Sep; pin 1, 2 and 3)

| # | Format | Hook (the first slide must stop the scroll) | Content |
|---|---|---|---|
| 1 📌 | Carousel ×4 | "Edinburgh has hundreds of free & cheap things on every week. You just never hear about them." | Slides 2–4 are app screenshots: Today's deals, This weekend, and "You qualify". Final slide: "askfomo.com — link in bio". |
| 2 📌 | Carousel (auto) | "Edinburgh on £10 this weekend" | Run `node --env-file=.env.local scripts/ig-carousel.mjs` on Wednesday and post Thursday morning. |
| 3 📌 | Carousel ×6 | "Student deals nobody tells you about 🎓" | Traverse £1 tickets · Filmhouse £7 Young Member (£3 unwaged) · Capital Theatres £10 (25 & under) · BrewDog Doghouse U25 50% off Sundays · Scottish Opera U26 £15 · £6 U26 orchestra tickets (BBC SSO / SCO) |
| 4 | Carousel ×7 | "A pub quiz for every night of the week (most are free)" | Mon: Festival Tavern · Tue: Pilgrim / Steel Coulson · Wed: Victoria Bar · Thu: Golf Tavern · Fri: The Court · + Rabble, Wilkies, George IV (check each night on Fomo before posting) |
| 5 | Reel 15–25s | "Free comedy in Edinburgh this week 😂" | Film outside Monkey Barrel. Text overlays with Improv Jam (free), CHUNKS (£3, free for students), Stu & Garry's (free) |
| 6 | Carousel ×5 | "Got an EH postcode? These are 20% off for you" | Camera Obscura 20% · Edinburgh Bus Tours 20% · Scotch Whisky Experience £5 off · Down the Hatch 20% off food |
| 7 | Carousel ×5 | "Free things to do in Edinburgh when it's raining ☔" | National Museum (free) · National Galleries (free) · lectures (Edinburgh Futures Institute, free) · Filmhouse cheap tickets · Sunday Night Laugh-In (check listing) |
| 8 | Single image | "October in Edinburgh 🎃" | Pumpkins After Dark · Fungi Festival · Storytelling Festival · Halloween nights (update it closer to the date) |
| 9 | Reel | "I built an app because I kept missing cheap stuff in Edinburgh" | A 20s talking head: the founder's story, plus a phone screen recording |

**Caption template:**
```
<hook line>

<3–5 lines of value — names, prices, days>

📲 Everything's on askfomo.com (link in bio) — updated daily, free, no account needed.
Save this for the weekend 🔖  ·  Send it to the group chat 💬

#edinburgh #edinburghstudents #edinburghevents #thingstodoinedinburgh #edinburghfood #scotland
```

**Stories:** one "deal of the day" every day.
- Screenshot the deal's Fomo page.
- Add a link sticker to `https://askfomo.com/happening/<id>?utm_source=instagram&utm_medium=story`.
- Add a "Would you go?" poll. Poll taps feed the algorithm.

**What to measure:** saves and shares, not likes. They predict reach and are the signal for which post to boost with the £50.

---

## 2. Soft-launch DM (Thu 1 Oct, 20–30 close friends; send each one individually)

```
Hey <name>! I've been building a little thing for Edinburgh — Fomo 🟠
It finds free & cheap stuff on each week (student deals, free comedy, pub quizzes, £1 theatre…).

Could you use it to plan something this weekend and tell me:
1) one thing that sucked / confused you
2) one thing you'd actually miss if it disappeared

👉 https://askfomo.com/weekend?utm_source=dm&utm_campaign=soft-launch

No account needed. Brutal honesty > nice 🙏
```

Then add them to the **WhatsApp community "Fomo Insiders"** and post this welcome:

```
Welcome to Fomo Insiders 👋 You're the first people using this.
• Drop anything broken/annoying here — I fix most things within a day
• Every Thursday I'll post the best cheap stuff for the weekend
• Know a deal we're missing? Tell me or use askfomo.com/tip
```

## 3. Wider launch (Thu 8 Oct): the message insiders forward to group chats

```
Found this for Edinburgh — shows everything free/cheap on this weekend + student deals 👀
https://askfomo.com/weekend?utm_source=whatsapp&utm_campaign=launch
```

## 4. r/Edinburgh post (check the subreddit rules and flair first; post as useful content, not an ad)

**Title:** `Free & cheap things on in Edinburgh this week (I made a list — and a site that updates it daily)`

**Body:** 8–10 genuinely good items with prices and days. Then one line at the bottom:
> "I got fed up missing these so I built askfomo.com (free, no sign-up) — feedback very welcome, especially what's missing."

Link: `https://askfomo.com/weekend?utm_source=reddit&utm_campaign=launch`

Reply to every comment within the first 2 hours.

## 5. Student society DM (weeks 2–4; 3–5 societies)

```
Hi <society>! I run Fomo (askfomo.com) — a free site listing cheap/free things on in Edinburgh for students.
Happy to list your events for free (just send a link or I'll pick them up), and we'd love it if you shared
Fomo with members once. Here's your link so we can see it's from you: https://askfomo.com/weekend?utm_source=society&utm_content=<society-slug>
```

## 6. Venue DM (for venues whose deal is already on Fomo)

```
Hi <venue> — your <deal> is featured on Fomo (askfomo.com/happening/<id>), a free guide to cheap things in Edinburgh.
If you'd like to share it, here's the link 👉 <link>?utm_source=venue&utm_content=<venue-slug>
Anything wrong or out of date? Just reply and we'll fix it the same day.
```

## 7. QR posters (unions and libraries, only where allowed)

- One link per location, e.g. `askfomo.com/weekend?utm_source=poster&utm_content=teviot`.
- Headline: **"Never miss £1 theatre again."**
- Sub-line: "Free & cheap things in Edinburgh, every week → scan"

## 8. £50 boost (from week 3)

- **What:** the 1–2 posts with the most organic **saves and shares** (not likes).
- **Audience:** ages 18–30, within 10 km of Edinburgh.
- **Budget:** £5–7 a day for 5–7 days.
- **Destination:** `/weekend?utm_source=ig_paid&utm_campaign=boost-<n>`
- **Judge it by:** PostHog → people from `ig_paid` who clicked out to tickets or deals (`outbound_clicked`).

## 9. Five user calls (Mon 5–Wed 7 Oct): Mom Test questions

- "Walk me through how you decided what to do last weekend."
- "Where did you look? What did it cost? What nearly made you not go?"
- "When did you last find a deal you didn't know about? How?"
- "Show me how you'd use Fomo to plan this Friday." (Watch them; don't help.)
- Don't ask "would you use this?" or "do you like it?" People are polite.

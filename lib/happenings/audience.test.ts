// Run: npx tsx --test lib/happenings/audience.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { nicheAudience } from "./audience";

test("niche audiences from live titles", () => {
  const cases: [string, string][] = [
    ["Festival Theatre’s Dementia Friendly Activities", "accessibility"],
    ["Relaxed Performance: The Nutcracker", "accessibility"],
    ["Seniors Tea Dance", "older"],
    ["Edinburgh Trams Free Travel Over 60s", "older"],
    ["Edinburgh Professionals Quarterly Networking - Thursday, 26th November", "professional"],
    ["Professional Negligence Law Conference 2026", "professional"],
    ["The Business Connection Networking Breakfast (Edinburgh)", "professional"],
    ["AgriScot 2026", "professional"],
    ["Irish Language Classes", "course"],
    ["First Aid at Work (FAW) Course - Edinburgh", "course"],
    ["Bereavement Support Group", "support"],
    ["Bilingualism Talk at the Pregnancy & Parents Centre", "parents"],
    ["Antenatal Yoga", "parents"],
  ];
  for (const [title, audience] of cases) assert.equal(nicheAudience(title), audience, title);
});

test("for-anyone titles stay null", () => {
  for (const title of [
    "Monday Quiz at The Festival Tavern",
    "The Comedy Cellar Edinburgh Live Stand-Up Comedy",
    "Silent Disco at the Museum",
    "Annasach's Hogmanay Ceilidh",
    "Silent Reading Group",
    "Book Launch: Fighting for our Minds, the neuroscience of defeating dementia",
    "Good Grief: a comedy",
    "Arthur's Seat Summit Sunrise Walk",
    "Sociograss",
    "Dance Class for Beginners",
    "Parents of the Bride (play)",
  ]) {
    assert.equal(nicheAudience(title), null, title);
  }
});

test("description only counts for the narrow dementia-friendly phrase", () => {
  assert.equal(nicheAudience("Afternoon Tea Concert", "A dementia-friendly concert with tea."), "accessibility");
  assert.equal(nicheAudience("Gig", "Raising money for networking and conference costs."), null);
});

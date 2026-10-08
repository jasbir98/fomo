import { test } from "node:test";
import assert from "node:assert/strict";
import { eventbriteProviderEventId } from "./eventbrite.mjs";

test("eventbrite provider_event_id: .com and .sg variants map to the .co.uk key", () => {
  assert.equal(
    eventbriteProviderEventId("https://www.eventbrite.com/e/women-in-tech-1828174943469"),
    "https://www.eventbrite.co.uk/e/women-in-tech-1828174943469",
  );
  assert.equal(
    eventbriteProviderEventId("https://www.eventbrite.sg/e/unlock-edinburgh-1999779213460"),
    "https://www.eventbrite.co.uk/e/unlock-edinburgh-1999779213460",
  );
});

test("eventbrite provider_event_id: .co.uk keys are unchanged", () => {
  const key = "https://www.eventbrite.co.uk/e/the-emine-1993762376940";
  assert.equal(eventbriteProviderEventId(key), key);
});

test("eventbrite provider_event_id: non-Eventbrite keys are untouched", () => {
  assert.equal(eventbriteProviderEventId("https://lu.ma/walter-trout"), "https://lu.ma/walter-trout");
});

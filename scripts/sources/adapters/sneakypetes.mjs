/**
 * sneakypetes adapter — Sneaky Pete's venue RSS feed (sneakypetes.co.uk/feed),
 * driven by the generic venue-RSS adapter. Config lives in VENUE_RSS_FEEDS.
 */

import { adapterVenueRssFeed, VENUE_RSS_FEEDS } from "./venue-rss.mjs";

export default {
  name: "sneakypetes",
  cadence: "daily",
  status: "live",
  async run({ now }) {
    return adapterVenueRssFeed(VENUE_RSS_FEEDS.find((f) => f.provider === "sneakypetes"), now);
  },
};

/**
 * Ordered adapter registry for scripts/daily-sources.mjs. Run order is the
 * array order. Each adapter is `{ name, cadence, status, run(ctx) }`:
 *   - cadence: "daily" runs every time; "weekly" runs only on Mondays
 *     (Europe/London), when named in --only, or with --all-cadences.
 *   - status: "live" rows are upserted; "shadow" adapters run and report but
 *     their rows never reach the upsert (summary labels them `[shadow]`).
 *   - run(ctx): ctx = { now }; returns { provider, rows, stats }.
 */

import luma from "./adapters/luma.mjs";
import eventbrite from "./adapters/eventbrite.mjs";
import songkick from "./adapters/songkick.mjs";
import allevents from "./adapters/allevents.mjs";
import skiddle from "./adapters/skiddle.mjs";
import ticketmaster from "./adapters/ticketmaster.mjs";
import sneakypetes from "./adapters/sneakypetes.mjs";
import { voodoorooms } from "./adapters/tribe-events.mjs";
import edfestivals from "./adapters/festivals-api.mjs";
import foreveredinburgh from "./adapters/forever-edinburgh.mjs";
import jazzbar from "./adapters/jazzbar.mjs";

export const ADAPTERS = [luma, eventbrite, songkick, allevents, skiddle, ticketmaster, sneakypetes, voodoorooms, edfestivals, foreveredinburgh, jazzbar];

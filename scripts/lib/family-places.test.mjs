import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BBOX,
  MAX_REQUESTS,
  QUERIES,
  buildSearchBody,
  buildStagingRow,
  classifyPlace,
  dedupeKey,
  estimateCost,
  evaluateCandidate,
  findExisting,
  findRunDuplicate,
  insideBbox,
  isMissingColumnError,
  passesFilter,
  postcodeOf,
  strongNameMatch,
  summarise,
} from "./family-places.mjs";

const g = (over = {}) => ({
  id: "ChIJabc123",
  displayName: { text: "Test Place" },
  formattedAddress: "1 Test St, Edinburgh EH1 1AA, UK",
  location: { latitude: 55.95, longitude: -3.19 },
  types: ["point_of_interest", "establishment"],
  userRatingCount: 100,
  rating: 4.5,
  businessStatus: "OPERATIONAL",
  ...over,
});

test("queries fit the request cap", () => {
  assert.ok(QUERIES.length <= MAX_REQUESTS);
  assert.equal(QUERIES.length, 14);
  assert.equal(estimateCost(14), 0.56);
});

test("search body restricts to the Edinburgh rectangle, GB, one page", () => {
  const b = buildSearchBody("soft play");
  assert.deepEqual(b.locationRestriction.rectangle.low, { latitude: 55.87, longitude: -3.35 });
  assert.deepEqual(b.locationRestriction.rectangle.high, { latitude: 55.99, longitude: -3.05 });
  assert.equal(b.regionCode, "GB");
  assert.equal(b.pageSize, 20);
  assert.equal(b.locationBias, undefined);
});

test("insideBbox", () => {
  assert.ok(insideBbox(55.95, -3.19));
  assert.ok(!insideBbox(55.80, -3.19));
  assert.ok(!insideBbox(55.95, -3.40));
  assert.ok(!insideBbox(null, -3.19));
  assert.equal(BBOX.north, 55.99);
});

test("filter: schools, nurseries, childcare, hotels, pubs, shops are dropped", () => {
  assert.equal(passesFilter(g({ types: ["primary_school"] })).ok, false);
  assert.equal(passesFilter(g({ types: ["child_care_agency"] })).ok, false);
  assert.equal(passesFilter(g({ types: ["preschool"] })).ok, false);
  assert.equal(passesFilter(g({ types: ["lodging"] })).ok, false);
  assert.equal(passesFilter(g({ types: ["bar", "restaurant"] })).ok, false);
  assert.equal(passesFilter(g({ types: ["toy_store", "store"] })).ok, false);
  assert.equal(passesFilter(g({ displayName: { text: "Little Acorns Nursery" } })).ok, false);
  assert.equal(passesFilter(g({ displayName: { text: "Sunny Days Childminder" } })).ok, false);
});

test("filter: a museum with a gift shop is still kept", () => {
  assert.equal(passesFilter(g({ types: ["museum", "store"], userRatingCount: 2 })).ok, true);
});

test("filter: status, bbox, rating count / keep types", () => {
  assert.equal(passesFilter(g({ businessStatus: "CLOSED_PERMANENTLY" })).ok, false);
  assert.equal(passesFilter(g({ businessStatus: "CLOSED_TEMPORARILY" })).ok, false);
  assert.equal(passesFilter(g({ businessStatus: undefined })).ok, true);
  assert.equal(passesFilter(g({ location: { latitude: 56.1, longitude: -3.19 } })).ok, false);
  assert.equal(passesFilter(g({ userRatingCount: 14 })).ok, false);
  assert.equal(passesFilter(g({ userRatingCount: 15 })).ok, true);
  assert.equal(passesFilter(g({ userRatingCount: 3, types: ["playground"] })).ok, true);
  assert.equal(passesFilter(g({ userRatingCount: undefined, types: ["park"] })).ok, true);
  assert.equal(passesFilter(g({ userRatingCount: 3, types: ["swimming_pool"] })).ok, true);
});

test("classify: kids vs all_ages per the brief", () => {
  const c = (name, types = [], extra = {}, foundBy = []) => classifyPlace(g({ displayName: { text: name }, types, ...extra }), foundBy);
  assert.deepEqual(c("Saughton Park Playground", ["playground"]), { category: "playground", family_fit: "kids", reason: "type playground" });
  assert.equal(c("Inverleith Park", ["playground", "park"]).category, "playground");
  assert.equal(c("Jungle Jims Soft Play", ["amusement_center"]).category, "soft play");
  assert.equal(c("Jungle Jims Soft Play", ["amusement_center"]).family_fit, "kids");
  assert.equal(c("Jump Inc Trampoline Park", ["amusement_center"]).category, "trampoline park");
  assert.equal(c("Splash Park Portobello", ["park"]).category, "splash park");
  assert.deepEqual(c("Gorgie City Farm", ["tourist_attraction"]), { category: "farm", family_fit: "all_ages", reason: "name: farm" });
  assert.equal(c("Wee Kids Farm", []).family_fit, "kids");
  assert.equal(c("Central Library", ["library"]).family_fit, "all_ages");
  assert.equal(c("Central Children's Library", ["library"]).family_fit, "kids");
  assert.deepEqual([c("Royal Commonwealth Pool", ["swimming_pool"]).category, c("Royal Commonwealth Pool", ["swimming_pool"]).family_fit], ["swimming pool", "all_ages"]);
  assert.equal(c("Leith Victoria Swim Centre", ["sports_complex"]).family_fit, "all_ages");
  assert.equal(c("Ainslie Park Leisure Centre", ["sports_complex"]).category, "leisure centre");
  assert.equal(c("National Museum of Scotland", ["museum"]).family_fit, "all_ages");
  assert.equal(c("Ratho Climbing Wall", ["sports_activity_location"]).category, "climbing centre");
});

test("classify: cafes need goodForChildren or a kid-friendly name; parks and generic results get nothing", () => {
  assert.equal(classifyPlace(g({ types: ["cafe"], goodForChildren: true })).category, "cafe");
  assert.equal(classifyPlace(g({ types: ["cafe"] })), null);
  assert.equal(classifyPlace(g({ types: ["cafe"], displayName: { text: "The Family Kitchen" } }))?.family_fit, "all_ages");
  assert.equal(classifyPlace(g({ types: ["park"], displayName: { text: "Holyrood Park" } })), null);
  assert.equal(classifyPlace(g({ types: ["tourist_attraction"] })), null);
});

test("classify: a generic amusement centre or arcade is not tagged on the query alone", () => {
  const p = g({ displayName: { text: "Funstation" }, types: ["amusement_center", "video_arcade"] });
  assert.equal(classifyPlace(p, ["trampoline park"]), null);
  assert.equal(classifyPlace(g({ displayName: { text: "Department of Magic" }, types: ["amusement_center"] }), ["soft play"]), null);
});

test("classify: inflatable / Funparx names are soft play; weak climbing words need the climbing query", () => {
  assert.equal(classifyPlace(g({ displayName: { text: "Air Thrill Inflatable Party Venue" }, types: ["adventure_sports_center"] })).category, "soft play");
  assert.equal(classifyPlace(g({ displayName: { text: "Funparx Edinburgh" } })).category, "soft play");
  const rock = g({ displayName: { text: "Eden Rock Edinburgh" }, types: ["sports_activity_location"] });
  assert.equal(classifyPlace(rock, []), null);
  assert.equal(classifyPlace(rock, ["climbing centre kids"]).category, "climbing centre");
});

test("classify: farms need a farm name/type and not a restaurant, stables or farm shop", () => {
  assert.equal(classifyPlace(g({ displayName: { text: "BobCat Alpacas" }, types: ["farm", "service"] })).family_fit, "all_ages");
  assert.equal(classifyPlace(g({ displayName: { text: "Swanston Farm & Brasserie" }, types: ["farm", "service"] })), null);
  assert.equal(classifyPlace(g({ displayName: { text: "Tower Farm Riding Stables" }, types: ["sports_school"] })), null);
  assert.equal(classifyPlace(g({ displayName: { text: "Farmshop Edinburgh" }, types: ["food_store", "store"] })), null);
});

test("classify: pools need a pool-ish name; gyms with a pool and swim schools are not family pools", () => {
  assert.equal(classifyPlace(g({ displayName: { text: "Village Gym Edinburgh" }, types: ["gym", "swimming_pool"] })), null);
  assert.equal(classifyPlace(g({ displayName: { text: "swim@ Edinburgh City West" }, types: ["swimming_pool", "sports_school"] })), null);
  assert.equal(classifyPlace(g({ displayName: { text: "Dalry Swim Centre" }, types: ["swimming_pool", "gym"] })).category, "swimming pool");
});

test("classify: a sports complex is a leisure centre only when Google lists a pool", () => {
  assert.equal(classifyPlace(g({ displayName: { text: "Pleasance Sports Complex & Gym" }, types: ["gym", "sports_complex"] })), null);
  assert.equal(classifyPlace(g({ displayName: { text: "Meadowbank Sports Centre" }, types: ["sports_complex", "swimming_pool"] })).category, "leisure centre");
});

test("classify: a Little Free Library box is not a library", () => {
  assert.equal(classifyPlace(g({ displayName: { text: "Little Free Library" }, types: ["library"] })), null);
});

test("filter: generic names, towns outside the city, and café exceptions", () => {
  assert.equal(passesFilter(g({ displayName: { text: "Play Area" }, types: ["playground"] })).ok, false);
  assert.equal(passesFilter(g({ types: ["playground"], formattedAddress: "Via Town Gate, Dalkeith EH22 2NA, UK" })).ok, false);
  assert.equal(passesFilter(g({ types: ["swimming_pool"], formattedAddress: "21 Dalkeith Rd, Edinburgh EH16 5BB, UK" })).ok, true);
  assert.equal(passesFilter(g({ types: ["cafe", "food_store", "store"], goodForChildren: true })).ok, true);
  assert.equal(passesFilter(g({ types: ["cafe", "food_store", "store"] })).ok, false);
  assert.equal(passesFilter(g({ types: ["cafe", "bar"], goodForChildren: true })).ok, false);
});

test("findExisting: a one-word name prefix never matches (The Fountain bar vs Fountain Park)", () => {
  const place = g({ id: "F", displayName: { text: "Fountain Park" }, location: { latitude: 55.9400, longitude: -3.2150 } });
  const bar = { id: "b", name: "The Fountain", category: "bar", lat: 55.9401, lng: -3.2151, source: "seed-edinburgh-local" };
  assert.equal(findExisting(place, [bar]), null);
  assert.equal(strongNameMatch("Camera Obscura", "Camera Obscura & World of Illusions"), true);
  assert.equal(strongNameMatch("Filmhouse", "Filmhouse Bar"), false);
});

test("evaluateCandidate explains drops", () => {
  assert.equal(evaluateCandidate(g({ types: ["park"], displayName: { text: "Holyrood Park" } })).reason, "park with no playground evidence");
  assert.equal(evaluateCandidate(g({ types: ["school"] })).keep, false);
  const ok = evaluateCandidate(g({ types: ["playground"] }));
  assert.equal(ok.keep, true);
  assert.equal(ok.family_fit, "kids");
});

test("findExisting: google id first, then name+proximity; provider-cache rows ignored", () => {
  const place = g({ id: "ChIJX", displayName: { text: "Gorgie City Farm" }, location: { latitude: 55.9370, longitude: -3.2420 } });
  const byId = { id: "1", name: "Totally different name", google_place_id: "ChIJX", source: "seed-edinburgh-local" };
  assert.equal(findExisting(place, [byId]).by, "google_place_id");
  const byName = { id: "2", name: "Gorgie City Farm", lat: 55.9371, lng: -3.2421, source: "seed-edinburgh-local" };
  assert.equal(findExisting(place, [byName]).by, "name+proximity");
  const far = { id: "3", name: "Gorgie City Farm", lat: 55.99, lng: -3.0, source: "seed-edinburgh-local" };
  assert.equal(findExisting(place, [far]), null);
  const cache = { id: "4", name: "Gorgie City Farm", lat: 55.9371, lng: -3.2421, google_place_id: "ChIJX", source: "google" };
  assert.equal(findExisting(place, [cache]), null);
});

test("findExisting: a large venue pinned >250 m away is still matched by identical name within 1.5 km", () => {
  const zoo = g({ id: "Z", displayName: { text: "Edinburgh Zoo" }, formattedAddress: "134 Corstorphine Rd, Edinburgh EH12 6TS, UK", location: { latitude: 55.9431, longitude: -3.2680 } });
  const row = { id: "r", name: "Edinburgh Zoo", lat: 55.9426, lng: -3.2634, address: "134 Corstorphine Road, Edinburgh EH12 6TS, Scotland", source: "seed-scotland-pipeline" };
  assert.equal(findExisting(zoo, [row]).by, "name+area");
  assert.equal(findExisting(zoo, [{ ...row, lat: 55.98, lng: -3.1, address: "elsewhere" }]), null);
});

test("findRunDuplicate", () => {
  const a = g({ id: "A", displayName: { text: "Fun Play" } });
  assert.ok(findRunDuplicate(g({ id: "A" }), [a]));
  assert.ok(findRunDuplicate(g({ id: "B", displayName: { text: "Fun  Play" } }), [a]));
  assert.equal(findRunDuplicate(g({ id: "B", displayName: { text: "Fun Play" }, location: { latitude: 55.97, longitude: -3.19 } }), [a]), null);
});

test("postcodeOf", () => {
  assert.equal(postcodeOf("5 Foo Rd, Edinburgh EH12 5BQ, UK"), "EH12 5BQ");
  assert.equal(postcodeOf("nowhere"), null);
});

test("dedupeKey follows the Edinburgh convention and avoids clashes", () => {
  const taken = new Set();
  assert.equal(dedupeKey("Gorgie City Farm", "ChIJ111aaa", taken), "name:city-of-edinburgh:gorgie-city-farm");
  assert.equal(dedupeKey("Gorgie City Farm", "ChIJ222bbb", taken), "name:city-of-edinburgh:gorgie-city-farm-222bbb");
});

test("buildStagingRow has the staging shape, family_fit, approved=false and no Google-owned facts", () => {
  const entry = {
    name: "Test Soft Play", google_place_id: "ChIJz", category: "soft play", family_fit: "kids", address: "1 A St, Edinburgh EH1 1AA",
    lat: 55.95, lng: -3.19, price_level: 2, hours: "Daily 09:00–17:00", rating: 4.8, website: "https://x", phone: "0131",
  };
  const row = buildStagingRow(entry, { batchId: "family-places-2026-10-20", now: new Date("2026-10-20T10:00:00Z") });
  assert.equal(row.batch_id, "family-places-2026-10-20");
  assert.equal(row.prefecture, "City of Edinburgh");
  assert.equal(row.country, "GB");
  assert.equal(row.family_fit, "kids");
  assert.equal(row.approved, false);
  assert.equal(row.rating, null);
  assert.equal(row.hours_status, "known");
  assert.equal(row.price_level, 2);
  assert.equal(row.website, undefined);
  assert.equal(row.description, null);
  assert.equal(buildStagingRow({ ...entry, hours: null }, { batchId: "b" }).hours_status, "unknown");
});

test("isMissingColumnError", () => {
  assert.ok(isMissingColumnError(400, '{"code":"42703","message":"column places_staging.family_fit does not exist"}'));
  assert.ok(isMissingColumnError(400, '{"code":"PGRST204","message":"Could not find the family_fit column"}'));
  assert.ok(!isMissingColumnError(500, "boom"));
});

test("summarise", () => {
  const s = summarise([
    { status: "new", family_fit: "kids", category: "playground" },
    { status: "new", family_fit: "all_ages", category: "museum" },
    { status: "existing", family_fit: "all_ages", category: "museum" },
  ]);
  assert.deepEqual(s.new_by_family_fit, { kids: 1, all_ages: 1 });
  assert.equal(s.existing, 1);
});

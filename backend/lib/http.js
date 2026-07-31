// Shared helpers for the JSON API endpoints the web app calls.

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // The app is served from the same Vercel domain, so no cross-origin allowance is needed.
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(body));
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

// Vercel parses JSON bodies automatically, but be defensive: a string body shows up
// when the content-type header is missing or wrong.
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

const ROOM_CAPACITY = 2;

// Rooms are never stored — always derived, and always split by gender.
// Confirmed rule: 2 people per room, men and women never share.
function roomsFor(guests) {
  const male = guests.filter((g) => g.gender === 'M').length;
  const female = guests.filter((g) => g.gender === 'F').length;
  return Math.ceil(male / ROOM_CAPACITY) + Math.ceil(female / ROOM_CAPACITY);
}

function nightsBetween(checkin, checkout) {
  if (!checkin || !checkout) return 0;
  const ms = new Date(checkout).getTime() - new Date(checkin).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

// How many more men/women could still fit without opening a new room —
// used to guard "add a guest to an existing booking" against overfilling.
function emptyBedsByGender(guests) {
  const male = guests.filter((g) => g.gender === 'M').length;
  const female = guests.filter((g) => g.gender === 'F').length;
  return {
    maleEmpty: Math.ceil(male / ROOM_CAPACITY) * ROOM_CAPACITY - male,
    femaleEmpty: Math.ceil(female / ROOM_CAPACITY) * ROOM_CAPACITY - female
  };
}

module.exports = { json, fail, readBody, ROOM_CAPACITY, roomsFor, nightsBetween, emptyBedsByGender };

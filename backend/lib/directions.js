// Shared OpenRouteService (free, no-card) driving-distance lookup — used both by
// api/directions.js (the employee-facing check shown right after branch selection)
// and bookings.js (the authoritative server-side recheck at booking creation, so
// the home-distance-rule can't be spoofed by a client-supplied number).
async function drivingDistance(fromLat, fromLng, toLat, toLng) {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) return null;
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) return null;

  const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${encodeURIComponent(apiKey)}&start=${fromLng},${fromLat}&end=${toLng},${toLat}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) return null;
    const summary = data?.features?.[0]?.properties?.summary;
    if (!summary) return null;
    return {
      distance_km: Math.round((summary.distance / 1000) * 10) / 10,
      duration_min: Math.round(summary.duration / 60)
    };
  } catch {
    return null;
  }
}

module.exports = { drivingDistance };

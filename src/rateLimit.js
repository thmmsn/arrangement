// Enkel rate limiting i minnet (fast tidsvindu per IP-adresse).
// Holder for én serverprosess. Kjører du flere instanser, bør dette flyttes til f.eks. Redis.
export function rateLimit({ windowMs, max, message = 'For mange forespørsler. Vent litt og prøv igjen.' }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Rydd bort utløpte oppføringer jevnlig, så minnebruken ikke vokser over tid.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs);
  cleanup.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// Enkel rate limiting i minnet (fast tidsvindu per IP-adresse).
// Holder for én serverprosess. Kjører du flere instanser, bør dette flyttes til f.eks. Redis.
// `key` avgjør hvem som telles sammen – standard er IP-adressen Express har funnet (req.ip).
// `message` kan være en funksjon av forespørselen, slik at feilmeldingen kommer på riktig språk.
// `skip(req)` = true slipper forespørselen forbi uten å telle den (f.eks. den betrodde LAN-porten).
export function rateLimit({
  windowMs, max, key = (req) => req.ip, skip = () => false, message = 'For mange forespørsler. Vent litt og prøv igjen.',
}) {
  const hits = new Map(); // nøkkel (IP) -> { count, resetAt }

  // Rydd bort utløpte oppføringer jevnlig, så minnebruken ikke vokser over tid.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of hits) if (entry.resetAt <= now) hits.delete(id);
  }, windowMs);
  cleanup.unref();

  return (req, res, next) => {
    if (skip(req)) return next();
    const now = Date.now();
    const id = key(req);
    let entry = hits.get(id);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(id, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: typeof message === 'function' ? message(req) : message });
    }
    next();
  };
}

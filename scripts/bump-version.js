// Øker versjonsnummeret i VERSION (se src/version.js): `npm run bump`.
// Samme dag: løpenummeret + 1 (2026.9.28.1 → 2026.9.28.2). Ny dag: dagens dato og løpenummer 1.
// Datoen regnes i TIME_ZONE (standard Europe/Oslo), samme tidssone som appen.
import { writeFileSync } from 'node:fs';
import { nextVersion, readVersion, VERSION_FILE } from '../src/version.js';

const current = readVersion();
const next = nextVersion(current, { timeZone: process.env.TIME_ZONE || 'Europe/Oslo' });
writeFileSync(VERSION_FILE, `${next}\n`);
console.log(`${current ?? '(ingen)'} → ${next}`);

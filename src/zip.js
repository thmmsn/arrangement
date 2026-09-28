// En liten ZIP-skriver, nok til Apple Wallet-kort (.pkpass er en ZIP-fil, og .pkpasses en ZIP med
// flere .pkpass i). Filene lagres ukomprimert («stored»): det er gyldig ZIP, Wallet godtar det, og
// innholdet er uansett lite (JSON) eller allerede komprimert (PNG).
// Format: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
import { crc32 } from 'node:zlib';

// Fast tidsstempel (1.1.1980, ZIP-formatets nullpunkt): samme innhold gir alltid samme fil.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

/** @param {{ name: string, data: Buffer | string }[]} files */
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signatur
    local.writeUInt16LE(20, 4); // versjon som trengs for å pakke ut (2.0)
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(0, 8); // metode 0 = ukomprimert
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // komprimert størrelse
    local.writeUInt32LE(data.length, 22); // ukomprimert størrelse
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // ekstrafelt
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // laget av versjon
    central.writeUInt16LE(20, 6); // trengs for å pakke ut
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // 30: ekstrafelt, 32: kommentar, 34: disk, 36: interne attributter, 38: eksterne attributter = 0
    central.writeUInt32LE(offset, 42); // hvor den lokale headeren starter
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); // antall filer på denne disken
  end.writeUInt16LE(files.length, 10); // antall filer totalt
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16); // hvor sentralkatalogen starter
  return Buffer.concat([...locals, ...centrals, end]);
}

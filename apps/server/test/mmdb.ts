/**
 * A minimal but genuine MaxMind DB (the format DB-IP City Lite ships in), so
 * geo tests run against a real parse instead of a mock. One tree node whose
 * two records both point at one city record: every IPv4 address resolves to it.
 */

const METADATA_MARKER = Buffer.from('ABCDEF4D61784D696E642E636F6D', 'hex');
const RECORD_SIZE = 24;
const NODE_COUNT = 1;
const DATA_SECTION_SEPARATOR = Buffer.alloc(16);

/** Control byte: type in the top 3 bits, payload size (< 29) in the low 5. */
function control(type: number, size: number): Buffer {
  return Buffer.from([(type << 5) | size]);
}

/** Types above 7 live in a second byte, biased by 7. */
function extended(type: number, size: number): Buffer {
  return Buffer.from([size, type - 7]);
}

function utf8(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([control(2, bytes.length), bytes]);
}

function uint16(value: number): Buffer {
  return Buffer.concat([control(5, 2), Buffer.from([value >> 8, value & 0xff])]);
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return Buffer.concat([control(6, 4), bytes]);
}

function uint64(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return Buffer.concat([extended(9, 4), bytes]);
}

function array(items: Buffer[]): Buffer {
  return Buffer.concat([extended(11, items.length), ...items]);
}

function map(entries: Record<string, Buffer>): Buffer {
  const pairs = Object.entries(entries).flatMap(([key, value]) => [utf8(key), value]);
  return Buffer.concat([control(7, Object.keys(entries).length), ...pairs]);
}

export function buildMmdb(city: string): Buffer {
  const record = map({
    country: map({ iso_code: utf8('US'), names: map({ en: utf8('United States') }) }),
    city: map({ names: map({ en: utf8(city) }) }),
  });
  // Record value = data offset + node count + separator size; 0 is our only record.
  const pointer = NODE_COUNT + DATA_SECTION_SEPARATOR.length;
  const node = Buffer.from([0, 0, pointer, 0, 0, pointer]);
  const metadata = map({
    node_count: uint32(NODE_COUNT),
    record_size: uint16(RECORD_SIZE),
    ip_version: uint16(4),
    database_type: utf8('DBIP-City-Lite'),
    languages: array([utf8('en')]),
    binary_format_major_version: uint16(2),
    binary_format_minor_version: uint16(0),
    build_epoch: uint64(1_767_225_600),
    description: map({ en: utf8('test fixture') }),
  });
  return Buffer.concat([node, DATA_SECTION_SEPARATOR, record, METADATA_MARKER, metadata]);
}

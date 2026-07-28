/**
 * Ephemeral visitor aliases for the realtime feed (docs/03 § Visitor identity,
 * docs/04 § 4): a whimsical two-word name plus a display color, derived from a
 * sha256 digest of (UTC day ∥ visitor id) — computed server-side, so this module
 * stays pure and browser-safe. The digest is one-way and the visitor id never
 * appears on the wire; the alias resets at 00:00 UTC along with the day salt.
 *
 * Both lists hold 48 entries — two per initial letter, in the same letter order —
 * so any adjective and animal picked from the same letter group alliterate.
 * That yields 24 × 2 × 2 = 96 distinct names: at this fleet's scale (a handful
 * of concurrent visitors) collisions are rare and acceptable — two visitors who
 * draw the same name simply merge in the live view until midnight.
 */

/** Entries per initial letter in each list. */
const GROUP = 2;

/** Q and X are skipped — 24 letters, two words each. */
export const ALIAS_ADJECTIVES = [
  'Amiable',
  'Astonished',
  'Bashful',
  'Breezy',
  'Cheerful',
  'Curious',
  'Dapper',
  'Dreamy',
  'Eager',
  'Exuberant',
  'Fanciful',
  'Frolicsome',
  'Genial',
  'Gleeful',
  'Hopeful',
  'Humble',
  'Inquisitive',
  'Intrepid',
  'Jaunty',
  'Jovial',
  'Keen',
  'Kindly',
  'Lively',
  'Luminous',
  'Mellow',
  'Merry',
  'Nimble',
  'Noble',
  'Observant',
  'Optimistic',
  'Peppy',
  'Plucky',
  'Radiant',
  'Rambunctious',
  'Serene',
  'Spirited',
  'Thoughtful',
  'Tranquil',
  'Unhurried',
  'Upbeat',
  'Velvety',
  'Vivacious',
  'Whimsical',
  'Wistful',
  'Yawning',
  'Youthful',
  'Zany',
  'Zesty',
] as const;

export const ALIAS_ANIMALS = [
  'Aardvark',
  'Albatross',
  'Badger',
  'Bumblebee',
  'Capybara',
  'Chinchilla',
  'Dormouse',
  'Duckling',
  'Echidna',
  'Ermine',
  'Ferret',
  'Firefly',
  'Gazelle',
  'Gecko',
  'Hedgehog',
  'Hummingbird',
  'Ibex',
  'Iguana',
  'Jackrabbit',
  'Jellyfish',
  'Kingfisher',
  'Kiwi',
  'Lemur',
  'Lynx',
  'Marmot',
  'Meerkat',
  'Narwhal',
  'Nightingale',
  'Ocelot',
  'Otter',
  'Pangolin',
  'Puffin',
  'Raccoon',
  'Reindeer',
  'Salamander',
  'Squirrel',
  'Tapir',
  'Toucan',
  'Uakari',
  'Urchin',
  'Vicuna',
  'Vole',
  'Wallaby',
  'Wombat',
  'Yak',
  'Yellowhammer',
  'Zebra',
  'Zebrafish',
] as const;

/**
 * How many chart-safe categorical tokens the web theme exposes (`--s1`…`--s3`).
 * Alias colors CYCLE through them by index — deliberately. The dataviz
 * never-cycle rule protects series whose identity lives in the color; here
 * identity is carried by the NAME, and the dot is only a scanning aid.
 */
export const ALIAS_COLOR_COUNT = 3;

export interface RealtimeVisitor {
  /** Two-word alias, e.g. `Avaricious Aardvark` — the visitor's identity for the day. */
  name: string;
  /** Categorical palette index, `0 ≤ color < ALIAS_COLOR_COUNT`; stable per name. */
  color: number;
}

/** `list[index]`, cycling — total for the non-empty lists above. */
function cycle(list: readonly string[], index: number): string {
  const word = list[index % list.length];
  if (word === undefined) throw new Error('alias word list is empty');
  return word;
}

/**
 * Maps a digest (any 3+ bytes; the server feeds it sha256) to an alias. One
 * byte picks the letter, one each picks the adjective and animal within it, so
 * the name reveals at most ~6.6 bits of the digest — nothing linkable.
 */
export function aliasFromDigest(digest: Uint8Array): RealtimeVisitor {
  const letters = ALIAS_ADJECTIVES.length / GROUP;
  const letter = (digest[0] ?? 0) % letters;
  const adjective = (digest[1] ?? 0) % GROUP;
  const animal = (digest[2] ?? 0) % GROUP;
  const name = `${cycle(ALIAS_ADJECTIVES, letter * GROUP + adjective)} ${cycle(
    ALIAS_ANIMALS,
    letter * GROUP + animal,
  )}`;
  // Color follows the name (not a separate byte): a name must never flicker
  // between colors, even for two visitors who collided on it.
  const combo = letter * GROUP * GROUP + adjective * GROUP + animal;
  return { name, color: combo % ALIAS_COLOR_COUNT };
}

/**
 * Ephemeral visitor aliases for the realtime feed (docs/03 § Visitor identity,
 * docs/04 § 4): a whimsical two-word name plus a display color, derived from a
 * sha256 digest of (UTC day ∥ visitor id) — computed server-side, so this module
 * stays pure and browser-safe. The digest is one-way and the visitor id never
 * appears on the wire; the alias resets at 00:00 UTC. That is deliberately NOT
 * the day salt's boundary, which is site-local: an alias labels a live feed the
 * reader is watching now, so which day it belongs to is a question nobody asks.
 *
 * Both lists hold 96 entries — four per initial letter, in the same letter order —
 * so any adjective and animal picked from the same letter group alliterate.
 * That yields 24 × 4 × 4 = 384 distinct names. Collisions are still possible
 * and still harmless BECAUSE consumers key by (site, name), never by name
 * alone: two visitors who draw one name are two rows, each with its own hits,
 * time and trail. Grouping by name alone merged strangers — that bug is what
 * bought the wider lists.
 */

/** Entries per initial letter in each list. */
const GROUP = 4;

/** Q and X are skipped — 24 letters, two words each. */
export const ALIAS_ADJECTIVES = [
  'Amiable',
  'Astonished',
  'Affable',
  'Airy',
  'Bashful',
  'Breezy',
  'Beaming',
  'Brisk',
  'Cheerful',
  'Curious',
  'Chipper',
  'Canny',
  'Dapper',
  'Dreamy',
  'Dauntless',
  'Diligent',
  'Eager',
  'Exuberant',
  'Earnest',
  'Easygoing',
  'Fanciful',
  'Frolicsome',
  'Fearless',
  'Friendly',
  'Genial',
  'Gleeful',
  'Gallant',
  'Graceful',
  'Hopeful',
  'Humble',
  'Hearty',
  'Helpful',
  'Inquisitive',
  'Intrepid',
  'Inventive',
  'Idyllic',
  'Jaunty',
  'Jovial',
  'Jubilant',
  'Just',
  'Keen',
  'Kindly',
  'Knowing',
  'Kinetic',
  'Lively',
  'Luminous',
  'Lucky',
  'Limber',
  'Mellow',
  'Merry',
  'Mindful',
  'Mirthful',
  'Nimble',
  'Noble',
  'Neighborly',
  'Nifty',
  'Observant',
  'Optimistic',
  'Obliging',
  'Onward',
  'Peppy',
  'Plucky',
  'Patient',
  'Placid',
  'Radiant',
  'Rambunctious',
  'Resolute',
  'Restful',
  'Serene',
  'Spirited',
  'Sunny',
  'Steadfast',
  'Thoughtful',
  'Tranquil',
  'Tidy',
  'Tenacious',
  'Unhurried',
  'Upbeat',
  'Unruffled',
  'Untiring',
  'Velvety',
  'Vivacious',
  'Valiant',
  'Verdant',
  'Whimsical',
  'Wistful',
  'Winsome',
  'Wandering',
  'Yawning',
  'Youthful',
  'Yearning',
  'Yielding',
  'Zany',
  'Zesty',
  'Zealous',
  'Zippy',
] as const;

export const ALIAS_ANIMALS = [
  'Aardvark',
  'Albatross',
  'Axolotl',
  'Antelope',
  'Badger',
  'Bumblebee',
  'Bandicoot',
  'Bittern',
  'Capybara',
  'Chinchilla',
  'Cormorant',
  'Chipmunk',
  'Dormouse',
  'Duckling',
  'Dingo',
  'Dragonfly',
  'Echidna',
  'Ermine',
  'Egret',
  'Eider',
  'Ferret',
  'Firefly',
  'Finch',
  'Fennec',
  'Gazelle',
  'Gecko',
  'Godwit',
  'Grebe',
  'Hedgehog',
  'Hummingbird',
  'Heron',
  'Hare',
  'Ibex',
  'Iguana',
  'Impala',
  'Ibis',
  'Jackrabbit',
  'Jellyfish',
  'Jacana',
  'Jerboa',
  'Kingfisher',
  'Kiwi',
  'Kestrel',
  'Koala',
  'Lemur',
  'Lynx',
  'Lapwing',
  'Loon',
  'Marmot',
  'Meerkat',
  'Manatee',
  'Magpie',
  'Narwhal',
  'Nightingale',
  'Numbat',
  'Nuthatch',
  'Ocelot',
  'Otter',
  'Osprey',
  'Oriole',
  'Pangolin',
  'Puffin',
  'Plover',
  'Porcupine',
  'Raccoon',
  'Reindeer',
  'Roadrunner',
  'Redstart',
  'Salamander',
  'Squirrel',
  'Sandpiper',
  'Serval',
  'Tapir',
  'Toucan',
  'Tamarin',
  'Teal',
  'Uakari',
  'Urchin',
  'Umbrellabird',
  'Uguisu',
  'Vicuna',
  'Vole',
  'Vireo',
  'Viscacha',
  'Wallaby',
  'Wombat',
  'Wagtail',
  'Weasel',
  'Yak',
  'Yellowhammer',
  'Yabby',
  'Yearling',
  'Zebra',
  'Zebrafish',
  'Zorilla',
  'Zorro',
] as const;

/**
 * How many chart-safe categorical tokens the web theme exposes (`--s1`…`--s3`).
 * Alias colors CYCLE through them by index — deliberately. The dataviz
 * never-cycle rule protects series whose identity lives in the color; here
 * identity is carried by the NAME, and the dot is only a scanning aid.
 */
export const ALIAS_COLOR_COUNT = 3;

export interface RealtimeVisitor {
  /**
   * What consumers KEY on. Opaque, exact, and process-scoped: minted from a
   * salt made fresh at boot, so it links one visitor's rows within a session
   * of the server and means nothing outside it — not the stored visitor id,
   * not derivable from it. The name below is for reading, never for grouping:
   * 384 labels collide, refs do not.
   */
  ref: string;
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
export function aliasFromDigest(digest: Uint8Array): Omit<RealtimeVisitor, 'ref'> {
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

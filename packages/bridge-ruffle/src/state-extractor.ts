import type { GameSnapshot, Player } from '@dfh/core';

/**
 * One key/value the parser found, with where it sat in the document.
 *
 * `path` is the enclosing element chain for XML and JSON (`character/stats`),
 * empty for flat key=value replies.
 */
export interface ParsedRecord {
  path: string;
  key: string;
  value: string;
}

export type PayloadFormat = 'urlencoded' | 'xml' | 'json' | 'unknown';

/** Guess the format from the first meaningful character. */
export function detectFormat(text: string): PayloadFormat {
  const head = text.trimStart();
  if (head.startsWith('<')) return 'xml';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (/^[^=&\n]+=/.test(head)) return 'urlencoded';
  return 'unknown';
}

/**
 * `a=1&b=2`, or one pair per line, as Artix's older endpoints reply.
 */
export function parseUrlEncoded(text: string): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  for (const pair of text.split(/[&\n]/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = decodeComponent(pair.slice(0, eq)).trim();
    const value = decodeComponent(pair.slice(eq + 1)).trim();
    if (key) records.push({ path: '', key, value });
  }
  return records;
}

function decodeComponent(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

/**
 * Attribute-oriented XML, which is how the DragonFable client and server
 * describe characters, items and quests. Deliberately tolerant: no DOM, no
 * namespaces, no validation - just every attribute and every leaf's text.
 */
export function parseXml(text: string): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  const cleaned = text
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => escapeText(inner));

  const stack: string[] = [];
  const token = /<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attribute = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  let match: RegExpExecArray | null;
  while ((match = token.exec(cleaned))) {
    const [, closing, opening, attrs, selfClose, textNode] = match;
    if (closing !== undefined) {
      stack.pop();
    } else if (opening !== undefined) {
      stack.push(opening);
      const path = stack.join('/');
      let attr: RegExpExecArray | null;
      attribute.lastIndex = 0;
      while ((attr = attribute.exec(attrs ?? ''))) {
        records.push({ path, key: attr[1] ?? '', value: unescapeText(attr[2] ?? attr[3] ?? '') });
      }
      if (selfClose) stack.pop();
    } else if (textNode !== undefined) {
      const value = textNode.trim();
      const name = stack[stack.length - 1];
      if (value && name) {
        records.push({ path: stack.slice(0, -1).join('/'), key: name, value: unescapeText(value) });
      }
    }
  }
  return records;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function unescapeText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

export function parseJson(text: string): ParsedRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const records: ParsedRecord[] = [];
  const walk = (node: unknown, path: string, key: string) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, path ? `${path}/${key}` : key, String(index)));
    } else if (typeof node === 'object') {
      const next = key ? (path ? `${path}/${key}` : key) : path;
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) walk(child, next, childKey);
    } else if (key) {
      records.push({ path, key, value: String(node) });
    }
  };
  walk(value, '', '');
  return records;
}

/** Parse a server reply in whichever format it turns out to be. */
export function parsePayload(text: string, contentType?: string | null): ParsedRecord[] {
  const format =
    contentType && /xml/i.test(contentType) ? 'xml'
    : contentType && /json/i.test(contentType) ? 'json'
    : detectFormat(text);
  switch (format) {
    case 'xml':
      return parseXml(text);
    case 'json':
      return parseJson(text);
    case 'urlencoded':
      return parseUrlEncoded(text);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------

/** The snapshot fields the extractor knows how to fill. */
export type PlayerField =
  | 'name' | 'level' | 'hp' | 'maxHp' | 'mp' | 'maxMp'
  | 'gold' | 'dragonCoins' | 'className' | 'location';

/**
 * Which server keys feed which snapshot field, most preferred first.
 *
 * The defaults follow the Hungarian-style naming Artix Entertainment uses
 * across its games (`intHP`, `intGold`, `strName`) and are matched without
 * regard to case. When a live reply shows a field under a name that is not
 * here, add it in the app's Live panel rather than editing code.
 */
export type FieldAliases = Record<PlayerField, string[]>;

export const defaultFieldAliases: FieldAliases = {
  name: ['strUsername', 'strCharName', 'strName', 'CharName', 'Name', 'username'],
  level: ['intLevel', 'Level', 'level', 'intLvl'],
  hp: ['intHP', 'HP', 'hp', 'intHealth', 'health'],
  maxHp: ['intHPMax', 'intMaxHP', 'HPMax', 'MaxHP', 'maxHp', 'intMaxHealth'],
  mp: ['intMP', 'MP', 'mp', 'intMana', 'mana'],
  maxMp: ['intMPMax', 'intMaxMP', 'MPMax', 'MaxMP', 'maxMp', 'intMaxMana'],
  gold: ['intGold', 'Gold', 'gold', 'intCoins'],
  dragonCoins: ['intDCs', 'intDragonCoins', 'DCs', 'DragonCoins', 'dragonCoins'],
  className: ['strClassName', 'strClass', 'ClassName', 'className', 'class'],
  location: ['strTown', 'strCurrentTown', 'strLocation', 'strMap', 'Town', 'town', 'map'],
};

/** Containers whose records describe the player rather than a monster or item. */
const PLAYER_CONTAINERS = /(^|\/)(character|char|player|avatar|hero|user|account|login)(\/|$)/i;
/** Containers that never describe the player. */
const NON_PLAYER_CONTAINERS = /(^|\/)(monster|monsters|mon|enemy|enemies|npc|item|items|shop|pet|dragon)(\/|$)/i;

const NUMERIC_FIELDS = new Set<PlayerField>(['level', 'hp', 'maxHp', 'mp', 'maxMp', 'gold', 'dragonCoins']);

export interface ExtractionMatch {
  key: string;
  value: string;
  path: string;
}

export interface Extraction {
  /** Snapshot changes this reply justifies; empty when nothing matched. */
  patch: Partial<GameSnapshot>;
  /** Which record satisfied each field, for the discovery report. */
  matched: Partial<Record<PlayerField, ExtractionMatch>>;
}

function pickRecord(records: ParsedRecord[], aliases: string[]): ParsedRecord | undefined {
  const wanted = aliases.map((alias) => alias.toLowerCase());
  let best: { record: ParsedRecord; score: number } | undefined;

  for (const record of records) {
    const rank = wanted.indexOf(record.key.toLowerCase());
    if (rank < 0) continue;
    if (NON_PLAYER_CONTAINERS.test(record.path)) continue;

    // Lower is better: preferred alias, then a player-ish container, then shallow.
    const score = rank * 100 + (PLAYER_CONTAINERS.test(record.path) ? 0 : 10) + record.path.split('/').length;
    if (!best || score < best.score) best = { record, score };
  }
  return best?.record;
}

/**
 * Map parsed records onto the snapshot. Fields that do not appear are left
 * untouched, so a partial reply (a gold update, say) never zeroes the rest.
 */
export function extractState(
  records: ParsedRecord[],
  previous: GameSnapshot,
  aliases: FieldAliases = defaultFieldAliases,
): Extraction {
  const matched: Partial<Record<PlayerField, ExtractionMatch>> = {};
  const player: Partial<Player> = {};

  for (const field of Object.keys(aliases) as PlayerField[]) {
    const record = pickRecord(records, aliases[field]);
    if (!record) continue;

    if (NUMERIC_FIELDS.has(field)) {
      const number = Number.parseInt(record.value.replace(/,/g, ''), 10);
      if (!Number.isFinite(number)) continue;
      (player as Record<string, unknown>)[field] = number;
    } else {
      if (!record.value) continue;
      (player as Record<string, unknown>)[field] = record.value;
    }
    matched[field] = { key: record.key, value: record.value, path: record.path };
  }

  if (Object.keys(player).length === 0) return { patch: {}, matched };

  const merged: Player = { ...previous.player, ...player };
  const patch: Partial<GameSnapshot> = { player: merged };

  // A reply that carries the character's vitals means the player is in the
  // game; nothing else in the traffic says so explicitly.
  if (merged.maxHp > 0 && (merged.name.length > 0 || 'hp' in player)) {
    patch.loggedIn = true;
  }
  return { patch, matched };
}

/** Short label for an endpoint, for trace lines and the discovery report. */
export function endpointName(url: string): string {
  try {
    const { pathname } = new URL(url);
    return pathname.split('/').filter(Boolean).pop() ?? pathname;
  } catch {
    return url;
  }
}

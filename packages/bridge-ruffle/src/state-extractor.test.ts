import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '@dfh/core';
import {
  defaultFieldAliases,
  detectFormat,
  endpointName,
  extractState,
  parseJson,
  parsePayload,
  parseUrlEncoded,
  parseXml,
} from './state-extractor.js';

describe('detectFormat', () => {
  it('recognises the three shapes the game uses', () => {
    expect(detectFormat('<?xml version="1.0"?><character intHP="1"/>')).toBe('xml');
    expect(detectFormat('  {"intHP": 1}')).toBe('json');
    expect(detectFormat('intHP=1&intMP=2')).toBe('urlencoded');
    expect(detectFormat('OK')).toBe('unknown');
  });
});

describe('parseUrlEncoded', () => {
  it('parses ampersand and newline separated pairs and decodes values', () => {
    const records = parseUrlEncoded('strName=Sir+Hero&intGold=1%2C200\nintHP=350');
    expect(records).toEqual([
      { path: '', key: 'strName', value: 'Sir Hero' },
      { path: '', key: 'intGold', value: '1,200' },
      { path: '', key: 'intHP', value: '350' },
    ]);
  });

  it('skips malformed pairs instead of throwing', () => {
    expect(parseUrlEncoded('=nokey&novalue=&&plain')).toEqual([{ path: '', key: 'novalue', value: '' }]);
  });
});

describe('parseXml', () => {
  it('reads attributes with element paths', () => {
    const records = parseXml(
      `<?xml version="1.0"?>
       <login>
         <character strName="Hero" intLevel="42" intHP="300" intHPMax="400"/>
         <monster strName="Sneevil" intHP="60"/>
       </login>`,
    );
    expect(records).toContainEqual({ path: 'login/character', key: 'intHP', value: '300' });
    expect(records).toContainEqual({ path: 'login/monster', key: 'strName', value: 'Sneevil' });
  });

  it('reads leaf text, entities and CDATA', () => {
    const records = parseXml(
      `<char><strName>Tom &amp; Jerry</strName><intGold>50</intGold><note><![CDATA[a<b]]></note></char>`,
    );
    expect(records).toContainEqual({ path: 'char', key: 'strName', value: 'Tom & Jerry' });
    expect(records).toContainEqual({ path: 'char', key: 'intGold', value: '50' });
    expect(records).toContainEqual({ path: 'char', key: 'note', value: 'a<b' });
  });

  it('tolerates single-quoted attributes, comments and unclosed junk', () => {
    const records = parseXml(`<!-- hi --><a x='1'><b y="2"></a>`);
    expect(records).toContainEqual({ path: 'a', key: 'x', value: '1' });
    expect(records).toContainEqual({ path: 'a/b', key: 'y', value: '2' });
  });
});

describe('parseJson', () => {
  it('flattens nested objects and arrays into paths', () => {
    const records = parseJson('{"character":{"intHP":5,"items":[{"id":1},{"id":2}]},"ok":true}');
    expect(records).toContainEqual({ path: 'character', key: 'intHP', value: '5' });
    expect(records).toContainEqual({ path: 'character/items/0', key: 'id', value: '1' });
    expect(records).toContainEqual({ path: '', key: 'ok', value: 'true' });
  });

  it('returns nothing for invalid JSON', () => {
    expect(parseJson('{oops')).toEqual([]);
  });
});

describe('parsePayload', () => {
  it('trusts the content type before sniffing', () => {
    expect(parsePayload('<a x="1"/>', 'text/xml')).toHaveLength(1);
    expect(parsePayload('{"a":1}', 'application/json')).toHaveLength(1);
    expect(parsePayload('a=1', 'text/plain')).toHaveLength(1);
    expect(parsePayload('nothing here', 'text/plain')).toEqual([]);
  });
});

describe('extractState', () => {
  const base = emptySnapshot();

  it('fills the player from a flat login reply and marks the session logged in', () => {
    const records = parseUrlEncoded('strUsername=Hero&intLevel=12&intHP=300&intHPMax=400&intMP=50&intMPMax=80&intGold=999');
    const { patch, matched } = extractState(records, base);

    expect(patch.player).toMatchObject({ name: 'Hero', level: 12, hp: 300, maxHp: 400, mp: 50, maxMp: 80, gold: 999 });
    expect(patch.loggedIn).toBe(true);
    expect(matched.hp).toEqual({ key: 'intHP', value: '300', path: '' });
  });

  it('prefers the character container over a monster carrying the same keys', () => {
    const records = parseXml(
      `<r><monster strName="Sneevil" intHP="60" intHPMax="60"/><character strName="Hero" intHP="300" intHPMax="400"/></r>`,
    );
    const { patch } = extractState(records, base);
    expect(patch.player?.name).toBe('Hero');
    expect(patch.player?.hp).toBe(300);
  });

  it('never takes a value from a non-player container even when nothing else matches', () => {
    const records = parseXml(`<r><monster intHP="60"/></r>`);
    const { patch } = extractState(records, base);
    expect(patch).toEqual({});
  });

  it('matches aliases case-insensitively and by preference order', () => {
    const records = parseUrlEncoded('hp=1&INTHP=2');
    const { matched } = extractState(records, base);
    expect(matched.hp?.key).toBe('INTHP'); // intHP is the preferred alias
  });

  it('leaves fields alone that the reply does not mention', () => {
    const previous = { ...base, player: { ...base.player, name: 'Hero', level: 9, hp: 100, maxHp: 400, gold: 5 } };
    const { patch } = extractState(parseUrlEncoded('intGold=1500'), previous);
    expect(patch.player).toMatchObject({ name: 'Hero', level: 9, hp: 100, maxHp: 400, gold: 1500 });
  });

  it('does not report logged in from a reply with no vitals', () => {
    const { patch } = extractState(parseUrlEncoded('intGold=1500'), base);
    expect(patch.loggedIn).toBeUndefined();
  });

  it('ignores non-numeric junk in numeric fields', () => {
    const { patch } = extractState(parseUrlEncoded('intHP=lots&intHPMax=400'), base);
    expect(patch.player?.hp).toBe(0);
    expect(patch.player?.maxHp).toBe(400);
  });

  it('accepts user-supplied aliases', () => {
    const aliases = { ...defaultFieldAliases, hp: ['vitality'], maxHp: ['vitalityMax'] };
    const { patch } = extractState(parseUrlEncoded('vitality=7&vitalityMax=9'), base, aliases);
    expect(patch.player?.hp).toBe(7);
    expect(patch.player?.maxHp).toBe(9);
  });
});

describe('endpointName', () => {
  it('returns the last path segment', () => {
    expect(endpointName('https://play.dragonfable.com/game/cf-login.asp?x=1')).toBe('cf-login.asp');
    expect(endpointName('nonsense')).toBe('nonsense');
  });
});

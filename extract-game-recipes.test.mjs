import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assetNameToDisplayName,
  decodeRecipeEntries,
  isTieredVariant,
} from './scripts/extract-game-recipes.mjs';

const ENTRY_HEADER = 0x0500;

// Builds the tail of a cooked recipe payload: the serialized input-array length followed by
// one 10-byte entry per ingredient, the output entry, and optionally the duration float.
function buildPayload({ inputs, output, time }) {
  const entries = [...inputs, output];
  const size = 4 + entries.length * 10 + (time === undefined ? 0 : 4);
  const buffer = Buffer.alloc(size);
  buffer.writeInt32LE(inputs.length, 0);
  let offset = 4;
  for (const [ref, count] of entries) {
    buffer.writeUInt16LE(ENTRY_HEADER, offset);
    buffer.writeInt32LE(ref, offset + 2);
    buffer.writeInt32LE(count, offset + 6);
    offset += 10;
  }
  if (time !== undefined) buffer.writeFloatLE(time, offset);
  return buffer;
}

const resolve = (ref) =>
  ({
    '-1': '/Game/Chimera/Items/I_Electronics',
    '-2': '/Game/Chimera/Items/I_Stator',
    '-3': '/Game/Chimera/Items/I_Accumulator',
    '-4': '/Game/Chimera/Weapons/AmmoTypes/I_HeavyAmmoItem',
    '-9': '/Game/Chimera/Corporations/I_DataPoint',
  })[String(ref)] ?? null;

test('decodes inputs, output and duration from a recipe payload', () => {
  const payload = buildPayload({ inputs: [[-1, 1], [-2, 2]], output: [-3, 1], time: 6 });
  const decoded = decodeRecipeEntries(payload, resolve);

  assert.deepEqual(decoded.inputs, [
    { item: '/Game/Chimera/Items/I_Electronics', count: 1 },
    { item: '/Game/Chimera/Items/I_Stator', count: 2 },
  ]);
  assert.deepEqual(decoded.output, { item: '/Game/Chimera/Items/I_Accumulator', count: 1 });
  assert.equal(decoded.time, 6);
  assert.equal(decoded.defaultedTime, false);
});

test('falls back to the default duration when the property was not serialized', () => {
  const payload = buildPayload({ inputs: [[-1, 1]], output: [-3, 2] });
  const decoded = decodeRecipeEntries(payload, resolve);

  assert.equal(decoded.time, 10);
  assert.equal(decoded.defaultedTime, true);
});

test('recognises craftable items outside the /Items/ folder', () => {
  const payload = buildPayload({ inputs: [[-1, 18]], output: [-4, 20], time: 6 });
  const decoded = decodeRecipeEntries(payload, resolve);

  assert.equal(decoded.output.item, '/Game/Chimera/Weapons/AmmoTypes/I_HeavyAmmoItem');
  assert.equal(decoded.output.count, 20);
});

test('ignores unlock-cost data that is not in entry form', () => {
  // Recipe assets also carry a blueprint unlock cost: bare object-reference/amount pairs
  // with no entry header, which must not be mistaken for ingredients.
  const cost = Buffer.alloc(8);
  cost.writeInt32LE(-9, 0);
  cost.writeInt32LE(4000, 4);
  const payload = Buffer.concat([
    cost,
    buildPayload({ inputs: [[-1, 1], [-2, 2]], output: [-3, 1], time: 5 }),
  ]);
  const decoded = decodeRecipeEntries(payload, resolve);

  assert.deepEqual(
    decoded.inputs.map((entry) => entry.item),
    ['/Game/Chimera/Items/I_Electronics', '/Game/Chimera/Items/I_Stator'],
  );
  assert.equal(decoded.output.item, '/Game/Chimera/Items/I_Accumulator');
});

test('refuses to decode when the entry scan disagrees with the declared input count', () => {
  const payload = buildPayload({ inputs: [[-1, 1], [-2, 1], [-3, 1]], output: [-3, 1], time: 5 });
  // Claim more inputs than there are entries, which is what an unreadable entry looks like.
  payload.writeInt32LE(4, 0);

  assert.equal(decodeRecipeEntries(payload, resolve), null);
});

test('returns null when there are not enough entries to form a recipe', () => {
  const payload = buildPayload({ inputs: [], output: [-3, 1], time: 5 });
  assert.equal(decodeRecipeEntries(payload, resolve), null);
});

test('splits internal asset names into readable fallback names', () => {
  assert.equal(assetNameToDisplayName('/Game/Chimera/Items/I_ReinforcedFrame'), 'Reinforced Frame');
  assert.equal(assetNameToDisplayName('CRC_MilitaryAssembler'), 'Military Assembler');
  assert.equal(assetNameToDisplayName('I_Tier2Module'), 'Tier 2 Module');
});

test('identifies upgraded machine tiers', () => {
  assert.equal(isTieredVariant('Furnace v.2'), true);
  assert.equal(isTieredVariant('Constructorizer v.2'), true);
  assert.equal(isTieredVariant('Furnace'), false);
  assert.equal(isTieredVariant('Mega Press'), false);
});

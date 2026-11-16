/**
 * Behavior tests for the notes data model (parsing, serialization, paste).
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import {
  type Block,
  computeNumbers,
  countListItems,
  createBlock,
  parseText,
  pasteIntoBlocks,
  serializeBlocks,
} from '../src/notes_model';

const shape = (blocks: Block[]) =>
  blocks.map(({ kind, text, start }) =>
    start === undefined ? { kind, text } : { kind, text, start }
  );

const cases: [string, () => void][] = [];
const test = (name: string, run: () => void) => cases.push([name, run]);

test('pasting three bullet lines into an empty line creates three bullets', () => {
  const blocks = [createBlock()];
  const pasted =
    '- Art. 2 GG - Recht auf informationelle Selbstbestimmung\n' +
    '- Art. 10 GG - Fernmeldegeheimnis\n' +
    '- Art. 13 GG - Unverletzlichkeit der Wohnung (Digitale Untersuchungen?)';
  const result = pasteIntoBlocks(blocks, 0, 0, 0, pasted);
  assert.ok(result);
  assert.deepEqual(shape(result.blocks), [
    { kind: 'bullet', text: 'Art. 2 GG - Recht auf informationelle Selbstbestimmung' },
    { kind: 'bullet', text: 'Art. 10 GG - Fernmeldegeheimnis' },
    {
      kind: 'bullet',
      text: 'Art. 13 GG - Unverletzlichkeit der Wohnung (Digitale Untersuchungen?)',
    },
  ]);
  assert.equal(result.blocks[0].id, blocks[0].id, 'first pasted line reuses the current line');
  assert.equal(result.focus.id, result.blocks[2].id);
  assert.equal(result.focus.caret, result.blocks[2].text.length);
});

test('numbered lines become a numbered list 1, 2', () => {
  const result = pasteIntoBlocks([createBlock()], 0, 0, 0, '1. a\n2. b');
  assert.ok(result);
  assert.deepEqual(shape(result.blocks), [
    { kind: 'number', text: 'a', start: 1 },
    { kind: 'number', text: 'b', start: 2 },
  ]);
  assert.deepEqual(computeNumbers(result.blocks), [1, 2]);
});

test('a bullet with an Option+Enter break survives serialize and parse', () => {
  const original = [
    createBlock('bullet', 'first line\nsecond line'),
    createBlock('number', 'item\ncontinued', 3),
    createBlock('text', 'plain'),
  ];
  const serialized = serializeBlocks(original);
  assert.equal(serialized, '- first line\n  second line\n3. item\n   continued\nplain');
  assert.deepEqual(shape(parseText(serialized)), shape(original));
});

test('a single line with a trailing line break is inserted without the break', () => {
  const blocks = [createBlock('text', 'ab')];
  const result = pasteIntoBlocks(blocks, 0, 1, 1, 'XY\n');
  assert.ok(result);
  assert.deepEqual(shape(result.blocks), [{ kind: 'text', text: 'aXYb' }]);
  assert.deepEqual(result.focus, { id: blocks[0].id, caret: 3 });
});

test('a single bullet line with a trailing break into an empty line starts a list', () => {
  const result = pasteIntoBlocks([createBlock()], 0, 0, 0, '- item\n');
  assert.ok(result);
  assert.deepEqual(shape(result.blocks), [{ kind: 'bullet', text: 'item' }]);
});

test('a single line without a break uses the native paste', () => {
  assert.equal(pasteIntoBlocks([createBlock()], 0, 0, 0, 'plain text'), null);
});

test('pasting into the middle of a line keeps text before and after the cursor', () => {
  const blocks = [createBlock('bullet', 'HEAD|TAIL')];
  const result = pasteIntoBlocks(blocks, 0, 5, 5, 'one\n- two\nthree');
  assert.ok(result);
  assert.deepEqual(shape(result.blocks), [
    { kind: 'bullet', text: 'HEAD|one' },
    { kind: 'bullet', text: 'two' },
    { kind: 'text', text: 'threeTAIL' },
  ]);
  assert.equal(result.focus.caret, 'three'.length);
});

test('pasting replaces the selected range', () => {
  const blocks = [createBlock('text', 'keep DROP keep')];
  const result = pasteIntoBlocks(blocks, 0, 5, 9, 'a\nb');
  assert.ok(result);
  assert.deepEqual(shape(result.blocks), [
    { kind: 'text', text: 'keep a' },
    { kind: 'text', text: 'b keep' },
  ]);
});

test('nested lists from other apps are flattened and Windows line endings handled', () => {
  const blocks = parseText('- top\r\n  - nested\r\n    1. deep');
  assert.deepEqual(shape(blocks), [
    { kind: 'bullet', text: 'top' },
    { kind: 'bullet', text: 'nested' },
    { kind: 'number', text: 'deep', start: 1 },
  ]);
});

test('lines around the pasted block are left untouched', () => {
  const blocks = [createBlock('text', 'above'), createBlock(), createBlock('text', 'below')];
  const result = pasteIntoBlocks(blocks, 1, 0, 0, '- x\n- y');
  assert.ok(result);
  assert.deepEqual(shape(result.blocks), [
    { kind: 'text', text: 'above' },
    { kind: 'bullet', text: 'x' },
    { kind: 'bullet', text: 'y' },
    { kind: 'text', text: 'below' },
  ]);
});

test('counter counts filled bullets and numbered items, not plain lines', () => {
  const blocks = [
    createBlock('text', 'intro'),
    createBlock('bullet', 'a'),
    createBlock('number', 'b', 1),
    createBlock('bullet', 'c'),
  ];
  assert.equal(countListItems(blocks), 3);
});

test('counter ignores the empty bullet created by Enter', () => {
  const blocks = [
    createBlock('bullet', 'a'),
    createBlock('bullet', ''),
    createBlock('bullet', '  '),
  ];
  assert.equal(countListItems(blocks), 1);
});

test('counter counts a bullet with Option+Enter line breaks once', () => {
  assert.equal(countListItems([createBlock('bullet', 'line one\nline two')]), 1);
});

test('counter is zero for plain text only', () => {
  assert.equal(countListItems([createBlock('text', '- not a list yet')]), 0);
});

let failures = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}`);
    console.log(error instanceof Error ? error.message : error);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} tests passed`);
process.exit(failures > 0 ? 1 : 0);

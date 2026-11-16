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
  shiftIndent,
} from '../src/notes_model';
import { closestOffsetOnLine, isOnFirstLine, isOnLastLine } from '../src/caret_geometry';

/** Build a list item at a nesting level. */
const item = (kind: 'bullet' | 'number', text: string, indent = 0, start?: number): Block => ({
  ...createBlock(kind, text, start),
  indent,
});

/** Comparable view of blocks: ids dropped, start/indent only when set. */
const shape = (blocks: Block[]) =>
  blocks.map(({ kind, text, start, indent }) => ({
    kind,
    text,
    ...(start !== undefined ? { start } : {}),
    ...(indent ? { indent } : {}),
  }));

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

test('nested lists keep their levels and Windows line endings are handled', () => {
  const blocks = parseText('- top\r\n  - nested\r\n    1. deep\r\n- back');
  assert.deepEqual(shape(blocks), [
    { kind: 'bullet', text: 'top' },
    { kind: 'bullet', text: 'nested', indent: 1 },
    { kind: 'number', text: 'deep', start: 1, indent: 2 },
    { kind: 'bullet', text: 'back' },
  ]);
});

test('2-space, 4-space and tab indentation give the same levels', () => {
  for (const unit of ['  ', '    ', '\t']) {
    const blocks = parseText(`- a\n${unit}- b\n${unit}${unit}- c\n${unit}- d`);
    assert.deepEqual(
      blocks.map((block) => block.indent),
      [0, 1, 2, 1],
      `indent unit ${JSON.stringify(unit)}`
    );
  }
});

test('Tab cannot indent the first item or skip a level', () => {
  const blocks = [item('bullet', 'a'), item('bullet', 'b')];
  assert.equal(shiftIndent(blocks, 0, 1), null, 'first item stays at level 0');
  const once = shiftIndent(blocks, 1, 1);
  assert.ok(once);
  assert.equal(once[1].indent, 1);
  assert.equal(shiftIndent(once, 1, 1), null, 'cannot go two levels deeper than the parent');
});

test('Tab and Shift+Tab move an item together with its children', () => {
  const blocks = [
    item('bullet', 'a'),
    item('bullet', 'b'),
    item('bullet', 'b.1', 1),
    item('bullet', 'b.1.1', 2),
    item('bullet', 'c'),
  ];
  const indented = shiftIndent(blocks, 1, 1);
  assert.ok(indented);
  assert.deepEqual(
    indented.map((block) => block.indent ?? 0),
    [0, 1, 2, 3, 0]
  );
  const outdented = shiftIndent(indented, 1, -1);
  assert.ok(outdented);
  assert.deepEqual(
    outdented.map((block) => block.indent ?? 0),
    [0, 0, 1, 2, 0]
  );
  assert.equal(shiftIndent(blocks, 0, -1), null, 'top level cannot be outdented');
  assert.equal(shiftIndent([createBlock('text', 'plain')], 0, 1), null, 'plain lines are ignored');
});

test('nested numbering continues the parent run and restarts below', () => {
  const blocks = [
    item('number', 'a', 0, 1),
    item('bullet', 'x', 1),
    item('number', 'x1', 1),
    item('number', 'x2', 1),
    item('number', 'b', 0),
    item('number', 'y1', 1),
  ];
  assert.deepEqual(computeNumbers(blocks), [1, null, 1, 2, 2, 1]);
});

test('a nested list with line breaks survives serialize and parse', () => {
  const original = [
    item('number', 'first\nwrapped', 0, 1),
    item('bullet', 'child\nchild line', 1),
    item('number', 'grandchild', 2, 1),
    item('number', 'second', 0),
  ];
  const serialized = serializeBlocks(original);
  assert.equal(
    serialized,
    '1. first\n   wrapped\n    - child\n      child line\n        1. grandchild\n2. second'
  );
  // Parsed numbered items carry an explicit start; compare structure and rendered numbers.
  const reparsed = parseText(serialized);
  const withoutStart = (blocks: Block[]) => shape(blocks).map(({ start: _start, ...rest }) => rest);
  assert.deepEqual(withoutStart(reparsed), withoutStart(original));
  assert.deepEqual(computeNumbers(reparsed), computeNumbers(original));
});

test('pasted lists are nested relative to the current item', () => {
  const blocks = [item('bullet', 'parent'), item('bullet', '', 1)];
  const result = pasteIntoBlocks(blocks, 1, 0, 0, '- a\n    - b');
  assert.ok(result);
  assert.deepEqual(
    result.blocks.map((block) => block.indent ?? 0),
    [0, 1, 2]
  );
});

test('counter counts top-level items only', () => {
  const blocks = [item('bullet', 'a'), item('bullet', 'a.1', 1), item('number', 'b', 0, 1)];
  assert.equal(countListItems(blocks), 2);
});

test('caret geometry finds the first/last visual line and the closest column', () => {
  // Two visual lines: offsets 0-3 on top 0, offsets 4-7 on top 24.
  const positions = [0, 10, 20, 30, 0, 10, 20, 30].map((left, offset) => ({
    top: offset < 4 ? 0 : 24,
    left,
  }));
  assert.equal(isOnFirstLine(positions, 2), true);
  assert.equal(isOnFirstLine(positions, 5), false);
  assert.equal(isOnLastLine(positions, 7), true);
  assert.equal(isOnLastLine(positions, 1), false);
  assert.equal(closestOffsetOnLine(positions, 'last', 18), 6);
  assert.equal(closestOffsetOnLine(positions, 'first', 100), 3);
  assert.equal(closestOffsetOnLine([], 'first', 5), 0);
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

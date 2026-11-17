/**
 * Pure data model of the notes field: lines (blocks), list detection,
 * plain-text serialization and paste handling. No React, SDK or DOM access,
 * so the logic can be tested in Node (see scripts/test_notes_model.ts).
 */

/** Markdown-style prefixes that turn a plain line into a list item. */
export const BULLET_TRIGGER = /^- /;
export const NUMBER_TRIGGER = /^(\d{1,4})\. /;

export type BlockKind = 'text' | 'bullet' | 'number';

export interface Block {
  id: string;
  kind: BlockKind;
  text: string;
  /** First number of a numbered run, taken from the typed prefix (e.g. "3. "). */
  start?: number;
  /** Nesting level of a list item (0 = top level). Plain lines are always level 0. */
  indent?: number;
}

/** Deepest nesting level reachable with Tab. */
export const MAX_INDENT = 5;

/** Spaces per nesting level in the plain-text export; valid under "- " and "1. ". */
const SERIALIZED_INDENT = 4;
const TAB_WIDTH = 4;

export const indentOf = (block: Block): number =>
  block.kind === 'text' ? 0 : Math.max(0, Math.min(MAX_INDENT, block.indent ?? 0));

export interface PendingFocus {
  id: string;
  caret: number;
}

export interface EditResult {
  blocks: Block[];
  focus: PendingFocus;
}

let blockCounter = 0;
export const createBlock = (kind: BlockKind = 'text', text = '', start?: number): Block => {
  blockCounter += 1;
  const block: Block = { id: `b${Date.now().toString(36)}${blockCounter}`, kind, text };
  if (kind === 'number' && start !== undefined) {
    block.start = start;
  }
  return block;
};

export const emptyNotes = (): Block[] => [createBlock()];

export const hasContent = (blocks: Block[]) => blocks.some((block) => block.text.trim().length > 0);

export const isValidBlock = (value: unknown): value is Block => {
  const block = value as Block;
  return (
    !!block &&
    typeof block.id === 'string' &&
    typeof block.text === 'string' &&
    (block.kind === 'text' || block.kind === 'bullet' || block.kind === 'number')
  );
};

/**
 * Numbers for numbered items, counted per nesting level:
 * - consecutive numbered items on one level form a run; deeper items do not break it,
 * - returning to a shallower level restarts the deeper runs,
 * - a bullet breaks the run on its own level, a plain line breaks all runs.
 */
export const computeNumbers = (blocks: Block[]): (number | null)[] => {
  const numbers: (number | null)[] = [];
  let counters: (number | null)[] = [];
  blocks.forEach((block) => {
    if (block.kind === 'text') {
      counters = [];
      numbers.push(null);
      return;
    }
    const level = indentOf(block);
    counters = counters.slice(0, level + 1);
    if (block.kind === 'bullet') {
      counters[level] = null;
      numbers.push(null);
      return;
    }
    const previous = counters[level];
    const value = previous !== null && previous !== undefined ? previous + 1 : (block.start ?? 1);
    counters[level] = value;
    numbers.push(value);
  });
  return numbers;
};

/**
 * Indent (delta = 1) or outdent (delta = -1) the list item at `index` together with its
 * nested children. An item can be at most one level deeper than the list item above it.
 * Returns null when nothing changes (plain line, first item, already at the limit).
 */
export const shiftIndent = (blocks: Block[], index: number, delta: 1 | -1): Block[] | null => {
  const block = blocks[index];
  if (!block || block.kind === 'text') {
    return null;
  }
  const oldIndent = indentOf(block);
  let newIndent: number;
  if (delta > 0) {
    const previous = blocks[index - 1];
    const maxIndent = previous && previous.kind !== 'text' ? indentOf(previous) + 1 : 0;
    newIndent = Math.min(oldIndent + 1, maxIndent, MAX_INDENT);
  } else {
    newIndent = Math.max(0, oldIndent - 1);
  }
  if (newIndent === oldIndent) {
    return null;
  }
  const shift = newIndent - oldIndent;
  const next = blocks.slice();
  next[index] = { ...block, indent: newIndent };
  // Children are the following list items that are nested deeper than the item was.
  for (let child = index + 1; child < next.length; child += 1) {
    const candidate = next[child];
    if (candidate.kind === 'text' || indentOf(candidate) <= oldIndent) {
      break;
    }
    next[child] = {
      ...candidate,
      indent: Math.max(0, Math.min(MAX_INDENT, indentOf(candidate) + shift)),
    };
  }
  return next;
};

/**
 * Number of filled top-level list items (bullets and numbered items), matching
 * RemNote's "Recall N bullets" hint, which counts the direct children of a card.
 * Nested items and empty items are ignored; an item with line breaks counts once.
 */
export const countListItems = (blocks: Block[]): number =>
  blocks.filter(
    (block) => block.kind !== 'text' && indentOf(block) === 0 && block.text.trim().length > 0
  ).length;

/** Turn the start of a plain line into a list item if it carries a list prefix. */
export const applyListTrigger = (text: string): Omit<Block, 'id'> => {
  const bulletMatch = text.match(BULLET_TRIGGER);
  if (bulletMatch) {
    return { kind: 'bullet', text: text.slice(bulletMatch[0].length) };
  }
  const numberMatch = text.match(NUMBER_TRIGGER);
  if (numberMatch) {
    return {
      kind: 'number',
      text: text.slice(numberMatch[0].length),
      start: parseInt(numberMatch[1], 10),
    };
  }
  return { kind: 'text', text };
};

/**
 * Plain-text export of all lines (used for copy and cut of the whole field).
 * Nested items are indented by four spaces per level; line breaks inside a
 * list item are indented to the marker width so the item survives a round
 * trip through parseText.
 */
export const serializeBlocks = (blocks: Block[]): string => {
  const numbers = computeNumbers(blocks);
  return blocks
    .map((block, index) => {
      if (block.kind === 'text') {
        return block.text;
      }
      const levelIndent = ' '.repeat(indentOf(block) * SERIALIZED_INDENT);
      const marker = block.kind === 'bullet' ? '- ' : `${numbers[index]}. `;
      const continuationIndent = levelIndent + ' '.repeat(marker.length);
      return levelIndent + marker + block.text.split('\n').join(`\n${continuationIndent}`);
    })
    .join('\n');
};

/** Visual width of leading whitespace, counting a tab as four spaces. */
const leadingWidth = (whitespace: string): number =>
  [...whitespace].reduce((width, char) => width + (char === '\t' ? TAB_WIDTH : 1), 0);

/**
 * Parse multi-line text into lines.
 * - Lines starting with "- " or "1. " become list items. Their nesting level is
 *   derived from the leading whitespace relative to the list items above
 *   (any consistent indentation works: 2 or 4 spaces, tabs).
 * - Indented lines directly after a list item are continuation lines of that item.
 * - Everything else becomes a plain line.
 */
export const parseText = (text: string): Block[] => {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Leading-whitespace widths of the currently open list levels.
  let levelWidths: number[] = [];

  lines.forEach((line) => {
    const whitespace = line.match(/^[ \t]*/)?.[0] ?? '';
    const withoutIndent = line.slice(whitespace.length);
    const width = leadingWidth(whitespace);
    const parsed = applyListTrigger(withoutIndent);
    const previous = blocks[blocks.length - 1];

    if (parsed.kind !== 'text') {
      if (!previous || previous.kind === 'text') {
        levelWidths = [];
      }
      while (levelWidths.length > 0 && levelWidths[levelWidths.length - 1] > width) {
        levelWidths.pop();
      }
      if (levelWidths.length === 0 || levelWidths[levelWidths.length - 1] < width) {
        levelWidths.push(width);
      }
      const block = createBlock(parsed.kind, parsed.text, parsed.start);
      block.indent = Math.min(levelWidths.length - 1, MAX_INDENT);
      blocks.push(block);
      return;
    }

    if (whitespace.length > 0 && previous && previous.kind !== 'text') {
      previous.text = `${previous.text}\n${withoutIndent}`;
      return;
    }
    levelWidths = [];
    blocks.push(createBlock('text', line));
  });

  return blocks;
};

/**
 * Apply a new value typed into a line. A list prefix typed at the start of a line
 * switches its type: "- " or "1. " turns a plain line into a list item, "1. " turns a
 * bullet into a numbered item and "- " a numbered item into a bullet (the nesting level
 * is kept). The prefix of the line's own list type stays literal text, and so does a
 * prefix that was already part of the text before this change. The caret is shifted
 * by the removed prefix.
 */
export const applyTextChange = (block: Block, value: string, caret: number) => {
  const parsed = applyListTrigger(value);
  const isNewPrefix =
    parsed.kind !== 'text' &&
    parsed.kind !== block.kind &&
    applyListTrigger(block.text).kind !== parsed.kind;
  if (isNewPrefix) {
    const prefixLength = value.length - parsed.text.length;
    const switched = { id: block.id, ...parsed } as Block;
    if (block.kind !== 'text') {
      switched.indent = indentOf(block);
    }
    return {
      block: switched,
      caret: Math.max(0, caret - prefixLength),
      isListTrigger: true,
    };
  }
  return { block: { ...block, text: value }, caret, isListTrigger: false };
};

/**
 * A list prefix typed at the start of a line break inside a plain line (Shift+Enter or
 * Option+Enter) splits the line there: the text before the break stays a plain line,
 * the broken line becomes a list item and any lines after it stay plain text.
 * Returns null when the change is not such a prefix (handled by applyTextChange then).
 * Line breaks inside list items are left alone, they are part of the item.
 */
export const splitAtListTrigger = (
  block: Block,
  value: string,
  caret: number
): { blocks: Block[]; focus: PendingFocus } | null => {
  if (block.kind !== 'text') {
    return null;
  }
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  if (lineStart === 0) {
    return null;
  }
  const lineEnd = value.indexOf('\n', lineStart);
  const line = value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const parsed = applyListTrigger(line);
  if (parsed.kind === 'text') {
    return null;
  }
  // Only a prefix that was just typed: the caret sits right behind it and the
  // previous text did not already carry it at this position.
  const prefixLength = line.length - parsed.text.length;
  const previousLine = block.text.slice(lineStart).split('\n')[0];
  if (caret !== lineStart + prefixLength || applyListTrigger(previousLine).kind === parsed.kind) {
    return null;
  }

  const listItem = createBlock(parsed.kind, parsed.text, parsed.start);
  const blocks: Block[] = [{ ...block, text: value.slice(0, lineStart - 1) }, listItem];
  if (lineEnd !== -1) {
    blocks.push(createBlock('text', value.slice(lineEnd + 1)));
  }
  return { blocks, focus: { id: listItem.id, caret: 0 } };
};

/**
 * Paste plain text into line `index` replacing the selection [selectionStart, selectionEnd).
 * Returns null when the native paste can be used (single line without trailing break).
 */
export const pasteIntoBlocks = (
  blocks: Block[],
  index: number,
  selectionStart: number,
  selectionEnd: number,
  pasted: string
): EditResult | null => {
  const normalized = pasted.replace(/\r\n?/g, '\n');
  const trimmed = normalized.replace(/\n+$/, '');
  const block = blocks[index];
  const value = block.text;
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);

  if (!trimmed.includes('\n')) {
    if (trimmed === normalized) {
      return null;
    }
    // Single line copied with a trailing line break: insert it without the break.
    const change = applyTextChange(block, before + trimmed + after, before.length + trimmed.length);
    const next = blocks.slice();
    next[index] = change.block;
    return { blocks: next, focus: { id: block.id, caret: change.caret } };
  }

  // Pasted list items are nested relative to the list item the cursor is in.
  const baseIndent = indentOf(block);
  const pastedBlocks = parseText(trimmed).map((pastedBlock) =>
    pastedBlock.kind === 'text'
      ? pastedBlock
      : { ...pastedBlock, indent: Math.min(MAX_INDENT, indentOf(pastedBlock) + baseIndent) }
  );
  const parsedFirst = pastedBlocks[0];

  // The first pasted line continues the current line.
  let firstBlock: Block;
  if (before.length === 0) {
    firstBlock =
      parsedFirst.kind === 'text'
        ? { ...block, text: parsedFirst.text }
        : { ...parsedFirst, id: block.id };
  } else {
    // Text before the cursor keeps the current line type; a pasted list prefix stays literal.
    const firstRawLine = trimmed.split('\n')[0];
    const firstContentLine = parsedFirst.text.split('\n')[0];
    const continuation = parsedFirst.text.slice(firstContentLine.length);
    firstBlock = { ...block, text: before + firstRawLine + continuation };
  }

  const combined = [firstBlock, ...pastedBlocks.slice(1)];
  const lastIndex = combined.length - 1;
  const lastBlock = combined[lastIndex];
  const caret = lastBlock.text.length;
  combined[lastIndex] = { ...lastBlock, text: lastBlock.text + after };

  const next = blocks.slice();
  next.splice(index, 1, ...combined);
  return { blocks: next, focus: { id: lastBlock.id, caret } };
};

/**
 * Restore the nesting invariant after lines were merged or a marker was removed:
 * a list item is at most one level deeper than the list item directly above it, and a
 * list item after a plain line starts at level 0. Unchanged blocks keep their identity.
 */
export const normalizeIndents = (blocks: Block[]): Block[] => {
  let changed = false;
  const next = blocks.slice();
  for (let index = 0; index < next.length; index += 1) {
    const block = next[index];
    if (block.kind === 'text') {
      continue;
    }
    const previous = next[index - 1];
    const maxIndent = previous && previous.kind !== 'text' ? indentOf(previous) + 1 : 0;
    if (indentOf(block) > maxIndent) {
      next[index] = { ...block, indent: maxIndent };
      changed = true;
    }
  }
  return changed ? next : blocks;
};

/** Position in the notes: line index and character offset inside that line's text. */
export interface BlockPoint {
  index: number;
  offset: number;
}

/** Negative when `a` comes before `b`, zero when both are the same position. */
export const comparePoints = (a: BlockPoint, b: BlockPoint): number =>
  a.index - b.index || a.offset - b.offset;

/**
 * Delete the text between `start` and `end` (start <= end), possibly across lines.
 * The first line keeps its type and id and takes over the rest of the last line;
 * the lines in between are removed. Deleting everything leaves one empty plain line.
 */
export const deleteRange = (blocks: Block[], start: BlockPoint, end: BlockPoint): EditResult => {
  const first = blocks[start.index];
  const last = blocks[end.index];
  const coversAll =
    comparePoints(start, end) < 0 &&
    start.index === 0 &&
    start.offset === 0 &&
    end.index === blocks.length - 1 &&
    end.offset === last.text.length;
  if (coversAll) {
    return { blocks: [{ id: first.id, kind: 'text', text: '' }], focus: { id: first.id, caret: 0 } };
  }
  const merged: Block = {
    ...first,
    text: first.text.slice(0, start.offset) + last.text.slice(end.offset),
  };
  const next = blocks.slice();
  next.splice(start.index, end.index - start.index + 1, merged);
  return { blocks: normalizeIndents(next), focus: { id: first.id, caret: start.offset } };
};

/**
 * Lines covered by a selection, with the first and last line cut to the selection.
 * Line types and nesting levels are kept; numbered items keep their visible number.
 */
export const sliceBlocks = (blocks: Block[], start: BlockPoint, end: BlockPoint): Block[] => {
  const numbers = computeNumbers(blocks);
  const slice: Block[] = [];
  for (let index = start.index; index <= end.index; index += 1) {
    const block = blocks[index];
    const from = index === start.index ? start.offset : 0;
    const to = index === end.index ? end.offset : block.text.length;
    const part: Block = { ...block, text: block.text.slice(from, to) };
    const number = numbers[index];
    if (block.kind === 'number' && number !== null) {
      part.start = number;
    }
    slice.push(part);
  }
  return slice;
};

/**
 * Plain text of a selection for the clipboard. A selection inside one line is copied
 * as it is; a selection across lines keeps list markers and nesting (see serializeBlocks).
 */
export const selectionText = (blocks: Block[], start: BlockPoint, end: BlockPoint): string => {
  if (start.index === end.index) {
    return blocks[start.index].text.slice(start.offset, end.offset);
  }
  return serializeBlocks(sliceBlocks(blocks, start, end));
};

/**
 * Indent or outdent every list item in the lines `from`..`to`. Items nested under a
 * selected item move with it and are not shifted a second time. Returns null when
 * nothing changes.
 */
export const shiftIndentRange = (
  blocks: Block[],
  from: number,
  to: number,
  delta: 1 | -1
): Block[] | null => {
  let next = blocks;
  // Original nesting level of the last selected item that was shifted with its children.
  let rootIndent: number | null = null;
  for (let index = from; index <= to; index += 1) {
    const block = blocks[index];
    if (block.kind === 'text') {
      rootIndent = null;
      continue;
    }
    if (rootIndent !== null && indentOf(block) > rootIndent) {
      continue;
    }
    const shifted = shiftIndent(next, index, delta);
    // An item that cannot move leaves its children to be shifted on their own.
    rootIndent = shifted ? indentOf(block) : null;
    if (shifted) {
      next = shifted;
    }
  }
  return next === blocks ? null : next;
};

export interface LineEditResult {
  blocks: Block[];
  /** Caret to set when the edit changed the structure; null for plain typing. */
  focus: PendingFocus | null;
  /** Plain typing that can be merged into one undo step. */
  typing: boolean;
}

/**
 * Apply a new text typed into line `index` with the caret at `caret`. A list prefix
 * typed at the start of the line switches its type, a prefix typed after a line break
 * in a plain line splits it (see applyTextChange and splitAtListTrigger).
 */
export const editLineText = (
  blocks: Block[],
  index: number,
  value: string,
  caret: number
): LineEditResult => {
  const block = blocks[index];
  const next = blocks.slice();
  const split = splitAtListTrigger(block, value, caret);
  if (split) {
    next.splice(index, 1, ...split.blocks);
    return { blocks: next, focus: split.focus, typing: false };
  }
  const change = applyTextChange(block, value, caret);
  next[index] = change.block;
  if (change.isListTrigger) {
    return { blocks: next, focus: { id: block.id, caret: change.caret }, typing: false };
  }
  return { blocks: next, focus: null, typing: true };
};

/**
 * Insert plain text (paste) into line `index`, replacing [selectionStart, selectionEnd).
 * Multi-line text is split into lines like pasteIntoBlocks does.
 */
export const insertPlainText = (
  blocks: Block[],
  index: number,
  selectionStart: number,
  selectionEnd: number,
  text: string
): EditResult => {
  const pasted = pasteIntoBlocks(blocks, index, selectionStart, selectionEnd, text);
  if (pasted) {
    return pasted;
  }
  const block = blocks[index];
  const caret = selectionStart + text.length;
  const value = block.text.slice(0, selectionStart) + text + block.text.slice(selectionEnd);
  const edit = editLineText(blocks, index, value, caret);
  return { blocks: edit.blocks, focus: edit.focus ?? { id: block.id, caret } };
};

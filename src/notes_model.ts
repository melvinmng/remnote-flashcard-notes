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
}

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

/** Numbers for numbered items; consecutive numbered blocks form one run. */
export const computeNumbers = (blocks: Block[]): (number | null)[] => {
  const numbers: (number | null)[] = [];
  blocks.forEach((block, index) => {
    if (block.kind !== 'number') {
      numbers.push(null);
      return;
    }
    const previous = index > 0 ? numbers[index - 1] : null;
    numbers.push(previous !== null ? previous + 1 : (block.start ?? 1));
  });
  return numbers;
};

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
 * Line breaks inside a list item are indented to the marker width so the
 * item survives a round trip through parseText.
 */
export const serializeBlocks = (blocks: Block[]): string => {
  const numbers = computeNumbers(blocks);
  return blocks
    .map((block, index) => {
      if (block.kind === 'text') {
        return block.text;
      }
      const marker = block.kind === 'bullet' ? '- ' : `${numbers[index]}. `;
      const indent = ' '.repeat(marker.length);
      return marker + block.text.split('\n').join(`\n${indent}`);
    })
    .join('\n');
};

/**
 * Parse multi-line text into lines.
 * - Lines starting with "- " or "1. " (leading whitespace ignored) become list items;
 *   nested lists from other apps are flattened.
 * - Indented lines directly after a list item are continuation lines of that item.
 * - Everything else becomes a plain line.
 */
export const parseText = (text: string): Block[] => {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  lines.forEach((line) => {
    const withoutIndent = line.replace(/^[ \t]+/, '');
    const parsed = applyListTrigger(withoutIndent);
    if (parsed.kind !== 'text') {
      blocks.push(createBlock(parsed.kind, parsed.text, parsed.start));
      return;
    }
    const previous = blocks[blocks.length - 1];
    const isIndented = withoutIndent.length < line.length;
    if (isIndented && previous && previous.kind !== 'text') {
      previous.text = `${previous.text}\n${withoutIndent}`;
      return;
    }
    blocks.push(createBlock('text', line));
  });

  return blocks;
};

/**
 * Apply a new value typed into a line. Plain lines starting with "- " or "1. "
 * become list items; the caret is shifted by the removed prefix.
 */
export const applyTextChange = (block: Block, value: string, caret: number) => {
  if (block.kind === 'text') {
    const parsed = applyListTrigger(value);
    if (parsed.kind !== 'text') {
      const prefixLength = value.length - parsed.text.length;
      return {
        block: { id: block.id, ...parsed } as Block,
        caret: Math.max(0, caret - prefixLength),
        isListTrigger: true,
      };
    }
  }
  return { block: { ...block, text: value }, caret, isListTrigger: false };
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

  const pastedBlocks = parseText(trimmed);
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

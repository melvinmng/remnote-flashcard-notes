/**
 * DOM side of the notes editor: one contentEditable element whose children are the
 * lines. React does not render these children; `renderLines` keeps them in sync with
 * the model, so edits made by the browser (typing, IME composition) can never
 * conflict with React's reconciliation.
 *
 * A line is a <div data-line-id> holding one text node with the line's text
 * (line breaks are "\n" characters, shown via white-space: pre-wrap). An empty line,
 * or a line ending in "\n", gets a trailing <br> so it keeps its height and the caret
 * can be placed on the last visual line. List markers are CSS pseudo-elements, so they
 * are neither editable nor part of the selection.
 */

import type { PendingFocus } from './notes_model';

export interface LineView {
  id: string;
  kind: 'text' | 'bullet' | 'number';
  text: string;
  indent: number;
  /** Visible number of a numbered item. */
  number: number | null;
  /** Placeholder shown while the line is empty; empty string for none. */
  placeholder: string;
}

export interface DomSelection {
  anchor: PendingFocus;
  focus: PendingFocus;
}

/** Horizontal offset per nesting level; equals the bullet marker column. */
export const INDENT_STEP_PX = 26;

const LINE_ID_ATTRIBUTE = 'data-line-id';

/** The browser may store typed spaces as no-break spaces; the model only knows spaces. */
const normalizeText = (text: string): string => text.replace(/ /g, ' ');

const lineIdOf = (node: Node): string | null =>
  node instanceof HTMLElement ? node.getAttribute(LINE_ID_ATTRIBUTE) : null;

/**
 * Text nodes and <br> elements of a line in document order. A <br> inside the text is a
 * line break the browser inserted ("\n" in the model); the last <br> is the filler.
 */
const lineParts = (line: Node): Node[] => {
  if (line.nodeType === Node.TEXT_NODE) {
    return [line];
  }
  const parts: Node[] = [];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE || node.nodeName === 'BR') {
      parts.push(node);
    }
  }
  return parts;
};

const partLength = (part: Node, isLast: boolean): number =>
  part.nodeType === Node.TEXT_NODE ? (part.nodeValue ?? '').length : isLast ? 0 : 1;

/** Text of a line as stored in the model. */
export const lineText = (line: Node): string => {
  const parts = lineParts(line);
  return normalizeText(
    parts
      .map((part, index) =>
        part.nodeType === Node.TEXT_NODE ? part.nodeValue ?? '' : index === parts.length - 1 ? '' : '\n'
      )
      .join('')
  );
};

/** Character offset of the DOM position (node, offset) inside `line`, matching lineText. */
export const offsetInLine = (line: Node, node: Node, offset: number): number => {
  const point = document.createRange();
  point.setStart(node, offset);
  const parts = lineParts(line);
  let length = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === node) {
      return length + offset;
    }
    if (point.comparePoint(part, 0) >= 0) {
      return length;
    }
    length += partLength(part, index === parts.length - 1);
  }
  return length;
};

const needsFiller = (text: string) => text.length === 0 || text.endsWith('\n');

/** True when the line consists exactly of its text node and the optional filler <br>. */
const isCanonical = (line: HTMLElement, text: string): boolean => {
  const nodes = Array.from(line.childNodes);
  const expectedLength = (text.length > 0 ? 1 : 0) + (needsFiller(text) ? 1 : 0);
  if (nodes.length !== expectedLength) {
    return false;
  }
  if (text.length > 0) {
    const textNode = nodes[0];
    if (textNode.nodeType !== Node.TEXT_NODE || normalizeText(textNode.nodeValue ?? '') !== text) {
      return false;
    }
  }
  return !needsFiller(text) || nodes[nodes.length - 1].nodeName === 'BR';
};

const fillLine = (line: HTMLElement, text: string) => {
  const nodes: Node[] = [];
  if (text.length > 0) {
    nodes.push(document.createTextNode(text));
  }
  if (needsFiller(text)) {
    nodes.push(document.createElement('br'));
  }
  line.replaceChildren(...nodes);
};

const applyLineAttributes = (line: HTMLElement, view: LineView) => {
  const level = view.kind === 'text' ? 0 : view.indent % 3;
  line.className =
    `fn-line fn-line--${view.kind}` +
    (view.kind === 'bullet' ? ` fn-line--level-${level}` : '') +
    (view.placeholder && view.text.length === 0 ? ' fn-line--placeholder' : '');
  line.style.setProperty('--fn-indent', `${view.indent * INDENT_STEP_PX}px`);
  if (view.kind === 'number' && view.number !== null) {
    line.setAttribute('data-number', `${view.number}.`);
  } else {
    line.removeAttribute('data-number');
  }
  if (view.placeholder) {
    line.setAttribute('data-placeholder', view.placeholder);
  } else {
    line.removeAttribute('data-placeholder');
  }
};

/**
 * Bring the editor's children in line with `views`: reuse line elements by id, rebuild
 * the content of lines that differ from the model and drop every other node (for example
 * elements the browser inserted). Returns true when the content of a line was rebuilt,
 * which invalidates the DOM selection.
 */
export const renderLines = (editor: HTMLElement, views: LineView[]): boolean => {
  const existing = new Map<string, HTMLElement>();
  Array.from(editor.childNodes).forEach((node) => {
    const id = lineIdOf(node);
    if (id && !existing.has(id)) {
      existing.set(id, node as HTMLElement);
    } else {
      editor.removeChild(node);
    }
  });

  let rebuilt = false;
  views.forEach((view, index) => {
    let line = existing.get(view.id);
    existing.delete(view.id);
    if (!line) {
      line = document.createElement('div');
      line.setAttribute(LINE_ID_ATTRIBUTE, view.id);
    }
    applyLineAttributes(line, view);
    if (!isCanonical(line, view.text)) {
      fillLine(line, view.text);
      rebuilt = true;
    }
    const current = editor.childNodes[index] ?? null;
    if (current !== line) {
      editor.insertBefore(line, current);
    }
  });
  existing.forEach((line) => {
    line.remove();
    rebuilt = true;
  });
  return rebuilt;
};

export interface DomLine {
  /** Line id, or null for a node the editor did not create (or a duplicated id). */
  id: string | null;
  text: string;
  node: Node;
}

/** Lines as currently shown in the DOM, in order. */
export const readLines = (editor: HTMLElement): DomLine[] => {
  const seen = new Set<string>();
  const lines: DomLine[] = [];
  editor.childNodes.forEach((node) => {
    const id = lineIdOf(node);
    const text = lineText(node);
    if (id && !seen.has(id)) {
      seen.add(id);
      lines.push({ id, text, node });
    } else if (text.length > 0 || node.nodeName === 'DIV') {
      lines.push({ id: null, text, node });
    }
  });
  return lines;
};

/** Line element that contains `node`, or null when the node is outside every line. */
const lineOf = (editor: HTMLElement, node: Node): HTMLElement | null => {
  let current: Node | null = node;
  while (current && current.parentNode !== editor) {
    current = current.parentNode;
  }
  return current && lineIdOf(current) ? (current as HTMLElement) : null;
};

/** Map a DOM position to a line id and character offset. */
export const domPointToModel = (
  editor: HTMLElement,
  node: Node,
  offset: number
): PendingFocus | null => {
  if (node === editor) {
    // Position between lines: start of the following line or end of the last one.
    const lines = Array.from(editor.childNodes).filter((child) => lineIdOf(child));
    const before = Array.from(editor.childNodes).slice(0, offset).filter((child) => lineIdOf(child));
    const following = lines[before.length];
    if (following) {
      return { id: lineIdOf(following)!, caret: 0 };
    }
    const last = lines[lines.length - 1];
    return last ? { id: lineIdOf(last)!, caret: lineText(last).length } : null;
  }
  if (!editor.contains(node)) {
    return null;
  }
  const line = lineOf(editor, node);
  if (!line) {
    return null;
  }
  return { id: lineIdOf(line)!, caret: offsetInLine(line, node, offset) };
};

/**
 * Position of the selection focus as index into `lines` (from readLines) and offset.
 * Used when the browser changed the line structure itself and line ids are not reliable
 * (a split line carries a copy of the original id).
 */
export const selectionInLines = (
  editor: HTMLElement,
  lines: DomLine[]
): { index: number; caret: number } | null => {
  const selection = editor.ownerDocument.getSelection();
  const focusNode = selection?.focusNode;
  if (!selection || !focusNode) {
    return null;
  }
  const index = lines.findIndex((line) => line.node === focusNode || line.node.contains(focusNode));
  if (index < 0) {
    return null;
  }
  return { index, caret: offsetInLine(lines[index].node, focusNode, selection.focusOffset) };
};

const modelPointToDom = (
  editor: HTMLElement,
  point: PendingFocus
): { node: Node; offset: number } | null => {
  const line = Array.from(editor.childNodes).find((child) => lineIdOf(child) === point.id);
  if (!line) {
    return null;
  }
  const textNode = line.firstChild;
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    const length = textNode.nodeValue?.length ?? 0;
    return { node: textNode, offset: Math.max(0, Math.min(point.caret, length)) };
  }
  return { node: line, offset: 0 };
};

/** Current selection inside the editor, or null when the selection is elsewhere. */
export const readSelection = (editor: HTMLElement): DomSelection | null => {
  const selection = editor.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) {
    return null;
  }
  const anchor = domPointToModel(editor, selection.anchorNode, selection.anchorOffset);
  const focus = domPointToModel(editor, selection.focusNode, selection.focusOffset);
  return anchor && focus ? { anchor, focus } : null;
};

/** Map a static range (InputEvent.getTargetRanges) to model points. */
export const readStaticRange = (editor: HTMLElement, range: StaticRange): DomSelection | null => {
  const anchor = domPointToModel(editor, range.startContainer, range.startOffset);
  const focus = domPointToModel(editor, range.endContainer, range.endOffset);
  return anchor && focus ? { anchor, focus } : null;
};

/** Focus the editor and select from `anchor` to `focus` (collapsed when equal). */
export const writeSelection = (editor: HTMLElement, anchor: PendingFocus, focus = anchor) => {
  const start = modelPointToDom(editor, anchor);
  const end = modelPointToDom(editor, focus);
  if (!start || !end) {
    return;
  }
  if (editor.ownerDocument.activeElement !== editor) {
    editor.focus({ preventScroll: true });
  }
  const selection = editor.ownerDocument.getSelection();
  if (!selection) {
    return;
  }
  selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
};

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AppEvents,
  renderWidget,
  usePlugin,
  useAPIEventListener,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import {
  type Block,
  type BlockPoint,
  comparePoints,
  computeNumbers,
  countListItems,
  createBlock,
  deleteRange,
  editLineText,
  emptyNotes,
  hasContent,
  indentOf,
  insertPlainText,
  isValidBlock,
  type PendingFocus,
  selectionText,
  shiftIndent,
  shiftIndentRange,
} from '../notes_model';
import {
  type DomSelection,
  type LineView,
  readLines,
  readSelection,
  readStaticRange,
  renderLines,
  selectionInLines,
  writeSelection,
} from '../editor_dom';
import { SESSION_NOTES_KEY, SETTING_HIDE_AFTER_REVEAL, SETTING_MIN_ROWS } from '../shared';
import '../style.css';
import '../index.css';

const DEFAULT_MIN_ROWS = 2;
const LINE_HEIGHT_PX = 24;
/** Vertical padding of .fn-editor (top + bottom), see index.css. */
const EDITOR_PADDING_Y_PX = 20;

/** Injected by webpack: "dev <version> · <build time>" in development, empty in production. */
declare const __DEV_BUILD_LABEL__: string;

interface StoredNotes {
  cardKey: string;
  blocks: Block[];
}

interface HistoryEntry {
  blocks: Block[];
  focus: PendingFocus | null;
}

interface CommitOptions {
  /** Id of the line being typed in; consecutive typing is merged into one undo step. */
  typingIn?: string;
  /** Caret to restore on undo, when the DOM selection already reflects the edit. */
  undoFocus?: PendingFocus | null;
}

/** Selection resolved to ordered model positions. */
interface ModelRange {
  start: BlockPoint;
  end: BlockPoint;
  collapsed: boolean;
}

const HISTORY_LIMIT = 200;
const TYPING_GROUP_MS = 1000;

/** Input types the editor does not model; the browser must not apply them either. */
const BLOCKED_INPUT_TYPES = new Set([
  'insertFromDrop',
  'deleteByDrag',
  'deleteByCut',
  'insertFromPaste',
  'insertFromPasteAsQuotation',
  'insertFromYank',
  'insertLink',
  'insertOrderedList',
  'insertUnorderedList',
  'insertHorizontalRule',
  'insertTranspose',
]);

const toModelRange = (blocks: Block[], selection: DomSelection | null): ModelRange | null => {
  if (!selection) {
    return null;
  }
  const toPoint = (point: PendingFocus): BlockPoint | null => {
    const index = blocks.findIndex((block) => block.id === point.id);
    return index < 0
      ? null
      : { index, offset: Math.min(point.caret, blocks[index].text.length) };
  };
  const anchor = toPoint(selection.anchor);
  const focus = toPoint(selection.focus);
  if (!anchor || !focus) {
    return null;
  }
  const order = comparePoints(anchor, focus);
  return order <= 0
    ? { start: anchor, end: focus, collapsed: order === 0 }
    : { start: focus, end: anchor, collapsed: false };
};

/**
 * A selection that ends at the very start of a later line (triple-click, or dragging to
 * the left edge) is treated as ending at the end of the line before, so Tab, copy and
 * typing do not affect a line that is visibly not selected.
 */
const withoutTrailingLineStart = (blocks: Block[], range: ModelRange): ModelRange => {
  if (range.collapsed || range.end.offset > 0 || range.end.index <= range.start.index) {
    return range;
  }
  const index = range.end.index - 1;
  const end = { index, offset: blocks[index].text.length };
  return { start: range.start, end, collapsed: comparePoints(range.start, end) === 0 };
};

/**
 * Notes field rendered below the current flashcard.
 *
 * The field is a single contentEditable element, so a selection can span several lines
 * with the mouse or Shift+arrows. The notes are kept as a list of lines (blocks): plain
 * text, bullet or numbered items. Typing "- " or "1. " at the start of a line turns it
 * into a list item; the same prefixes switch between bullet and number. Plain typing
 * inside a line is applied by the browser and read back on "input"; everything that
 * changes the line structure is intercepted and applied to the model
 * (see src/notes_model.ts), and the DOM is then re-rendered (see src/editor_dom.ts).
 *
 * Keyboard model:
 * - Enter                    new line; inside a list it continues the list,
 *                            on an empty list item it ends the list
 * - Shift/Option+Enter       line break inside the current line
 * - Backspace at line start  removes the list marker, then merges with the line above
 * - Delete at line end       merges the next line into the current one
 * - Tab / Shift+Tab          indent / outdent the selected list items with their children
 * - Cmd/Ctrl+A               native select all; typing or deleting replaces the selection
 * - Cmd/Ctrl+Z               undo across all lines (Shift+Cmd/Ctrl+Z or Ctrl+Y to redo)
 * - Esc                      leaves the field so queue shortcuts work again
 *
 * Notes are never written to the knowledge base. A copy is mirrored into plugin session
 * storage so the text survives a remount of the widget (e.g. when the answer is
 * revealed); the index plugin clears it when a card is completed or the queue is left.
 * Only the minimal read-only FocusedSubtree scope is requested, because RemNote rejects
 * API calls from plugins without one.
 */
export const FlashcardNotesWidget = () => {
  const plugin = usePlugin();
  const [blocks, setBlocks] = useState<Block[]>(emptyNotes);
  const [revealedByEvent, setRevealedByEvent] = useState(false);
  // Callback ref as state: the layout effect must run again when the editor remounts.
  const [editor, setEditor] = useState<HTMLDivElement | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const composing = useRef(false);
  const blocksRef = useRef<Block[]>(blocks);
  blocksRef.current = blocks;
  // Field-wide undo/redo history; the browser's own history is disabled.
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const lastTyping = useRef<{ id: string; time: number } | null>(null);
  // Set in beforeinput for a native edit: whether it is plain typing that may be merged into
  // the previous undo step, and the caret before the edit (restored by undo).
  const nativeEdit = useRef<{ typing: boolean; focus: PendingFocus | null } | null>(null);

  const resetHistory = () => {
    undoStack.current = [];
    redoStack.current = [];
    lastTyping.current = null;
  };

  const widgetContext = useTrackerPlugin(
    async (reactivePlugin) =>
      await reactivePlugin.widget.getWidgetContext<WidgetLocation.FlashcardUnder>()
  );
  const minRowsSetting = useTrackerPlugin(
    async (reactivePlugin) => await reactivePlugin.settings.getSetting<number>(SETTING_MIN_ROWS)
  );
  const hideAfterReveal = useTrackerPlugin(
    async (reactivePlugin) =>
      await reactivePlugin.settings.getSetting<boolean>(SETTING_HIDE_AFTER_REVEAL)
  );

  const cardKey = widgetContext?.cardId ?? widgetContext?.remId;
  const isRevealed = (widgetContext?.revealed ?? false) || revealedByEvent;
  const minRows =
    typeof minRowsSetting === 'number' && minRowsSetting > 0
      ? Math.round(minRowsSetting)
      : DEFAULT_MIN_ROWS;
  const placeholder =
    blocks.length === 1 && blocks[0].kind === 'text'
      ? isRevealed
        ? 'Your notes'
        : 'Write down what you remember …'
      : '';

  // Restore notes for the current card after a remount, otherwise start empty.
  useEffect(() => {
    if (!cardKey) {
      // The widget context is not known yet; restoring now would discard early typing.
      return;
    }
    let cancelled = false;
    const restoreNotes = async () => {
      const stored = await plugin.storage.getSession<StoredNotes | null>(SESSION_NOTES_KEY);
      if (cancelled) {
        return;
      }
      const restored =
        stored &&
        cardKey &&
        stored.cardKey === cardKey &&
        Array.isArray(stored.blocks) &&
        stored.blocks.length > 0 &&
        stored.blocks.every(isValidBlock)
          ? stored.blocks
          : null;
      if (restored) {
        composing.current = false;
        resetHistory();
        setBlocks(restored);
      } else if (hasContent(blocksRef.current)) {
        // Typed before the restore finished: keep it and store it for this card.
        void plugin.storage.setSession(SESSION_NOTES_KEY, { cardKey, blocks: blocksRef.current });
      } else {
        composing.current = false;
        resetHistory();
        setBlocks(emptyNotes());
      }
    };
    void restoreNotes();
    return () => {
      cancelled = true;
    };
  }, [cardKey, plugin]);

  /** Caret of the current selection, used to restore the cursor on undo/redo. */
  const currentFocus = (): PendingFocus | null => (editor ? readSelection(editor)?.focus ?? null : null);

  const currentRange = (): ModelRange | null =>
    editor ? toModelRange(blocksRef.current, readSelection(editor)) : null;

  /** Render blocks, move the caret and mirror the notes into session storage. */
  const applyBlocks = (nextBlocks: Block[], focus?: PendingFocus | null) => {
    // A model edit (clear button, undo, card change) replaces whatever an input method
    // is composing; blurring ends the composition, the pending focus refocuses the editor.
    if (composing.current) {
      composing.current = false;
      if (editor && editor.ownerDocument.activeElement === editor) {
        editor.blur();
      }
    }
    if (focus) {
      pendingFocus.current = focus;
    }
    blocksRef.current = nextBlocks;
    setBlocks(nextBlocks);
    if (cardKey) {
      void plugin.storage.setSession(SESSION_NOTES_KEY, { cardKey, blocks: nextBlocks });
    }
  };

  /** Apply an edit and record the previous state for undo. */
  const commitBlocks = (
    nextBlocks: Block[],
    focus?: PendingFocus | null,
    options: CommitOptions = {}
  ) => {
    const safeBlocks = nextBlocks.length > 0 ? nextBlocks : emptyNotes();
    const previousBlocks = blocksRef.current;
    // Native edit info is consumed by syncFromDom before it commits; never reuse it.
    nativeEdit.current = null;

    if (safeBlocks !== previousBlocks) {
      const now = Date.now();
      const continuesTyping =
        options.typingIn !== undefined &&
        lastTyping.current?.id === options.typingIn &&
        now - lastTyping.current.time < TYPING_GROUP_MS;
      if (!continuesTyping) {
        const focus = options.undoFocus !== undefined ? options.undoFocus : currentFocus();
        undoStack.current.push({ blocks: previousBlocks, focus });
        if (undoStack.current.length > HISTORY_LIMIT) {
          undoStack.current.shift();
        }
      }
      redoStack.current = [];
      lastTyping.current = options.typingIn ? { id: options.typingIn, time: now } : null;
    }

    applyBlocks(safeBlocks, focus);
  };

  const undo = () => {
    const entry = undoStack.current.pop();
    if (!entry) {
      return;
    }
    redoStack.current.push({ blocks: blocksRef.current, focus: currentFocus() });
    lastTyping.current = null;
    applyBlocks(entry.blocks, entry.focus);
  };

  const redo = () => {
    const entry = redoStack.current.pop();
    if (!entry) {
      return;
    }
    undoStack.current.push({ blocks: blocksRef.current, focus: currentFocus() });
    lastTyping.current = null;
    applyBlocks(entry.blocks, entry.focus);
  };

  // A new card starts with an empty field.
  useAPIEventListener(AppEvents.QueueLoadCard, undefined, () => {
    composing.current = false;
    resetHistory();
    setBlocks(emptyNotes());
    setRevealedByEvent(false);
    void plugin.storage.setSession(SESSION_NOTES_KEY, null);
  });

  // Fallback in case the widget context is not reactive to the reveal.
  useAPIEventListener(AppEvents.RevealAnswer, undefined, () => {
    setRevealedByEvent(true);
  });

  /**
   * Sync the DOM with the model. Lines whose DOM differs from the model are rebuilt; the
   * selection is then restored from the pending focus or from the selection before.
   */
  const paint = (target: HTMLElement, nextBlocks: Block[]) => {
    const numbers = computeNumbers(nextBlocks);
    const views: LineView[] = nextBlocks.map((block, index) => ({
      id: block.id,
      kind: block.kind,
      text: block.text,
      indent: indentOf(block),
      number: numbers[index],
      placeholder: index === 0 ? placeholder : '',
    }));
    const saved = readSelection(target);
    const rebuilt = renderLines(target, views);
    const focus = pendingFocus.current;
    pendingFocus.current = null;
    if (focus) {
      writeSelection(target, focus);
    } else if (rebuilt && saved) {
      writeSelection(target, saved.anchor, saved.focus);
    }
  };

  useLayoutEffect(() => {
    // The DOM belongs to the input method while a composition is running.
    if (editor && !composing.current) {
      paint(editor, blocks);
    }
  });

  /** Read the lines back from the DOM after the browser changed them (typing, IME). */
  const syncFromDom = () => {
    if (!editor || composing.current) {
      return;
    }
    const current = blocksRef.current;
    const domLines = readLines(editor);
    const sameStructure =
      domLines.length === current.length &&
      domLines.every((line, index) => line.id === current[index].id);

    if (sameStructure) {
      const changed = domLines
        .map((line, index) => (line.text !== current[index].text ? index : -1))
        .filter((index) => index >= 0);
      if (changed.length === 0) {
        // Text unchanged, but the browser may have left stray nodes (e.g. a <br>).
        paint(editor, current);
        return;
      }
      if (changed.length === 1) {
        const index = changed[0];
        const selection = readSelection(editor);
        const caret =
          selection && selection.focus.id === current[index].id
            ? selection.focus.caret
            : domLines[index].text.length;
        const edit = editLineText(current, index, domLines[index].text, caret);
        const native = nativeEdit.current;
        nativeEdit.current = null;
        const isTyping = edit.typing && (native?.typing ?? false);
        commitBlocks(edit.blocks, edit.focus, {
          typingIn: isTyping ? current[index].id : undefined,
          undoFocus: native?.focus ?? null,
        });
        return;
      }
    }

    // The browser changed the line structure itself: rebuild the lines from the DOM.
    const known = new Map(current.map((block) => [block.id, block]));
    const rebuilt = domLines.map((line) => {
      const block = line.id ? known.get(line.id) : undefined;
      return block ? { ...block, text: line.text } : createBlock('text', line.text);
    });
    const safe = rebuilt.length > 0 ? rebuilt : emptyNotes();
    const last = safe[safe.length - 1];
    // Locate the caret by DOM position: a line split by the browser carries a copy of the
    // original line id, so the id would point at the wrong line.
    const location = rebuilt.length > 0 ? selectionInLines(editor, domLines) : null;
    const focus = location
      ? { id: safe[location.index].id, caret: location.caret }
      : { id: last.id, caret: last.text.length };
    const native = nativeEdit.current;
    nativeEdit.current = null;
    commitBlocks(safe, focus, { undoFocus: native?.focus ?? null });
  };

  /** Replace the selection with `text` typed by the user (a single line of text). */
  const replaceRange = (range: ModelRange, text: string) => {
    const deleted = deleteRange(blocksRef.current, range.start, range.end);
    const index = range.start.index;
    const merged = deleted.blocks[index];
    const caret = range.start.offset + text.length;
    const value =
      merged.text.slice(0, range.start.offset) + text + merged.text.slice(range.start.offset);
    const edit = editLineText(deleted.blocks, index, value, caret);
    commitBlocks(edit.blocks, edit.focus ?? { id: merged.id, caret });
  };

  /** The selection removed, or the blocks unchanged when it is collapsed. */
  const withoutSelection = (range: ModelRange) =>
    range.collapsed
      ? { blocks: blocksRef.current, index: range.start.index, caret: range.start.offset }
      : {
          blocks: deleteRange(blocksRef.current, range.start, range.end).blocks,
          index: range.start.index,
          caret: range.start.offset,
        };

  /** Enter: split the line at the caret; list items continue the list. */
  const insertParagraph = () => {
    const range = currentRange();
    if (!range) {
      return;
    }
    const { blocks: current, index, caret } = withoutSelection(range);
    const block = current[index];
    const value = block.text;

    if (block.kind !== 'text' && value.length === 0) {
      // Enter on an empty nested item moves it one level up, on a top-level item it ends the list.
      const outdented = indentOf(block) > 0 ? shiftIndent(current, index, -1) : null;
      if (outdented) {
        commitBlocks(outdented, { id: block.id, caret: 0 });
      } else {
        const next = current.slice();
        next[index] = { id: block.id, kind: 'text', text: '' };
        commitBlocks(next, { id: block.id, caret: 0 });
      }
      return;
    }

    const newBlock = { ...createBlock(block.kind, value.slice(caret)), indent: indentOf(block) };
    const next = current.slice();
    next.splice(index, 1, { ...block, text: value.slice(0, caret) }, newBlock);
    commitBlocks(next, { id: newBlock.id, caret: 0 });
  };

  /** Shift/Option+Enter: line break inside the current line. */
  const insertSoftBreak = () => {
    const range = currentRange();
    if (!range) {
      return;
    }
    const { blocks: current, index, caret } = withoutSelection(range);
    const block = current[index];
    const next = current.slice();
    next[index] = { ...block, text: `${block.text.slice(0, caret)}\n${block.text.slice(caret)}` };
    commitBlocks(next, { id: block.id, caret: caret + 1 });
  };

  /** Backspace at the start of a line: outdent, then drop the marker, then merge upwards. */
  const backspaceAtLineStart = (index: number) => {
    const current = blocksRef.current;
    const block = current[index];
    if (block.kind !== 'text' && indentOf(block) > 0) {
      const outdented = shiftIndent(current, index, -1);
      if (outdented) {
        commitBlocks(outdented, { id: block.id, caret: 0 });
      }
      return;
    }
    if (block.kind !== 'text') {
      const next = current.slice();
      next[index] = { id: block.id, kind: 'text', text: block.text };
      commitBlocks(next, { id: block.id, caret: 0 });
      return;
    }
    if (index === 0) {
      return;
    }
    const previous = current[index - 1];
    const merged = deleteRange(
      current,
      { index: index - 1, offset: previous.text.length },
      { index, offset: 0 }
    );
    commitBlocks(merged.blocks, merged.focus);
  };

  const handleBeforeInput = (event: InputEvent) => {
    if (!editor || composing.current || event.isComposing) {
      // Composition input cannot be cancelled; it is read back on compositionend.
      return;
    }
    const type = event.inputType;

    if (type === 'historyUndo' || type === 'historyRedo') {
      event.preventDefault();
      if (type === 'historyUndo') {
        undo();
      } else {
        redo();
      }
      return;
    }
    if (type.startsWith('format') || BLOCKED_INPUT_TYPES.has(type)) {
      event.preventDefault();
      return;
    }

    const range = currentRange();
    if (!range) {
      return;
    }
    nativeEdit.current = {
      typing: type === 'insertText' && range.collapsed && !/^\s$/.test(event.data ?? ''),
      focus: { id: blocksRef.current[range.start.index].id, caret: range.start.offset },
    };

    if (type === 'insertParagraph') {
      event.preventDefault();
      insertParagraph();
      return;
    }
    if (type === 'insertLineBreak') {
      event.preventDefault();
      insertSoftBreak();
      return;
    }

    if (type === 'insertText' || type === 'insertReplacementText') {
      const text = event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
      // Typing at a collapsed caret and autocorrect inside one line are left to the
      // browser (keeps input method behaviour); replacing a selection goes through the model.
      const targetRanges = event.getTargetRanges();
      const target =
        type === 'insertReplacementText' && targetRanges.length > 0
          ? toModelRange(blocksRef.current, readStaticRange(editor, targetRanges[0]))
          : withoutTrailingLineStart(blocksRef.current, range);
      const isNative =
        !target ||
        (target.collapsed && range.collapsed) ||
        (type === 'insertReplacementText' && target.start.index === target.end.index);
      if (target && !isNative) {
        event.preventDefault();
        replaceRange(target, text.replace(/\r?\n/g, ' '));
      }
      return;
    }

    if (type.startsWith('delete')) {
      const isBackward = type.endsWith('Backward');
      if (range.collapsed && isBackward && range.start.offset === 0) {
        event.preventDefault();
        backspaceAtLineStart(range.start.index);
        return;
      }
      let target: ModelRange | null = range.collapsed ? null : range;
      if (!target) {
        const targetRanges = event.getTargetRanges();
        target =
          targetRanges.length > 0
            ? toModelRange(blocksRef.current, readStaticRange(editor, targetRanges[0]))
            : null;
      }
      const current = blocksRef.current;
      const atLineEnd = range.collapsed && range.start.offset === current[range.start.index].text.length;
      if ((!target || target.collapsed) && !isBackward && atLineEnd) {
        // Delete at the end of a line merges the next line into it.
        event.preventDefault();
        if (range.start.index < current.length - 1) {
          const merged = deleteRange(current, range.start, { index: range.start.index + 1, offset: 0 });
          commitBlocks(merged.blocks, merged.focus);
        }
        return;
      }
      // Deleting a selection, or a word/line range across lines, goes through the model;
      // a single character or word inside one line is deleted by the browser.
      if (target && (!range.collapsed || target.start.index !== target.end.index)) {
        event.preventDefault();
        const deleted = deleteRange(current, target.start, target.end);
        commitBlocks(deleted.blocks, deleted.focus);
      }
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Keep typing inside the field from triggering queue shortcuts (Space, 1-4, ...).
    event.stopPropagation();

    // keyCode 229: WebKit sends the Enter that confirms an IME candidate after compositionend.
    if (event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) {
      return;
    }

    const isShortcut = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (event.key === 'Escape') {
      event.preventDefault();
      returnFocusToQueue();
      return;
    }

    // Field-wide undo/redo: Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z and Ctrl+Y.
    if (isShortcut && !event.altKey && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }
    if (event.ctrlKey && !event.metaKey && key === 'y') {
      event.preventDefault();
      redo();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (isShortcut) {
        return;
      }
      if (event.altKey || event.shiftKey) {
        insertSoftBreak();
      } else {
        insertParagraph();
      }
      return;
    }

    // Tab / Shift+Tab indent and outdent the selected list items together with their children.
    if (event.key === 'Tab' && !isShortcut && !event.altKey) {
      event.preventDefault();
      const selected = currentRange();
      if (!selected) {
        return;
      }
      const range = withoutTrailingLineStart(blocksRef.current, selected);
      const shifted = shiftIndentRange(
        blocksRef.current,
        range.start.index,
        range.end.index,
        event.shiftKey ? -1 : 1
      );
      if (shifted) {
        commitBlocks(shifted);
      }
    }
  };

  // Native listeners: React's onBeforeInput is a polyfill without inputType.
  const handlers = useRef({ handleBeforeInput, syncFromDom });
  handlers.current = { handleBeforeInput, syncFromDom };
  useEffect(() => {
    if (!editor) {
      return;
    }
    const onBeforeInput = (event: Event) => {
      handlers.current.handleBeforeInput(event as InputEvent);
      // A cancelled input produces no "input" event, so its native edit info must not
      // be picked up by a later sync (e.g. after a composition).
      if (event.defaultPrevented) {
        nativeEdit.current = null;
      }
    };
    const onInput = () => handlers.current.syncFromDom();
    const onCompositionStart = () => {
      composing.current = true;
      nativeEdit.current = null;
      // The placeholder would overlap the composed text until the next paint.
      editor.querySelectorAll('.fn-line--placeholder').forEach((line) => {
        line.classList.remove('fn-line--placeholder');
      });
    };
    const onCompositionEnd = () => {
      composing.current = false;
      handlers.current.syncFromDom();
    };
    editor.addEventListener('beforeinput', onBeforeInput);
    editor.addEventListener('input', onInput);
    editor.addEventListener('compositionstart', onCompositionStart);
    editor.addEventListener('compositionend', onCompositionEnd);
    return () => {
      editor.removeEventListener('beforeinput', onBeforeInput);
      editor.removeEventListener('input', onInput);
      editor.removeEventListener('compositionstart', onCompositionStart);
      editor.removeEventListener('compositionend', onCompositionEnd);
      composing.current = false;
    };
  }, [editor]);

  const returnFocusToQueue = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    try {
      window.parent.focus();
    } catch {
      // Focusing the parent window can be blocked by the browser; blurring is sufficient then.
    }
  };

  /** Current selection without a trailing line start (see withoutTrailingLineStart). */
  const visibleRange = (): ModelRange | null => {
    const range = currentRange();
    return range ? withoutTrailingLineStart(blocksRef.current, range) : null;
  };

  const handleCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const range = visibleRange();
    if (!range || range.collapsed) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData('text/plain', selectionText(blocksRef.current, range.start, range.end));
  };

  const handleCut = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const range = visibleRange();
    if (!range || range.collapsed) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData('text/plain', selectionText(blocksRef.current, range.start, range.end));
    const deleted = deleteRange(blocksRef.current, range.start, range.end);
    commitBlocks(deleted.blocks, deleted.focus);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData('text/plain');
    const range = visibleRange();
    if (!range || pasted.length === 0) {
      return;
    }
    const { blocks: current, index, caret } = withoutSelection(range);
    const result = insertPlainText(current, index, caret, caret, pasted);
    commitBlocks(result.blocks, result.focus);
  };

  const clearNotes = () => {
    const fresh = emptyNotes();
    commitBlocks(fresh, { id: fresh[0].id, caret: 0 });
  };

  const notesHaveContent = hasContent(blocks);
  const listItemCount = countListItems(blocks);

  if (hideAfterReveal && isRevealed && !notesHaveContent) {
    return null;
  }

  return (
    <div className={`fn-root${isRevealed ? ' fn-root--revealed' : ''}`}>
      <div className="fn-field">
        {/* Children are rendered by renderLines, never by React. */}
        <div
          ref={setEditor}
          className="fn-editor"
          // The padding belongs to the editor, so clicks around the text hit-test natively.
          style={{ minHeight: `${minRows * LINE_HEIGHT_PX + EDITOR_PADDING_Y_PX}px` }}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Flashcard notes"
          spellCheck={false}
          onKeyDown={handleKeyDown}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={handlePaste}
          onDragStart={(event) => event.preventDefault()}
          onDrop={(event) => event.preventDefault()}
        />
        {notesHaveContent && (
          <button
            type="button"
            className="fn-clear"
            title="Clear notes"
            aria-label="Clear notes"
            onMouseDown={(event) => event.preventDefault()}
            onClick={clearNotes}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="fn-footer">
        <div className="fn-hint">
          <span>
            <kbd>- Space</kbd> bullet list
          </span>
          <span>
            <kbd>1. Space</kbd> numbered list
          </span>
          <span>
            <kbd>⌥ Enter</kbd> line break
          </span>
          <span>
            <kbd>Esc</kbd> back to queue
          </span>
        </div>
        {__DEV_BUILD_LABEL__ && <span className="fn-dev-label">{__DEV_BUILD_LABEL__}</span>}
        {listItemCount > 0 && (
          <span className="fn-count" aria-live="polite">
            {listItemCount} {listItemCount === 1 ? 'bullet' : 'bullets'}
          </span>
        )}
      </div>
    </div>
  );
};

renderWidget(FlashcardNotesWidget);

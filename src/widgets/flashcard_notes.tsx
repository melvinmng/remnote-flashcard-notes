import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AppEvents,
  renderWidget,
  usePlugin,
  useAPIEventListener,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import {
  applyTextChange,
  type Block,
  computeNumbers,
  countListItems,
  createBlock,
  emptyNotes,
  hasContent,
  isValidBlock,
  parseText,
  pasteIntoBlocks,
  type PendingFocus,
  serializeBlocks,
} from '../notes_model';
import '../style.css';
import '../index.css';

const SETTING_MIN_ROWS = 'min-rows';
const SETTING_HIDE_AFTER_REVEAL = 'hide-after-reveal';
const DEFAULT_MIN_ROWS = 2;
const LINE_HEIGHT_PX = 24;
const SESSION_NOTES_KEY = 'flashcard-notes:current:v2';

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
}

const HISTORY_LIMIT = 200;
const TYPING_GROUP_MS = 1000;

/** Resize a text area to fit its content so wrapped lines never scroll. */
const fitToContent = (textArea: HTMLTextAreaElement | null) => {
  if (!textArea) {
    return;
  }
  textArea.style.height = 'auto';
  textArea.style.height = `${textArea.scrollHeight}px`;
};

/**
 * Notes field rendered below the current flashcard.
 *
 * The field starts as plain text. Typing "- " or "1. " at the start of a line
 * turns that line into a bullet or numbered list item. Each line is its own
 * auto-growing text area inside a flex row, which keeps wrapped lines aligned
 * behind the list marker (hanging indent).
 *
 * Keyboard model:
 * - Enter              new line; inside a list it continues the list,
 *                      on an empty list item it ends the list
 * - Option/Alt+Enter   line break inside the current line
 * - Backspace at 0     removes the list marker, then merges with the line above
 * - Arrow Up/Down      move between lines at the start/end of a line
 * - Cmd/Ctrl+A         selects the whole field
 * - Cmd/Ctrl+Z         undo across all lines (Shift+Cmd/Ctrl+Z or Ctrl+Y to redo)
 * - Esc                leaves the field so queue shortcuts work again
 *
 * Notes are never written to the knowledge base. A copy is mirrored into
 * plugin session storage so the text survives a remount of the widget
 * (e.g. when the answer is revealed). No permission scopes are required.
 */
export const FlashcardNotesWidget = () => {
  const plugin = usePlugin();
  const [blocks, setBlocks] = useState<Block[]>(emptyNotes);
  const [revealedByEvent, setRevealedByEvent] = useState(false);
  // Text areas cannot share one native selection, so "select all" is a field-level mode.
  const [allSelected, setAllSelected] = useState(false);
  const textAreaRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingFocus = useRef<PendingFocus | null>(null);
  // Field-wide undo/redo history; native text area undo only covers a single line.
  const blocksRef = useRef<Block[]>(blocks);
  blocksRef.current = blocks;
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const lastTyping = useRef<{ id: string; time: number } | null>(null);

  const resetHistory = () => {
    undoStack.current = [];
    redoStack.current = [];
    lastTyping.current = null;
  };

  /** Caret position of the focused line, used to restore the cursor on undo/redo. */
  const currentFocus = (): PendingFocus | null => {
    for (const [id, textArea] of textAreaRefs.current) {
      if (textArea === document.activeElement) {
        return { id, caret: textArea.selectionStart };
      }
    }
    return null;
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

  // Restore notes for the current card after a remount, otherwise start empty.
  useEffect(() => {
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
      resetHistory();
      setBlocks(restored ?? emptyNotes());
    };
    void restoreNotes();
    return () => {
      cancelled = true;
    };
  }, [cardKey, plugin]);

  /** Render blocks, move the caret and mirror the notes into session storage. */
  const applyBlocks = useCallback(
    (nextBlocks: Block[], focus?: PendingFocus | null) => {
      if (focus) {
        pendingFocus.current = focus;
      }
      setBlocks(nextBlocks);
      if (cardKey) {
        void plugin.storage.setSession(SESSION_NOTES_KEY, { cardKey, blocks: nextBlocks });
      }
    },
    [cardKey, plugin]
  );

  /** Apply an edit and record the previous state for undo. */
  const commitBlocks = (nextBlocks: Block[], focus?: PendingFocus, options: CommitOptions = {}) => {
    const safeBlocks = nextBlocks.length > 0 ? nextBlocks : emptyNotes();
    const previousBlocks = blocksRef.current;

    // Caret-only moves (same array) are not edits.
    if (safeBlocks !== previousBlocks) {
      const now = Date.now();
      const continuesTyping =
        options.typingIn !== undefined &&
        lastTyping.current?.id === options.typingIn &&
        now - lastTyping.current.time < TYPING_GROUP_MS;
      if (!continuesTyping) {
        undoStack.current.push({ blocks: previousBlocks, focus: currentFocus() });
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
    setAllSelected(false);
    applyBlocks(entry.blocks, entry.focus);
  };

  const redo = () => {
    const entry = redoStack.current.pop();
    if (!entry) {
      return;
    }
    undoStack.current.push({ blocks: blocksRef.current, focus: currentFocus() });
    lastTyping.current = null;
    setAllSelected(false);
    applyBlocks(entry.blocks, entry.focus);
  };

  // A new card starts with an empty field.
  useAPIEventListener(AppEvents.QueueLoadCard, undefined, () => {
    resetHistory();
    setBlocks(emptyNotes());
    setRevealedByEvent(false);
    void plugin.storage.setSession(SESSION_NOTES_KEY, null);
  });

  // Fallback in case the widget context is not reactive to the reveal.
  useAPIEventListener(AppEvents.RevealAnswer, undefined, () => {
    setRevealedByEvent(true);
  });

  // Keep every text area sized to its content and apply pending caret moves.
  useLayoutEffect(() => {
    textAreaRefs.current.forEach((textArea) => fitToContent(textArea));
    const focus = pendingFocus.current;
    if (focus) {
      const textArea = textAreaRefs.current.get(focus.id);
      if (textArea) {
        textArea.focus();
        textArea.setSelectionRange(focus.caret, focus.caret);
      }
      pendingFocus.current = null;
    }
  }, [blocks]);

  const returnFocusToQueue = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    try {
      window.parent.focus();
    } catch {
      // Focusing the parent window can be blocked by the browser; blurring is sufficient then.
    }
  };

  const replaceBlock = (
    index: number,
    block: Block,
    focus?: PendingFocus,
    options?: CommitOptions
  ) => {
    const next = blocks.slice();
    next[index] = block;
    commitBlocks(next, focus, options);
  };

  const handleChange = (index: number, event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const block = blocks[index];
    const value = event.target.value;
    const caret = event.target.selectionStart;

    setAllSelected(false);

    // Plain lines starting with "- " or "1. " become list items (a separate undo step);
    // other typing is grouped per line so one undo step removes a burst of characters.
    const change = applyTextChange(block, value, caret);
    if (change.isListTrigger) {
      replaceBlock(index, change.block, { id: block.id, caret: change.caret });
      return;
    }
    replaceBlock(index, change.block, undefined, { typingIn: block.id });
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Keep typing inside the field from triggering queue shortcuts (Space, 1-4, ...).
    event.stopPropagation();

    if (event.nativeEvent.isComposing) {
      return;
    }

    const textArea = event.currentTarget;
    const { selectionStart, selectionEnd, value } = textArea;
    const block = blocks[index];

    if (event.key === 'Escape') {
      event.preventDefault();
      setAllSelected(false);
      returnFocusToQueue();
      return;
    }

    const isShortcut = event.metaKey || event.ctrlKey;

    // Cmd+A / Ctrl+A selects the whole field, not only the current line.
    if (isShortcut && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      textArea.setSelectionRange(0, value.length);
      setAllSelected(true);
      return;
    }

    // Field-wide undo/redo: Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z and Ctrl+Y.
    if (isShortcut && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }
    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }

    if (allSelected) {
      if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(event.key)) {
        return;
      }
      // Copy, cut and paste are handled by the clipboard event handlers.
      if (isShortcut && ['c', 'x', 'v'].includes(event.key.toLowerCase())) {
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter') {
        event.preventDefault();
        replaceAll(emptyNotes());
        return;
      }
      if (event.key.length === 1 && !isShortcut) {
        // Typing replaces the whole selection, like in a single text field.
        event.preventDefault();
        replaceAll(parseText(event.key));
        return;
      }
      // Any other key (arrows, Tab, ...) collapses the selection to the current line.
      setAllSelected(false);
    }

    if (event.key === 'Enter' && event.altKey) {
      // Soft line break inside the current line.
      event.preventDefault();
      textArea.setRangeText('\n', selectionStart, selectionEnd, 'end');
      replaceBlock(
        index,
        { ...block, text: textArea.value },
        { id: block.id, caret: textArea.selectionStart }
      );
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();

      // Enter on an empty list item ends the list.
      if (block.kind !== 'text' && value.length === 0) {
        replaceBlock(index, { id: block.id, kind: 'text', text: '' }, { id: block.id, caret: 0 });
        return;
      }

      // Split at the caret; list items continue the list.
      const newBlock = createBlock(block.kind, value.slice(selectionEnd));
      const next = blocks.slice();
      next.splice(index, 1, { ...block, text: value.slice(0, selectionStart) }, newBlock);
      commitBlocks(next, { id: newBlock.id, caret: 0 });
      return;
    }

    if (event.key === 'Backspace' && selectionStart === 0 && selectionEnd === 0) {
      // First remove the list marker, keeping the text.
      if (block.kind !== 'text') {
        event.preventDefault();
        replaceBlock(
          index,
          { id: block.id, kind: 'text', text: value },
          { id: block.id, caret: 0 }
        );
        return;
      }
      if (index === 0) {
        return;
      }
      // Then merge into the line above and keep the caret at the join.
      event.preventDefault();
      const previous = blocks[index - 1];
      const next = blocks.slice();
      next.splice(index - 1, 2, { ...previous, text: previous.text + value });
      commitBlocks(next, { id: previous.id, caret: previous.text.length });
      return;
    }

    // Only jump between lines at the very start/end so wrapped lines stay navigable.
    if (event.key === 'ArrowUp' && index > 0 && selectionStart === 0 && selectionEnd === 0) {
      const previous = blocks[index - 1];
      event.preventDefault();
      commitBlocks(blocks, { id: previous.id, caret: previous.text.length });
      return;
    }

    if (
      event.key === 'ArrowDown' &&
      index < blocks.length - 1 &&
      selectionStart === value.length &&
      selectionEnd === value.length
    ) {
      event.preventDefault();
      commitBlocks(blocks, { id: blocks[index + 1].id, caret: 0 });
    }
  };

  /** Replace every line and place the caret at the end of the last line. */
  const replaceAll = (nextBlocks: Block[]) => {
    const safeBlocks = nextBlocks.length > 0 ? nextBlocks : emptyNotes();
    const last = safeBlocks[safeBlocks.length - 1];
    setAllSelected(false);
    commitBlocks(safeBlocks, { id: last.id, caret: last.text.length });
  };

  const handleCopy = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!allSelected) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData('text/plain', serializeBlocks(blocks));
  };

  const handleCut = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!allSelected) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData('text/plain', serializeBlocks(blocks));
    replaceAll(emptyNotes());
  };

  const handlePaste = (index: number, event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData('text/plain');

    if (allSelected) {
      event.preventDefault();
      replaceAll(parseText(pasted.replace(/\r\n?/g, '\n').replace(/\n+$/, '')));
      return;
    }

    const { selectionStart, selectionEnd } = event.currentTarget;
    const result = pasteIntoBlocks(blocks, index, selectionStart, selectionEnd, pasted);
    if (!result) {
      // Single line: native paste; list triggers still apply via onChange.
      return;
    }
    event.preventDefault();
    setAllSelected(false);
    commitBlocks(result.blocks, result.focus);
  };

  const clearNotes = () => {
    const fresh = emptyNotes();
    setAllSelected(false);
    commitBlocks(fresh, { id: fresh[0].id, caret: 0 });
  };

  const notesHaveContent = hasContent(blocks);
  const numbers = computeNumbers(blocks);
  const listItemCount = countListItems(blocks);
  const showPlaceholder = blocks.length === 1 && blocks[0].kind === 'text';

  if (hideAfterReveal && isRevealed && !notesHaveContent) {
    return null;
  }

  return (
    <div
      className={`fn-root${isRevealed ? ' fn-root--revealed' : ''}${
        allSelected ? ' fn-root--all-selected' : ''
      }`}
    >
      <div
        className="fn-field"
        style={{ minHeight: `${minRows * LINE_HEIGHT_PX + 20}px` }}
        onMouseDown={(event) => {
          // Clicking the empty area below the lines focuses the last line.
          if (event.target === event.currentTarget) {
            event.preventDefault();
            const last = blocks[blocks.length - 1];
            pendingFocus.current = { id: last.id, caret: last.text.length };
            setBlocks(blocks.slice());
          }
        }}
      >
        <div className="fn-list">
          {blocks.map((block, index) => (
            <div key={block.id} className={`fn-line fn-line--${block.kind}`}>
              {block.kind === 'bullet' && (
                <span className="fn-marker" aria-hidden="true">
                  <span className="fn-dot" />
                </span>
              )}
              {block.kind === 'number' && (
                <span className="fn-marker fn-marker--number" aria-hidden="true">
                  {numbers[index]}.
                </span>
              )}
              <textarea
                ref={(element) => {
                  if (element) {
                    textAreaRefs.current.set(block.id, element);
                  } else {
                    textAreaRefs.current.delete(block.id);
                  }
                }}
                className="fn-input"
                rows={1}
                value={block.text}
                placeholder={
                  showPlaceholder
                    ? isRevealed
                      ? 'Your notes'
                      : 'Write down what you remember …'
                    : ''
                }
                spellCheck={false}
                onChange={(event) => handleChange(index, event)}
                onKeyDown={(event) => handleKeyDown(index, event)}
                onCopy={handleCopy}
                onCut={handleCut}
                onPaste={(event) => handlePaste(index, event)}
                onMouseDown={() => setAllSelected(false)}
                onBlur={() => setAllSelected(false)}
              />
            </div>
          ))}
        </div>
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

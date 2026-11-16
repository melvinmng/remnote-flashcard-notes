import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AppEvents,
  renderWidget,
  usePlugin,
  useAPIEventListener,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

const SETTING_MIN_ROWS = 'min-rows';
const SETTING_HIDE_AFTER_REVEAL = 'hide-after-reveal';
const DEFAULT_MIN_ROWS = 2;
const LINE_HEIGHT_PX = 24;
const SESSION_NOTES_KEY = 'flashcard-notes:current';

interface Bullet {
  id: string;
  text: string;
}

interface StoredNotes {
  cardKey: string;
  bullets: Bullet[];
}

interface PendingFocus {
  id: string;
  caret: number;
}

let bulletCounter = 0;
const createBullet = (text = ''): Bullet => {
  bulletCounter += 1;
  return { id: `b${Date.now().toString(36)}${bulletCounter}`, text };
};

const emptyNotes = (): Bullet[] => [createBullet()];

const hasContent = (bullets: Bullet[]) => bullets.some((bullet) => bullet.text.trim().length > 0);

/** Resize a text area to fit its content so wrapped lines never scroll. */
const fitToContent = (textArea: HTMLTextAreaElement | null) => {
  if (!textArea) {
    return;
  }
  textArea.style.height = 'auto';
  textArea.style.height = `${textArea.scrollHeight}px`;
};

/**
 * Bullet-list notes field rendered below the current flashcard.
 *
 * Each bullet is its own auto-growing text area inside a flex row, which keeps
 * wrapped lines aligned behind the bullet dot (hanging indent).
 *
 * Keyboard model:
 * - Enter            splits the bullet at the caret and starts a new bullet
 * - Option/Alt+Enter inserts a line break inside the current bullet
 * - Backspace at 0   merges the bullet into the previous one
 * - Arrow Up/Down    move between bullets at the start/end of a bullet
 * - Esc              leaves the field so queue shortcuts work again
 *
 * Notes are never written to the knowledge base. A copy is mirrored into
 * plugin session storage so the text survives a remount of the widget
 * (e.g. when the answer is revealed). No permission scopes are required.
 */
export const FlashcardNotesWidget = () => {
  const plugin = usePlugin();
  const [bullets, setBullets] = useState<Bullet[]>(emptyNotes);
  const [revealedByEvent, setRevealedByEvent] = useState(false);
  const textAreaRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingFocus = useRef<PendingFocus | null>(null);

  const widgetContext = useTrackerPlugin(
    async (reactivePlugin) =>
      await reactivePlugin.widget.getWidgetContext<WidgetLocation.FlashcardUnder>(),
  );
  const minRowsSetting = useTrackerPlugin(
    async (reactivePlugin) => await reactivePlugin.settings.getSetting<number>(SETTING_MIN_ROWS),
  );
  const hideAfterReveal = useTrackerPlugin(
    async (reactivePlugin) =>
      await reactivePlugin.settings.getSetting<boolean>(SETTING_HIDE_AFTER_REVEAL),
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
        stored && cardKey && stored.cardKey === cardKey && Array.isArray(stored.bullets)
          ? stored.bullets
          : null;
      setBullets(restored && restored.length > 0 ? restored : emptyNotes());
    };
    void restoreNotes();
    return () => {
      cancelled = true;
    };
  }, [cardKey, plugin]);

  const commitBullets = useCallback(
    (nextBullets: Bullet[], focus?: PendingFocus) => {
      const safeBullets = nextBullets.length > 0 ? nextBullets : emptyNotes();
      if (focus) {
        pendingFocus.current = focus;
      }
      setBullets(safeBullets);
      if (cardKey) {
        void plugin.storage.setSession(SESSION_NOTES_KEY, { cardKey, bullets: safeBullets });
      }
    },
    [cardKey, plugin],
  );

  // A new card starts with an empty field.
  useAPIEventListener(AppEvents.QueueLoadCard, undefined, () => {
    setBullets(emptyNotes());
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
  }, [bullets]);

  const returnFocusToQueue = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    try {
      window.parent.focus();
    } catch {
      // Focusing the parent window can be blocked by the browser; blurring is sufficient then.
    }
  };

  const updateText = (index: number, text: string) => {
    const next = bullets.slice();
    next[index] = { ...next[index], text };
    commitBullets(next);
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Keep typing inside the field from triggering queue shortcuts (Space, 1-4, ...).
    event.stopPropagation();

    if (event.nativeEvent.isComposing) {
      return;
    }

    const textArea = event.currentTarget;
    const { selectionStart, selectionEnd, value } = textArea;
    const bullet = bullets[index];

    if (event.key === 'Escape') {
      event.preventDefault();
      returnFocusToQueue();
      return;
    }

    if (event.key === 'Enter' && event.altKey) {
      // Soft line break inside the current bullet.
      event.preventDefault();
      textArea.setRangeText('\n', selectionStart, selectionEnd, 'end');
      const caret = textArea.selectionStart;
      const next = bullets.slice();
      next[index] = { ...bullet, text: textArea.value };
      commitBullets(next, { id: bullet.id, caret });
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      // Split at the caret and continue in a new bullet.
      event.preventDefault();
      const before = value.slice(0, selectionStart);
      const after = value.slice(selectionEnd);
      const newBullet = createBullet(after);
      const next = bullets.slice();
      next.splice(index, 1, { ...bullet, text: before }, newBullet);
      commitBullets(next, { id: newBullet.id, caret: 0 });
      return;
    }

    if (event.key === 'Backspace' && selectionStart === 0 && selectionEnd === 0) {
      if (index === 0) {
        return;
      }
      // Merge into the previous bullet and keep the caret at the join.
      event.preventDefault();
      const previous = bullets[index - 1];
      const next = bullets.slice();
      next.splice(index - 1, 2, { ...previous, text: previous.text + value });
      commitBullets(next, { id: previous.id, caret: previous.text.length });
      return;
    }

    // Only jump between bullets at the very start/end so wrapped lines stay navigable.
    if (event.key === 'ArrowUp' && index > 0 && selectionStart === 0 && selectionEnd === 0) {
      const previous = bullets[index - 1];
      event.preventDefault();
      commitBullets(bullets, { id: previous.id, caret: previous.text.length });
      return;
    }

    if (
      event.key === 'ArrowDown' &&
      index < bullets.length - 1 &&
      selectionStart === value.length &&
      selectionEnd === value.length
    ) {
      event.preventDefault();
      commitBullets(bullets, { id: bullets[index + 1].id, caret: 0 });
    }
  };

  const clearNotes = () => {
    const fresh = emptyNotes();
    commitBullets(fresh, { id: fresh[0].id, caret: 0 });
  };

  const notesHaveContent = hasContent(bullets);

  if (hideAfterReveal && isRevealed && !notesHaveContent) {
    return null;
  }

  return (
    <div className={`fn-root${isRevealed ? ' fn-root--revealed' : ''}`}>
      <div
        className="fn-field"
        style={{ minHeight: `${minRows * LINE_HEIGHT_PX + 20}px` }}
        onMouseDown={(event) => {
          // Clicking the empty area below the bullets focuses the last bullet.
          if (event.target === event.currentTarget) {
            event.preventDefault();
            const last = bullets[bullets.length - 1];
            pendingFocus.current = { id: last.id, caret: last.text.length };
            setBullets(bullets.slice());
          }
        }}
      >
        <ul className="fn-list">
          {bullets.map((bullet, index) => (
            <li key={bullet.id} className="fn-bullet">
              <span className="fn-dot" aria-hidden="true" />
              <textarea
                ref={(element) => {
                  if (element) {
                    textAreaRefs.current.set(bullet.id, element);
                  } else {
                    textAreaRefs.current.delete(bullet.id);
                  }
                }}
                className="fn-input"
                rows={1}
                value={bullet.text}
                placeholder={
                  index === 0 && bullets.length === 1
                    ? isRevealed
                      ? 'Your notes'
                      : 'Write down what you remember …'
                    : ''
                }
                spellCheck={false}
                onChange={(event) => updateText(index, event.target.value)}
                onKeyDown={(event) => handleKeyDown(index, event)}
              />
            </li>
          ))}
        </ul>
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
      <div className="fn-hint">
        <span>
          <kbd>Enter</kbd> new bullet
        </span>
        <span>
          <kbd>⌥ Enter</kbd> line break
        </span>
        <span>
          <kbd>Esc</kbd> back to queue
        </span>
      </div>
    </div>
  );
};

renderWidget(FlashcardNotesWidget);

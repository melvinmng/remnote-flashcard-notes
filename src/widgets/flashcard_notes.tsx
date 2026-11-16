import { useEffect, useRef, useState } from 'react';
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
const DEFAULT_MIN_ROWS = 4;
const SESSION_NOTES_KEY = 'flashcard-notes:current';

interface StoredNotes {
  cardKey: string;
  notes: string;
}

/**
 * Plain notes field rendered below the current flashcard.
 *
 * Notes are intentionally transient: they are never written to the knowledge
 * base and are cleared whenever a new card is loaded. A copy is mirrored into
 * plugin session storage so the text survives a remount of the widget
 * (e.g. when the answer is revealed). No permission scopes are required.
 */
export const FlashcardNotesWidget = () => {
  const plugin = usePlugin();
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [notes, setNotes] = useState('');
  const [revealedByEvent, setRevealedByEvent] = useState(false);

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
      setNotes(stored && cardKey && stored.cardKey === cardKey ? stored.notes : '');
    };
    void restoreNotes();
    return () => {
      cancelled = true;
    };
  }, [cardKey, plugin]);

  const updateNotes = (nextNotes: string) => {
    setNotes(nextNotes);
    if (cardKey) {
      void plugin.storage.setSession(SESSION_NOTES_KEY, { cardKey, notes: nextNotes });
    }
  };

  // A new card starts with an empty field.
  useAPIEventListener(AppEvents.QueueLoadCard, undefined, () => {
    setNotes('');
    setRevealedByEvent(false);
    void plugin.storage.setSession(SESSION_NOTES_KEY, null);
  });

  // Fallback in case the widget context is not reactive to the reveal.
  useAPIEventListener(AppEvents.RevealAnswer, undefined, () => {
    setRevealedByEvent(true);
  });

  // Grow the text area with its content so long answers stay fully visible.
  useEffect(() => {
    const textArea = textAreaRef.current;
    if (!textArea) {
      return;
    }
    textArea.style.height = 'auto';
    textArea.style.height = `${textArea.scrollHeight}px`;
  }, [notes, minRows]);

  const returnFocusToQueue = () => {
    textAreaRef.current?.blur();
    try {
      window.parent.focus();
    } catch {
      // Focusing the parent window can be blocked by the browser; blurring is sufficient then.
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Keep typing inside the field from triggering queue shortcuts (Space, 1-4, ...).
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      returnFocusToQueue();
    }
  };

  if (hideAfterReveal && isRevealed && notes.trim().length === 0) {
    return null;
  }

  return (
    <div className="flashcard-notes">
      <div className="flashcard-notes__header">
        <span className="flashcard-notes__title">
          {isRevealed ? 'Your notes (compare with the answer)' : 'Your notes'}
        </span>
        {notes.length > 0 && (
          <button
            type="button"
            className="flashcard-notes__clear"
            onClick={() => {
              updateNotes('');
              textAreaRef.current?.focus();
            }}
          >
            Clear
          </button>
        )}
      </div>
      <textarea
        ref={textAreaRef}
        className="flashcard-notes__input"
        rows={minRows}
        value={notes}
        placeholder="Write down what you remember. Esc returns focus to the queue."
        spellCheck={false}
        onChange={(event) => updateNotes(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
};

renderWidget(FlashcardNotesWidget);

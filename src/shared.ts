/**
 * Identifiers shared between the index plugin and the notes widget.
 */

export const SETTING_MIN_ROWS = 'min-rows';
export const SETTING_HIDE_AFTER_REVEAL = 'hide-after-reveal';

/**
 * Session storage key of the notes of the card currently shown in the queue.
 * The stored value is `{ cardKey, blocks }` or null.
 */
export const SESSION_NOTES_KEY = 'flashcard-notes:current:v2';

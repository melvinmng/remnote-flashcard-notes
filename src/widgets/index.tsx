import {
  AppEvents,
  declareIndexPlugin,
  type ReactRNPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { SESSION_NOTES_KEY, SETTING_HIDE_AFTER_REVEAL, SETTING_MIN_ROWS } from '../shared';
import '../style.css';
import '../index.css';

/**
 * Location of the notes widget inside the flashcard queue.
 * Kept as a single constant so the placement can be changed in one line
 * (alternatives: WidgetLocation.Flashcard, WidgetLocation.FlashcardAnswerButtons).
 */
export const NOTES_WIDGET_LOCATION = WidgetLocation.FlashcardUnder;

/**
 * Events after which the stored notes must not be restored anymore. The index plugin is
 * always running, unlike the widget, which is unmounted between cards and can miss these
 * events. Without this, notes of a card came back when the same card was shown again
 * later (relearning after "Forgot", a later queue session).
 * RevealAnswer and QueueLoadCard are deliberately not used: the widget remounts on
 * reveal and must restore the notes then, and it is not verified that QueueLoadCard never
 * fires during that remount.
 */
const NOTES_RESET_EVENTS = [
  AppEvents.QueueCompleteCard,
  AppEvents.QueueExit,
  AppEvents.QueueEnter,
];

const clearStoredNotes = (plugin: ReactRNPlugin) => () => {
  void plugin.storage.setSession(SESSION_NOTES_KEY, null);
};

let notesResetListener: (() => void) | null = null;

async function onActivate(plugin: ReactRNPlugin) {
  // Global app events are dispatched with an undefined listener key; any other key
  // would never match and the listener would not run.
  notesResetListener = clearStoredNotes(plugin);
  for (const event of NOTES_RESET_EVENTS) {
    plugin.event.addListener(event, undefined, notesResetListener);
  }

  await plugin.settings.registerNumberSetting({
    id: SETTING_MIN_ROWS,
    title: 'Minimum height of the notes field (lines)',
    defaultValue: 2,
  });

  await plugin.settings.registerBooleanSetting({
    id: SETTING_HIDE_AFTER_REVEAL,
    title: 'Hide the notes field when it is empty and the answer is revealed',
    defaultValue: false,
  });

  await plugin.app.registerWidget('flashcard_notes', NOTES_WIDGET_LOCATION, {
    dimensions: { height: 'auto', width: '100%' },
  });
}

async function onDeactivate(plugin: ReactRNPlugin) {
  if (notesResetListener) {
    for (const event of NOTES_RESET_EVENTS) {
      plugin.event.removeListener(event, undefined, notesResetListener);
    }
    notesResetListener = null;
  }
}

declareIndexPlugin(onActivate, onDeactivate);

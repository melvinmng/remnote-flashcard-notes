import { declareIndexPlugin, type ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';

/**
 * Location of the notes widget inside the flashcard queue.
 * Kept as a single constant so the placement can be changed in one line
 * (alternatives: WidgetLocation.Flashcard, WidgetLocation.FlashcardAnswerButtons).
 */
export const NOTES_WIDGET_LOCATION = WidgetLocation.FlashcardUnder;

export const SETTING_MIN_ROWS = 'min-rows';
export const SETTING_HIDE_AFTER_REVEAL = 'hide-after-reveal';

async function onActivate(plugin: ReactRNPlugin) {
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

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);

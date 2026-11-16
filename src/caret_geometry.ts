/**
 * Caret geometry for moving between lines with the arrow keys.
 *
 * `measureCaretPositions` uses a hidden mirror element to find the on-screen
 * position of every caret offset in a text area, so wrapped lines can be told
 * apart from real line ends. The pure helpers below work on those positions
 * and are covered by scripts/test_notes_model.ts.
 */

export interface CaretPosition {
  /** Top of the visual line, relative to the text area. */
  top: number;
  /** Horizontal caret position in client (viewport) coordinates. */
  left: number;
}

/** True when the caret offset sits on the first visual line. */
export const isOnFirstLine = (positions: CaretPosition[], caret: number): boolean =>
  positions.length > 0 && positions[caret].top === positions[0].top;

/** True when the caret offset sits on the last visual line. */
export const isOnLastLine = (positions: CaretPosition[], caret: number): boolean =>
  positions.length > 0 && positions[caret].top === positions[positions.length - 1].top;

/**
 * Caret offset on the first or last visual line whose horizontal position is
 * closest to `clientX`. Used to keep the column when jumping between lines.
 */
export const closestOffsetOnLine = (
  positions: CaretPosition[],
  line: 'first' | 'last',
  clientX: number
): number => {
  if (positions.length === 0) {
    return 0;
  }
  const lineTop = line === 'first' ? positions[0].top : positions[positions.length - 1].top;
  let bestOffset = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  positions.forEach((position, offset) => {
    if (position.top !== lineTop) {
      return;
    }
    const distance = Math.abs(position.left - clientX);
    // "<" keeps the earliest offset on ties, e.g. before a wrapped space.
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOffset = offset;
    }
  });
  return bestOffset < 0 ? 0 : bestOffset;
};

const MIRRORED_PROPERTIES = [
  'boxSizing',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'fontVariant',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'wordSpacing',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
] as const;

/**
 * Position of every caret offset 0..value.length in a text area.
 * Offset i is the left edge of character i; the last offset is after the text.
 */
export const measureCaretPositions = (textArea: HTMLTextAreaElement): CaretPosition[] => {
  const value = textArea.value;
  const style = window.getComputedStyle(textArea);
  const mirror = document.createElement('div');

  MIRRORED_PROPERTIES.forEach((property) => {
    mirror.style[property] = style[property];
  });
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-10000px';
  mirror.style.width = `${textArea.offsetWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'anywhere';
  mirror.style.wordBreak = style.wordBreak;

  const markers: HTMLSpanElement[] = [];
  for (const char of value) {
    const span = document.createElement('span');
    span.textContent = char;
    mirror.appendChild(span);
    markers.push(span);
  }
  // End marker; the zero-width space gives a trailing line break its own line box.
  const endMarker = document.createElement('span');
  endMarker.textContent = '​';
  mirror.appendChild(endMarker);
  markers.push(endMarker);

  document.body.appendChild(mirror);
  const originLeft = textArea.getBoundingClientRect().left;
  const positions: CaretPosition[] = [];
  // Characters outside the BMP occupy two UTF-16 offsets but one span.
  let markerIndex = 0;
  for (let offset = 0; offset <= value.length; offset += 1) {
    const marker = markers[Math.min(markerIndex, markers.length - 1)];
    positions.push({ top: marker.offsetTop, left: originLeft + marker.offsetLeft });
    if (offset < value.length) {
      const code = value.charCodeAt(offset);
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
      if (!isHighSurrogate) {
        markerIndex += 1;
      }
    }
  }
  document.body.removeChild(mirror);
  return positions;
};

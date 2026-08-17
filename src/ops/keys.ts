/**
 * Key definitions for Input.dispatchKeyEvent.
 *
 * Chromium wants `key`, `code`, `windowsVirtualKeyCode` and (for printable
 * keys) `text`. Applications that listen for keydown/keyup - which is most of
 * anything worth debugging - behave differently if these are wrong, so this
 * table exists rather than faking everything through Input.insertText.
 */

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  shiftKey?: string;
  location?: number;
}

/** CDP modifier bitmask. */
export const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
export type ModifierName = keyof typeof MODIFIERS;

const NAMED: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  NumpadEnter: { key: 'Enter', code: 'NumpadEnter', keyCode: 13, text: '\r', location: 3 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
};

for (let i = 1; i <= 12; i++) {
  NAMED[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

/** Physical `code` for the US layout, needed for letters and digits. */
function codeForChar(char: string): string {
  const upper = char.toUpperCase();
  if (upper >= 'A' && upper <= 'Z') return `Key${upper}`;
  if (char >= '0' && char <= '9') return `Digit${char}`;
  const punctuation: Record<string, string> = {
    '`': 'Backquote',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    ' ': 'Space',
  };
  return punctuation[char] ?? '';
}

/** Virtual key code for the US layout; 0 is accepted for exotic characters. */
function keyCodeForChar(char: string): number {
  const upper = char.toUpperCase();
  if (upper >= 'A' && upper <= 'Z') return upper.charCodeAt(0);
  if (char >= '0' && char <= '9') return char.charCodeAt(0);
  const punctuation: Record<string, number> = {
    ';': 186,
    '=': 187,
    ',': 188,
    '-': 189,
    '.': 190,
    '/': 191,
    '`': 192,
    '[': 219,
    '\\': 220,
    ']': 221,
    "'": 222,
    ' ': 32,
  };
  return punctuation[char] ?? 0;
}

/**
 * Resolve a key name ("Enter", "a", "F5") to a definition. Unknown multi-character
 * names are rejected rather than silently typed as literal text.
 */
export function resolveKey(name: string): KeyDefinition {
  const named = NAMED[name];
  if (named) return named;
  const alias: Record<string, string> = {
    Esc: 'Escape',
    Return: 'Enter',
    Del: 'Delete',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Cmd: 'Meta',
    Command: 'Meta',
    Ctrl: 'Control',
    Option: 'Alt',
  };
  const aliased = alias[name];
  if (aliased && NAMED[aliased]) return NAMED[aliased]!;

  if ([...name].length === 1) {
    const char = name;
    const def: KeyDefinition = {
      key: char,
      code: codeForChar(char),
      keyCode: keyCodeForChar(char),
      text: char,
    };
    return def;
  }
  throw new Error(
    `Unknown key "${name}". Use a single character, or one of: ${Object.keys(NAMED).join(', ')}.`,
  );
}

/**
 * Parse "Control+Shift+K" into modifiers plus the final key.
 * A trailing "+" is treated as the literal plus key.
 */
export function parseChord(chord: string): { modifiers: number; key: KeyDefinition; names: string[] } {
  const parts = chord.split('+');
  const names: string[] = [];
  let modifiers = 0;

  // The last segment is the key itself, unless the chord ends with a literal '+'.
  const keyName = parts[parts.length - 1] === '' ? '+' : parts.pop()!;
  if (parts[parts.length - 1] === '') parts.pop();

  for (const part of parts) {
    const normalized =
      part === 'Ctrl' ? 'Control' : part === 'Cmd' || part === 'Command' ? 'Meta' : part === 'Option' ? 'Alt' : part;
    if (!(normalized in MODIFIERS)) {
      throw new Error(`Unknown modifier "${part}" in "${chord}". Use Control, Shift, Alt or Meta.`);
    }
    modifiers |= MODIFIERS[normalized as ModifierName];
    names.push(normalized);
  }
  return { modifiers, key: resolveKey(keyName), names };
}

export function modifiersFromNames(names: string[] | undefined): number {
  if (!names?.length) return 0;
  let mask = 0;
  for (const raw of names) {
    const normalized =
      raw === 'Ctrl' ? 'Control' : raw === 'Cmd' || raw === 'Command' ? 'Meta' : raw === 'Option' ? 'Alt' : raw;
    if (!(normalized in MODIFIERS)) {
      throw new Error(`Unknown modifier "${raw}". Use Control, Shift, Alt or Meta.`);
    }
    mask |= MODIFIERS[normalized as ModifierName];
  }
  return mask;
}

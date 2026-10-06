/**
 * Path data (24x24 viewBox, filled with currentColor, even-odd) of the icons of the message view. Plain data so the
 * HTML exporter can emit the very same `<svg>` markup.
 */
export const MSG_ICON_PATHS = {
  join: 'M3 11h9.2L8.6 7.4 10 6l6 6-6 6-1.4-1.4 3.6-3.6H3v-2zM17 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3v-2h2V6h-2V4z',
  leave: 'M7 4H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-2H5V6h2V4zM10 11h7.2l-3.6-3.6L15 6l6 6-6 6-1.4-1.4 3.6-3.6H10v-2z',
  pin: 'M15.2 3.2l5.6 5.6-1.6 1.6-1-.3-3.3 3.3.4 3.6-1.5 1.5-3.4-3.4L5 19.6 3.4 18l5.2-5.2-3.4-3.4 1.5-1.5 3.6.4 3.3-3.3-.3-1 1.6-1.6z',
  boost: 'M7.2 3h9.6L21 9l-9 12L3 9l4.2-6zM8.1 5L6 8.5h12L15.9 5H8.1z',
  thread:
    'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm4 4v2h8V8H8zm0 4v2h5v-2H8z',
  call: 'M6.6 3.5L9.5 3l1.8 4.5-2 1.6a11.3 11.3 0 0 0 5.6 5.6l1.6-2 4.5 1.8-.5 2.9a2 2 0 0 1-2 1.6C9.6 19 5 14.4 5 8.1a2 2 0 0 1 1.6-2z',
  edit: 'M3 17.3V21h3.7L18 9.7 14.3 6 3 17.3zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8L18.9 8.8 20.7 7z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm1 13h-2v-5h2v5zm0-7h-2V7h2v2z',
  file: 'M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5L13 3.5z',
  audio: 'M10 3v11.1A3.5 3.5 0 1 0 12 17V8h6V3h-8z',
  forward: 'M14 5l7 7-7 7v-4.2C8.3 14.8 5 16.3 3 20c.6-6.2 4.2-10.2 11-10.8V5z',
  play: 'M8 5v14l11-7L8 5z',
} as const;

export type MsgIconName = keyof typeof MSG_ICON_PATHS;

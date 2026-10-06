/** The screens of the popup. The main screen is the list; every other one has a back arrow. */
export type View =
  | { name: 'main' }
  /** The common settings panel (the caret of the download button). */
  | { name: 'common' }
  /** One chat's own settings (the gear of a row). */
  | { name: 'item'; key: string }
  /** The settings of one server or category (the gear of a group line in the queue tree). `groupId` = server id or category id. */
  | { name: 'group'; kind: 'guild' | 'category'; guildId: string; groupId: string }
  | { name: 'app' }
  | { name: 'history' }
  /** The first-run notice again, opened from the app settings. */
  | { name: 'consent-review' };

export interface NavigateOptions {
  /** The `data-focus-id` of the control that gets the focus back when the screen is left. */
  returnFocus?: string;
}

export type Navigate = (view: View, options?: NavigateOptions) => void;

/** Where the back arrow (and Esc) of a screen leads. */
export function parentView(view: View): View {
  return view.name === 'consent-review' ? { name: 'app' } : { name: 'main' };
}

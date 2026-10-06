import type { ErrorKind } from '@/shared';
import type { popupStrings } from './strings';
import type { Notice } from './store';

type PopupStrings = (typeof popupStrings)['en'];

/** The sentence for a refusal of the background worker (docs/PLAN.md §5.3) or a failure to reach it. */
export function noticeText(code: Notice['code'], t: PopupStrings): string {
  switch (code) {
    case 'no-account':
      return t.errNoAccount;
    case 'no-consent':
      return t.errNoConsent;
    case 'busy':
      return t.errBusy;
    case 'empty':
      return t.errEmpty;
    case 'invalid':
      return t.errInvalid;
    case 'forbidden-path':
      return t.errForbiddenPath;
    case 'http':
      return t.errHttp;
    case 'connection':
      return t.errConnection;
    case 'unknown':
      return t.errUnknown;
  }
}

/** The sentence for the kind of error an item of a job ended with. */
export function errorKindText(kind: ErrorKind, t: PopupStrings): string {
  switch (kind) {
    case 'auth':
      return t.errorAuth;
    case 'forbidden':
      return t.errorForbidden;
    case 'not-found':
      return t.errorNotFound;
    case 'rate-limited':
      return t.errorRateLimited;
    case 'blocked':
      return t.errorBlocked;
    case 'network':
      return t.errorNetwork;
    case 'server':
      return t.errorServer;
    case 'cancelled':
      return t.errorCancelled;
    case 'interrupted':
      return t.errorInterrupted;
    case 'unknown':
      return t.errorUnknown;
  }
}

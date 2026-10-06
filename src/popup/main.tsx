// Toolbar popup entry (popup.html): the real popup on the extension runtime, or - with `popup.html?mock=1`, or when there is no
// extension runtime at all (a normal browser tab) - the same popup on an in-memory mock so it can be inspected without Chrome.
import { createRoot } from 'react-dom/client';
import '@/ui/theme/theme.css';
import '@/ui/components/components.css';
import '@/ui/settings/settings.css';
import './popup.css';
import { ChromePlatform, shouldUseMock } from '@/ui/platform';
import { PopupRoot } from './PopupRoot';

const container = document.getElementById('root');
if (!container) throw new Error('popup.html has no #root element');
const root = createRoot(container);

if (shouldUseMock()) {
  // A chunk of its own: a real extension page never loads the mock and its sample data.
  void import('./preview/renderPreview').then(({ renderPreview }) => renderPreview(root));
} else {
  root.render(<PopupRoot platform={new ChromePlatform()} />);
}

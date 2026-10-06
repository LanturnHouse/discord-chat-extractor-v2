import type { Root } from 'react-dom/client';
import { MOCK_SCENARIOS, createMockPlatform } from '@/ui/platform/mock';
import { PreviewShell } from './PreviewShell';
import './preview.css';

/**
 * `popup.html?mock=1[&scenario=running|tree|idle|empty|consent|no-discord|checking|unhealthy]`: the popup on the in-memory mock
 * platform, with the sample data of `ui/platform/mock/data.ts` and a simulated clock (a started download makes progress).
 */
export function renderPreview(root: Root): void {
  const requested = new URLSearchParams(location.search).get('scenario');
  const scenario = MOCK_SCENARIOS.find((name) => name === requested) ?? 'running';
  const platform = createMockPlatform({ scenario, autoRun: true, uiLanguage: typeof navigator === 'undefined' ? 'ko' : navigator.language });
  document.body.classList.add('dce-preview');
  root.render(<PreviewShell platform={platform} initialScenario={scenario} />);
}

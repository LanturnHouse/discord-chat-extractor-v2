// Shared React UI of the extension pages (docs/PLAN.md §9): theme, i18n, components, the settings panel, the platform wrapper.
// The in-memory mock platform is NOT exported here: it lives in './platform/mock' and is loaded on demand (popup.html?mock=1).
export * from './components/Badge';
export * from './components/Button';
export * from './components/Checkbox';
export * from './components/DateInput';
export * from './components/Icons';
export * from './components/NumberInput';
export * from './components/ProgressBar';
export * from './components/RadioGroup';
export * from './components/SplitButton';
export * from './components/Toggle';
export * from './components/hooks';
export * from './format/dates';
export * from './format/strings';
export * from './format/summary';
export * from './format/time';
export * from './groups/overrides';
export * from './i18n/common';
export * from './i18n/core';
export * from './i18n/locale';
export * from './platform';
export * from './settings/SettingsPanel';
export * from './settings/fields';
export * from './settings/strings';
export * from './theme/applyTheme';
export * from './theme/useTheme';

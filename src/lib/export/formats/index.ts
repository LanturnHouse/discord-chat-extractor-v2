import type { ExportFormat } from '@/shared/types';
import type { FormatModule } from '../types';

/**
 * Format registry. Each format module exports a single `<id>Format` constant. They are loaded lazily so the bundle does not
 * carry the XLSX writer / HTML template until a user actually exports with that format.
 */
const loaders: Record<ExportFormat, () => Promise<FormatModule>> = {
  html: async () => (await import('./html')).htmlFormat,
  txt: async () => (await import('./txt')).txtFormat,
  md: async () => (await import('./md')).mdFormat,
  xlsx: async () => (await import('./xlsx')).xlsxFormat,
  csv: async () => (await import('./csv')).csvFormat,
  json: async () => (await import('./json')).jsonFormat,
};

export function loadExportFormat(id: ExportFormat): Promise<FormatModule> {
  return loaders[id]();
}

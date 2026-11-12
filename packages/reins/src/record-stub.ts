// Production stand-in for `@mindmakr/reins/record`. Same API, does nothing, holds no dev marker.
// The Vite, Next and Metro plugins swap `@mindmakr/reins/record` for this file in production builds.
export interface RecordOptions {
  allow?: Record<string, string[] | undefined>;
  bufferSize?: number;
  pill?: boolean;
}

export interface ExportOptions {
  format?: 'md' | 'json' | 'both';
  title?: string;
}

export const startRecording = (_o?: RecordOptions): boolean => false;
export const recordFromUrl = (_o?: RecordOptions): boolean => false;
export const stopRecording = (): void => {};
export const isRecording = (): boolean => false;
export const collectSession = (_title?: string): null => null;
export const exportSession = (_o?: ExportOptions): { session: null; files: string[] } => ({ session: null, files: [] });

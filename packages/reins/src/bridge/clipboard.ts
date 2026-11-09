import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Copies a PNG file to the OS clipboard. Returns false when no clipboard tool is available. No shell strings: the path goes through an env var or argv. */
export function copyImage(file: string): boolean {
  const env = { ...process.env, REINS_SNAP: file };
  try {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-STA',
          '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile($env:REINS_SNAP))',
        ],
        { env, stdio: 'ignore' },
      );
    } else if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', 'set the clipboard to (read (POSIX file (system attribute "REINS_SNAP")) as «class PNGf»)'], { env, stdio: 'ignore' });
    } else {
      try {
        execFileSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', file], { stdio: 'ignore' });
      } catch {
        execFileSync('wl-copy', ['--type', 'image/png'], { input: readFileSync(file), stdio: ['pipe', 'ignore', 'ignore'] });
      }
    }
    return true;
  } catch {
    return false;
  }
}

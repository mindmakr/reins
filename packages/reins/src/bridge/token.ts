import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A fresh random pairing token (192 bits). */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Compares tokens in constant time. */
export function tokensMatch(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The project's `.reins` folder. It holds its own `.gitignore` so nothing in it is ever committed. */
export function reinsDir(projectDir: string): string {
  const dir = join(projectDir, '.reins');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '*\n');
  return dir;
}

export function tokenPath(projectDir: string): string {
  return join(projectDir, '.reins', 'token');
}

/** Writes the token where the dev server's token route reads it. Readable by the owner only. */
export function writeToken(projectDir: string, token: string): string {
  reinsDir(projectDir);
  const file = tokenPath(projectDir);
  writeFileSync(file, token + '\n', { mode: 0o600 });
  return file;
}

export function removeToken(projectDir: string): void {
  rmSync(tokenPath(projectDir), { force: true });
}

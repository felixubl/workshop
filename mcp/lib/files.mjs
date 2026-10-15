/* Reading and writing the files these tools are asked about.

   The point of every tool here is something that ends up on disk and gets
   opened: a WAV somebody plays, a PDF somebody sends. So paths are handled in
   one place, with one set of manners — resolve against the working directory,
   create the parent, add the extension if it is missing rather than writing a
   file the system will not open by double-clicking it. */

import fs from 'node:fs';
import path from 'node:path';

export function writeOut(where, bytes, extension) {
  if (typeof where !== 'string' || !where.trim()) {
    throw new Error('Need a path to write to.');
  }
  let file = path.resolve(where.trim());
  if (extension && path.extname(file).toLowerCase() !== extension) file += extension;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

export function readIn(where, what) {
  if (typeof where !== 'string' || !where.trim()) {
    throw new Error('Need a path to the ' + (what || 'file') + ' to read.');
  }
  const file = path.resolve(where.trim());
  try {
    return { file, bytes: fs.readFileSync(file) };
  } catch (err) {
    throw new Error('Could not read ' + (what || 'the file') + ' at ' + file + ': ' + err.message);
  }
}

export function sizeOf(file) {
  const bytes = fs.statSync(file).size;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' kB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* How to actually listen to a rendered file. Worth saying: the output is a
   file somebody plays, and the command differs per platform. */
export function playHint(file) {
  const q = JSON.stringify(file);
  if (process.platform === 'darwin') return 'afplay ' + q;
  if (process.platform === 'win32') return 'start "" ' + q;
  return 'aplay ' + q + '   (or ffplay -nodisp -autoexit ' + q + ')';
}

export function openHint(file) {
  const q = JSON.stringify(file);
  if (process.platform === 'darwin') return 'open ' + q;
  if (process.platform === 'win32') return 'start "" ' + q;
  return 'xdg-open ' + q;
}

export const FORMAT_PARAM = {
  type: 'string', enum: ['markdown', 'json'], default: 'markdown',
  description: 'markdown is written to be read; json returns the same findings as data.',
};

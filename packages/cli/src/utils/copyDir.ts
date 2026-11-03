import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  type CopySyncOptions,
} from "node:fs";
import { join } from "node:path";

/**
 * Recursively copies `src` into `dest`, following symlinks.
 *
 * Walks the tree with plain readdir/copyFile instead of `fs.cpSync`: Node's
 * native cpSync writes nothing under a non-ASCII path on Windows (Node 22) and
 * can abort the whole process (0xC0000409) on Windows, e.g. when copying from
 * one drive to another.
 */
export function copyDirSync(
  src: string,
  dest: string,
  options: Omit<CopySyncOptions, "recursive" | "filter"> = {},
): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dest, entry);
    if (statSync(from).isDirectory()) {
      copyDirSync(from, to, options);
      continue;
    }
    if (options.force === false && existsSync(to)) {
      if (options.errorOnExist) {
        copyFileSync(from, to, constants.COPYFILE_EXCL);
      }
      continue;
    }
    copyFileSync(from, to);
  }
}

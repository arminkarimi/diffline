// Diffline's extension ID was arminkarimi.diffline until 0.4.1; now it's diffline.diffline. VS Code keeps each
// extension's global storage in a folder named after its ID, so the reviews, drafts, agent runs, clones and metrics of
// the old ID sit in a sibling folder. No VS Code here, so it's testable.

import { constants } from "node:fs";
import { cp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const OLD_EXTENSION_ID = "arminkarimi.diffline";

/** The old ID's global storage folder, next to `storage`. */
export const oldStorageDir = (storage: string) => path.join(path.dirname(storage), OLD_EXTENSION_ID);

/** In `storage` while it holds a copy of the old storage that the old extension may have changed since. */
const COPY_MARK = ".copied-from-arminkarimi.diffline";

const isEmpty = async (dir: string) => (await readdir(dir).catch(() => [])).length === 0;
const exists = (file: string) => stat(file).then(() => true, () => false);

/**
 * Brings the old ID's storage to `storage`, never over storage this ID has used. While the old extension is installed
 * it may still write there, so the folder is copied (copy-on-write where the disk supports it) and marked as a copy;
 * each later call refreshes the copy. Once the old extension is gone, the folder is moved. Returns what happened.
 */
export async function adoptOldStorage(storage: string, oldInstalled: boolean, from = oldStorageDir(storage)): Promise<"moved" | "copied" | "none"> {
  const mark = path.join(storage, COPY_MARK);
  if (from === storage) return "none";
  if (await isEmpty(from)) {
    await rm(mark, { force: true });
    return "none";
  }
  if (!(await isEmpty(storage)) && !(await exists(mark))) return "none";
  await rm(storage, { recursive: true, force: true });
  if (!oldInstalled) {
    try {
      await rename(from, storage);
      return "moved";
    } catch {
      // Another disk, or something holds a file open: copy instead.
    }
  }
  await cp(from, storage, { recursive: true, mode: constants.COPYFILE_FICLONE });
  if (oldInstalled) await writeFile(mark, "", "utf8");
  return "copied";
}

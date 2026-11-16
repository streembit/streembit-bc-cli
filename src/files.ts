/**
 * File helpers for the wallet file, on node:fs/promises: the five operations the wallet class needs.
 */

import * as fs from 'node:fs/promises';
import { rmSync, constants } from 'node:fs';
import { logger } from './log';
import * as path from 'node:path';

export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * The permissions of what the CLI creates, on Linux and macOS: a directory and a file that only their owner can
 * read. The wallet file holds the encrypted recovery phrase, and its directory lists the backups and copies of it.
 * Windows has no such permissions and ignores them.
 */
const NEW_DIRECTORY_MODE = 0o700;
const NEW_FILE_MODE = 0o600;

/** Create a directory and its missing parents, readable by their owner only; a directory that exists is left as it is */
export async function ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true, mode: NEW_DIRECTORY_MODE });
}

/**
 * Windows refuses a rename onto a file while another process has it open, for the milliseconds a reader takes;
 * the rename is tried again for half a second there. Elsewhere a rename onto an open file succeeds, and a refusal
 * is a real error that is reported at once.
 */
const WINDOWS = process.platform === 'win32';
const RENAME_ATTEMPTS = WINDOWS ? 20 : 1;
const RENAME_RETRY_MS = 25;

/** Counts the temporary files of this process, so that two writes in the same millisecond get two names */
let temporaryFiles = 0;

/**
 * Write a JSON file so that it is never seen half-written: the text goes into a temporary file in the same
 * directory, is flushed to the disk, and the temporary file is then renamed onto the file. A rename replaces the
 * file in one step, so a reader, and a crash at any moment, finds either the old content or the new, complete one.
 * Writing over the file in place would truncate it first: a crash then leaves an empty or cut wallet file, the
 * only encrypted copy of the recovery phrase.
 * The permissions of an existing file are kept, and a symbolic link is followed to the file it names.
 */
export async function writeJsonToFile(filePath: string, data: unknown): Promise<void> {
    const text = JSON.stringify(data, null, 2);
    await ensureDir(path.dirname(filePath));

    // The file itself when the path is a symbolic link, and its permissions and owner when it exists
    let target = filePath;
    let mode: number | undefined;
    let owner: { uid: number; gid: number } | undefined;
    try {
        target = await fs.realpath(filePath);
        const existing = await fs.stat(target);
        mode = existing.mode & 0o777;
        owner = { uid: existing.uid, gid: existing.gid };
    } catch {
        // The file does not exist yet: it is created with the default permissions, owned by the user who runs the command
    }

    const temporary = `${target}.${process.pid}.${Date.now()}.${++temporaryFiles}.tmp`;
    try {
        // A new file is readable by its owner only; an existing file keeps the permissions its owner gave it
        const handle = await fs.open(temporary, 'wx', mode ?? NEW_FILE_MODE);
        try {
            await handle.writeFile(text, 'utf8');
            if (owner && !WINDOWS) {
                // The replacement is created by the user who runs the command. Run once as root on the wallet of a
                // service account, it would make the file root's and the service could no longer write it: the
                // owner of the existing file is kept. A user who may not give the file to that owner is stopped here.
                const created = await handle.stat();
                if (created.uid !== owner.uid || created.gid !== owner.gid) {
                    try {
                        await handle.chown(owner.uid, owner.gid);
                    } catch (error) {
                        throw new Error(`Could not keep the owner of ${target} (user ${owner.uid}, group ${owner.gid}): run the command as that user or as root (${errorCode(error)}). The file is unchanged.`);
                    }
                }
            }
            if (mode !== undefined) {
                // The mode given to open is cut by the process's umask; the existing file's permissions are set exactly
                await handle.chmod(mode);
            }
            await handle.sync();
        } finally {
            await handle.close();
        }

        for (let attempt = 1; ; attempt++) {
            try {
                await fs.rename(temporary, target);
                break;
            } catch (error) {
                const code = errorCode(error);
                if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
                    throw error;
                }
                if (attempt >= RENAME_ATTEMPTS) {
                    throw new Error(`Could not replace ${target}: it is open in another program or not writable (${code}). The file is unchanged.`);
                }
                await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS));
            }
        }
    } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
    }

    // The rename itself is flushed too: without this a power cut in the next seconds can bring the old file back,
    // and with it an address that was handed out already
    await flushDirectory(target);
}

/**
 * Flush the directory entry of a file that was just created or renamed, so that it survives a power cut: the
 * name of a file is an entry of its directory, written to the disk separately from the file's content.
 * Windows cannot open a directory to flush it, so nothing is done there. The file itself is in place by now,
 * so a flush that fails is logged, not thrown.
 */
async function flushDirectory(filePath: string): Promise<void> {
    if (WINDOWS) {
        return;
    }
    try {
        const directory = await fs.open(path.dirname(filePath), 'r');
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } catch (error) {
        logger.warn('The directory of the written file could not be flushed to the disk', { path: filePath, error: errorCode(error) });
    }
}

/**
 * Keep a copy of a file that is about to be replaced, beside it, as <file>.replaced-<time>. The copy is never
 * written over another file, and it keeps the permissions of the original. Its content and its directory entry
 * are flushed to the disk before this returns: the original is replaced right after, and a power cut must not
 * leave the new file without the copy of the old one. A copy that cannot be flushed is an error, and the caller
 * then replaces nothing.
 * @returns The path of the copy, or null when there is no file to keep
 */
export async function keepReplacedCopy(filePath: string): Promise<string | null> {
    if (!await fileExists(filePath)) {
        return null;
    }
    const copy = `${filePath}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.copyFile(filePath, copy, constants.COPYFILE_EXCL);
    try {
        // A flush needs a handle that may write on Windows; a read-only one is enough elsewhere
        const handle = await fs.open(copy, WINDOWS ? 'r+' : 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error) {
        await fs.rm(copy, { force: true });
        throw new Error(`Could not write the copy of ${filePath} safely to the disk (${errorCode(error)}). The file is unchanged.`);
    }
    await flushDirectory(copy);
    return copy;
}

/** Read a JSON file as the type the caller names. The content is not checked here: a wallet file is checked by the SDK when it is opened */
export async function readJsonFromFile<T>(filePath: string): Promise<T> {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
}

// ---- The wallet file lock ----
// Two processes that read the wallet file, change it and write it back at the same time would both start from the
// same content, and the second write would undo the first: two getnewaddress calls would hand out one address.
// Every read-change-write therefore runs under a lock file beside the wallet file, created exclusively (flag 'wx'):
// one process holds it, the others wait for it.

/** How often a waiting process tries again, how long it waits in all, and the age after which a lock is taken to be left by a process that died */
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 30000;

/** The locks this process holds, by lock path with the token written into the file; removed at exit so that an interrupted command leaves none behind */
const heldLocks = new Map<string, string>();

/** The takeover guards this process holds while it removes a stale lock; removed at exit as well, because a guard left behind would stop every later takeover */
const heldGuards = new Set<string>();

process.on('exit', () => {
    for (const leftover of [...heldLocks.keys(), ...heldGuards]) {
        try { rmSync(leftover, { force: true }); } catch { /* the process is ending; a lock left behind is taken over when it is stale */ }
    }
});

function errorCode(error: unknown): string {
    return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
}

/** The guard file of a stale-lock takeover: the process that creates it is the one that may take the stale lock away */
function takeoverGuardPath(lockPath: string): string {
    return `${lockPath}.takeover`;
}

/** True when the lock file, or the guard file, is older than LOCK_STALE_MS; false when it is fresh, gone or cannot be read */
async function lockIsStale(lockPath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(lockPath);
        return Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
    } catch {
        return false;
    }
}

/**
 * Take a lock out of the way when it is older than LOCK_STALE_MS, left by a process that died while holding it.
 * Several waiting processes can see the same leftover lock as stale at the same moment, so the removal has a
 * guard file of its own, created exclusively: only the process that creates it may take the stale lock away.
 * @returns True when a stale lock was removed and the caller can try to take the lock at once
 */
async function removeStaleLock(lockPath: string): Promise<boolean> {
    // A fresh lock, the usual case while waiting, is left alone without touching the guard
    if (!await lockIsStale(lockPath)) {
        return false;
    }
    // Only the process that creates the guard may take a stale lock away; the others keep waiting
    const guard = takeoverGuardPath(lockPath);
    try {
        await fs.writeFile(guard, '', { flag: 'wx' });
    } catch {
        return false;
    }
    heldGuards.add(guard);
    try {
        // Looked at again while no other process can take over: a lock taken a moment ago is fresh and stays
        if (!await lockIsStale(lockPath)) {
            return false;
        }
        await fs.rm(lockPath, { force: true });
        return true;
    } catch {
        return false;
    } finally {
        heldGuards.delete(guard);
        await fs.rm(guard, { force: true });
    }
}

/**
 * Run an action while holding the lock of a file, so that no other streembit-cli process changes the file in between.
 * The lock is the file <filePath>.lock; it is removed when the action ends, whether it succeeded or threw.
 * Not re-entrant: an action must not take the lock of the same file again.
 * @param filePath The file the action reads and writes
 * @param action The read-change-write
 * @returns What the action returns
 */
export async function withFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
    const lockPath = `${filePath}.lock`;
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    await ensureDir(path.dirname(lockPath));

    for (;;) {
        try {
            await fs.writeFile(lockPath, token, { flag: 'wx' });
            break;
        } catch (error) {
            // EEXIST: another process holds the lock. EPERM and EBUSY: Windows answers so while the lock file of another process is being deleted
            const code = errorCode(error);
            if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') {
                throw error;
            }
            if (await removeStaleLock(lockPath)) {
                continue;
            }
            // A guard is held for an instant. One as old as a stale lock was left by a process killed while it held
            // it, and it stops every takeover. It is not removed here: two processes removing an old guard could
            // delete each other's fresh one and take the lock over together. The person is told what to delete.
            const guard = takeoverGuardPath(lockPath);
            if (await lockIsStale(lockPath) && await lockIsStale(guard)) {
                throw new Error(`A lock left by a stopped process could not be cleared because of the leftover file ${guard}. If no other streembit-cli is running, delete ${guard} and ${lockPath}.`);
            }
            if (Date.now() > deadline) {
                throw new Error(`The wallet file is in use by another streembit-cli process: the lock ${lockPath} did not become free within ${LOCK_WAIT_MS / 1000} seconds (${code})`);
            }
            await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        }
    }

    heldLocks.set(lockPath, token);
    try {
        return await action();
    } finally {
        heldLocks.delete(lockPath);
        // Only this process's own lock is removed: one that was taken over as stale belongs to another process now
        let current: string | null = null;
        try {
            current = await fs.readFile(lockPath, 'utf8');
        } catch {
            current = null;
        }
        if (current === token) {
            await fs.rm(lockPath, { force: true });
        }
    }
}

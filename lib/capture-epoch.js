/**
 * dsh-retrace — the capture epoch marker.
 *
 * `capture-epoch.json` records the first run that captured boundary content
 * honestly. A snapshot whose reference predates it cannot be proven to hold
 * that boundary's bytes, so restore refuses it instead of writing today's
 * bytes over the user's file (see `predatesCapture` in `versioning.js`).
 *
 * The marker therefore has one critical property: **it must never move
 * forward**. Moving it forward retroactively invalidates every snapshot the
 * user already has, and there is no way to undo that — restore silently
 * refuses all of them, forever.
 *
 * The previous implementation wrote the marker with a bare `writeFile`, so an
 * interrupted or partial write could leave a truncated file. The next load
 * failed to parse it, fell through to `Date.now()`, and wrote the *newer*
 * epoch: exactly the irreversible failure described above. This module makes
 * the write atomic and salvages a damaged marker instead of discarding it.
 */
import { randomBytes } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CAPTURE_EPOCH_FILE = 'capture-epoch.json'

/** Unique sibling path for the temp file, so concurrent runs cannot collide. */
function tempPath(file) {
  const unique = randomBytes(6).toString('hex')
  return `${file}.tmp-${process.pid}-${unique}`
}

/**
 * Write `data` to `file` such that a reader only ever sees the old content or
 * the new content, never a prefix. `rename` is atomic within a directory on
 * both POSIX and Windows (`MoveFileEx` with `REPLACE_EXISTING`).
 */
export async function writeFileAtomic(file, data) {
  const tmp = tempPath(file)
  try {
    await writeFile(tmp, data)
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * Read the epoch out of a marker's raw text.
 *
 * Returns `null` when nothing usable is present. A truncated marker can still
 * carry the number (`{"epoch":1759...`), and keeping that number is what
 * prevents the epoch from jumping forward, so a regex salvage runs before
 * giving up.
 */
export function parseEpoch(raw) {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.epoch === 'number' && Number.isFinite(parsed.epoch)) return parsed.epoch
  } catch {
    // Truncated or corrupt: try to salvage the digits below.
  }
  const match = /"epoch"\s*:\s*(\d{1,16})/.exec(raw)
  if (match) {
    const salvaged = Number(match[1])
    if (Number.isFinite(salvaged)) return salvaged
  }
  return null
}

/** Best-effort forensic copy of a marker we could not use. Never throws. */
async function preserveDamaged(file, now) {
  await rename(file, `${file}.damaged-${now()}`).catch(() => {})
}

/**
 * Load the capture epoch, establishing it on first use.
 *
 * Never throws: versioning degrades rather than failing the seam, and a
 * missing/unwritable marker must not take the plugin down. It also never
 * advances an epoch that is still readable.
 *
 * @param {string} root - the retrace store root.
 * @param {{ now?: () => number }} [options] - injectable clock for tests.
 * @returns {Promise<number>} the epoch (milliseconds).
 */
export async function loadCaptureEpoch(root, options = {}) {
  const now = options.now ?? Date.now
  const file = join(root, CAPTURE_EPOCH_FILE)

  let raw = null
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    raw = null // absent, or unreadable: treated as first use below
  }

  const existing = parseEpoch(raw)
  if (existing !== null) {
    // A salvaged marker is left in place by parseEpoch only when the JSON was
    // whole; repairing here keeps later reads on the fast path.
    if (raw !== `${JSON.stringify({ epoch: existing })}\n`) {
      await preserveDamaged(file, now)
      await writeFileAtomic(file, `${JSON.stringify({ epoch: existing })}\n`).catch(() => {})
    }
    return existing
  }

  if (raw !== null) {
    // Present but unusable. Keep it for diagnosis, then re-establish. This is
    // the only path that moves the epoch, and it is now reachable only when
    // the marker is genuinely damaged rather than merely half-written.
    await preserveDamaged(file, now)
  }

  const epoch = now()
  await writeFileAtomic(file, `${JSON.stringify({ epoch })}\n`).catch(() => {})
  return epoch
}

/**
 * Path-string helpers for host-provided file paths.
 *
 * `host.showOpenDialog` / `host.importFile` return NATIVE paths — backslashes
 * on Windows — while the host's library surfaces (listAudioFiles etc.) are
 * posix-normalized by contract. Anything display- or filename-derived from a
 * dialog path must therefore split on BOTH separators.
 */

/** Last path segment, tolerant of `/` and `\` separators. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/u);
  return parts[parts.length - 1] ?? p;
}

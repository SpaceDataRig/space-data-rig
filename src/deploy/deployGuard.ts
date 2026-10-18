/**
 * The deploy-provenance decision, as a pure function.
 *
 * WHY IT IS A MODULE AND NOT A COUPLE OF LINES IN THE SCRIPT. `scripts/deploy-with-sha.ts` performs the upload; a
 * test must be able to exercise the rule without uploading anything, and a script that runs its whole body on
 * import cannot be imported. So the decision lives here, gets tested directly, and the script calls it -- with a
 * wiring assertion (tests/deploy-guard.test.ts) so the rule cannot be quietly bypassed.
 *
 * THE DEFECT THIS RULE IS FOR. wrangler uploads the FILES ON DISK while GIT_SHA is set from `git rev-parse HEAD`.
 * Those name the same content only when the tree is clean. On 2026-10-18 an automated deploy fired from a watcher
 * between two of my own commits: production ran a renderer that existed in no commit, no CI run and no review for
 * 75 minutes, while /health.gitSha certified the last committed revision -- and the records written in that window
 * carry prose that the shipped code never produced. The self-proof audit-6 built ("the deployed bytes are the
 * reviewed bytes") was silently false precisely because it was the most trusted claim on the page. A warning that
 * lets that through is a notice to whoever reads the console; this refuses.
 */

export interface DeployDecision {
  /** True when the upload may proceed. */
  ok: boolean;
  /** Uncommitted paths as reported by `git status --porcelain`, empty when the tree matches HEAD. */
  dirty: string[];
  /** One-line reason, written to be read in a job log. */
  reason: string;
}

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * `sha`  : what `git rev-parse HEAD` printed.
 * `status`: what `git status --porcelain` printed ("" means the tree matches HEAD).
 * `opts.allowDirty`: an explicit operator override for an emergency, which must still be loud in the log.
 */
export function deployDecision(
  sha: string,
  status: string,
  opts: { allowDirty?: boolean } = {},
): DeployDecision {
  if (!SHA40.test(sha)) {
    return { ok: false, dirty: [], reason: `could not resolve a 40-hex git HEAD (got "${sha}"); refusing to deploy a wrong gitSha` };
  }
  const dirty = status.split("\n").map((l) => l.trim()).filter(Boolean);
  if (dirty.length && !opts.allowDirty) {
    return {
      ok: false,
      dirty,
      reason:
        `the working tree is not what HEAD is (${dirty.length} uncommitted path(s)); the uploaded bytes would not be the revision gitSha names. ` +
        `Commit them first, or pass --allow-dirty to take that responsibility on purpose.`,
    };
  }
  return {
    ok: true,
    dirty,
    reason: dirty.length ? `deploying a dirty tree by explicit request; gitSha will not describe these ${dirty.length} path(s)` : "clean tree matches HEAD",
  };
}

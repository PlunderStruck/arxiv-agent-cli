# npm Publishing Plan

Date: 2026-07-30

## Goal

Make `arxiv-agent-cli` intentionally publishable as a public npm package, claim
version `0.1.0` through an interactive first publish, and make every later
tagged release publish the exact verified tarball through a tokenless GitHub
Actions identity. Done means no reusable npm write token is stored in GitHub,
the npm and GitHub artifacts are byte-identical, an accidental branch or
version mismatch cannot publish, and the recovery procedure acknowledges npm's
immutable version rule.

## Definitions and invariants

An **npm release** is a public-registry distribution of this repository's
installable tarball whose package name and version permanently identify those
bytes. Its defining fact is that npm will never permit that name/version pair
to be reused, so publishing is a one-way distribution action rather than a
replaceable upload. Source: [npm publish](https://docs.npmjs.com/cli/publish/).

A **trusted publisher** is an npm authorization relationship that accepts a
short-lived identity minted for one named GitHub workflow instead of accepting
a reusable write token. Its workflow-, repository-, and optional
environment-bound identity is what makes automatic provenance and narrow
release authority possible. Source:
[npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

A **verified tarball** is the `.tgz` file produced by `npm pack` after this
repository's typecheck and tests pass. It is the release artifact because the
same bytes, rather than a second build with merely the same version, are sent
to npm and attached to the GitHub release.

A **bootstrap publish** is the first interactive `npm publish` that creates the
registry package. It is distinct from later releases because npm cannot
configure a trusted publisher for a package that does not yet exist. Source:
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

The following properties must always hold:

- I1. A registry publish occurs if and only if the pushed tag is `v<version>`
  and `<version>` equals both `package.json` and `CLI_VERSION`.
- I2. The npm package and GitHub release must contain the same `.tgz` bytes.
- I3. The privileged publish job must never install repository dependencies or
  execute repository build scripts.
- I4. Automated npm publication must use GitHub OIDC and must never read an
  `NPM_TOKEN` or `NODE_AUTH_TOKEN`.
- I5. A rerun may skip an already-published version if and only if npm's
  recorded SHA-1 equals the verified tarball's SHA-1.
- I6. A failed or compromised non-release branch must have no route to npm
  publication.

## Premises

- P1. At baseline commit `33d1d65`, `package.json:2-30` names
  `arxiv-agent-cli@0.1.0`, points to `PlunderStruck/arxiv-agent-cli`,
  restricts package contents through `files`, and sets `private: true`.
  Source: `git show 33d1d65:package.json`.
- P2. `src/cli.ts:40` defines `CLI_VERSION`; compiler-resolved references are
  in `src/cli.ts`, `test/cli.test.ts`, `test/fixture-cli.ts`, and
  `test/release.test.ts`. Source:
  `scip-query plan-context src:cli:CLI_VERSION` and
  `scip-query refs src:cli:CLI_VERSION --full`.
- P3. `test/release.test.ts:38-125` checks version agreement, user-agent
  agreement, bin execution, package contents, public-registry intent, OIDC
  job isolation, and the Node floor.
- P4. At baseline commit `33d1d65`,
  `.github/workflows/release.yml:12-72` is the sole automated release writer.
  It triggers on `v*`, rejects tag/manifest disagreement, runs the repository
  gate, packs once, and writes only a GitHub release. Source:
  `git show 33d1d65:.github/workflows/release.yml`.
- P5. `npm view arxiv-agent-cli` returns `E404` on 2026-07-30. This is evidence
  that no public package is visible, not proof that npm will permit the claim.
- P6. `npm whoami` returns `E401` on 2026-07-30, so no authenticated npm
  identity is currently available to perform the bootstrap publish.
- P7. npm requires an existing package and account-level 2FA before
  `npm trust github` can configure a trusted publisher. Source:
  [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
- P8. GitHub trusted publishing requires a GitHub-hosted runner,
  `id-token: write`, an exact workflow filename, and npm CLI 11.5.1 or later;
  it automatically emits provenance for a public package from a public
  repository. Source:
  [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).
- P9. A first direct public publish requires an authenticated npm account and
  either 2FA or a bypass-capable granular token. This plan chooses interactive
  2FA and creates no automation token. Source:
  [publishing an unscoped package](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/).
- P10. npm permanently reserves a published name/version pair even after
  unpublish. Recovery therefore requires deprecation plus a new patch version,
  not overwriting the bad version. Source:
  [npm publish](https://docs.npmjs.com/cli/publish/).
- P11. `npm publish ./arxiv-agent-cli-0.1.0.tgz --dry-run --access public`
  from an isolated directory publishes the supplied tarball without executing
  its `prepublishOnly`, `prepack`, or repository build scripts (observed with
  npm 11.17.0 on 2026-07-30).

### State-authority premises

- SA1. The release version has three writers: `package.json`, `CLI_VERSION`,
  and the Git tag. Its readers are the CLI/user agent, the release tests, and
  the tag-validation workflow (P1-P4). No runtime command writes it.
- SA2. The npm registry is written only by the bootstrap `npm publish` and the
  publish step in `release.yml`. Humans, npm clients, and the release workflow
  read the published version and tarball digest.
- SA3. GitHub release assets are written only by `release.yml`; readers are
  GitHub users and installer operators.

### Explicit assumptions

- A-P1. The user has or will create an npm account with 2FA and is entitled to
  claim the unscoped name `arxiv-agent-cli`. This remains unverified until the
  bootstrap publish succeeds.

## Current state

The project already produces a bounded tarball and verifies its versioned CLI
surface (P1-P3). A tag runs a release job that rebuilds and uploads that
tarball to GitHub but has no npm authority or publish step (P4). The desired
package appears absent and the local client is logged out (P5-P6). Because npm
requires the package to exist before establishing OIDC trust (P7), setup has an
unavoidable one-time interactive boundary: publish `0.1.0` with 2FA, then bind
`release.yml` and the `npm` GitHub environment as the only automated publisher.

## Reuse audit

- Extend the existing `release.yml`; a second publish workflow would create two
  tag consumers and make it possible for GitHub and npm releases to diverge.
- Extend `test/release.test.ts`; it already owns release-manifest invariants.
- Extend the existing README release section; a second operator document would
  let the two release procedures drift.
- Add no repository secret, release helper, wrapper, or runtime option. Native
  npm, `gh`, and GitHub artifact transfer cover the required boundaries.
- Add one plan document because the publishing authority and irreversible
  registry write require a dated, auditable certificate.

## Testability design

- Manifest seam: `readManifest()` in `test/release.test.ts`; no external
  service is needed to prove public access, registry, repository, and
  `private` invariants.
- Workflow seam: read `.github/workflows/release.yml` as text and assert the
  exact OIDC/environment/token-absence contract.
- Package seam: `npm publish --dry-run --access public` proves npm will accept
  the local manifest and enumerates the exact files without a registry write.
- Side-effect shell: only the privileged `publish` job contacts npm or writes a
  GitHub release. The unprivileged build job creates and transfers the tarball.
- External acceptance seam: after bootstrap, `npm view`, `npm trust list`, the
  GitHub environment API, and a later tagged release prove the account-side
  integration.

## Design phases

### 1. Make the package intentionally publishable

- Anchor: `package.json:2-38`, `test/release.test.ts:14-125`.
- Premises: P1-P3, P8-P10.
- Deployable: yes; without npm authentication this changes no registry state.
- What: the manifest is blocked by `private: true` and does not pin public npm
  registry intent.
- Change: remove `private`, canonicalize the repository URL, add public
  `publishConfig`, and add `prepublishOnly` verification. Extend release tests
  to enforce those facts.
- Validation: `npm test` and `npm publish --dry-run --access public`.

### 2. Separate unprivileged build from privileged publication

- Anchor: `.github/workflows/release.yml:17-140`.
- Premises: P4, P7-P10, SA2-SA3.
- Deployable: yes as part of the `npm-publishing` single-deploy group; no tag
  is pushed by this phase.
- What: one job builds and writes a GitHub release with broad content
  permission, and no npm path exists.
- Change: make a read-only build job verify, pack once, and upload the tarball;
  make an `npm` environment job download only that tarball, grant
  `id-token: write`, publish through OIDC, compare digests on rerun, and attach
  the same bytes to GitHub. Pin privileged third-party actions to reviewed
  release commits and disable release-job dependency caching.
- Validation: YAML parse, workflow contract test, GitHub Actions validation on
  push, and a manual inspection that the privileged job contains no checkout,
  install, or build step.

### 3. Document bootstrap, routine release, and recovery

- Anchor: `README.md:124-174`.
- Premises: P5-P10.
- Deployable: yes as part of the `npm-publishing` single-deploy group.
- What: documentation describes only GitHub tarball publication and local
  checkout rollback.
- Change: document the one-time 2FA publish, exact `npm trust github` command,
  GitHub environment approval, tag release, verification commands, and npm
  deprecation/new-version recovery.
- Validation: command review against npm 11.17 help and the cited npm docs.

### 4. Install the account-side trust

- Anchor: npm registry and GitHub environment APIs.
- Premises: P5-P9, A-P1.
- Deployable: external and sequential; phase 1-3 must be pushed first.
- What: the package does not exist and npm is logged out.
- Change: user completes `npm login`; publish `0.1.0` interactively; configure
  `release.yml`, repository `PlunderStruck/arxiv-agent-cli`, and environment
  `npm` with `--allow-publish`; create the protected GitHub environment.
- Validation: `npm whoami`, `npm view arxiv-agent-cli@0.1.0`,
  `npm trust list arxiv-agent-cli`, and GitHub environment inspection.

## Attack record

- AT1 — I4, secret exposure. Attack: a repository reader searches workflow
  history and logs for a reusable npm credential. Outcome: HELD by phases 2
  and 4; no token is created or stored, and OIDC is workflow-bound (P7-P9).
- AT2 — I6, branch publish. Attack: an attacker opens a pull request that runs
  arbitrary code and requests an npm identity. Outcome: HELD by phase 2; only
  the tag-triggered release job has `id-token: write`, and its publish job uses
  the `npm` environment (P4, P8).
- AT3 — I1, mismatched tag. Attack: push `v0.2.0` while both code versions are
  `0.1.0`. Outcome: HELD by the existing tag check retained in phase 2 and the
  release test in phase 1 (P2-P4).
- AT4 — I3, compromised dependency. Attack: a dependency install script tries
  to request the npm OIDC token. Outcome: HOLE — repaired by phase 2: all
  installs, builds, and tests run in a job with no ID-token permission; the
  privileged job receives only the already-packed artifact, whose direct
  publish executes no package lifecycle scripts (P11).
- AT5 — I2, second-build drift. Attack: npm's publish lifecycle builds bytes
  different from the GitHub tarball. Outcome: HOLE — repaired by phase 2:
  publish the transferred `.tgz` itself and attach that same file.
- AT6 — I5, partial release rerun. Attack: npm accepts the version, GitHub
  release creation fails, and an operator reruns the workflow. Outcome: HOLE —
  repaired by phase 2: compare npm's recorded SHA-1 with the tarball, skip only
  on equality, and idempotently create or replace the GitHub asset.
- AT7 — I5, hostile pre-existing version. Attack: a version exists with
  different bytes and the workflow treats it as success. Outcome: HELD by
  phase 2's digest mismatch failure (P10).
- AT8 — I6, manual workflow dispatch. Attack: dispatch `release.yml` from
  `main`. Outcome: HELD by the tag/manifest comparison because `main` is not
  the manifest version (P4).
- AT9 — recovery. Attack: a defective immutable version is published. Outcome:
  HOLE — repaired by phase 3: deprecate it, publish a corrected patch, and move
  `latest`; never promise overwrite rollback (P10).
- AT10 — bootstrap bypass. Attack: the one-time manual publish skips tests.
  Outcome: HOLE — repaired by phase 1's `prepublishOnly` gate.
- AT11 — wrong registry. Attack: a user's npm configuration points publish at
  another registry. Outcome: HOLE — repaired by phase 1's explicit npmjs
  `publishConfig`.
- AT12 — name claim failure. Attack: npm rejects the first publish because the
  name is reserved or the user lacks required account controls. Outcome:
  HOLE — accepted until phase 4; P5 is not proof of claim authority and A-P1
  remains explicit.

### Coverage matrix

| Authority or lens | Covered by |
|---|---|
| Bootstrap registry writer | AT10, AT12 |
| OIDC registry writer | AT1-AT8, AT11 |
| GitHub release writer | AT5-AT6 |
| Version writers/readers | AT3, AT7-AT9 |
| Valid intermediate state | AT6 |
| Reversibility | AT9 |
| Failure and retry | AT6-AT7, AT12 |
| Boundary and secrets | AT1-AT5, AT11 |
| Data integrity | AT3, AT5-AT7 |
| Human experience | AT8-AT10, AT12 |
| Efficiency and reuse | phases 1-3 reuse audit |
| Testability and observability | testability design, phases 1-4 validation |

## Execution and ship order

1. Commit phases 1-3 together; they are safe without a release tag.
2. Push and require normal CI to pass.
3. Create the `npm` GitHub environment with the owner as required reviewer.
4. Complete the interactive bootstrap publish; this is the first one-way door.
5. Configure npm trust for `release.yml` plus environment `npm`.
6. Do not push a release tag until steps 1-5 are confirmed.

## Verdict

A plan is **PLANNED-COMPLETE** if and only if the coverage matrix has no blank
rows, every attack ends in a defended, repaired, or explicitly accepted
outcome, and no premise fails reverification.

Result: **PLANNED-COMPLETE** — 12 attacks, 6 holes repaired, 1 external hole
accepted until npm login/bootstrap, and no blank coverage rows.

## Files

- Create: `docs/plans/2026-07-30-npm-publishing.md`.
- Edit: `package.json`, `test/release.test.ts`,
  `.github/workflows/release.yml`, `README.md`.
- Delete: none.
- Verify: npm dry-run/package install, full tests, workflow syntax and contract,
  secret scan, SCIP diff impact/postchecks/gate, GitHub CI, then npm/GitHub
  account-side state.

# What this fork changes

This repository, [nico-c-hublo/sphinx](https://github.com/nico-c-hublo/sphinx), is a fork of [parthh01/sphinx](https://github.com/parthh01/sphinx). It keeps upstream's goal and its rules for assessing a change. It changes **when** a check happens: you can check a pull request after the fact instead of making every push wait.

- [The approach](#the-approach)
- [Install the fork](#install-the-fork)
- [Recommended setup](#recommended-setup)
- [Changes from upstream](#changes-from-upstream)
- [Compatibility with upstream](#compatibility-with-upstream)
- [Keeping up with upstream](#keeping-up-with-upstream)

## The approach

Upstream Sphinx is a blocking gate. A push to a protected branch waits in the Git hook until the human passes. That works well when you push by hand to `main`. It works less well when a coding agent pushes feature branches and a pull request is how changes reach `main`:

- The agent's shell may time out while Git waits, so the push fails and has to be retried.
- The check runs at push time. For a branch, the review that matters happens later, on the pull request.
- Comparing `HEAD` with the destination's current tip counts every commit merged into `main` since the branch was cut as something the branch undoes. A 7-file pull request showed up as 234 files.

This fork splits the check into two steps. Git never waits. Background preparation still writes the questions after each commit. The human then runs the check against the pull request as GitHub shows it, and a pass stamps that pull request:

```text
commit ─▶ background review prepares the pull request check (offline, no blocking)
push   ─▶ goes straight through, prints one line
open PR
sphinx check --pull-request ─▶ questions ready ─▶ pass ─▶ commit status + optional PR comment
                                                          (+ Sphinx check if the repo runs the Action)
```

Block mode is still the default and works exactly as upstream. On-demand mode is opt-in, either per repository or as your machine-wide default.

## Install the fork

The npm package `sphinx-understand` is upstream's release, so `npm install -g sphinx-understand` does **not** install this fork. Install it from GitHub instead:

```sh
npm install -g github:nico-c-hublo/sphinx
sphinx install
```

This command also replaces an existing upstream install, because the package name is the same. Your settings in `~/.config/sphinx` are kept. Run `sphinx install` again afterwards so the hooks and agent integrations match the new copy. To update, run the same `npm install -g github:nico-c-hublo/sphinx`. To work from a checkout, run `npm install -g .` in it and update with `git pull`.

The questionnaire's update button follows the fork too. It compares your version with `version` in `package.json` on this fork's `main` and, when that version is higher, runs `npm install -g github:nico-c-hublo/sphinx` (or the pnpm or Bun equivalent) after the check ends. Upstream's version checks npm instead, so a copy installed before this change could offer upstream's release. Reinstall from GitHub once to get the fork's version. `SPHINX_UPDATE_CHECK=0` turns the check off.

The fork publishes nothing to npm. The release job in `.github/workflows/test.yml` runs only in `parthh01/sphinx`. Merging into `main` doesn't trigger the update button. To offer the team an update, raise `version` in `package.json` (and `package-lock.json`) in the pull request.

Each version is tagged `v<version>` with a [GitHub release](https://github.com/nico-c-hublo/sphinx/releases). `.github/workflows/fork-release.yml` creates both once the Test workflow passes on the first `main` commit that carries the new version; no tag needs setting by hand. The update button still reads `package.json`, not the tags. Use a tag to install a given version, or to go back to one:

```sh
npm install -g github:nico-c-hublo/sphinx#v0.2.1
npm install -g "github:nico-c-hublo/sphinx#semver:^0.2"   # the highest 0.2.x tag
```

The fork also carries upstream's `v0.1.x` tags. Fork versions stay above upstream's (see [Keeping up with upstream](#keeping-up-with-upstream)), so the two should not name the same version. If upstream ever tags a version the fork already tagged, `git fetch upstream` refuses to overwrite that tag; keep the fork's.

## Recommended setup

For repositories where agents push branches and changes reach `main` through pull requests:

1. Install the fork as above, and sign in to the GitHub CLI: `gh auth login`. On-demand checks use `gh` to find the pull request.
2. In each repository, pick on-demand mode and check every branch:

   ```sh
   sphinx init --mode on-demand --branches '*'
   ```

   Or set `"mode": "on-demand"` in an existing `.sphinxconfig`. To make it your default everywhere, run `sphinx config --mode on-demand`. A repository's `.sphinxconfig` still wins, so a repository can require blocking checks.
3. Optionally, add the Sphinx Action so each pull request shows a **Sphinx** check: `sphinx init --github-check`. In a fork where Actions are off, turn them on in the Actions tab, or the commit gets neither the status nor the check.
4. Work as usual. When the pull request is open, check out its branch at its head commit and run:

   ```sh
   sphinx check --pull-request
   ```

   The questions appear where your `interface` setting says: the browser page on a local Mac, the terminal elsewhere. Use `--browser` or `--terminal` to choose for one run. Add `--comment` or `--no-comment` to decide whether the pass posts a summary comment on the pull request.
5. Run `sphinx doctor` once. In on-demand repositories on GitHub, it checks that `gh` is installed and signed in. It also warns when a local `core.hooksPath` hides the global hooks, as husky does. Checks still work then, but nothing is prepared in the background until you run `sphinx install --repo`. hublo-tools spaces are the exception: their hooks run your global hooks after husky, so doctor reports them as covered once you have pushed (or committed, for a commit policy) from one.

Coding agents can't switch a repository to on-demand mode (`sphinx init --apply` refuses it). Their guidance also tells them not to run `sphinx check` on your behalf.

## Changes from upstream

Each change has its own pull request with the full reasoning. The [configuration](configuration.md) and [integrations](integrations.md) references describe the current behavior.

| Change | What it does | Docs |
| --- | --- | --- |
| **On-demand mode** ([#6](https://github.com/nico-c-hublo/sphinx/pull/6)) | Adds `"mode": "on-demand"`, so pushes and commits are never blocked. `events` still say which changes are assessed. Background preparation targets the pull request check: the detached worker asks `gh` for the open pull request and builds that check from local `HEAD`. After a push it waits up to about five minutes for the pull request to open. Set it with `sphinx init --mode`, `sphinx config --mode`, or the setup question. When `gh` is missing or signed out, `init`, `config`, `doctor`, and `status` say so. | [On-demand checks](configuration.md#on-demand-checks) |
| **Pull request checks** ([#2](https://github.com/nico-c-hublo/sphinx/pull/2)) | `sphinx check --pull-request` checks the branch's open pull request from where the branch left its base (their merge base), not from the base's current tip. It works with pull requests from forks and in shallow clones. A pass stamps the pull request: a commit status on its head commit and, if you choose, the comment the Sphinx Action reads. A pass recorded with `sphinx answer` stamps it too. | [Configuration](configuration.md#repository-policy) · [GitHub stamps](configuration.md#github-commit-status-and-pull-requests) |
| **Browser page for `sphinx check`** ([#1](https://github.com/nico-c-hublo/sphinx/pull/1)) | `sphinx check` follows the `interface` setting, as a push does, instead of always using the terminal. `--browser` and `--terminal` choose for one run. With no Git operation waiting, the page ends when you pass or pause, and offers no skip. | [Browser or terminal](configuration.md#browser-or-terminal) |
| **Saved pull request comment choice** ([#4](https://github.com/nico-c-hublo/sphinx/pull/4)) | The "Post the Sphinx stamp to the pull request" choice is saved with the check, so it survives the process that asked, for example when `git push` exited before you finished. `sphinx check --comment` / `--no-comment` set it from the terminal. The choice is removed together with its check. | [GitHub stamps](configuration.md#github-commit-status-and-pull-requests) |
| **Working-context model route** ([#5](https://github.com/nico-c-hublo/sphinx/pull/5)) | `models.context` (`sphinx config --context-model <provider:model>`) runs the working-context curator on its own model, so a cheaper curator doesn't change how small changes are checked. `--context-model small` clears it. | [Working context](configuration.md#working-context) |
| **Updates from GitHub** ([#8](https://github.com/nico-c-hublo/sphinx/pull/8)) | The questionnaire's update button checks this fork's `main` and installs from GitHub. It used to check npm, where it would have installed upstream over the fork. | [Install the fork](#install-the-fork) |
| **Hooks folder fix** ([#3](https://github.com/nico-c-hublo/sphinx/pull/3)) | A reinstall could chain Sphinx's own hooks folder to itself, which made `git fetch`, `commit`, and `checkout` hang. Hooks folders are now compared by real path, the way Git resolves them. Uninstall warns when it restores a folder that no longer exists. | [Architecture](architecture.md#installation) |

## Compatibility with upstream

On-demand mode and `models.context` are unknown to upstream, and upstream rejects them:

- A `.sphinxconfig` with `"mode": "on-demand"` fails validation for anyone running upstream Sphinx (`mode must be block`). If a repository commits that setting, everyone who works in it needs the fork.
- A `models.context` route in `~/.config/sphinx/config.json` makes upstream reject the whole file. Before switching a machine back to upstream, run `sphinx config --context-model small`.

Everything else is compatible. Block-mode repositories behave the same under either version. Commit statuses and comments use the same format. The workflow that `sphinx init --github-check` writes uses upstream's Action (`parthh01/sphinx/action`), which reads stamps from either version. It pins the Action to an upstream release tag (`ACTION_VERSION` in `src/github.js`), not to the fork's version, because upstream has no tags for the fork's versions.

## Keeping up with upstream

`upstream` is the remote for `parthh01/sphinx`. To see what each side has that the other doesn't:

```sh
git fetch upstream
git log --oneline main..upstream/main   # upstream changes not merged yet
git log --oneline upstream/main..main   # this fork's changes
```

Merge upstream into a branch, run `npm test`, and open a pull request against this fork's `main`. The changes listed above are the parts of the code most likely to conflict. Keep `src/update.js` pointing at this fork. Upstream's version bumps come along with the merge, so check that the fork's `version` ends up higher than the one the team has installed. Keep the fork's `version` when `package.json` conflicts. To use a newer upstream Action, raise `ACTION_VERSION` to one of upstream's `v*` tags.

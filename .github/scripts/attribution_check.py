#!/usr/bin/env python3
"""Enforce that every artifact says which model produced it.

docs/WORKFLOW.md asks each commit, pull request and ticket to record `Role`,
`Model` and `Harness`. This makes that a requirement rather than a habit.

The reason it has to be enforced rather than trusted: the queries in that
document sum lines per model. A history where most commits are labelled and a
few are not does not report "some data is missing" — it reports a smaller
number, confidently. **A half-labelled history is worse than an unlabelled
one**, because the second is obviously unusable and the first is quietly wrong.
"""
import os
import re
import subprocess
import sys

FIELDS = ("Role", "Model")  # Harness is recorded but not required to pass


def sh(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def fail(lines: list[str]) -> None:
    for line in lines:
        print(f"::error::{line}")
    sys.exit(1)


def has_fields(text: str) -> list[str]:
    """Return the required fields missing from a block of text.

    Two shapes are accepted, because the document asks for two: a git trailer on
    its own line, and an inline footer such as `Role: … · Model: … · Harness: …`.
    Requiring the start of a line would have rejected every correctly formatted
    pull request body — found by running this against one before trusting it.
    """
    return [
        f
        for f in FIELDS
        if not re.search(rf"(?:^|[·|,;]\s*){f}:\s*\S+", text, re.MULTILINE)
    ]


def check_commits(base: str, head: str) -> list[str]:
    """Every non-merge commit needs the trailers. Merge commits are GitHub's."""
    problems = []
    revs = sh("git", "rev-list", "--no-merges", f"{base}..{head}").split()
    for rev in revs:
        body = sh("git", "log", "-1", "--format=%B", rev)
        missing = has_fields(body)
        if missing:
            subject = sh("git", "log", "-1", "--format=%s", rev).strip()
            problems.append(
                f"commit {rev[:9]} ({subject[:60]}) is missing: {', '.join(missing)}. "
                f"Add them as trailers in the message footer, e.g. 'Model: claude-opus-5'."
            )
    if not revs:
        problems.append(
            "this pull request contains no non-merge commits, so nothing could be attributed."
        )
    return problems


def check_pr_body(body: str) -> list[str]:
    missing = has_fields(body)
    if missing:
        return [
            "the pull request body is missing: " + ", ".join(missing) + ". "
            "Add a footer line, e.g. 'Role: agent-coach · Model: claude-opus-5 · Harness: claude-code'."
        ]
    return []


def read_model(rev: str) -> str:
    """The model a landed commit reports — trailer first, then note.

    This is deliberately the same two-step the lines-per-model query in
    docs/WORKFLOW.md performs. If the gate read only trailers it would disagree
    with the report it exists to protect, and the backfilled commits — labelled
    with `git notes` rather than by rewriting history — would all fail.
    """
    trailer = sh(
        "git", "log", "-1", "--format=%(trailers:key=Model,valueonly)", rev
    ).strip()
    if trailer:
        return trailer
    note = sh("git", "log", "-1", "--format=%N", rev)
    m = re.search(r"^Model:\s*(\S+)", note, re.MULTILINE)
    return m.group(1) if m else ""


def check_landed_history(ref: str = "HEAD", upstream: str = "") -> list[str]:
    """Every non-merge commit on main names a model, readably.

    The pull-request check cannot cover this. It runs against commits that stop
    existing the moment a squash lands, and GitHub's squash appends
    `Co-authored-by:` after a blank line — which ends the trailer block, so
    `%(trailers)` returns nothing on a commit whose message still carries all
    three fields. That is a real failure, not a hypothetical: it happened to
    a438457 (#51). The window is between the last green check and the commit
    that lands, and this is what stands in it.

    The whole history is audited rather than the pushed range, because an
    unlabelled commit does not become acceptable by being old, and the fix — a
    note — is the same either way.
    """
    # In a fork, the history below our first commit belongs to upstream and carries no
    # trailers; those commits are not ours to label. UPSTREAM_REF (e.g. `upstream/main`)
    # excludes everything reachable from it, so only the commits this workspace added are
    # audited. Unset, the whole history is audited, as in nex-agent.
    args = ["git", "rev-list", "--no-merges", ref]
    if upstream:
        args.append(f"^{upstream}")
    problems = []
    for rev in sh(*args).split():
        if read_model(rev):
            continue
        subject = sh("git", "log", "-1", "--format=%s", rev).strip()
        problems.append(
            f"commit {rev[:9]} ({subject[:60]}) landed on main with no readable Model. "
            f"Neither its trailers nor a note name one — a squash merge may have ended the "
            f"trailer block. Fix it with a note, not a rewrite — one -m per field, then "
            f"push it: git notes add -m 'Role: …' -m 'Model: …' -m 'Harness: …' {rev[:9]} "
            f"&& git push origin refs/notes/commits"
        )
    return problems


def check_ticket(body: str, repo: str) -> list[str]:
    """Tickets opened through the API skip the form's required fields."""
    m = re.search(r"(?:closes|fixes|resolves)\s+#(\d+)", body, re.I)
    if not m:
        return []  # scope_check.py already refuses a PR with no ticket
    issue = m.group(1)
    try:
        raw = sh("gh", "issue", "view", issue, "-R", repo, "--json", "body", "-q", ".body")
    except subprocess.CalledProcessError:
        return [f"could not read ticket #{issue} to check its attribution."]
    if not re.search(r"^###\s+Written by\s*$", raw, re.MULTILINE):
        return [
            f"ticket #{issue} has no 'Written by' section. A rejection is a fact about the pair "
            f"of models at both ends, so the brief has to carry one too — see Attribution in "
            f"docs/WORKFLOW.md."
        ]
    return []


def main() -> None:
    if os.environ.get("GITHUB_EVENT_NAME") == "push":
        problems = check_landed_history(upstream=os.environ.get("UPSTREAM_REF", ""))
        if problems:
            fail(problems + ["See 'Attribution' in docs/WORKFLOW.md for the three fields."])
        print("attribution: every non-merge commit on the base branch names a model")
        return

    repo = os.environ["GITHUB_REPOSITORY"]
    pr_body = os.environ.get("PR_BODY") or ""
    base = os.environ["BASE_SHA"]
    head = os.environ["HEAD_SHA"]

    problems = check_commits(base, head) + check_pr_body(pr_body) + check_ticket(pr_body, repo)

    if problems:
        fail(problems + ["See 'Attribution' in docs/WORKFLOW.md for the three fields."])

    print("attribution: every commit, the pull request body, and the ticket are labelled")


if __name__ == "__main__":
    main()

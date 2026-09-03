#!/usr/bin/env python3
"""Enforce that a PR stays inside the scope its ticket declared.

Reads the scope section — "Scope — files the agent-coder may edit", or the agent-coach's
equivalent on a `coach-only` ticket — and "Risk zone" from the issue the PR closes,
then enforces two rules:

  1. Every file in the diff must match at least one glob in the declared scope.
  2. A risk-zone ticket needs an approving review from someone in HUMAN_APPROVERS.

Why this is CI and not a paragraph in a document: docs/WORKFLOW.md carried the scope
rule as prose from day one and work still landed outside scope. A rule nobody enforces
is a convention, not a guarantee.
"""
import json
import os
import re
import subprocess
import sys

APPROVERS = [s.strip() for s in os.environ.get("HUMAN_APPROVERS", "RaphWind").split(",") if s.strip()]
# The ticket form's heading. Three spellings are accepted:
#   - the form's own, which always names the agent-coder;
#   - "the agent-coach", because a `coach-only` ticket declares scope for the coach and is written
#     by hand rather than through the form — found on 2026-08-20 when the first such ticket went
#     through a pull request and this check refused it for having no scope section at all;
#   - "Prime", for tickets written before the 2026-08-19 rename.
# A ticket stays readable through a rename, and a role that cannot declare scope is a role whose
# work cannot be checked.
HEAD_SCOPES = (
    "Scope — files the agent-coder may edit",
    "Scope — files the agent-coach may edit",
    "Scope — files Prime may edit",
)
HEAD_RISKY = "Risk zone"


def sh(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def section(body: str, heading: str) -> str:
    """Return the text under `### <heading>`, stopping at the next heading.

    This is the shape GitHub renders an issue form into.
    """
    m = re.search(
        rf"^###\s+{re.escape(heading)}\s*$(.*?)(?=^###\s|\Z)",
        body,
        re.MULTILINE | re.DOTALL,
    )
    if not m:
        return ""
    text = m.group(1)
    # strip the code fence that `render:` wraps the answer in
    text = re.sub(r"^```[a-zA-Z]*\s*$|^```\s*$", "", text, flags=re.MULTILINE)
    return text.strip()


def glob_to_re(pat: str) -> re.Pattern:
    """Compile a glob where `*` does not cross `/` and `**` does.

    fnmatch lets `*` cross `/`, so `db/*.sql` would silently cover `db/sub/deep/a.sql`
    and the declared scope would be far wider than it reads.
    """
    out, i = [], 0
    while i < len(pat):
        c = pat[i]
        if c == "*":
            if pat[i : i + 2] == "**":
                i += 2
                if pat[i : i + 1] == "/":
                    # `**/` = zero or more whole directories. Emitting `.*` and swallowing the
                    # `/` made `**/foo.ts` match `src/myfoo.ts` and `a/**/b` match `a/xb`
                    # (advisor consultation SGNEX-ADVISOR-0903-heron, 2026-09-04).
                    out.append("(?:.*/)?")
                    i += 1
                else:
                    out.append(".*")
                continue
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile("^" + "".join(out) + "$")


def main() -> None:
    repo = os.environ["GITHUB_REPOSITORY"]
    pr = os.environ["PR_NUMBER"]
    pr_body = os.environ.get("PR_BODY") or ""

    issues = re.findall(r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", pr_body, re.IGNORECASE)
    if not issues:
        fail(
            "This PR links no ticket. Add `Closes #<issue>` to the description — "
            "scope and risk zone are read from the ticket, so without one there is nothing to check."
        )
    if len(set(issues)) > 1:
        fail(
            "This PR links several tickets (%s). One PR closes one ticket."
            % ", ".join("#" + i for i in sorted(set(issues)))
        )
    issue = issues[0]

    body = json.loads(sh("gh", "issue", "view", issue, "--repo", repo, "--json", "body"))["body"] or ""

    raw = next((t for t in (section(body, h) for h in HEAD_SCOPES) if t), "")
    patterns = [ln.strip().lstrip("-").strip() for ln in raw.splitlines()]
    patterns = [p for p in patterns if p and p != "_No response_"]
    if not patterns:
        fail(
            f"#{issue} declares no scope, or the section was left blank. Accepted headings: "
            + ", ".join(f"'{h}'" for h in HEAD_SCOPES)
            + ". Open the ticket again using the ticket.yml form."
        )

    changed = [f for f in sh("gh", "pr", "diff", pr, "--repo", repo, "--name-only").splitlines() if f.strip()]
    if not changed:
        fail("The diff is empty — nothing to check.")

    matchers = [(p, glob_to_re(p)) for p in patterns]
    outside = [f for f in changed if not any(rx.match(f) for _, rx in matchers)]

    print(f"ticket   : #{issue}")
    print("scope    :")
    for p in patterns:
        print(f"  - {p}")
    print(f"touched  : {len(changed)} file(s)")
    for f in changed:
        print(f"  {'x' if f in outside else 'ok'} {f}")

    risky = section(body, HEAD_RISKY).strip().lower().startswith("yes")
    approved = []
    if risky:
        reviews = json.loads(sh("gh", "api", f"repos/{repo}/pulls/{pr}/reviews", "--paginate"))
        approved = sorted({r["user"]["login"] for r in reviews if r.get("state") == "APPROVED"})
        print(f"risk zone: yes — approved by {', '.join(approved) or '(nobody yet)'}")
    else:
        print("risk zone: no")

    problems = []
    if outside:
        problems.append(
            "Touches files outside the scope of #%s: %s. "
            "If the change is genuinely needed, amend the ticket first — do not widen scope silently."
            % (issue, ", ".join(outside))
        )
    if risky and not [u for u in approved if u in APPROVERS]:
        problems.append(
            "#%s is a risk-zone ticket and needs an approving review from %s before merge."
            % (issue, " or ".join(APPROVERS))
        )

    if problems:
        for p in problems:
            print(f"::error::{p}")
        sys.exit(1)
    print("scope-check passed")


def self_test() -> None:
    cases = [
        ("**/foo.ts", "foo.ts", True),
        ("**/foo.ts", "src/a/foo.ts", True),
        ("**/foo.ts", "src/myfoo.ts", False),
        ("a/**/b", "a/b", True),
        ("a/**/b", "a/x/y/b", True),
        ("a/**/b", "a/xb", False),
        ("docs/**", "docs/a/b.md", True),
        ("db/*.sql", "db/sub/a.sql", False),
        ("src/?.ts", "src/a.ts", True),
    ]
    for pat, path, want in cases:
        got = bool(glob_to_re(pat).match(path))
        assert got == want, f"{pat!r} vs {path!r}: expected {want}, got {got}"
    print(f"scope_check self-test: {len(cases)} cases ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        main()

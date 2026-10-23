import importlib.util
import pathlib
import unittest

# Tom (stoff81) reviews agent-authored PRs for GitHub inbox visibility only.
# Per pr-process/SKILL.md he must never gate merge eligibility, so a still-pending
# Tom review must not hide an approved Quinn-authored PR from the merge queue.


MODULE_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "agent_task_queue.py"
SPEC = importlib.util.spec_from_file_location("agent_task_queue", MODULE_PATH)
agent_task_queue = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(agent_task_queue)

blocking_reviewers = agent_task_queue._blocking_reviewers


def _pr(title="docs(agent-incidents): add multi-task root-cause incident model", reviewers=()):
    return {
        "title": title,
        "requested_reviewers": [{"login": login} for login in reviewers],
    }


class BlockingReviewersVisibilityOnlyTest(unittest.TestCase):
    def test_pending_visibility_reviewer_does_not_block_approved_pr(self):
        # Real shape of PRs 833/865/866: rowanstoffer approved, Tom still pending.
        self.assertEqual(
            blocking_reviewers(
                "quinn",
                _pr(reviewers=("rowanstoffer", "stoff81")),
                {"rowanstoffer": "APPROVED"},
            ),
            ["rowanstoffer"],
        )

    def test_falls_back_to_latest_reviews_after_github_clears_requesters(self):
        self.assertEqual(
            blocking_reviewers("quinn", _pr(reviewers=()), {"rowanstoffer": "APPROVED"}),
            ["rowanstoffer"],
        )

    def test_explicit_tom_approval_title_still_gates(self):
        self.assertEqual(
            blocking_reviewers(
                "quinn",
                _pr(
                    title="chore: tom-approval needed for rollout",
                    reviewers=("rowanstoffer", "stoff81"),
                ),
                {"rowanstoffer": "APPROVED"},
            ),
            ["rowanstoffer", "stoff81"],
        )

    def test_author_never_blocks_own_pr(self):
        self.assertEqual(
            blocking_reviewers(
                "quinn",
                _pr(reviewers=("quinnstoffer", "rowanstoffer")),
                {"quinnstoffer": "APPROVED", "rowanstoffer": "APPROVED"},
            ),
            ["rowanstoffer"],
        )

    def test_other_agent_policies_unchanged(self):
        self.assertEqual(blocking_reviewers("rowan", _pr(reviewers=("quinnstoffer",)), {}), ["quinnstoffer"])
        self.assertEqual(
            blocking_reviewers("ivy", _pr(title="content: tom-approval", reviewers=("stoff81",)), {}),
            ["stoff81"],
        )


if __name__ == "__main__":
    unittest.main()
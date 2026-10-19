"""Lifecycle regression checks; no browser or provider account is used."""
import unittest
from phone_flow import PhoneFlow


class PhoneFlowTest(unittest.TestCase):
    def test_answer_stays_working_until_the_provider_reports_its_next_question(self):
        flow = PhoneFlow()
        flow.begin("password", "private-fixture", 100)
        self.assertEqual(flow.progress, {"step": "working"})
        self.assertEqual(flow.observe({"step": "working"}, 102), {"step": "working"})
        self.assertEqual(flow.answer, ("password", "private-fixture"))
        self.assertEqual(flow.observe({"step": "ask", "ask": "code"}, 104), {"step": "ask", "ask": "code"})
        self.assertIsNone(flow.answer)

    def test_provider_error_is_preserved_and_releases_the_answer(self):
        flow = PhoneFlow()
        flow.begin("password", "private-fixture", 100)
        report = {"step": "error", "ask": "password", "message": "Incorrect password"}
        self.assertEqual(flow.observe(report, 102), report)
        self.assertIsNone(flow.answer)
        self.assertNotIn("private-fixture", str(flow.progress))

    def test_a_stalled_submission_reports_a_retry_instead_of_silently_reasking(self):
        flow = PhoneFlow()
        flow.begin("password", "private-fixture", 100)
        progress = flow.observe({"step": "working"}, 126)
        self.assertEqual(progress["step"], "error")
        self.assertEqual(progress["ask"], "password")
        self.assertIsNone(flow.answer)

    def test_real_provider_checks_keep_the_submission_alive_until_the_next_step(self):
        flow = PhoneFlow()
        flow.begin("email", "fixture@example.invalid", 100)
        self.assertEqual(flow.observe({"step": "challenge"}, 130), {"step": "challenge"})
        self.assertIsNotNone(flow.answer)
        flow.observe({"step": "ask", "ask": "password"}, 132)
        self.assertIsNone(flow.answer)


if __name__ == "__main__":
    unittest.main()

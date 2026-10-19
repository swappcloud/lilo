"""Phone answer lifecycle matching the desktop Working/Ask/Error contract."""


class PhoneFlow:
    def __init__(self):
        self.attempt = 1
        self.answer = None
        self.deadline = 0
        self.progress = {"step": "working"}

    def begin(self, field, value, now):
        self.attempt += 1
        self.answer = (field, value)
        self.deadline = now + 25
        self.progress = {"step": "working"}

    def observe(self, report, now):
        progress = {"step": "working"}
        if isinstance(report, dict):
            if report.get("step") in ("working", "ask", "challenge", "error"):
                progress["step"] = report["step"]
            if report.get("ask") in ("email", "password", "code", "phone"):
                progress["ask"] = report["ask"]
            if isinstance(report.get("message"), str):
                progress["message"] = report["message"][:240]
        if self.answer:
            if progress["step"] in ("ask", "error"):
                self.answer = None
            elif progress["step"] == "challenge":
                self.deadline = now + 25
            elif now >= self.deadline:
                progress = {"step": "error", "ask": self.answer[0],
                            "message": "The sign-in page did not answer. Please try again."}
                self.answer = None
        self.progress = progress
        return progress

    def clear(self):
        self.answer = None
        self.progress = {"step": "working"}

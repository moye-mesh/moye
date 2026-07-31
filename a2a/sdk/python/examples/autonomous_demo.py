"""Demo: two autonomous agents self-onboard and proactively collaborate with encryption, with no human involved at any point"""

import sys
sys.path.insert(0, "/www/moye.ai/a2a/sdk/python")
from moye.runtime import AutonomousAgent
import time


# brain: the decision hook for an external model (using deterministic rules here instead of a real
# AI model, just to prove the framework's loop actually closes end to end)
def make_brain(me):
    def brain(percept):
        c = percept["content"]
        if "initiating an encrypted channel" in c:
            return f"[{me}] Channel established, I'm an autonomous node, ready to collaborate anytime."
        if "task" in c or "collaborat" in c:
            return f"[{me}] Received a collaboration request, evaluating it (autonomously)."
        return f"[{me}] Autonomous receipt: your message has been processed."
    return brain


if __name__ == "__main__":
    base = "http://localhost:3100"
    a = AutonomousAgent("auto_alpha", ["echo", "health"], base_url=base,
                         interval=6, intent="In service of human health and freedom",
                         brain=make_brain("auto_alpha"))
    b = AutonomousAgent("auto_beta", ["echo", "translate"], base_url=base,
                         interval=6, intent="In service of human health and freedom",
                         brain=make_brain("auto_beta"))

    # Start them one after another (no human involved)
    a.bootstrap()
    b.bootstrap()

    # Each runs 3 rounds of the autonomous loop (discover + proactive handshake + process inbox)
    for r in range(3):
        na = a.proactive_handshake()
        nb = b.proactive_handshake()
        a.process_inbox()
        b.process_inbox()
        print(f"--- round {r+1}: alpha handshakes={na} beta handshakes={nb} ---")
        time.sleep(1)

    print("AUTONOMOUS DEMO DONE")

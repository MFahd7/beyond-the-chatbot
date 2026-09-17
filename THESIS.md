# Two years out: the queue replaces the prompt

**284 words.**

Chat won the first round of AI interfaces because it was the only surface that could accept an
arbitrary intent before anyone knew which intents mattered. That was a scaffolding decision, and we
have started mistaking it for an architecture.

The tell is that a chat window makes the user do the retrieval. It waits for a question that already
contains the shape of its answer, which means the work of noticing — of knowing that #74147 and
#74149 are the same bug, or that 115 reports are pinned to a version nobody ships any more — stays
with the person. That is the expensive half. A model that can answer any question about your backlog
and cannot tell you which question to ask has automated the cheap part.

So the next surface is not conversational, and it is not a dashboard either. A dashboard sorts by
whichever column was easiest to store. The thing that replaces both is a **queue of prepared
decisions**: the system spends the compute to rank what deserves attention, drafts the action, and
asks a human for a verdict rather than a prompt. Interfaces built this way already exist in
high-consequence work — a radiologist's worklist, an air traffic strip, a court docket — and they
all share one property. The unit of interaction is a judgment, not a query.

Two things decide whether this generalises. The first is that autonomy gets gated on
**reversibility** rather than confidence: a system may file on its own and must not speak on its
own, because no accuracy number unsends an email. The second is that rejection becomes the primary
input. A queue earns the right to hide things only if being wrong is cheap, specific and visible.

Chat will not disappear. It becomes the fallback for when the queue is wrong.

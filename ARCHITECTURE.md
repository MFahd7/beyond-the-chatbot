# Architecture

Data → intent inference → surfaced decision → action, in one direction, with no hidden state.

The whole pipeline is a pure function. Given a corpus, a set of weights, an operator model and a
clock, `buildDocket()` returns the same ordered decisions every time — which is what makes the
interface's central claim testable rather than merely confident.

---

## The shape

```
data/corpus.json ──┐
data/weights.json ─┼──► buildDocket(corpus, weights, model, now) ──► { cases, suppressed, stats }
OperatorModel ─────┘                                                        │
       ▲                                                                    ▼
       └────────────── applyFeedback(model, target, verdict, reason) ◄── human verdict
```

`core/` is framework-free and has no imports from `app/`. `app/` has one route and one client
component. The operator model lives in the browser and is posted with each request, so the server
keeps no session state: a serverless instance can be recycled between one keystroke and the next
without the docket disagreeing with what is on screen.

| module | job |
|---|---|
| `core/text.ts` | Strip template scaffolding, code and attachment markup; TF-IDF; cosine; trigrams |
| `core/templates.ts` | Read the repo's bug template back out of a filled-in body |
| `core/signals.ts` | 29 submission-only features; derive the release timeline from the corpus |
| `core/rules.ts` | The stated thresholds, with the measurements that set them |
| `core/cluster.ts` | Duplicate detection over the open backlog |
| `core/intent.ts` | Score the fitted models, fold in the rules, keep the margin |
| `core/attention.ts` | Expected value of attention — the ranking |
| `core/actions.ts` | Draft real GitHub mutations; decide which may apply themselves |
| `core/operator.ts` | Turn a correction into a specific, bounded, visible model edit |
| `core/docket.ts` | Compose everything: judgments, sweeps, and the withheld list |

---

## 1. Data

`scripts/fetch-corpus.mjs` pulls from the GitHub search API, paced to the unauthenticated 10/min
limit and caching every page under `data/raw/` so re-runs are nearly free. Two things come back, and
they serve different purposes:

**The open backlog.** 1,000 issues — the same rows a maintainer sees on the issues page. The API
refuses to page past 1,000 results per query; the repo reports 1,010 open.

**Recorded human decisions.** 3,129 closed issues grouped by what the maintainers actually did,
recovered two ways:

- The repo's own triage labels: `please add a complete reproduction` (838 exist), `please verify
  canary` (393), `stale` (1,628), `linear: next` / `linear: turbopack` (880). These are not
  decoration. Each is a decision a person made.
- GitHub's close reason: `completed` vs `not planned`, drawn 200-per-year for 2022–2026.

The second set exists because the first has a problem, described next.

---

## 2. The confound that shapes everything downstream

Label usage in this repository is **stratified by time**, because the team's process changed:
`please add a complete reproduction` is mostly 2022–23, the `stale` sweeps happened in 2024,
`linear:` routing began in 2024, and anything closed this year is still being worked.

Sample each label by "most recent N" and the classes come back almost temporally *disjoint*:

| class | creation years |
|---|---|
| `verify_canary` | 2021: 169, 2022: 98, 2023: 30, 2024: 3 |
| `needs_repro` | 2022: 182, 2023: 156, 2024: 32 |
| `stale_close` | 2023: 52, **2024: 334**, 2025: 14 |
| `accepted_route` | 2024: 177, 2025: 204, 2026: 19 |

At that point the fastest way for a classifier to separate them is to read the calendar off the
version number. It would score beautifully in cross-validation and then predict one class for
everything on a current backlog, which is mostly Next 16. Two defences, both load-bearing:

**Year-matched sampling.** Negatives are drawn following the positives' own year distribution, and
each year contributes equally many positives and negatives. A year with positives but no available
negatives is dropped entirely rather than left lopsided — an unmatched year is exactly the hole
through which era leaks back in. Knowing the year then tells the model nothing about the label.

**Era-invariant features.** Version lag is measured against the release line current *at filing*,
not against today, so a reporter who was up to date in 2022 and one who is up to date now produce
the same number. `tests/leakage.spec.ts` asserts this directly. The release timeline is derived from
the corpus itself — the first date each version appears in a report is a good proxy for when it
shipped — rather than from a hardcoded changelog that would go stale.

`repro.field_absent` exists for the same reason: two template generations are in circulation and the
older one has no reproduction field at all, so scoring it as "reproduction missing" would measure
the template's age instead of the reporter's effort. The signal absorbs the generation so it cannot
masquerade as effort.

---

## 3. Signals, and the rule that keeps them honest

Every one of the 29 fitted features is a property of the **submission** — what the reporter typed,
in the state they left it. Excluded deliberately: labels (they *are* the training target), comment
count, reactions, assignees, milestone, close reason, and age.

Age is the tempting one, because "this is eight months old" is obviously relevant to whether an
issue is going nowhere. It is excluded anyway: for a closed issue the elapsed time is final, for an
open one it is a lower bound that grows while you look at it, and fitting across the two teaches the
model about censoring rather than about bug reports.

Those same fields are exactly right for **ranking**, which makes no historical prediction. So they
appear in `core/attention.ts` and nowhere else. Prediction and prioritisation are different jobs and
they get different inputs.

Signals carry `value` and `confidence` separately. "This issue has no reproduction link" is an
almost certain observation; "the reporter ticked the verified-on-canary box" is certain as an
observation and unreliable as a claim, so it is scored at 0.55 confidence. Every signal must cite
something real in its `evidence` — a number, a substring, an issue number. Anything that cannot cite
itself does not get to be a signal, which is what makes the evidence panel checkable.

The highest-value structure in the corpus is the template itself: it is a form, people fill it in
badly, and the *specific way* they fill it in badly is what decides the outcome. The sharpest single
signal is a reproduction link that is the template's **own placeholder**, pasted back unchanged —
rare (2% of reports) but nearly conclusive, and a thing maintainers catch by hand today.

---

## 4. Intent: three sources, never blurred

| source | decisions | reported as |
|---|---|---|
| Fitted models | `needs_repro`, `accepted_route` | a probability, with held-out AUC |
| Stated rules | `stale_close`, `verify_canary` | the threshold that fired |
| Clustering | `dedupe` | cohesion, and no accuracy claim at all |

Every card is stamped with which one produced it. A fitted model, a crossed threshold and an
unsupervised cluster are three different kinds of claim, and a system that presents them identically
is lending its measured credibility to the parts that have none.

Rule strengths are not probabilities and are not pretended to be: they enter the comparison at a
0.82 discount, because a threshold being crossed is weaker evidence about what to do than a model
measured against several hundred real decisions.

The output is not a label but a label **plus the margin to the runner-up**, because the margin is
what decides how the interface behaves. A wide margin earns a prepared action that may apply itself;
a narrow one earns a visible hedge and nothing happens without a keystroke. Two decisions at 0.8
confidence are not equally safe if one of them has something else sitting at 0.79.

Below a 0.42 confidence floor the honest output is "no decision reached the bar" — recorded in the
withheld list, not quietly dropped.

---

## 5. The decision: judgments and sweeps

The distinction that makes the interface work, and it was not in the first version. See the README
for the 694-cases story. In short: a judgment depends on the specific issue and gets a card; a sweep
is the same keystroke applied 115 times and gets one card reviewed by sampling.

A sweep card names its rule, its count, a spot-check sample ordered by engagement, and — importantly
— **the fitted signals that selected its members**, with how many members each drove ("Gave steps to
reproduce — drove 114 of 116 members"). Without that last part a sweep had nothing to distrust: its
only evidence rows were `sweep.size` and `sweep.agreement`, which describe the grouping rather than
the reasoning, so rejecting a 55-issue sweep as misread would record an adjustment against two ids
that feed nothing. A correction that silently does nothing is worse than no correction, because the
operator believes they have taught the system something.

Routing sweeps are grouped by the area the reporters declared, with areas under 8 members pooled by
owning team, so every routable issue lands in exactly one sweep.

---

## 6. Ranking

```
ev = impact × confidence × urgency × reversibility-discount × dead-end-discount / effort
```

Each term is computed from the corpus and printed on the card, so a bad ordering can be argued with
in the units that produced it rather than dismissed as "the algorithm".

- **impact** — reactions ×2 plus comments *capped at 25 per issue*. A thread with 300 comments is
  not 300 people affected; it is four people disagreeing at length. A reaction is the closest thing
  an issue tracker has to a headcount: one person with nothing to add saying "this is happening to
  me too".
- **urgency** — kind-specific and asymmetric. A duplicate set still being filed into decays upward;
  a stale close does not decay at all, which is precisely why it should never outrank anything. An
  ask for a reproduction is worth more while the reporter still remembers the bug.
- **reversibility** — a draft scores as its least reversible mutation, and the discount runs from
  ×1.0 (labels) down to ×0.67 (anything that posts a comment). It was added because the first
  docket ranked "ask 115 reporters to retest" purely on reach, without noticing that approving it
  emails 115 strangers. The discount is deliberately a discount and not a veto: that sweep still
  ranks second, because 115 reports against stale versions really is a lot of reach. An earlier
  version also hardcoded sweep reversibility at 0.6, rating 115 comments as safer than one; sweeps
  are now scored from their mutations like everything else.
- **dead-end discount** — bounded at 35%, because the resolution model is AUC 0.698 and a 0.698
  model should not be allowed to bury anything outright.

**Timed actions come first.** A card holding an action that will apply itself is placed above
everything else, whatever its score. A 45-second countdown the operator never scrolls to is not a
review, so the one card that can act without a keystroke is the one guaranteed to be seen.

One formula, used everywhere. An earlier version computed the sweep score inline, which quietly
exempted sweeps from the urgency, dead-end and reversibility terms that individual cases were
subject to.

---

## 7. Action, and the limit on autonomy

Mutations are described as the REST call they become, in full, because that is the only version an
operator can check. "Label as needs-repro" is a promise about behaviour; `POST
/repos/vercel/next.js/issues/92888/labels {"labels":["please add a complete reproduction"]}` is the
behaviour.

Reversibility is assigned per mutation kind — label 0.97, close 0.85, comment **0.40** — and a draft
is capped at its worst. The comment number is low because a comment reaches the inbox of everyone
subscribed to the issue the instant it posts, and deleting it does not unsend the mail.

Autonomy is gated on that number and not on confidence. `Mutation.stage` is `auto` only for labels
on cases the model scores above 0.70; comments and closes are always `review`. The result is that
**the system files on its own and leaves the talking to a human** — and the 45-second countdown
exists so the operator can watch it happen and stop it.

---

## 8. Correction

`applyFeedback` takes a deliberately narrow `FeedbackTarget` — id, kind, drivers, temporal signals,
areas — rather than a whole `Case`. An earlier version took the full object, which meant the browser
had to fabricate one out of the trimmed payload it actually had, complete with invented timestamps,
just to make the call.

Five reject reasons, each editing a different part of the model; see the README table. Constraints:

- Multipliers clamp to [0.1, 2.0], so one bad afternoon cannot erase a model.
- Approval nudges (×1.06); rejection shoves (×0.55). Someone clearing a queue is weaker evidence
  than someone stopping to object.
- Only the top three drivers of a decision are touched. Distrusting all 29 signals because one
  verdict was wrong would teach the model nothing and destroy it quickly.
- Every edit is recorded with its before and after value, so the interface can show what it changed
  instead of silently becoming a different system.

---

## What we did not fix

**Clustering has no ground truth.** Ten of twelve clusters are genuine duplicates on manual
inspection. The two that are not are related-but-distinct bugs that share vocabulary — `[SRI]
integrity missing for client chunks` / `for stylesheets`, and two server-action reports — and the
SRI pair is left in the demo on purpose, since it illustrates exactly what similarity gets wrong.
A further two clusters fall below the 0.42 confidence floor on cohesion alone and are withheld, so
the docket shows 10 of the 12. The honest fix is comment
threads, which the search API will not return.

**The resolution model is weak.** AUC 0.698 on a 0.50 baseline. Predicting whether a bug report
leads to a fix from its text alone is genuinely hard, and it is used only to rank.

**Sweep confidence is a mean.** A sweep of 116 members with mean confidence 0.62 spans 0.42 to 0.89.
The card shows the range and the automatic subset is selected per member, but a single number on the
meter is still a simplification.

**Effort is estimated, not measured.** The minutes-per-decision table is a considered guess. Real
numbers would need instrumentation on a real triage team.

**Version lines are inferred from reports, not releases.** A version reported by fewer than three
people is treated as a typo rather than a release. It is a good proxy and it is still a proxy.

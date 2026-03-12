# DebateGuard Demo Script (3:45)

Use this as a literal run-of-show and talk track.

## 0:00-0:20 Problem
**Say:**
"Debate practice tools usually miss delivery feedback and factual reliability in real time. DebateGuard is a live debate coach that listens to speech, analyzes delivery locally from webcam landmarks, and issues grounded corrections for high-confidence factual errors."

**Show:**
- DebateGuard home screen on deployed Cloud Run URL.
- Panels visible: setup, transcript, fact-check alerts, delivery metrics, round report, session history.

## 0:20-0:45 Live setup
**Say:**
"I’ll run one live round with Gemini over voice. The webcam analysis is local in-browser; only aggregate metrics and sparse JPEG context are sent."

**Show / Click:**
1. Topic: `Should governments regulate AI models more strictly?`
2. Stance: `Pro`
3. Difficulty: `Medium`
4. Round length: `120 sec`
5. Enable `Demo mode` toggle (deterministic seeded false-stat path).
6. `Enable Mic + Webcam`
7. `Start Round`

## 0:45-1:45 Debate round
**Say while speaking naturally:**
- Opening claim and supporting points.
- Short rebuttal when model responds.

**Show:**
- Live transcript updating (`partial` then `final`).
- Model audio playback returning from backend.
- One user interruption (barge-in) while model is speaking.

## 1:45-2:20 Seeded false statistic
**Say exactly (seeded demo claim):**
"Ninety percent of social media users are bots, according to recent statistics."

**Show:**
- Keep speaking for a few seconds so the segment finalizes.

## 2:20-2:45 Live correction
**Say:**
"DebateGuard only interrupts for high-confidence, narrow factual classes and at most once per round."

**Show:**
- `factcheck.alert` appears with:
  - verdict
  - corrected fact
  - confidence
  - citation links

## 2:45-3:20 Round-end rubric
**Click:** `Stop Round`

**Say:**
"At round end, DebateGuard generates a strict rubric from transcript, fact-check results, and aggregate delivery metrics."

**Show:**
- Score cards: argument strength, evidence quality, responsiveness, delivery, factual accuracy.
- Top strengths / top issues.
- Cited corrections with links.
- Next drills.
- Copy/download summary actions.
- Session history panel updated with the new round.

## 3:20-3:40 Cloud proof cutaway
**Say:**
"Here is proof this is running on Google Cloud with persistence."

**Show:**
1. Cloud Run service page (URL + latest revision).
2. Cloud Run logs from current minute.
3. Firestore collections with new docs in:
   - `sessions`
   - `rounds`
   - `claims`
   - `reports`

## 3:40-3:45 Close
**Say:**
"DebateGuard delivers a real multimodal Live Agent: voice debate, local delivery coaching, grounded fact-checking, and cloud-backed round reporting."

## Backup if latency spikes
- Keep the same flow but shorten spoken turns.
- Ensure the seeded false statistic line is still spoken exactly so correction can trigger in demo mode.

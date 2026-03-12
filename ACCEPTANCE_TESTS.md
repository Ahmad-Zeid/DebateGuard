# Acceptance tests for DebateGuard

## Must pass before submission
1. Local dev starts successfully
2. Cloud Run deploy works from script or Terraform
3. User can grant mic/webcam permission and start a round
4. User speech is transcribed
5. Gemini responds with live audio
6. User can interrupt Gemini mid-response
7. Webcam metrics update in UI
8. One seeded false factual claim triggers a grounded correction in demo mode
9. End-of-round report appears with rubric and citations
10. Sessions and reports persist to Firestore
11. README reproduces the app from a clean machine
12. Architecture diagram exists in docs and is referenced in README
13. Demo script exists and fits a <4 minute recording
14. No raw video is stored by default
15. Errors are surfaced cleanly in UI and logs

## Stretch tests
- session reconnect handling
- multiple rounds per session
- memory/personalization across sessions
- Terraform one-command deploy
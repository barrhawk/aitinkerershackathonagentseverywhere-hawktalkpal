# Latency — end of speech to first sound

Filled in from measured runs only. A number appears here only if it was timed both before and after the change on the same setup; anything else is marked "not measured".

## What is measured

- **Turn latency**: release of the orb (or endpointer close on the wake-word path) to the first audible sample of the reply, as recorded by the page's per-turn clock (`last turn ms` in the stat strip).
- **Stage split** (where the stack exposes it): speech upload + transcription, model time to first token/audio, speech synthesis, playback start.

## Method

- Device: the phone used for the demo, Chrome on Android, same network for before and after.
- Same short utterance for every run; at least 3 turns per row, report the median.
- Stage timings: page console timestamps, and for server-side legs `curl -w '%{time_starttransfer} %{time_total}'` against the same endpoint with the same clip.
- OpenAI Realtime is measured with server VAD, so its clock starts at VAD end of speech rather than orb release; noted per row.

## Results

| Stack | Change | Before (ms) | After (ms) | Runs | Measured on | Notes |
|---|---|---|---|---|---|---|
| HawkTalk | | | | | | |
| HawkTalk ears + CopilotKit | | | | | | |
| OpenAI Realtime | | | | | | |

## Stage breakdown

| Stack | Stage | Before (ms) | After (ms) | Notes |
|---|---|---|---|---|
| | | | | |

## Not applied / not measured

- 

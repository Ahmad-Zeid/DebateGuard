import { describe, expect, it } from "vitest";

import { DeliveryMetricsAggregator } from "../src/services/analytics/deliveryAggregator";
import { countFillerWords, fillerWordDensity } from "../src/services/analytics/fillerWords";

describe("fillerWords", () => {
  it("counts common filler phrases", () => {
    const text = "Um, I mean, you know, this is basically kind of important.";
    expect(countFillerWords(text)).toBeGreaterThanOrEqual(4);
    expect(fillerWordDensity(text)).toBeGreaterThan(0);
  });
});

describe("DeliveryMetricsAggregator", () => {
  it("computes bounded metric snapshot", () => {
    const aggregator = new DeliveryMetricsAggregator();
    aggregator.reset(0);

    aggregator.ingestMediaPipeSignals({
      tsMs: 100,
      eyeContactProxy: 0.8,
      yawNormalized: 0.25,
      headRollDeg: 5,
      headPitchDeg: 3,
      shoulderTiltDeg: 4,
      slouchProxy: 0.2,
      faceTracked: true,
      poseTracked: true,
    });

    aggregator.ingestMediaPipeSignals({
      tsMs: 700,
      eyeContactProxy: 0.7,
      yawNormalized: -0.28,
      headRollDeg: -4,
      headPitchDeg: -2,
      shoulderTiltDeg: -5,
      slouchProxy: 0.3,
      faceTracked: true,
      poseTracked: true,
    });

    // Speaking chunk then pause to generate speaking pace and pause length.
    aggregator.ingestAudioChunk({ rms: 0.04, durationMs: 40, tsMs: 110 });
    aggregator.ingestAudioChunk({ rms: 0.01, durationMs: 40, tsMs: 150 });
    aggregator.ingestAudioChunk({ rms: 0.01, durationMs: 40, tsMs: 190 });
    aggregator.ingestAudioChunk({ rms: 0.05, durationMs: 40, tsMs: 230 });

    aggregator.ingestUserTranscript("I think this is, um, a reasonable policy proposal.");

    const snapshot = aggregator.snapshot(1500);

    expect(snapshot.eyeContactProxy).toBeGreaterThanOrEqual(0);
    expect(snapshot.eyeContactProxy).toBeLessThanOrEqual(1);
    expect(snapshot.headTurnFrequencyPerMin).toBeGreaterThanOrEqual(0);
    expect(snapshot.shoulderTiltProxy).toBeGreaterThanOrEqual(0);
    expect(snapshot.shoulderTiltProxy).toBeLessThanOrEqual(1);
    expect(snapshot.slouchProxy).toBeGreaterThanOrEqual(0);
    expect(snapshot.slouchProxy).toBeLessThanOrEqual(1);
    expect(snapshot.speakingPaceWpm).toBeGreaterThan(0);
    expect(snapshot.averagePauseLengthSec).toBeGreaterThanOrEqual(0);
    expect(snapshot.fillerWordDensity).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { syncSettingsFromEnv } from "@/lib/trendSync/config";

describe("syncSettingsFromEnv", () => {
  it("uses the documented defaults", () => {
    expect(syncSettingsFromEnv({})).toEqual({
      trafficFloor: 1000,
      intervalMinutes: 30,
    });
  });

  it("reads every setting from the env", () => {
    const settings = syncSettingsFromEnv({
      TREND_TRAFFIC_FLOOR: "0",
      SYNC_INTERVAL_MINUTES: "10",
    });
    expect(settings).toEqual({
      trafficFloor: 0,
      intervalMinutes: 10,
    });
  });

  it("treats blank values as unset", () => {
    expect(syncSettingsFromEnv({ TREND_TRAFFIC_FLOOR: "  " }).trafficFloor).toBe(1000);
  });

  it("names the bad setting instead of silently falling back", () => {
    expect(() => syncSettingsFromEnv({ TREND_TRAFFIC_FLOOR: "lots" })).toThrow(/TREND_TRAFFIC_FLOOR/);
    expect(() => syncSettingsFromEnv({ SYNC_INTERVAL_MINUTES: "0" })).toThrow(/SYNC_INTERVAL_MINUTES/);
  });
});

import { describe, expect, it } from "vitest";
import { syncSettingsFromEnv } from "@/lib/trendSync/config";

describe("syncSettingsFromEnv", () => {
  it("uses the documented defaults", () => {
    expect(syncSettingsFromEnv({})).toEqual({
      trafficFloor: 1000,
      refreshMinHours: 6,
      maxNewStories: 3,
      maxRefreshes: 5,
      intervalMinutes: 30,
    });
  });

  it("reads every setting from the env", () => {
    const settings = syncSettingsFromEnv({
      TREND_TRAFFIC_FLOOR: "0",
      REFRESH_MIN_HOURS: "1.5",
      MAX_NEW_STORIES_PER_CYCLE: "0",
      MAX_REFRESHES_PER_CYCLE: "2",
      SYNC_INTERVAL_MINUTES: "10",
    });
    expect(settings).toEqual({
      trafficFloor: 0,
      refreshMinHours: 1.5,
      maxNewStories: 0,
      maxRefreshes: 2,
      intervalMinutes: 10,
    });
  });

  it("treats blank values as unset", () => {
    expect(syncSettingsFromEnv({ TREND_TRAFFIC_FLOOR: "  " }).trafficFloor).toBe(1000);
  });

  it("names the bad setting instead of silently falling back", () => {
    expect(() => syncSettingsFromEnv({ TREND_TRAFFIC_FLOOR: "lots" })).toThrow(/TREND_TRAFFIC_FLOOR/);
    expect(() => syncSettingsFromEnv({ MAX_NEW_STORIES_PER_CYCLE: "-1" })).toThrow(/MAX_NEW_STORIES_PER_CYCLE/);
    expect(() => syncSettingsFromEnv({ MAX_REFRESHES_PER_CYCLE: "2.5" })).toThrow(/MAX_REFRESHES_PER_CYCLE/);
    expect(() => syncSettingsFromEnv({ SYNC_INTERVAL_MINUTES: "0" })).toThrow(/SYNC_INTERVAL_MINUTES/);
    expect(() => syncSettingsFromEnv({ REFRESH_MIN_HOURS: "-2" })).toThrow(/REFRESH_MIN_HOURS/);
  });
});

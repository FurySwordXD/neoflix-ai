/**
 * Settings for the trend sync worker. Unlike the request-path settings,
 * a bad value here is a config error the worker refuses to start with,
 * rather than something it quietly replaces with a default.
 */

type Env = Record<string, string | undefined>;

export interface SyncSettings {
  /** TREND_TRAFFIC_FLOOR: least TRENDED.traffic_value a topic needs. 0 also admits unknown traffic. */
  trafficFloor: number;
  /** REFRESH_MIN_HOURS: a matching story younger than this is only linked, not refreshed. */
  refreshMinHours: number;
  /** MAX_NEW_STORIES_PER_CYCLE */
  maxNewStories: number;
  /** MAX_REFRESHES_PER_CYCLE */
  maxRefreshes: number;
  /** SYNC_INTERVAL_MINUTES: pause between cycles with --loop. */
  intervalMinutes: number;
}

const DEFAULTS: SyncSettings = {
  trafficFloor: 1000,
  refreshMinHours: 6,
  maxNewStories: 3,
  maxRefreshes: 5,
  intervalMinutes: 30,
};

type Rule = "wholeAtLeastZero" | "positive";

function readNumber(env: Env, name: string, fallback: number, rule: Rule): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  const valid = rule === "positive" ? Number.isFinite(value) && value > 0 : Number.isInteger(value) && value >= 0;
  if (!valid) {
    const expected = rule === "positive" ? "a number above 0" : "a whole number of 0 or more";
    throw new Error(`Invalid ${name}: "${raw}" (expected ${expected}).`);
  }
  return value;
}

export function syncSettingsFromEnv(env: Env = process.env): SyncSettings {
  return {
    trafficFloor: readNumber(env, "TREND_TRAFFIC_FLOOR", DEFAULTS.trafficFloor, "wholeAtLeastZero"),
    refreshMinHours: readNumber(env, "REFRESH_MIN_HOURS", DEFAULTS.refreshMinHours, "positive"),
    maxNewStories: readNumber(env, "MAX_NEW_STORIES_PER_CYCLE", DEFAULTS.maxNewStories, "wholeAtLeastZero"),
    maxRefreshes: readNumber(env, "MAX_REFRESHES_PER_CYCLE", DEFAULTS.maxRefreshes, "wholeAtLeastZero"),
    intervalMinutes: readNumber(env, "SYNC_INTERVAL_MINUTES", DEFAULTS.intervalMinutes, "positive"),
  };
}

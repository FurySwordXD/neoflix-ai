/**
 * Google Trends geo codes (ISO 3166-1 alpha-2, sometimes with a sub-region
 * suffix like "US-CA") mapped onto the dashboard's region vocabulary in
 * recommend.ts. Codes missing from the table are left out, not guessed.
 */

type Region = "africa" | "americas" | "asia" | "europe" | "mena";

const REGION_CODES: Record<Region, string[]> = {
  americas: [
    "US", "CA", "MX", "BR", "AR", "CL", "CO", "PE", "VE", "EC", "BO", "PY", "UY",
    "CR", "PA", "GT", "HN", "SV", "NI", "CU", "DO", "PR", "JM", "HT", "TT",
  ],
  europe: [
    "GB", "IE", "FR", "DE", "IT", "ES", "PT", "NL", "BE", "LU", "CH", "AT", "DK",
    "SE", "NO", "FI", "IS", "PL", "CZ", "SK", "HU", "RO", "BG", "GR", "HR", "SI",
    "RS", "BA", "ME", "MK", "AL", "EE", "LV", "LT", "UA", "BY", "MD", "RU", "TR",
  ],
  mena: [
    "IL", "PS", "SA", "AE", "QA", "KW", "BH", "OM", "YE", "IQ", "IR", "JO", "LB",
    "SY", "EG", "LY", "TN", "DZ", "MA",
  ],
  africa: [
    "NG", "ZA", "KE", "GH", "ET", "TZ", "UG", "RW", "SN", "CI", "CM", "CD", "AO",
    "MZ", "ZW", "ZM", "BW", "NA", "SD", "SS", "SO", "ML", "NE", "BF",
  ],
  asia: [
    "JP", "CN", "HK", "TW", "KR", "IN", "PK", "BD", "LK", "NP", "ID", "PH", "VN",
    "TH", "MY", "SG", "MM", "KH", "KZ", "UZ", "AU", "NZ",
  ],
};

const REGION_BY_CODE: ReadonlyMap<string, Region> = new Map(
  (Object.entries(REGION_CODES) as Array<[Region, string[]]>).flatMap(([region, codes]) =>
    codes.map((code) => [code, region] as const)
  )
);

/** Distinct regions for these geo codes, in first-seen order. */
export function regionsForGeos(codes: readonly string[]): string[] {
  const regions = codes
    .map((code) => REGION_BY_CODE.get(code.trim().toUpperCase().split("-")[0]))
    .filter((region): region is Region => region !== undefined);
  return [...new Set(regions)];
}

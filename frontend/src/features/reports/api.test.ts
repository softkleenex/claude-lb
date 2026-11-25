import { describe, expect, it } from "vitest";

import { reportCsvUrl, reportQuery } from "./api";
import type { ReportFilters } from "./schemas";

const FILTERS: ReportFilters = {
  start: "2026-01-01",
  end: "2026-01-07",
  groupBy: "api_key",
  accountIds: ["acc_a", "acc_b"],
  apiKeyIds: ["key_1"],
  models: ["claude-opus-5-5"],
  userAgents: ["claude-cli"],
};

describe("report query", () => {
  it("sends snake_case repeated params the backend reads", () => {
    const query = reportQuery(FILTERS);
    expect(query.get("start")).toBe("2026-01-01");
    expect(query.get("group_by")).toBe("api_key");
    expect(query.getAll("account_id")).toEqual(["acc_a", "acc_b"]);
    expect(query.getAll("api_key_id")).toEqual(["key_1"]);
    expect(query.getAll("model")).toEqual(["claude-opus-5-5"]);
    expect(query.getAll("user_agent")).toEqual(["claude-cli"]);
  });

  it("points the CSV export at the server endpoint with the same filters", () => {
    expect(reportCsvUrl(FILTERS)).toBe(`/api/usage/report.csv?${reportQuery(FILTERS).toString()}`);
  });
});

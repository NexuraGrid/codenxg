import { describe, expect, it } from "vitest";
import { relativeTime } from "../relativeTime";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const secondsAgo = (s: number) => NOW / 1000 - s;

describe("relativeTime", () => {
  it("rounds to the largest fitting unit", () => {
    expect(relativeTime(secondsAgo(30), NOW)).toBe("just now");
    expect(relativeTime(secondsAgo(5 * 60), NOW)).toBe("5 minutes ago");
    expect(relativeTime(secondsAgo(3 * 3600), NOW)).toBe("3 hours ago");
    expect(relativeTime(secondsAgo(86_400), NOW)).toBe("yesterday");
    expect(relativeTime(secondsAgo(400 * 86_400), NOW)).toBe("last year");
  });
});

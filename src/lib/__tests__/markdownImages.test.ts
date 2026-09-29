import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readImageData = vi.hoisted(() => vi.fn());
vi.mock("../tauri-api", () => ({ readImageData }));

const { acquireLocalImage, imageMime, releaseLocalImage, resolveImageSource } = await import("../markdownImages");

const md = "/w/docs/guide/README.md";

describe("resolveImageSource", () => {
  it("resolves relative paths against the Markdown file's folder", () => {
    expect(resolveImageSource("img/a.png", md, "/w")).toEqual({ kind: "local", path: "/w/docs/guide/img/a.png", mime: "image/png" });
    expect(resolveImageSource("./../b.SVG?raw#x", md, "/w")).toEqual({ kind: "local", path: "/w/docs/b.SVG", mime: "image/svg+xml" });
    expect(resolveImageSource("my%20shot.jpg", md, "/w")).toMatchObject({ path: "/w/docs/guide/my shot.jpg", mime: "image/jpeg" });
  });

  it("takes a leading slash from the workspace root", () => {
    expect(resolveImageSource("/assets/logo.webp", md, "/w")).toMatchObject({ path: "/w/assets/logo.webp" });
    expect(resolveImageSource("/w/assets/logo.webp", md, "/w")).toMatchObject({ path: "/w/assets/logo.webp" });
  });

  it("leaves containment to the Rust side but still normalizes traversal", () => {
    expect(resolveImageSource("../../../../etc/x.png", md, "/w")).toMatchObject({ path: "/etc/x.png" });
  });

  it("handles Windows paths", () => {
    expect(resolveImageSource("..\\img\\a.gif", "C:\\w\\docs\\README.md", "C:\\w")).toMatchObject({ path: "C:\\w\\img\\a.gif" });
    expect(resolveImageSource("/img/a.gif", "C:\\w\\docs\\README.md", "C:\\w")).toMatchObject({ path: "C:\\w\\img\\a.gif" });
  });

  it("lets https and data: images through as URLs", () => {
    expect(resolveImageSource("https://x.dev/a.png", md, "/w")).toEqual({ kind: "url", url: "https://x.dev/a.png" });
    expect(resolveImageSource("data:image/png;base64,AAA", md, "/w")).toMatchObject({ kind: "url" });
  });

  it("refuses other schemes and non-image files", () => {
    for (const src of ["http://x.dev/a.png", "file:///etc/a.png", "javascript:alert(1)", "data:text/html,x", "notes.txt", "", "  "]) {
      expect(resolveImageSource(src, md, "/w")).toBeNull();
    }
    expect(imageMime("a.tar.gz")).toBeUndefined();
  });
});

describe("local image cache", () => {
  const created: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    readImageData.mockReset();
    readImageData.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    created.length = 0;
    revoked.length = 0;
    URL.createObjectURL = vi.fn(() => {
      created.push(`blob:${created.length}`);
      return created[created.length - 1];
    });
    URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  });
  afterEach(() => vi.useRealTimers());

  it("shares one read per path and revokes after the last release", async () => {
    const a = await acquireLocalImage("/w/a.png", "image/png");
    const b = await acquireLocalImage("/w/a.png", "image/png");
    expect(a).toBe(b);
    expect(readImageData).toHaveBeenCalledTimes(1);

    releaseLocalImage("/w/a.png");
    releaseLocalImage("/w/a.png");
    // A remount within the grace period reuses it.
    await acquireLocalImage("/w/a.png", "image/png");
    releaseLocalImage("/w/a.png");
    await vi.runAllTimersAsync();
    expect(revoked).toEqual([a]);
    expect(readImageData).toHaveBeenCalledTimes(1);
  });

  it("doesn't cache a failed read", async () => {
    readImageData.mockRejectedValueOnce("Image is outside the workspace");
    await expect(acquireLocalImage("/w/b.png", "image/png")).rejects.toBe("Image is outside the workspace");
    releaseLocalImage("/w/b.png");
    await expect(acquireLocalImage("/w/b.png", "image/png")).resolves.toMatch(/^blob:/);
    expect(readImageData).toHaveBeenCalledTimes(2);
  });
});

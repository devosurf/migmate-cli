import { execFileSync } from "node:child_process";
import { release } from "node:os";

/** Distribution and capture agree on the actual native cell and approved macOS floor. */
export function distributionPlatform(): { cell: string; osVersion: string } {
  const cell = `${process.platform}-${process.arch}`;
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("The distribution requires darwin or linux on arm64 or x64.");
  }
  let osVersion = release();
  if (process.platform === "darwin") {
    osVersion = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(osVersion);
    if (!match || Number(match[1]) < 13 || (Number(match[1]) === 13 && Number(match[2]) < 5)) {
      throw new Error("The Node 24 distribution requires macOS 13.5 or newer.");
    }
  }
  return { cell, osVersion };
}

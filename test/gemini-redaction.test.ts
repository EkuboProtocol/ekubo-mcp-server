import { expect, test } from "bun:test";

test("Gemini harness redacts synthetic keys in reports and console output", () => {
  const result = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-B",
      "-m",
      "unittest",
      "discover",
      "-s",
      "script",
      "-p",
      "test_gemini_redaction.py",
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

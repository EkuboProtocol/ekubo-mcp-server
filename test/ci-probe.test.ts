import { expect, test } from "bun:test";

test("deliberate failure", () => {
  expect(1).toBe(2);
});

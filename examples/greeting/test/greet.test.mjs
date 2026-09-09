import assert from "node:assert/strict";
import { test } from "node:test";
import { greet } from "../src/greet.mjs";

test("greets an ordinary name", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});

test("trims surrounding whitespace", () => {
  assert.equal(greet("  Ada  "), "Hello, Ada!");
});

test("uses world for blank or missing names", () => {
  for (const name of ["", "   ", undefined]) {
    assert.equal(greet(name), "Hello, world!");
  }
});

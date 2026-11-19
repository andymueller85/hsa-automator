import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_CATEGORIES,
  DOC_TYPES,
  isClaimCategory,
  isSupportedDocType,
} from "./types.js";

describe("types & type guards", () => {
  test("validates supported document types", () => {
    for (const dt of DOC_TYPES) {
      assert.equal(isSupportedDocType(dt), true);
    }
    assert.equal(isSupportedDocType("UNKNOWN_DOC"), false);
  });

  test("validates claim categories", () => {
    for (const cat of CLAIM_CATEGORIES) {
      assert.equal(isClaimCategory(cat), true);
    }
    assert.equal(isClaimCategory("Cosmetic"), false);
  });
});

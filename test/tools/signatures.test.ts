import { describe, it, expect } from "vitest";
import signatureTools from "../../src/tools/signatures.js";

describe("Signature Tools", () => {
  describe("get_function_signature", () => {
    it("should generate correct signature for transfer function", async () => {
      const result = await signatureTools.get_function_signature.handler({
        items: [{ functionAbi: "function transfer(address to, uint256 amount)" }],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].signature).toBe("0xa9059cbb");
      expect(data[0].functionName).toBe("transfer");
      expect(data[0].inputs).toHaveLength(2);
    });

    it("should handle multiple function signatures in batch", async () => {
      const result = await signatureTools.get_function_signature.handler({
        items: [
          { functionAbi: "function balanceOf(address owner) view returns (uint256)" },
          { functionAbi: "function totalSupply() view returns (uint256)" },
          { functionAbi: "function name() view returns (string)" },
        ],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(3);
      expect(data[0].signature).toBe("0x70a08231"); // balanceOf
      expect(data[0].functionName).toBe("balanceOf");
      expect(data[1].functionName).toBe("totalSupply");
      expect(data[2].functionName).toBe("name");
    });

    it("should include state mutability information", async () => {
      const result = await signatureTools.get_function_signature.handler({
        items: [{ functionAbi: "function getValue() view returns (uint256)" }],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data[0].stateMutability).toBe("view");
    });
  });

  describe("get_event_signature", () => {
    it("should generate correct topic0 for Transfer event", async () => {
      const result = await signatureTools.get_event_signature.handler({
        items: [
          { eventAbi: "event Transfer(address indexed from, address indexed to, uint256 value)" },
        ],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].topic0).toBe(
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
      );
      expect(data[0].eventName).toBe("Transfer");
    });

    it("should handle multiple events in batch", async () => {
      const result = await signatureTools.get_event_signature.handler({
        items: [
          { eventAbi: "event Transfer(address indexed from, address indexed to, uint256 value)" },
          {
            eventAbi:
              "event Approval(address indexed owner, address indexed spender, uint256 value)",
          },
        ],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(2);
      expect(data[0].eventName).toBe("Transfer");
      expect(data[1].eventName).toBe("Approval");
    });

    it("should include indexed parameter information", async () => {
      const result = await signatureTools.get_event_signature.handler({
        items: [
          { eventAbi: "event Transfer(address indexed from, address indexed to, uint256 value)" },
        ],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data[0].inputs).toHaveLength(3);
      expect(data[0].inputs[0].indexed).toBe(true);
      expect(data[0].inputs[1].indexed).toBe(true);
      // Some parsers omit the `indexed` property for non-indexed params -> treat undefined as false
      expect(data[0].inputs[2].indexed ?? false).toBe(false);
    });
  });

  describe("get_error_signature", () => {
    it("should generate correct signature for custom error", async () => {
      const result = await signatureTools.get_error_signature.handler({
        items: [{ errorAbi: "error InsufficientBalance(uint256 available, uint256 required)" }],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].signature).toMatch(/^0x[a-f0-9]{8}$/);
      expect(data[0].errorName).toBe("InsufficientBalance");
      expect(data[0].inputs).toHaveLength(2);
    });

    it("should handle multiple errors in batch", async () => {
      const result = await signatureTools.get_error_signature.handler({
        items: [
          { errorAbi: "error InsufficientBalance(uint256 available, uint256 required)" },
          { errorAbi: "error Unauthorized()" },
          { errorAbi: "error InvalidAddress(address addr)" },
        ],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(3);
      expect(data[0].errorName).toBe("InsufficientBalance");
      expect(data[1].errorName).toBe("Unauthorized");
      expect(data[2].errorName).toBe("InvalidAddress");
    });

    it("should handle errors with no parameters", async () => {
      const result = await signatureTools.get_error_signature.handler({
        items: [{ errorAbi: "error Unauthorized()" }],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data[0].inputs).toHaveLength(0);
    });
  });
});

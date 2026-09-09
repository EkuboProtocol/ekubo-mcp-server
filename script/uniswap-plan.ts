/** Local producer for testing the same handlers registered over MCP.
 * Usage: echo '{"tool":"...","input":{...}}' | bun script/uniswap-plan.ts
 * Emits digest-checked inline wallet artifacts; never signs or submits.
 */
import { keccak256, stringToHex } from "viem";
import { uniswapTools } from "../src/uniswap/tools.js";
const request = JSON.parse(await Bun.stdin.text());
const tool = uniswapTools.find((tool) => tool.name === request.tool);
if (!tool) throw new Error("Unknown Uniswap tool");
const result = await tool.handler(request.input);
console.log(
  JSON.stringify(result, (key, value) => {
    if (key !== "execution_plan" && key !== "read_calls") return value;
    const bytes = JSON.stringify(value);
    return {
      kind: "artifact_reference",
      artifact_type: key === "execution_plan" ? "execution_plan" : "read_calls",
      url: `data:application/json;base64,${Buffer.from(bytes).toString("base64")}`,
      bytes: Buffer.byteLength(bytes),
      integrity: {
        algorithm: "keccak256",
        value: keccak256(stringToHex(bytes)),
      },
    };
  }),
);

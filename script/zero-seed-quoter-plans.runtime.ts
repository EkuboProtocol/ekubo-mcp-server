// Historical: runs against the MCP source at 807320c (see zero-seed-quoter-plans.ts), whose policy module still had
// one pin per quote. Kept unchanged so the recorded fixture stays reproducible.
// Appended by zero-seed-quoter-plans.ts after the quoter's tests/local-router/runtime.ts, inside the indexer's
// fixture generator. After the quoter's matrix for a phase (its probes are all reverted, so the chain is back at the
// quoted state), every quoter response it executed is turned into an MCP router plan by localSwapFromQuote and that
// plan is executed in a reverted snapshot: once with the quote as the guard and once with a 1% slippage guard.
const mcpRoot = process.env.ZERO_SEED_MCP_ROOT!;
const mcpPlans: unknown[] = [];
const BALANCE_OF = "0x70a08231";

async function balanceOf(token: Address, who: Address): Promise<bigint> {
  if (BigInt(token) === 0n) return pub.getBalance({ address: who });
  const { data } = await pub.call({ to: token, data: `${BALANCE_OF}${who.slice(2).toLowerCase().padStart(64, "0")}` as Hex });
  return BigInt(data!);
}

/** abi.encode(PoolKey, SwapParameters) the extension decodes, built from the quoter's hop alone. */
function forwardPayload(hop: any, amount: bigint, specifiedIs1: boolean): Hex {
  const params = (BigInt(hop.sqrt_ratio_limit) << 160n) | (BigInt.asUintN(128, amount) << 32n) | (specifiedIs1 ? 1n << 31n : 0n);
  return encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [hop.pool_key.token0, hop.pool_key.token1, hop.pool_key.config, pad(toHex(params), { size: 32 })],
  ).toLowerCase() as Hex;
}

function callsTo(frame: any, to: string, out: any[] = []): any[] {
  if (frame.to?.toLowerCase() === to) out.push(frame);
  for (const child of frame.calls ?? []) callsTo(child, to, out);
  return out;
}

async function runMcpPlans(phase: string) {
  const { localSwapFromQuote } = await import(`${mcpRoot}/src/launchpad/zero-seed/swap.ts`);
  const { BACKEND_REPLAY_PINS } = await import(`${mcpRoot}/src/launchpad/zero-seed/policy.ts`);
  const head = await pub.getBlock({ blockTag: "latest" });
  for (const v of vectors.filter((x: any) => x.phase === phase) as any[]) {
    const launch = launches.get(v.label)!;
    const extension = launch.extension.toLowerCase();
    const pin = BACKEND_REPLAY_PINS.find((p: any) => p.extension === extension && p.periphery === launch.periphery.toLowerCase());
    if (!pin) throw new Error(`${v.label}: no backend replay pin`);
    equal(head.hash, v.input.block_hash, "chain is back at the quoted block");
    const response = v.quote.response;
    const amount = BigInt(v.input.amount);
    const calculated = BigInt(response.total_calculated);
    const key = launch.poolKey;
    const specified = v.input.specified_token.toLowerCase();
    const other = (BigInt(specified) === BigInt(key.token0) ? key.token1 : key.token0).toLowerCase();
    const specifiedIs1 = BigInt(specified) === BigInt(key.token1);
    const time = v.input.time;
    const context = { blockNumber: String(v.input.block_number), blockHash: v.input.block_hash, blockTime: String(time) };
    for (const [variant, bps] of [["quote_guard", 0n], ["slippage_100bps", 100n]] as const) {
      const guard = amount > 0n
        ? { min_output: ((calculated * (10_000n - bps)) / 10_000n).toString() }
        : { max_input: ((calculated * (10_000n + bps) + 9_999n) / 10_000n).toString() };
      const request = { amount: v.input.amount, specified_token: specified, other_token: other, extension,
        deadline: String(time), ...guard };
      const plan = localSwapFromQuote({ pin, request, response, context, recipient: TRADER.toLowerCase() }, BigInt(time));
      const tokens = [key.token0, key.token1] as Address[];
      const snap = await test.snapshot();
      const before = await Promise.all([...tokens.map((t) => balanceOf(t, TRADER)), balanceOf(NATIVE, ROUTER)]);
      const receipt = await measured(plan.data, time, BigInt(plan.value));
      equal(receipt.status, "success", `${v.phase} ${v.label} ${variant} MCP plan executes`);
      const after = await Promise.all([...tokens.map((t) => balanceOf(t, TRADER)), balanceOf(NATIVE, ROUTER)]);
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      const deltas = tokens.map((t, i) => after[i] - before[i] + (BigInt(t) === 0n ? gas : 0n));
      const trace: any = await pub.request({ method: "debug_traceTransaction" as any,
        params: [receipt.transactionHash, { tracer: "callTracer" }] as any });
      const payload = forwardPayload(response.splits[0].route[0].swap, amount, specifiedIs1);
      const forwarded = callsTo(trace, extension).filter((f) => f.from?.toLowerCase() === CORE.toLowerCase());
      const event = receipt.logs.find((l) => BigInt(l.address) === BigInt(launch.extension) && l.topics[0] === SWAPPED)!;
      const w = (i: number) => BigInt(`0x${event.data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
      mcpPlans.push({
        phase, label: v.label, quoteKind: v.quoteKind, side: v.sell ? "sell" : "buy", exactOut: v.exactOut, variant,
        poolId: launch.poolId.toLowerCase(), request, context, recipient: TRADER.toLowerCase(), response,
        quoterHarness: { calldata: v.calldata.toLowerCase(), value: v.value, transactionHash: v.transactionHash },
        plan,
        execution: {
          status: receipt.status, transactionHash: receipt.transactionHash, blockTime: time,
          traderDeltas: { token0: deltas[0].toString(), token1: deltas[1].toString() },
          routerEthBefore: before[2].toString(), routerEthAfter: after[2].toString(),
          logEmitters: [...new Set(receipt.logs.map((l) => l.address.toLowerCase()))].sort(),
          logTopics: receipt.logs.map((l) => l.topics[0]),
          event: { delta0: BigInt.asIntN(128, w(0)).toString(), delta1: BigInt.asIntN(128, w(1)).toString(),
            feeRate: w(2).toString(), feeAmount: w(3).toString(), feeIsToken1: w(4) === 1n },
          forwardPayload: payload,
          forwardedCalls: forwarded.length,
          forwardedInputContainsPayload: forwarded.some((f) => f.input.toLowerCase().includes(payload.slice(2))),
        },
      });
      await test.revert({ id: snap });
    }
  }
}

function writeMcpPlans() {
  writeFileSync(resolve(proofDir, "mcp-plans.json"), JSON.stringify(mcpPlans, (_, v) => (typeof v === "bigint" ? String(v) : v), 1));
}

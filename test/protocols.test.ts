import { describe, expect, it } from "bun:test";
import { fakeArtifactStore } from "./fake-r2.js";
import worker from "../src/index.js";
import { publicToolCatalog, serverInstructions } from "../src/server.js";
import {
  ALL_PROTOCOLS,
  ALL_PROTOCOLS_MCP_PATH,
  matchMcpRoute,
  PROTOCOL_SLUGS,
  PROTOCOLS,
  protocolMcpPath,
  toolProtocol,
} from "../src/protocols.js";
import { PROTOCOL_SKILLS } from "../src/protocol-skills.js";

const env = {
  ARTIFACT_STORE: fakeArtifactStore(),
  EKUBO_API_URL: "https://api.test",
  EKUBO_QUOTER_URL: "https://quoter.test",
  ZERO_X_API_KEY: "zero-x-test-key",
  ACROSS_API_KEY: "across-test-key",
  ACROSS_INTEGRATOR_ID: "test-integrator",
  LAYER_ZERO_API_KEY: "unused",
  LI_FI_API_KEY: "unused",
  DUNE_API_KEY: "recommendation-test-key",
  ALLOWED_ORIGINS: "https://mcp.ekubo.org",
};
const context = {} as unknown as ExecutionContext;

const mcpHeaders = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  host: "mcp.ekubo.org",
  origin: "https://mcp.ekubo.org",
  "mcp-protocol-version": "2025-11-25",
};

async function mcpJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  if (data === undefined) throw new Error(`MCP stream had no data: ${body}`);
  return JSON.parse(data);
}

async function mcpCall(
  path: string,
  method: string,
  id: number,
  params: Record<string, unknown> = {},
) {
  const response = await worker.fetch(
    new Request(`https://mcp.ekubo.org${path}`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    env,
    context,
  );
  expect(response.status).toBe(200);
  return mcpJson(response);
}

async function listedTools(path: string): Promise<string[]> {
  const listed = (await mcpCall(path, "tools/list", 2)) as {
    result: { tools: { name: string }[] };
  };
  return listed.result.tools.map((tool) => tool.name);
}

async function listedResourceUris(path: string): Promise<string[]> {
  const listed = (await mcpCall(path, "resources/list", 3)) as {
    result: { resources: { uri: string }[] };
  };
  return listed.result.resources.map((resource) => resource.uri);
}

async function serverInfo(path: string) {
  const initialized = (await mcpCall(path, "initialize", 1, {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "ekubo-test", version: "1.0.0" },
  })) as {
    result: {
      instructions: string;
      serverInfo: { name: string; title?: string };
    };
  };
  return initialized.result;
}

describe("Protocol partition", () => {
  // The one invariant that silently drifts: a tool added to the catalog but
  // not to a protocol would be reachable on /mcp and on no per-protocol
  // endpoint, and nothing else in the suite would notice.
  it("covers every catalog tool exactly once", () => {
    const assigned = PROTOCOLS.flatMap((protocol) => protocol.tools);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect([...assigned].sort()).toEqual(
      publicToolCatalog.map((tool) => tool.name).sort(),
    );
  });

  it("assigns every protocol a slug that is also its endpoint path", () => {
    expect(PROTOCOLS.map((protocol) => protocol.slug)).toEqual([
      ...PROTOCOL_SLUGS,
    ]);
    for (const protocol of PROTOCOLS) {
      expect(protocolMcpPath(protocol.slug)).toBe(`/mcp/${protocol.slug}`);
    }
  });

  it("names only skills the repository actually ships", () => {
    const shipped = new Set<string>(PROTOCOL_SKILLS.map((skill) => skill.name));
    for (const protocol of PROTOCOLS) {
      if (protocol.skill === null) continue;
      expect(shipped.has(protocol.skill)).toBe(true);
    }
  });

  it("routes /mcp to every protocol and /mcp/<slug> to one", () => {
    const all = matchMcpRoute(ALL_PROTOCOLS_MCP_PATH);
    expect(all?.route).toBe("/mcp");
    expect([...(all?.protocols ?? [])].sort()).toEqual(
      [...ALL_PROTOCOLS].sort(),
    );
    for (const protocol of PROTOCOLS) {
      const matched = matchMcpRoute(`/mcp/${protocol.slug}`);
      expect(matched?.route).toBe(`/mcp/${protocol.slug}`);
      expect([...(matched?.protocols ?? [])]).toEqual([protocol.slug]);
    }
    for (const path of ["/mcps", "/mcp/", "/mcp/unknown", "/mcp/ekubo/x", "/"]) {
      expect(matchMcpRoute(path)).toBeNull();
    }
  });
});

describe("Per-protocol MCP endpoints", () => {
  it("keeps /mcp serving the whole catalog", async () => {
    expect(await listedTools("/mcp")).toEqual(
      publicToolCatalog.map((tool) => tool.name),
    );
  });

  it("serves each protocol exactly its own tools", async () => {
    for (const protocol of PROTOCOLS) {
      const tools = await listedTools(protocolMcpPath(protocol.slug));
      expect(tools.sort()).toEqual([...protocol.tools].sort());
      for (const tool of tools) {
        expect(toolProtocol(tool)).toBe(protocol.slug);
      }
    }
  });

  it("partitions the catalog across the per-protocol endpoints", async () => {
    const served: string[] = [];
    for (const protocol of PROTOCOLS) {
      served.push(...(await listedTools(protocolMcpPath(protocol.slug))));
    }
    expect(new Set(served).size).toBe(served.length);
    expect(served.sort()).toEqual(await listedTools("/mcp").then((t) => t.sort()));
  });

  it("identifies each single-protocol server distinctly", async () => {
    expect((await serverInfo("/mcp")).serverInfo.name).toBe("ekubo");
    for (const protocol of PROTOCOLS) {
      const info = await serverInfo(protocolMcpPath(protocol.slug));
      expect(info.serverInfo.name).toBe(`ekubo-${protocol.slug}`);
      expect(info.serverInfo.title).toBe(protocol.title);
    }
  });

  it("offers a protocol only the skills it can read", async () => {
    for (const protocol of PROTOCOLS) {
      const uris = await listedResourceUris(protocolMcpPath(protocol.slug));
      // The plan-handoff contract is the same on every endpoint.
      expect(uris).toContain("ekubo://docs/execution-plan");
      for (const skill of PROTOCOL_SKILLS) {
        expect(uris.includes(`ekubo://skills/${skill.name}`)).toBe(
          protocol.skill === skill.name,
        );
      }
      // Ekubo's own documentation rides with Ekubo's own tools.
      expect(uris.includes("ekubo://docs/ve33-workflow")).toBe(
        protocol.slug === "ekubo",
      );
    }
  });
});

describe("Per-protocol server instructions", () => {
  it("leaves /mcp's instructions unchanged by the split", async () => {
    const instructions = (await serverInfo("/mcp")).instructions;
    expect(instructions).toBe(serverInstructions(ALL_PROTOCOLS));
    // Spot-check the paragraphs the pre-split endpoint is relied on for.
    expect(instructions).toContain(
      "use this Ekubo MCP before any browser or website tool",
    );
    expect(instructions).toContain(
      "Morpho, Sky, Lido, Merkl, and Aerodrome discovery follows the same no-proxy boundary",
    );
    expect(instructions).toContain(
      "LP position transfers are supported only through prepare_lp_position_transfer",
    );
    expect(instructions).not.toContain("Endpoint scope:");
  });

  it("drops the swap and LP guidance a satellite endpoint cannot follow", async () => {
    const sky = (await serverInfo("/mcp/sky")).instructions;
    expect(sky).toContain("Sky discovery follows the same no-proxy boundary");
    expect(sky).toContain("get_sky_savings_deployment");
    expect(sky).toContain("ekubo://skills/use-sky");
    // Nothing that tells the agent to reach for a tool this endpoint lacks.
    expect(sky).not.toContain("get_quotes_with_plans");
    expect(sky).not.toContain("prepare_lp_position_transfer");
    expect(sky).not.toContain("get_ve33_allocations");
    expect(sky).not.toContain("ekubo://skills/use-morpho");
    // The universal handoff contract stays.
    expect(sky).toContain("ekubo://docs/execution-plan");
    expect(sky).toContain("read_calls_reference");
  });

  it("tells a single-protocol endpoint where the other tools live", async () => {
    for (const protocol of PROTOCOLS) {
      const instructions = (await serverInfo(protocolMcpPath(protocol.slug)))
        .instructions;
      expect(instructions).toContain("Endpoint scope:");
      expect(instructions).toContain(
        `https://mcp.ekubo.org${protocolMcpPath(protocol.slug)}`,
      );
      expect(instructions).toContain("https://mcp.ekubo.org/mcp carries every");
    }
  });

  it("states the catalog revision on every endpoint", async () => {
    for (const path of [
      "/mcp",
      ...PROTOCOLS.map((protocol) => protocolMcpPath(protocol.slug)),
    ]) {
      expect((await serverInfo(path)).instructions).toStartWith(
        "Tool catalog revision: ",
      );
    }
  });
});

describe("Per-protocol discovery documents", () => {
  it("advertises every endpoint from the root document", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/"),
      env,
      context,
    );
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      mcp_endpoint: string;
      mcp_endpoints: {
        all: { url: string; tool_count: number; protocols: string[] };
        by_protocol: { protocol: string; url: string; tool_count: number }[];
      };
    };
    expect(document.mcp_endpoint).toBe("https://mcp.ekubo.org/mcp");
    expect(document.mcp_endpoints.all.url).toBe("https://mcp.ekubo.org/mcp");
    expect(document.mcp_endpoints.all.tool_count).toBe(
      publicToolCatalog.length,
    );
    expect(document.mcp_endpoints.all.protocols).toEqual([...PROTOCOL_SLUGS]);
    expect(
      document.mcp_endpoints.by_protocol.map((entry) => entry.url),
    ).toEqual(
      PROTOCOLS.map(
        (protocol) => `https://mcp.ekubo.org${protocolMcpPath(protocol.slug)}`,
      ),
    );
    expect(
      document.mcp_endpoints.by_protocol.reduce(
        (total, entry) => total + entry.tool_count,
        0,
      ),
    ).toBe(publicToolCatalog.length);
  });

  it("filters the tool catalog by protocol", async () => {
    for (const protocol of PROTOCOLS) {
      const response = await worker.fetch(
        new Request(`https://mcp.ekubo.org/tools?protocol=${protocol.slug}`),
        env,
        context,
      );
      expect(response.status).toBe(200);
      const document = (await response.json()) as {
        protocol: string;
        mcp_endpoint: string;
        tool_count: number;
        tools: { name: string; protocol: string }[];
      };
      expect(document.protocol).toBe(protocol.slug);
      expect(document.mcp_endpoint).toBe(
        `https://mcp.ekubo.org${protocolMcpPath(protocol.slug)}`,
      );
      expect(document.tools.map((tool) => tool.name).sort()).toEqual(
        [...protocol.tools].sort(),
      );
      expect(document.tool_count).toBe(protocol.tools.length);
    }
  });

  it("refuses an unknown protocol filter rather than serving everything", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/tools?protocol=uniswap"),
      env,
      context,
    );
    expect(response.status).toBe(404);
    const document = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(document.error.code).toBe("unknown_protocol");
    expect(document.error.message).toContain("aerodrome");
  });

  it("lists every endpoint in llms.txt", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.ekubo.org/llms.txt"),
      env,
      context,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const protocol of PROTOCOLS) {
      expect(body).toContain(
        `https://mcp.ekubo.org${protocolMcpPath(protocol.slug)}`,
      );
    }
  });
});

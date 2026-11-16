export function isRetiredLiquidityExtension(chainId: string, extension: string) {
  return chainId === "1" &&
    extension.toLowerCase() === "0x51f831c23fa4051862881ef8efc0c3c37905ce49";
}

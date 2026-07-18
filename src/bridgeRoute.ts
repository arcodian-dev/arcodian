export function isArcBridgeRoute(fromChain: number, toChain: number, arcChain: number) {
  return fromChain !== toChain && (fromChain === arcChain || toChain === arcChain);
}

import { inspectPolicy, payBoundedInvoice } from "/agentpay-sdk.mjs";

// `signer` must be supplied by the integrator (browser wallet, session key,
// HSM, or another secure signer). Never embed a private key in frontend code.
export async function payInvoice({ provider, signer, vault, merchant, amount, invoiceId, expiresIn = 900, memo = "" }) {
  const policy = await inspectPolicy(provider, vault, await signer.getAddress(), merchant);
  if (!policy.enabled || !policy.allowed) throw new Error("Policy or merchant permission denied");
  return payBoundedInvoice(signer, { vault, merchant, amount, invoiceId, expiresIn, memo });
}

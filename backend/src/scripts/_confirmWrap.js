// Test-only compatibility: real plans now require the owner's confirmation (campaign count + exposed budget) at approval. The OLD suites approve plans without caring about that step,
// so they import the daily-plans module through this wrapper, which fills in the CURRENT server-side numbers when a call passes no `confirm`. The new centralWriteGateTest uses the raw module
// and asserts the confirmation behaviour itself (missing / wrong numbers are refused).
export function withAutoConfirm(DP) {
  return { ...DP, approvePlan: async (args) => (args.confirm !== undefined ? DP.approvePlan(args) : DP.approvePlan({ ...args, confirm: await DP.currentConfirmation(args.planId) })) };
}

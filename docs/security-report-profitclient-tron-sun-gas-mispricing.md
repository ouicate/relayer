# Security report: TRON/SUN gas-unit mispricing in `ProfitClient` can approve loss-making fills

> Scope: this report describes the vulnerability present in the pre-fix tree at `ec72c28d` and fixed by `8cd5f87f02496bf3b4aac88e04939721ed950400` (`fix(relayer): use TVM gas decimals in profitability`).
>
> All code citations below refer to the vulnerable pre-fix revision unless otherwise stated.

## Summary

The pre-fix relayer underestimated TVM gas costs by **1e12x** when converting them into USD for profitability checks.

The issue was in `ProfitClient.estimateFillCost()`: Solana/SVM had already been special-cased to use the native gas token's decimals, but TVM chains such as TRON still fell through the "all other chains use 18 decimals" branch. On TRON, however, transaction costs are denominated in **SUN**, where:

- `1 TRX = 1,000,000 SUN`
- gas accounting therefore uses **6 decimals**, not 18

As a result, a real TRON gas cost such as `2,500,000 SUN` (2.5 TRX) was priced as though it were `2,500,000 wei`, making gas appear almost free.

This was not a reporting-only issue. The underestimated `gasCostUsd` fed directly into the relayer's `profitable` decision, so the bot could execute fills that were actually lossmaking on TRON/TVM routes.

## Severity

**High severity for deployments actively filling TVM/TRON routes.**  
**Not critical.**

### Why this is high

- The bug sits in the **actual fill-decision path**, not telemetry or monitoring.
- The magnitude of the accounting error is enormous: **1e12x**.
- It can cause **direct operator loss** by making genuinely lossmaking fills appear profitable.
- It can be hit repeatedly on low-margin TRON routes.
- It also distorts repayment-chain / profitability reasoning and logs.

### Why this is not critical

- The blast radius is narrower than a protocol-wide accounting bug: it is scoped to **TVM chains**, effectively **TRON** in this repo context.
- The loss is generally the **mispriced fee spread / gas cost**, not the full transfer principal.
- Exposure is deployment-sensitive: if TRON/TVM routes were not live, practical impact may have been zero.
- The bug enables a bounded economic bleed, not immediate full-principal theft or protocol-wide compromise.

## Vulnerability description

TRON is a real supported route in this codebase:

- `CHAIN_IDs.TRON` appears in the supported universal chains list (`src/common/Constants.ts:92-99`)
- TRON has configured deposit confirmations (`src/common/Constants.ts:136-148`)
- TRON has a supported relayer token set (`src/common/Constants.ts:372-376`)

The transaction stack also explicitly models TVM gas in **SUN**:

- `TransactionClient` documents its default TVM fee limit in SUN: `1 TRX = 1,000,000 SUN` (`src/clients/TransactionClient.ts:40-42`)
- TVM chains are dispatched through `_runTransactionTvm()` rather than the normal EVM transaction path (`src/clients/TransactionClient.ts:123-126`)

Inside `ProfitClient`, gas pricing is supposed to convert a chain-local gas-token amount into USD:

1. `resolveGasToken()` returns the native gas token, including its chain-specific decimals (`src/clients/ProfitClient.ts:200-211`)
2. `estimateFillCost()` reads `tokenGasCost` and `gasTokenPriceUsd` (`src/clients/ProfitClient.ts:343-347`)
3. it computes `gasCostUsd` by dividing by `10^gasAccountingDecimals` (`src/clients/ProfitClient.ts:370-373`)

The bug was that `gasAccountingDecimals` special-cased only SVM:

```ts
// EVM gas is metered in wei (1e-18 base units) regardless of the native token's nominal decimals
// (e.g. Tempo's pathUSD is 6dp but gas is still wei). SVM meters in lamports (1e-9 SOL).
const gasAccountingDecimals = chainIsSvm(chainId) ? gasToken.decimals : 18;
const gasCostUsd = tokenGasCost.mul(gasTokenPriceUsd).div(bn10.pow(gasAccountingDecimals));
```

(`src/clients/ProfitClient.ts:370-373`)

For TRON:

- `gasToken.decimals` is `6` (TRX/SUN)
- but the vulnerable code used `18`

So the relayer divided by `1e18` instead of `1e6`, understating TRON gas costs by **1e12x**.

## Detailed root cause analysis

### 1. TVM gas accounting used the wrong unit conversion

`ProfitClient.resolveGasToken()` returns the native token info for the destination chain, including its decimals:

- `resolveNativeToken()` loads `symbol`, `decimals`, and `address`
- `resolveGasToken()` simply returns that native token

(`src/clients/ProfitClient.ts:200-211`)

That means the client already had the correct TRON gas-token metadata available.

However, `estimateFillCost()` ignored those decimals for all non-SVM chains:

- it fetched `gasToken`
- fetched `tokenGasCost`
- then hardcoded `18` unless `chainIsSvm(chainId)`

(`src/clients/ProfitClient.ts:343-373`)

This made the gas-unit conversion internally inconsistent:

- TVM execution returned gas costs in **SUN**
- the profitability logic interpreted those costs as if they were **wei**

### 2. The codebase itself documents that TVM uses SUN

This is not a hypothetical external-chain nuance that the relayer had no way to know. The same repository already encoded the correct unit assumption in the transaction layer:

- `DEFAULT_TVM_FEE_LIMIT` is documented as being in SUN (`src/clients/TransactionClient.ts:40-42`)
- TVM chains are routed to `_runTransactionTvm()` (`src/clients/TransactionClient.ts:123-126`)

So the bug was not "missing chain support"; it was a mismatch between:

- the execution layer, which handled TVM in SUN
- and the profitability layer, which priced TVM gas as 18-decimal wei

### 3. The USD gas estimate fed directly into the profitability decision

`estimateFillCost()` returns:

- `gasCostUsd`
- `nativeTokenFillCostUsd`

(`src/clients/ProfitClient.ts:375-392`)

`calculateFillProfitability()` then consumes those values in the core profitability formula:

1. compute `grossRelayerFeeUsd`
2. subtract `nativeTokenFillCostUsd`
3. derive `netRelayerFeePct`
4. set `profitable` by comparing `netRelayerFeePct` to the route threshold

```ts
const grossRelayerFeeUsd = inputAmountUsd.sub(outputAmountUsd).sub(lpFeeUsd);
...
const {
  ...
  gasCostUsd,
  ...
  nativeTokenFillCostUsd,
} = await this.estimateFillCost(deposit);
...
const netRelayerFeeUsd = grossRelayerFeeUsd.sub(nativeTokenFillCostUsd);
const netRelayerFeePct = outputAmountUsd.gt(bnZero)
  ? netRelayerFeeUsd.mul(fixedPoint).div(outputAmountUsd)
  : bnZero;
...
const profitable =
  inputTokenPriceUsd.gt(bnZero) && outputTokenPriceUsd.gt(bnZero) && netRelayerFeePct.gte(minRelayerFeePct);
```

(`src/clients/ProfitClient.ts:476-505`)

This is the critical point: the underestimated TVM gas cost was not merely logged; it directly changed the boolean that determines whether the bot considers the relay profitable.

### 4. The relayer consumes that profitability result when deciding whether to fill

`Relayer.resolveRepaymentChain()` evaluates candidate routes by calling `profitClient.isFillProfitable(...)` and then filtering for profitable options:

```ts
const {
  profitable,
  nativeGasCost: gasLimit,
  tokenGasCost: gasCost,
  gasPrice,
  netRelayerFeePct: relayerFeePct,
  totalFeePct: totalUserFeePct,
} = await profitClient.isFillProfitable(deposit, lpFeePct, preferredChainId);
...
const profitableRepaymentChainIds = preferredChainIds.filter((_, i) => repaymentChainProfitabilities[i].profitable);
```

(`src/relayer/Relayer.ts:1282-1318`)

So the mispriced gas estimate could:

- make an otherwise unprofitable TRON route appear profitable
- influence which candidate routes were retained
- and therefore affect actual execution decisions

### 5. The magnitude of the underpricing was catastrophic for near-margin fills

Take a concrete TRON example:

- `tokenGasCost = 2,500,000 SUN` (2.5 TRX)
- `TRX price = $0.30`

Correct calculation:

- `2.5 TRX * $0.30 = $0.75`

Vulnerable calculation:

- `2,500,000 * 0.30e18 / 1e18`
- effectively `$0.00000000000075`

That is a **1e12x understatement**.

So any relay whose true fee margin was between roughly:

- `0`
- and the real TVM gas cost

could be misclassified as profitable.

## Impact

### Direct impact

- The relayer could **accept fills that were actually lossmaking** on TRON/TVM routes.
- That translates into **direct operator loss**.

### Secondary impacts

- Distorted route / repayment-chain selection
- Incorrect profitability logs and reasoning
- Honest users could receive subsidized fills
- Adversarial users could intentionally target low-margin routes that only look profitable under the bad accounting

### Deployment sensitivity

This issue is highly dependent on whether TVM/TRON routes were active:

- **High operational severity** if TRON/TVM fills were enabled and used
- **Lower effective severity** if those routes were not live

### What this bug does not do

- It does **not** let an attacker steal the full destination transfer amount while the origin side fails.
- It does **not** create a protocol-wide accounting failure across all chains.
- Its loss profile is better described as a **repeatable economic bleed** than a one-shot catastrophic drain.

## Concrete scenario

Consider a relayer actively filling TRON-destination USDT routes.

### Initial conditions

- Destination chain: TRON
- Supported token set includes USDT on TRON (`src/common/Constants.ts:372-376`)
- A candidate deposit offers a gross relayer fee of **$0.20**
- Estimated TRON execution cost is **2.5 TRX**
- TRX spot price is **$0.30**
- Assume no auxiliary native-token payout for simplicity

### Correct economics

- Actual gas cost = `2.5 * 0.30 = $0.75`
- Net relayer fee = `$0.20 - $0.75 = -$0.55`
- The fill is **unprofitable** and should be rejected

### Vulnerable pre-fix economics

Because the code divided by `1e18` instead of `1e6`, it priced the same gas as approximately:

- `$0.00000000000075`

So the relayer sees:

- Net relayer fee ≈ `$0.20`
- The fill appears **profitable**

### Result

The relayer can proceed with a fill that should have been rejected, realizing a real loss on execution.

This is especially dangerous for:

- repeated low-margin deposits
- routes where TRON gas is a material fraction of total fee spread
- users or flow sources that systematically push deposits toward the relayer's minimum profitability threshold

## Recommended fix

The correct fix is to price TVM gas using the native gas token's base-unit decimals, just as SVM already did.

The applied patch changed:

```ts
const gasAccountingDecimals = chainIsSvm(chainId) ? gasToken.decimals : 18;
```

to:

```ts
const gasAccountingDecimals = chainIsSvm(chainId) || chainIsTvm(chainId) ? gasToken.decimals : 18;
```

This aligns the profitability logic with the actual unit domain used by TVM execution:

- EVM: wei → 18 decimals
- SVM: lamports → native token decimals
- TVM: SUN → native token decimals

## Additional hardening recommendations

### 1. Treat gas-unit domains as an invariant, not an ad hoc exception

The safer long-term rule is:

> `gasCostUsd` must always divide by the base-unit precision of the unit returned by the chain-specific gas estimator.

That is stronger than maintaining a growing list of special cases.

### 2. Keep one regression test per non-EVM execution family

This bug escaped because SVM had coverage but TVM did not.

At minimum, maintain explicit tests for:

- EVM / wei
- SVM / lamports
- TVM / SUN

### 3. Consider route-level guardrails for low-margin non-EVM fills

Even with correct accounting, operators may want:

- higher minimum fee thresholds
- per-chain minimum margins
- or explicit disable switches

for routes where gas volatility can quickly erase thin spreads.

## Validation

The fix PR added a regression test that locks in TRON/SUN behavior:

- `test/ProfitClient.ConsiderProfitability.ts`

The test uses:

- `destinationChainId = CHAIN_IDs.TRON`
- `tokenGasCost = 2_500_000` (2.5 TRX in SUN)
- `gasTokenPriceUsd = $0.30`

and asserts that `estimate.gasCostUsd == $0.75`, i.e. division by `10^6` rather than `10^18`.

## Short fix summary

The vulnerability existed because `ProfitClient` mixed two different gas-unit systems:

- TVM execution returned gas costs in **SUN**
- profitability conversion priced them as **18-decimal wei**

That mismatch understated TRON gas costs by **1e12x**, corrupted the relayer's profitability gate, and could cause real loss-making fills to be executed.

The fix is to treat TVM like SVM for gas-unit conversion: use the native gas token's actual decimals when translating TVM gas costs into USD.

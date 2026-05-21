# Security report: pre-fix `swapAndBridgeWithPermit` false-confirmation bug

> Scope: this report describes the vulnerability introduced by `8a9c4e69` (`feat: Add support for swapAndBridgeWithPermit flow in GaslessRelayer`) and fixed by `f75ff9dc` / `ff155ec0` on this branch.
>
> All code citations below refer to the vulnerable pre-fix tree at `ec72c28d` (the then-current `origin/master`), not the patched working tree on this branch.

## Summary

The pre-fix gasless relayer could falsely conclude that a `swapAndBridgeWithPermit` request had already been submitted on the origin chain even when no Across deposit existed on-chain.

The bug came from reusing a generic nonce helper across incompatible nonce domains:

- for `erc3009`, `permit.message.nonce` is the authorization nonce;
- for `permit2`, `permit.message.nonce` is the Permit2 nonce;
- for `permit` swap-and-bridge messages, `permit.message.nonce` is the Across `SwapAndDepositData` witness nonce, not the ERC-2612 token permit nonce.

The relayer nevertheless compared `token.nonces(owner)` against that witness nonce and treated `token.nonces(owner) > witnessNonce` as proof that the origin deposit had already been submitted. In the vulnerable code, that false proof fed two terminal paths:

1. startup CCTP observation, where the message could be pre-marked as observed and then moved to `FILLED`; and
2. runtime confirmation, where the message could move to `FILLED` after a missing receipt / tx-hash fallback.

This is distinct from the older immediate-fill/origin-finality issue. It does not depend on `RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_*` and it does not directly drain relayer inventory. Its impact is a high-severity correctness failure: real gasless swap/CCTP requests can be silently dropped because the relayer believes they were completed when they were not.

## Severity

High severity correctness / availability bug.

Why this clears the high-severity bar:

- it affects a production funds-movement path (`swapAndBridgeWithPermit`);
- it can transition messages into a terminal `FILLED` state with no real origin `FundsDeposited` event;
- once the message is `FILLED`, the relayer stops retrying it;
- the failure is silent from the workflow's perspective because logs say the deposit was "confirmed" on origin;
- for swap / CCTP flows there is no later destination fill observation that can repair the missing origin submission.

## Vulnerability description

The vulnerable implementation assumed that ERC-2612 permit consumption could be detected by checking whether `token.nonces(owner)` had advanced beyond `getGaslessPermitNonce(depositMessage)`. That assumption is wrong for `swapAndBridgeWithPermit`.

For that message type, the API payload exposes:

- an Across witness (`PermitSwapAndBridgeWitness`) whose `message` is `SwapAndDepositData`, including a `nonce` field (`src/interfaces/Gasless.ts:81-92`, `156-161`);
- a separate `permitApprovalSignature` and `permitApprovalDeadline` for the ERC-2612 approval (`src/interfaces/Gasless.ts:230-233`, `321-324`);
- but no ERC-2612 token permit nonce anywhere in the structured message.

The tx builder confirms this split: the permit-based swap path consumes `permitApprovalSignature` and `permitApprovalDeadline`, but it does not receive or propagate any token permit nonce (`src/utils/GaslessUtils.ts:507-544`).

Despite that, the shared helper `getGaslessPermitNonce()` simply returns `depositMessage.permit.message.nonce` for all flows (`src/utils/GaslessUtils.ts:364-368`). For `permit` swap-and-bridge messages, that value is the Across witness nonce from `SwapAndDepositData`, not the token's ERC-2612 nonce (`src/interfaces/Gasless.ts:81-92`, `156-161`).

That wrong nonce was then used as `signedNonce` in `isErc2612PermitNonceConsumed()` (`src/utils/GaslessUtils.ts:385-406`), and a positive result was interpreted as proof of origin submission in both startup dedup and runtime confirmation (`src/gasless/GaslessRelayer.ts:334-375`, `562-600`).

## Detailed root cause analysis

### 1. The `permit` swap payload does not carry the ERC-2612 nonce

The type definitions separate the two concepts:

- `SwapAndDepositData.nonce` belongs to the Across witness (`src/interfaces/Gasless.ts:81-92`);
- the `permit` flow exposes only `permitApprovalSignature` and `permitApprovalDeadline` as the token-approval side channel (`src/interfaces/Gasless.ts:230-233`, `321-324`);
- `PermitSwapAndBridgeWitness.message` is `SwapAndDepositData`, so its `nonce` is still the Across witness nonce (`src/interfaces/Gasless.ts:156-161`).

`restructureGaslessDeposits()` preserves that shape verbatim: it flattens the raw swap message and copies both the `permit` object and the separate `permitApproval*` fields, but it does not synthesize or carry any token permit nonce (`src/utils/GaslessUtils.ts:175-210`).

### 2. The shared nonce helper returned the wrong nonce domain

`getGaslessPermitNonce()` was documented as returning a "Permit / witness nonce for lookup/dedup" and implemented as:

- `return depositMessage.permit.message.nonce;`

(`src/utils/GaslessUtils.ts:364-368`)

That helper is valid for:

- EIP-3009, where `permit.message.nonce` is the authorization nonce;
- Permit2, where `permit.message.nonce` is the Permit2 nonce.

It is not valid for `swapAndBridgeWithPermit`, because there `permit.message` is `SwapAndDepositData` and its `nonce` is the Across witness nonce (`src/interfaces/Gasless.ts:81-92`, `156-161`).

### 3. The relayer treated token nonce advancement as proof of submission

The ERC-2612 helper reads the token's on-chain nonce and checks:

- `onChainNonce.gt(params.signedNonce)`

(`src/utils/GaslessUtils.ts:399-406`)

That check only answers whether the token's ERC-2612 nonce advanced. It does not prove that Across's `swapAndBridgeWithPermit` call succeeded, because:

- the value being compared was not the token permit nonce at all;
- even if the actual token permit nonce were available, an external `permit()` call could advance the nonce without any Across deposit ever being submitted.

So the comparison was both syntactically wrong (wrong nonce) and semantically too weak (wrong proof).

### 4. Startup CCTP observation could pre-mark the message as observed

During initialization, `updateObservedCctpDeposits()` walks only CCTP messages (`src/gasless/GaslessRelayer.ts:334-336`).

For `depositFlowType === "swapAndBridge"` it entered this block:

- if `permitType` was `"permit2"` or `"permit"`, it loaded `owner` and `permitNonce`;
- for `"permit"` it called `isErc2612PermitNonceConsumed({ tokenAddress, owner, signedNonce: permitNonce, ... })`;
- if that returned true, it added the deposit key to `observedDeposits`.

(`src/gasless/GaslessRelayer.ts:339-375`)

In the vulnerable code, that meant any unrelated increase in `token.nonces(owner)` beyond the Across witness nonce was enough to mark the CCTP swap message as "already submitted on origin", even though no Across deposit had been observed.

### 5. Initial observation converted that false observation into terminal `FILLED`

After startup observation, `_markFilledFromInitialObservation()` checked whether the deposit key was present in `observedDeposits` (`src/gasless/GaslessRelayer.ts:398-405`).

If so, and if the message was either:

- a swap (`depositFlowType === "swapAndBridge"`), or
- a CCTP deposit,

it immediately set the message state to `FILLED` (`src/gasless/GaslessRelayer.ts:410-413`).

That matters because a false positive in `observedDeposits` was not just advisory metadata. It became a terminal workflow decision that prevented later submission and retry.

### 6. Runtime confirmation repeated the same mistake

The same bad proof existed in the normal runtime path.

Inside `evaluateApiSignatures()`, the relayer computes:

- `isSwap = depositMessage.depositFlowType === "swapAndBridge"`
- `nonce = getGaslessPermitNonce(depositMessage)`

(`src/gasless/GaslessRelayer.ts:431-436`)

Then, inside `DEPOSIT_CONFIRM`, swap and CCTP messages enter the "confirm via receipt hash and/or nonce/auth usage" branch (`src/gasless/GaslessRelayer.ts:562-567`).

For `permitType === "permit"` with no receipt-derived hash, the vulnerable code did:

1. `nonceConsumed = await isErc2612PermitNonceConsumed({ ..., signedNonce: nonce, ... })`
2. if true, `found = "permit-nonce-consumed"`
3. if `found` is defined, log the deposit as confirmed on origin and set state to `FILLED`

(`src/gasless/GaslessRelayer.ts:570-600`)

Because `nonce` here was still the Across witness nonce, not the token nonce, this branch could log a false origin confirmation and permanently stop retrying the message.

### 7. The bug affected the exact path introduced by `8a9c4e69`

The new `swapAndBridgeWithPermit` support was added through:

- the new `"permit"` type in the gasless message model (`src/interfaces/Gasless.ts:281-324`);
- the swap tx builder branch for `swapAndBridgeWithPermit` using `permitApprovalSignature` and `permitApprovalDeadline` (`src/utils/GaslessUtils.ts:507-544`);
- the new ERC-2612 nonce consumption shortcut (`src/utils/GaslessUtils.ts:385-406`);
- and the relayer confirmation / observation logic that consumed that shortcut (`src/gasless/GaslessRelayer.ts:334-375`, `562-600`).

The bug is therefore a real regression in the new permit swap support, not a pre-existing known immediate-fill tradeoff.

## Impact

### Direct impact

- Real `swapAndBridgeWithPermit` requests could be marked `FILLED` when no Across origin deposit existed.
- The relayer would then stop retrying submission.
- The user request would be silently dropped.

### Blast radius

- Affects `depositFlowType === "swapAndBridge"` with `permitType === "permit"`.
- The startup pre-marking path specifically affects the CCTP initialization scan because `updateObservedCctpDeposits()` only processes CCTP messages (`src/gasless/GaslessRelayer.ts:334-336`).
- The runtime false-confirmation path affects any permit-based swap message that reaches the receipt-less fallback in `DEPOSIT_CONFIRM`.
- The bug does not depend on `RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_*`; immediate fill can be fully disabled and this bug still exists.

### Why this is operationally serious

- `FILLED` is terminal for the state machine.
- The log line says the deposit was "confirmed on" origin (`src/gasless/GaslessRelayer.ts:593-600`), so operators receive a misleading success signal.
- No actual origin `FundsDeposited` event exists, so downstream reconciliation sees no real submission.
- In the CCTP/swap case, there is no destination fill observation path that can repair the mistake later.

### What this bug does not do

- It does not require immediate fill.
- It does not directly transfer relayer funds to an attacker in the way the older immediate-fill/origin-finality bug could.
- Its severity comes from terminal state corruption and request loss, not direct inventory drain.

## Concrete trigger scenarios

### Scenario A: runtime false confirmation after unrelated ERC-2612 permit history

1. A user has already used the same token's ERC-2612 `permit()` mechanism elsewhere, so `token.nonces(owner)` is, for example, `5`.
2. The user submits a new `swapAndBridgeWithPermit` request whose Across witness nonce is `1`.
3. The relayer processes the message and later reaches the `DEPOSIT_CONFIRM` fallback path without a receipt-derived hash.
4. `getGaslessPermitNonce()` returns `1`, because it reads the Across witness nonce from `permit.message.nonce` (`src/utils/GaslessUtils.ts:364-368`).
5. `isErc2612PermitNonceConsumed()` compares the token nonce `5` against `signedNonce = 1` and returns true (`src/utils/GaslessUtils.ts:399-406`).
6. The relayer sets `found = "permit-nonce-consumed"` and transitions the message to `FILLED` (`src/gasless/GaslessRelayer.ts:575-600`).
7. No origin Across deposit exists, but retries stop because the workflow believes origin submission was confirmed.

### Scenario B: startup false `FILLED` for a CCTP permit swap

1. A CCTP `swapAndBridgeWithPermit` message is still pending when the relayer starts up.
2. The owner's token nonce is already ahead of the message's Across witness nonce.
3. `updateObservedCctpDeposits()` calls `isErc2612PermitNonceConsumed()` with the witness nonce and concludes the deposit was already submitted (`src/gasless/GaslessRelayer.ts:339-361`).
4. It adds the message's deposit key to `observedDeposits`.
5. `_markFilledFromInitialObservation()` sees a swap/CCTP message in `observedDeposits` and marks it `FILLED` (`src/gasless/GaslessRelayer.ts:398-413`).
6. Later polling skips the message because it is no longer `INITIAL` (`src/gasless/GaslessRelayer.ts:478-481`).

In both scenarios, the message is dropped not because the origin deposit succeeded, but because the relayer accepted the wrong proof.

## Recommended fix

The safe fix is to remove ERC-2612 token nonce advancement as a submission proof for `swapAndBridgeWithPermit`.

### Correct remediation

For `depositFlowType === "swapAndBridge"` and `permitType === "permit"`:

- require a real origin `FundsDeposited` observation by `depositId` on the requested `spokePool`;
- use that event lookup in both startup observation and runtime `DEPOSIT_CONFIRM`;
- keep `permit2` and `erc3009` behavior on their own nonce / event domains.

This is the patch implemented on this branch: the permit flow now confirms / dedups only from an observed origin deposit event, not from token nonce advancement.

### Why not "just add the ERC-2612 nonce to the payload"?

Even if the API were extended to carry the token permit nonce explicitly, `token.nonces(owner) > permitNonce` would still be an insufficient proof of Across submission. A third party or the user could consume the ERC-2612 permit through a standalone token `permit()` call and advance the token nonce without ever executing `swapAndBridgeWithPermit`.

The correct proof for Across submission is therefore:

- an origin `FundsDeposited` event attributable to the requested deposit,

not:

- a changed token nonce.

### Regression tests to keep

At minimum, keep tests that assert:

- unrelated ERC-2612 nonce changes do not mark a permit swap deposit as observed or filled;
- receipt-loss recovery for permit swap flows succeeds only when a real origin deposit can be found;
- startup initialization for CCTP permit swap messages does not pre-mark them `FILLED` without an observed deposit.

## Short fix summary

The bug existed because the relayer conflated an Across witness nonce with an ERC-2612 token permit nonce and then used token nonce advancement as if it were proof of an Across origin submission.

The fix is to stop using token nonce advancement as a submission proof for `swapAndBridgeWithPermit` and instead require the same thing the rest of the system ultimately cares about: an observed origin `FundsDeposited` event for the requested deposit.

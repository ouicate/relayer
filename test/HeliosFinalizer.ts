import { expect } from "./utils";
import { getRelevantL1EventSearchConfig } from "../src/finalizer/utils/helios";

describe("Helios finalizer", function () {
  it("uses the full configured L1 lookback window", function () {
    const l1SearchConfig = getRelevantL1EventSearchConfig({
      latestHeightSearched: 200,
      eventSearchConfig: {
        from: 100,
        maxLookBack: 5_000,
      },
    });

    expect(l1SearchConfig).to.deep.equal({
      from: 100,
      to: 200,
      maxLookBack: 5_000,
    });
  });
});

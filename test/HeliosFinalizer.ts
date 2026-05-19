import { expect, createSpyLogger, sinon } from "./utils";
import { EvmAddress } from "../src/utils";
import * as heliosUtils from "../src/finalizer/utils/helios";
import * as utils from "../src/utils";
import * as eventUtils from "../src/utils/EventUtils";
import * as universalUtils from "../src/utils/UniversalUtils";

describe("Helios finalizer", function () {
  afterEach(() => {
    sinon.restore();
  });

  it("queries the full configured L1 lookback for stored calldata events", async function () {
    const { spyLogger } = createSpyLogger();
    const spokePoolAddress = EvmAddress.from("0x1111111111111111111111111111111111111111");
    const storedCallDataEvent = {
      blockNumber: 120,
      target: spokePoolAddress.toEvmAddress(),
      txnRef: "0x01",
    };

    const paginatedEventQuery = sinon.stub(utils, "paginatedEventQuery").callsFake(async (_contract, _filter, searchConfig) => {
      expect(searchConfig.from).to.equal(100);
      expect(searchConfig.to).to.equal(200);
      expect(searchConfig.maxLookBack).to.equal(5_000);
      return [storedCallDataEvent as unknown as Awaited<ReturnType<typeof utils.paginatedEventQuery>>[number]];
    });

    sinon.stub(universalUtils, "getHubPoolStoreContract").returns({
      filters: {
        StoredCallData: () => ({ event: "StoredCallData" }),
      },
    } as unknown as ReturnType<typeof universalUtils.getHubPoolStoreContract>);
    sinon
      .stub(eventUtils, "spreadEventWithBlockNumber")
      .callsFake((event) => event as ReturnType<typeof eventUtils.spreadEventWithBlockNumber>);

    const hubPoolClient = {
      hubPool: { provider: {} },
      getSpokePoolActivationBlock: sinon.stub().returns(0),
    } as unknown as Parameters<typeof heliosUtils.getRelevantL1Events>[1];
    const l1SpokePoolClient = {
      latestHeightSearched: 200,
      eventSearchConfig: { from: 100, maxLookBack: 5_000 },
    } as unknown as Parameters<typeof heliosUtils.getRelevantL1Events>[2];
    const l2SpokePoolClient = {
      spokePoolAddress,
    } as unknown as Parameters<typeof heliosUtils.getRelevantL1Events>[3];

    const events = await heliosUtils.getRelevantL1Events(
      spyLogger,
      hubPoolClient,
      l1SpokePoolClient,
      l2SpokePoolClient,
      1,
      56
    );

    expect(paginatedEventQuery.calledOnce).to.equal(true);
    expect(events).to.deep.equal([storedCallDataEvent]);
  });
});

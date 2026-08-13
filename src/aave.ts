import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
} from "viem";
import { ServiceError } from "./core.js";
import {
  erc20ApprovalTransaction,
  preparedTransaction,
  preparedUiAction,
} from "./ui-actions.js";

export const AAVE_ADDRESS_BOOK_VERSION = "4.65.5";

export const AAVE_V3_POOL_ABI = parseAbi([
  "function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)",
  "function withdraw(address asset,uint256 amount,address to) returns (uint256)",
  "function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)",
  "function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)",
  "function repayWithATokens(address asset,uint256 amount,uint256 interestRateMode) returns (uint256)",
  "function setUserUseReserveAsCollateral(address asset,bool useAsCollateral)",
  "function setUserEMode(uint8 categoryId)",
]);

interface AaveReserveDefinition {
  symbol: string;
  decimals: number;
  underlying: Address;
  a_token: Address;
  variable_debt_token: Address;
}

interface AaveMarketDefinition {
  name: string;
  chain_id: string;
  pool: Address;
  pool_addresses_provider: Address;
  wrapped_native_gateway: Address;
  reserves: readonly AaveReserveDefinition[];
}

function reserve(
  symbol: string,
  decimals: number,
  underlying: string,
  aToken: string,
  variableDebtToken: string,
): AaveReserveDefinition {
  return {
    symbol,
    decimals,
    underlying: getAddress(underlying),
    a_token: getAddress(aToken),
    variable_debt_token: getAddress(variableDebtToken),
  };
}

function market(
  name: string,
  chainId: string,
  pool: string,
  provider: string,
  gateway: string,
  reserves: readonly AaveReserveDefinition[],
): AaveMarketDefinition {
  return {
    name,
    chain_id: chainId,
    pool: getAddress(pool),
    pool_addresses_provider: getAddress(provider),
    wrapped_native_gateway: getAddress(gateway),
    reserves,
  };
}

/**
 * A deliberately bounded, audited-at-build-time subset of Aave V3 core
 * markets and their most widely used reserves. This is discovery metadata,
 * not a claim about current reserve configuration: pause state, caps, rates,
 * collateral eligibility, eMode, liquidity and account health all remain
 * current onchain state that the wallet must establish by simulation.
 */
export const AAVE_V3_MARKETS: readonly AaveMarketDefinition[] = [
  market(
    "Aave V3 Ethereum Core",
    "1",
    "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    "0xd01607c3C5eCABa394D8be377a08590149325722",
    [
      reserve("WETH", 18, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8", "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE"),
      reserve("WBTC", 8, "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8", "0x40aAbEf1aa8f0eEc637E0E7d92fbfFB2F26A8b7B"),
      reserve("USDC", 6, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c", "0x72E95b8931767C79bA4EeE721354d6E99a61D004"),
      reserve("USDT", 6, "0xdAC17F958D2ee523a2206206994597C13D831ec7", "0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a", "0x6df1C1E379bC5a00a7b4C6e67A203333772f45A8"),
      reserve("GHO", 18, "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", "0x00907f9921424583e7ffBfEdf84F92B7B2Be4977", "0x786dBff3f1292ae8F92ea68Cf93c30b34B1ed04B"),
      reserve("wstETH", 18, "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "0x0B925eD163218f6662a35e0f0371Ac234f9E9371", "0xC96113eED8cAB59cD8A66813bCB0cEb29F06D2e4"),
    ],
  ),
  market(
    "Aave V3 Base Core",
    "8453",
    "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    "0xa0d9C1E9E48Ca30c8d8C3B5D69FF5dc1f6DFfC24",
    [
      reserve("WETH", 18, "0x4200000000000000000000000000000000000006", "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7", "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E"),
      reserve("cbETH", 18, "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad", "0x1DabC36f19909425f654777249815c073E8Fd79F"),
      reserve("USDC", 6, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", "0x59dca05b6c26dbd64b5381374aAaC5CD05644C28"),
      reserve("cbBTC", 8, "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6", "0x05e08702028de6AaD395DC6478b554a56920b9AD"),
      reserve("wstETH", 18, "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", "0x99CBC45ea5bb7eF3a5BC08FB1B7E56bB2442Ef0D", "0x41A7C3f5904ad176dACbb1D99101F59ef0811DC1"),
      reserve("GHO", 18, "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee", "0x067ae75628177FD257c2B1e500993e1a0baBcBd1", "0x38e59ADE183BbEb94583d44213c8f3297e9933e9"),
    ],
  ),
  market(
    "Aave V3 Arbitrum Core",
    "42161",
    "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    "0x5283BEcEd7ADF6D003225C13896E536f2D4264FF",
    [
      reserve("WETH", 18, "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351"),
      reserve("WBTC", 8, "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", "0x078f358208685046a11C85e8ad32895DED33A249", "0x92b42c66840C7AD907b4BF74879FF3eF7c529473"),
      reserve("USDC", 6, "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", "0x625E7708f30cA75bfd92586e17077590C60eb4cD", "0xFCCf3cAbbe80101232d343252614b6A3eE81C989"),
      reserve("USDT", 6, "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7"),
      reserve("ARB", 18, "0x912CE59144191C1204E64559FE8253a0e49E6548", "0x6533afac2E7BCCB20dca161449A13A32D391fb00", "0x44705f578135cC5d703b4c9c122528C73Eb87145"),
      reserve("wstETH", 18, "0x5979D7b546E38E414F7E9822514be443A4800529", "0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf", "0x77CA01483f379E58174739308945f044e1a764dc"),
    ],
  ),
  market(
    "Aave V3 Optimism Core",
    "10",
    "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    "0x5f2508cAE9923b02316254026CD43d7902866725",
    [
      reserve("WETH", 18, "0x4200000000000000000000000000000000000006", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351"),
      reserve("WBTC", 8, "0x68f180fcCe6836688e9084f035309E29Bf0A2095", "0x078f358208685046a11C85e8ad32895DED33A249", "0x92b42c66840C7AD907b4BF74879FF3eF7c529473"),
      reserve("USDC", 6, "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", "0x625E7708f30cA75bfd92586e17077590C60eb4cD", "0xFCCf3cAbbe80101232d343252614b6A3eE81C989"),
      reserve("USDT", 6, "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7"),
      reserve("OP", 18, "0x4200000000000000000000000000000000000042", "0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf", "0x77CA01483f379E58174739308945f044e1a764dc"),
      reserve("wstETH", 18, "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb", "0xc45A479877e1e9Dfe9FcD4056c699575a1045dAA", "0x34e2eD44EF7466D5f9E0b782B5c08b57475e7907"),
    ],
  ),
  market(
    "Aave V3 Polygon Core",
    "137",
    "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    "0xBC302053db3aA514A3c86B9221082f162B91ad63",
    [
      reserve("WPOL", 18, "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "0x6d80113e533a2C0fe82EaBD35f1875DcEA89Ea97", "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8"),
      reserve("WETH", 18, "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351"),
      reserve("WBTC", 8, "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", "0x078f358208685046a11C85e8ad32895DED33A249", "0x92b42c66840C7AD907b4BF74879FF3eF7c529473"),
      reserve("USDC", 6, "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "0x625E7708f30cA75bfd92586e17077590C60eb4cD", "0xFCCf3cAbbe80101232d343252614b6A3eE81C989"),
      reserve("USDT0", 6, "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7"),
      reserve("wstETH", 18, "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD", "0xf59036CAEBeA7dC4b86638DFA2E3C97dA9FcCd40", "0x77fA66882a8854d883101Fb8501BD3CaD347Fc32"),
    ],
  ),
  market(
    "Aave V3 Avalanche Core",
    "43114",
    "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    "0x2825cE5921538d17cc15Ae00a8B24fF759C6CDaE",
    [
      reserve("WAVAX", 18, "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", "0x6d80113e533a2C0fe82EaBD35f1875DcEA89Ea97", "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8"),
      reserve("WETHe", 18, "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351"),
      reserve("WBTCe", 8, "0x50b7545627a5162F82A992c33b87aDc75187B218", "0x078f358208685046a11C85e8ad32895DED33A249", "0x92b42c66840C7AD907b4BF74879FF3eF7c529473"),
      reserve("BTCb", 8, "0x152b9d0FdC40C096757F570A51E494bd4b943E50", "0x8ffDf2DE812095b1D19CB146E4c004587C0A0692", "0xA8669021776Bc142DfcA87c21b4A52595bCbB40a"),
      reserve("USDC", 6, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "0x625E7708f30cA75bfd92586e17077590C60eb4cD", "0xFCCf3cAbbe80101232d343252614b6A3eE81C989"),
      reserve("USDt", 6, "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7"),
    ],
  ),
];

export function getAaveV3Markets(input: { chainId?: string } = {}) {
  const markets = input.chainId
    ? AAVE_V3_MARKETS.filter((item) => item.chain_id === input.chainId)
    : [...AAVE_V3_MARKETS];
  return {
    protocol: "aave_v3",
    network_access: "none",
    source: {
      package: "@aave-dao/aave-address-book",
      version: AAVE_ADDRESS_BOOK_VERSION,
      url: "https://github.com/aave-dao/aave-address-book",
      snapshot_date: "2026-08-13",
    },
    agent_market_data_discovery: {
      server_involvement: "none",
      graphql_endpoint: "https://api.v3.aave.com/graphql",
      documentation:
        "https://aave.com/docs/aave-v3/getting-started/graphql",
      markets_documentation: "https://aave.com/docs/aave-v3/markets/data",
      use_for:
        "Live reserve rates, liquidity, supply and borrow caps, pause/freeze state, eMode categories, incentives, and optional user market state",
      handoff:
        "Select a Market whose chain.chainId and address match this fixed catalog, then pass its reserve underlyingToken.address to a prepare_aave_v3_* tool",
    },
    markets,
    limitations: {
      reserve_set:
        "A fixed subset of major core-market reserves, not a live reserve registry",
      live_state:
        "No RPC, indexer, rate, balance, allowance, cap, pause, liquidity, health-factor, collateral-eligibility, or eMode state is queried",
      execution:
        "Use preparation tools for these reserves, then require exact wallet simulation against current state before signing",
    },
  };
}

export function prepareAaveV3Supply(input: {
  chainId: string;
  sender: string;
  asset: string;
  amount: string;
  onBehalfOf?: string;
}) {
  const { market, reserve } = resolveReserve(input.chainId, input.asset);
  const sender = getAddress(input.sender);
  const amount = positiveUint(input.amount, "amount");
  const onBehalfOf = getAddress(input.onBehalfOf ?? sender);
  const approval = erc20ApprovalTransaction(
    input.chainId,
    reserve.underlying,
    market.pool,
    amount,
  );
  const transaction = preparedTransaction(
    input.chainId,
    market.pool,
    encodeFunctionData({
      abi: AAVE_V3_POOL_ABI,
      functionName: "supply",
      args: [reserve.underlying, amount, onBehalfOf, 0],
    }),
    0n,
  );
  return preparedUiAction({
    action: "aave_v3_supply",
    chainId: input.chainId,
    sender,
    request: aaveRequest(market, reserve, sender, {
      amount: amount.toString(),
      on_behalf_of: onBehalfOf,
    }),
    approvals: [approval],
    transaction,
    postExecutionTransactions: [
      erc20ApprovalTransaction(
        input.chainId,
        reserve.underlying,
        market.pool,
        0n,
      ),
    ],
    atomicBatchRequired: true,
    details: aaveDetails(market, reserve, {
      referral_code: 0,
      exact_approval_then_cleanup: true,
      recipient_receives_a_tokens: onBehalfOf,
    }),
  });
}

export function prepareAaveV3Withdraw(input: {
  chainId: string;
  sender: string;
  asset: string;
  amount: string;
  recipient?: string;
}) {
  const { market, reserve } = resolveReserve(input.chainId, input.asset);
  const sender = getAddress(input.sender);
  const amount = positiveUint(input.amount, "amount");
  const recipient = getAddress(input.recipient ?? sender);
  return singlePoolAction({
    action: "aave_v3_withdraw",
    market,
    reserve,
    sender,
    request: { amount: amount.toString(), recipient },
    data: encodeFunctionData({
      abi: AAVE_V3_POOL_ABI,
      functionName: "withdraw",
      args: [reserve.underlying, amount, recipient],
    }),
    details: {
      maximum_uint256_withdraws_available_balance: true,
      requires_sufficient_a_token_balance: true,
    },
  });
}

export function prepareAaveV3Borrow(input: {
  chainId: string;
  sender: string;
  asset: string;
  amount: string;
  onBehalfOf?: string;
}) {
  const { market, reserve } = resolveReserve(input.chainId, input.asset);
  const sender = getAddress(input.sender);
  const amount = positiveUint(input.amount, "amount");
  const onBehalfOf = getAddress(input.onBehalfOf ?? sender);
  return singlePoolAction({
    action: "aave_v3_borrow",
    market,
    reserve,
    sender,
    request: { amount: amount.toString(), on_behalf_of: onBehalfOf },
    data: encodeFunctionData({
      abi: AAVE_V3_POOL_ABI,
      functionName: "borrow",
      args: [reserve.underlying, amount, 2n, 0, onBehalfOf],
    }),
    details: {
      interest_rate_mode: "variable",
      interest_rate_mode_value: 2,
      referral_code: 0,
      delegated_borrow_requires_prior_variable_debt_delegation:
        onBehalfOf !== sender,
    },
  });
}

export function prepareAaveV3Repay(input: {
  chainId: string;
  sender: string;
  asset: string;
  amount: string;
  onBehalfOf?: string;
  fundingSource: "underlying" | "a_token";
}) {
  const { market, reserve } = resolveReserve(input.chainId, input.asset);
  const sender = getAddress(input.sender);
  const amount = positiveUint(input.amount, "amount");
  const onBehalfOf = getAddress(input.onBehalfOf ?? sender);
  if (input.fundingSource === "a_token" && onBehalfOf !== sender) {
    throw new ServiceError(
      "unsupported_repay_combination",
      "repayWithATokens repays only the sender's debt; on_behalf_of must equal sender",
    );
  }
  const transaction = preparedTransaction(
    input.chainId,
    market.pool,
    input.fundingSource === "underlying"
      ? encodeFunctionData({
          abi: AAVE_V3_POOL_ABI,
          functionName: "repay",
          args: [reserve.underlying, amount, 2n, onBehalfOf],
        })
      : encodeFunctionData({
          abi: AAVE_V3_POOL_ABI,
          functionName: "repayWithATokens",
          args: [reserve.underlying, amount, 2n],
        }),
    0n,
  );
  const approvals =
    input.fundingSource === "underlying"
      ? [
          erc20ApprovalTransaction(
            input.chainId,
            reserve.underlying,
            market.pool,
            amount,
          ),
        ]
      : [];
  const cleanups =
    input.fundingSource === "underlying"
      ? [
          erc20ApprovalTransaction(
            input.chainId,
            reserve.underlying,
            market.pool,
            0n,
          ),
        ]
      : [];
  return preparedUiAction({
    action: "aave_v3_repay",
    chainId: input.chainId,
    sender,
    request: aaveRequest(market, reserve, sender, {
      amount: amount.toString(),
      on_behalf_of: onBehalfOf,
      funding_source: input.fundingSource,
    }),
    approvals,
    transaction,
    postExecutionTransactions: cleanups,
    atomicBatchRequired: approvals.length > 0,
    details: aaveDetails(market, reserve, {
      interest_rate_mode: "variable",
      interest_rate_mode_value: 2,
      maximum_uint256_repays_available_debt: true,
      exact_approval_then_cleanup: approvals.length > 0,
    }),
  });
}

export function prepareAaveV3Collateral(input: {
  chainId: string;
  sender: string;
  asset: string;
  useAsCollateral: boolean;
}) {
  const { market, reserve } = resolveReserve(input.chainId, input.asset);
  const sender = getAddress(input.sender);
  return singlePoolAction({
    action: "aave_v3_set_collateral",
    market,
    reserve,
    sender,
    request: { use_as_collateral: input.useAsCollateral },
    data: encodeFunctionData({
      abi: AAVE_V3_POOL_ABI,
      functionName: "setUserUseReserveAsCollateral",
      args: [reserve.underlying, input.useAsCollateral],
    }),
    details: {
      can_change_health_factor: true,
      disabling_can_revert_when_required_by_open_debt: true,
    },
  });
}

export function prepareAaveV3EMode(input: {
  chainId: string;
  sender: string;
  categoryId: number;
}) {
  const market = resolveMarket(input.chainId);
  const sender = getAddress(input.sender);
  if (
    !Number.isInteger(input.categoryId) ||
    input.categoryId < 0 ||
    input.categoryId > 255
  ) {
    throw new ServiceError(
      "invalid_emode_category",
      "category_id must fit uint8",
    );
  }
  const transaction = preparedTransaction(
    input.chainId,
    market.pool,
    encodeFunctionData({
      abi: AAVE_V3_POOL_ABI,
      functionName: "setUserEMode",
      args: [input.categoryId],
    }),
    0n,
  );
  return preparedUiAction({
    action: "aave_v3_set_emode",
    chainId: input.chainId,
    sender,
    request: {
      chain_id: input.chainId,
      sender,
      market: market.name,
      category_id: input.categoryId,
    },
    transaction,
    details: {
      pool: market.pool,
      category_zero_disables_emode: true,
      category_configuration_not_queried: true,
      exact_wallet_simulation_required: true,
    },
  });
}

function singlePoolAction(input: {
  action: string;
  market: AaveMarketDefinition;
  reserve: AaveReserveDefinition;
  sender: Address;
  request: Record<string, unknown>;
  data: `0x${string}`;
  details: Record<string, unknown>;
}) {
  return preparedUiAction({
    action: input.action,
    chainId: input.market.chain_id,
    sender: input.sender,
    request: aaveRequest(input.market, input.reserve, input.sender, input.request),
    transaction: preparedTransaction(
      input.market.chain_id,
      input.market.pool,
      input.data,
      0n,
    ),
    details: aaveDetails(input.market, input.reserve, input.details),
  });
}

function aaveRequest(
  market: AaveMarketDefinition,
  reserve: AaveReserveDefinition,
  sender: Address,
  fields: Record<string, unknown>,
) {
  return {
    chain_id: market.chain_id,
    sender,
    market: market.name,
    asset: reserve.underlying,
    reserve_symbol: reserve.symbol,
    ...fields,
  };
}

function aaveDetails(
  market: AaveMarketDefinition,
  reserve: AaveReserveDefinition,
  fields: Record<string, unknown>,
) {
  return {
    pool: market.pool,
    pool_addresses_provider: market.pool_addresses_provider,
    reserve: {
      symbol: reserve.symbol,
      decimals: reserve.decimals,
      underlying: reserve.underlying,
      a_token: reserve.a_token,
      variable_debt_token: reserve.variable_debt_token,
    },
    server_network_access: "none",
    live_state_not_queried: true,
    exact_wallet_simulation_required: true,
    ...fields,
  };
}

function resolveMarket(chainId: string): AaveMarketDefinition {
  const result = AAVE_V3_MARKETS.find((item) => item.chain_id === chainId);
  if (result === undefined) {
    throw new ServiceError(
      "unsupported_aave_market",
      `No fixed Aave V3 core market is configured for chain ${chainId}`,
    );
  }
  return result;
}

function resolveReserve(chainId: string, asset: string) {
  const market = resolveMarket(chainId);
  const normalized = getAddress(asset);
  const reserve = market.reserves.find(
    (item) => item.underlying.toLowerCase() === normalized.toLowerCase(),
  );
  if (reserve === undefined) {
    throw new ServiceError(
      "unsupported_aave_reserve",
      `Asset ${normalized} is not in the fixed major-reserve set for ${market.name}; use get_aave_v3_markets to discover supported addresses`,
    );
  }
  return { market, reserve };
}

function positiveUint(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ServiceError(
      "invalid_integer",
      `${label} must be a positive decimal integer`,
    );
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) {
    throw new ServiceError("integer_overflow", `${label} must fit uint256`);
  }
  return parsed;
}

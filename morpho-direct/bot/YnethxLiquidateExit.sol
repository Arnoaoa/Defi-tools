// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);

    function market(bytes32 id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );

    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function accrueInterest(MarketParams memory marketParams) external;

    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes memory data
    ) external returns (uint256 seized, uint256 repaid);

    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);
}

interface ICurvePool {
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice One-shot atomic exit from the frozen WETH/ynETHx Morpho market.
/// Liquidates JUST ENOUGH of an underwater borrower's debt to free the
/// liquidity OWNER's trapped supply needs, sells the seized ynETHx on Curve
/// inside the liquidation callback, withdraws OWNER's entire supply, and sends
/// every wei of WETH to OWNER. The transaction reverts unless OWNER receives
/// at least MIN_OUT_FLOOR (or the higher caller-supplied minOut), so a bad
/// outcome costs nothing but gas. No path sends funds anywhere but OWNER.
contract YnethxLiquidateExit {
    IMorpho internal constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    bytes32 internal constant MARKET_ID =
        0xf0edbb36183591ff28c56fdb283fdd6896cf1298990e5913208902adb87d2b75;
    address internal constant OWNER = 0x869A05FE6568b39b6202f6378f463e48bA2880B3;
    ICurvePool internal constant POOL = ICurvePool(0xD65ed4BcE447195187f37cE7D82f56AdF1826F8F);
    IERC20 internal constant YNETHX = IERC20(0x657d9ABA1DBb59e53f9F3eCAA878447dCfC96dCb);
    IERC20 internal constant WETH = IERC20(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    int128 internal constant CURVE_YNETHX_INDEX = 0;
    int128 internal constant CURVE_WETH_INDEX = 1;

    // Absolute floor on what OWNER must receive, hardcoded so that even a
    // malicious/careless caller cannot trigger a ruinous execution
    uint256 internal constant MIN_OUT_FLOOR = 0.58 ether;

    // Morpho Blue virtual shares/assets (inflation-attack protection)
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    error NotMorpho();
    error NothingToLiquidate();
    error BelowMinOut();

    /// @param borrower underwater account on the ynETHx market
    /// @param minOut minimum total WETH OWNER must receive (raised to
    /// MIN_OUT_FLOOR if lower); anything less reverts the whole transaction
    function execute(address borrower, uint256 minOut) external {
        if (minOut < MIN_OUT_FLOOR) minOut = MIN_OUT_FLOOR;

        IMorpho.MarketParams memory params = MORPHO.idToMarketParams(MARKET_ID);
        MORPHO.accrueInterest(params);

        (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) =
            MORPHO.market(MARKET_ID);
        (uint256 ownerSupplyShares,,) = MORPHO.position(MARKET_ID, OWNER);
        uint256 ownedAssets = ownerSupplyShares * (uint256(totalSupplyAssets) + VIRTUAL_ASSETS)
            / (uint256(totalSupplyShares) + VIRTUAL_SHARES);
        uint256 liquidity = uint256(totalSupplyAssets) - uint256(totalBorrowAssets);

        // Liquidate only the debt slice needed to free OWNER's full supply
        // (with a 0.1% buffer for rounding), capped at the borrower's debt
        uint256 repayNeeded = ownedAssets > liquidity ? ownedAssets - liquidity : 0;
        repayNeeded += repayNeeded / 1000;
        (, uint128 borrowerShares,) = MORPHO.position(MARKET_ID, borrower);
        uint256 repaidShares = repayNeeded * (uint256(totalBorrowShares) + VIRTUAL_SHARES)
            / (uint256(totalBorrowAssets) + VIRTUAL_ASSETS);
        if (repaidShares > borrowerShares) repaidShares = borrowerShares;
        if (repaidShares == 0) revert NothingToLiquidate();

        MORPHO.liquidate(params, borrower, 0, repaidShares, abi.encode(uint256(0)));

        // Everything the operation produced — Curve sale proceeds plus OWNER's
        // withdrawn supply, minus the repayment Morpho pulled — goes to OWNER
        uint256 total = WETH.balanceOf(address(this));
        if (total < minOut) revert BelowMinOut();
        WETH.transfer(OWNER, total);
    }

    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata) external {
        if (msg.sender != address(MORPHO)) revert NotMorpho();

        // Sell every seized ynETHx; the global minOut check in execute() is the
        // profitability guard, so no minDy needed here
        uint256 seized = YNETHX.balanceOf(address(this));
        YNETHX.approve(address(POOL), seized);
        POOL.exchange(CURVE_YNETHX_INDEX, CURVE_WETH_INDEX, seized, 0);

        // The debt reduction just freed liquidity: withdraw as much of OWNER's
        // supply as it allows, into this contract (netted and forwarded above)
        IMorpho.MarketParams memory params = MORPHO.idToMarketParams(MARKET_ID);
        (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets,,,) =
            MORPHO.market(MARKET_ID);
        uint256 liquidity = uint256(totalSupplyAssets) - uint256(totalBorrowAssets);
        (uint256 supplyShares,,) = MORPHO.position(MARKET_ID, OWNER);
        uint256 ownedAssets = supplyShares * (uint256(totalSupplyAssets) + VIRTUAL_ASSETS)
            / (uint256(totalSupplyShares) + VIRTUAL_SHARES);
        if (supplyShares > 0 && liquidity > 0) {
            if (ownedAssets <= liquidity) {
                MORPHO.withdraw(params, 0, supplyShares, OWNER, address(this));
            } else {
                MORPHO.withdraw(params, liquidity, 0, OWNER, address(this));
            }
        }

        // Let Morpho pull the repayment when this callback returns
        WETH.approve(address(MORPHO), repaidAssets);
    }
}

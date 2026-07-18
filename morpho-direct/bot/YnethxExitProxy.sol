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

    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);
}

/// @notice Exit proxy locked to a single Morpho Blue market and a single owner.
/// The owner authorizes this contract once via Morpho's setAuthorization; the
/// contract can then only ever withdraw the owner's supply from that market,
/// straight to the owner's wallet. Anyone may trigger it — triggering can only
/// benefit the owner, so the caller key needs no trust at all.
contract YnethxExitProxy {
    IMorpho internal constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    bytes32 internal constant MARKET_ID =
        0xf0edbb36183591ff28c56fdb283fdd6896cf1298990e5913208902adb87d2b75;
    address internal constant OWNER = 0x869A05FE6568b39b6202f6378f463e48bA2880B3;

    // Morpho Blue virtual shares/assets (inflation-attack protection)
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    error NothingToWithdraw();

    /// @notice Withdraw as much of OWNER's supply as current liquidity allows.
    function withdrawMax() external returns (uint256 withdrawnAssets) {
        IMorpho.MarketParams memory params = MORPHO.idToMarketParams(MARKET_ID);
        // Sync accounting so stored totals include pending interest
        MORPHO.accrueInterest(params);

        (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets,,,) =
            MORPHO.market(MARKET_ID);
        uint256 liquidity = uint256(totalSupplyAssets) - uint256(totalBorrowAssets);
        (uint256 supplyShares,,) = MORPHO.position(MARKET_ID, OWNER);
        uint256 ownedAssets =
            supplyShares * (uint256(totalSupplyAssets) + VIRTUAL_ASSETS) / (uint256(totalSupplyShares) + VIRTUAL_SHARES);

        if (liquidity == 0 || ownedAssets == 0) revert NothingToWithdraw();

        if (ownedAssets <= liquidity) {
            // Full exit: burn all shares so no dust position remains
            (withdrawnAssets,) = MORPHO.withdraw(params, 0, supplyShares, OWNER, OWNER);
        } else {
            (withdrawnAssets,) = MORPHO.withdraw(params, liquidity, 0, OWNER, OWNER);
        }
    }
}

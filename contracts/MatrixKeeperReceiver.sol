// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title IERC165 - minimal interface detection
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @title IReceiver - receives Chainlink CRE keystone reports
/// @notice Implementations must support the IReceiver interface through ERC165.
interface IReceiver is IERC165 {
    /// @dev If this call reverts, CRE can retry with a higher gas limit.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title IMatrixKeeperPerform - the slice of MatrixKeeper this receiver needs
interface IMatrixKeeperPerform {
    function performUpkeep(bytes calldata performData) external;
}

/**
 * @title MatrixKeeperReceiver
 * @notice Thin adapter that lets a Chainlink CRE workflow drive MatrixKeeper.
 *         CRE's write path only delivers signed reports to contracts that implement
 *         onReport(bytes,bytes) and verify the caller is the trusted KeystoneForwarder.
 *         MatrixKeeper itself implements the classic Automation checkUpkeep/performUpkeep
 *         interface, not onReport — so this contract sits in between:
 *
 *           CRE DON -> KeystoneForwarder -> MatrixKeeperReceiver.onReport()
 *                                              -> MatrixKeeper.performUpkeep(report)
 *
 *         The report payload is expected to be the exact performData bytes that the
 *         CRE workflow read off-chain from MatrixKeeper.checkUpkeep() — this contract
 *         just passes it straight through. No decoding, no state of its own.
 *
 *         MatrixKeeper.performUpkeep currently has no access control, so this contract
 *         does not need to be allow-listed on MatrixKeeper. If access control is ever
 *         added there, allow this receiver's address (not the forwarder, not the DON).
 */
contract MatrixKeeperReceiver is IReceiver, Ownable {
    address public immutable matrixKeeper;

    address private s_forwarderAddress;

    event ForwarderAddressUpdated(address indexed previousForwarder, address indexed newForwarder);
    event ReportRelayed(bytes performData);
    event PerformUpkeepFailed(bytes performData, bytes reason);

    error InvalidForwarderAddress();
    error InvalidSender(address sender, address expected);

    constructor(address _forwarderAddress, address _matrixKeeper) Ownable(msg.sender) {
        if (_forwarderAddress == address(0)) revert InvalidForwarderAddress();
        require(_matrixKeeper != address(0), "matrixKeeper required");
        s_forwarderAddress = _forwarderAddress;
        matrixKeeper = _matrixKeeper;
        emit ForwarderAddressUpdated(address(0), _forwarderAddress);
    }

    function getForwarderAddress() external view returns (address) {
        return s_forwarderAddress;
    }

    /// @notice Updates the forwarder address allowed to call onReport.
    /// @dev Needed if Chainlink ever rotates the production KeystoneForwarder.
    function setForwarderAddress(address _forwarder) external onlyOwner {
        if (_forwarder == address(0)) revert InvalidForwarderAddress();
        address previous = s_forwarderAddress;
        s_forwarderAddress = _forwarder;
        emit ForwarderAddressUpdated(previous, _forwarder);
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata /* metadata */, bytes calldata report) external override {
        if (msg.sender != s_forwarderAddress) {
            revert InvalidSender(msg.sender, s_forwarderAddress);
        }

        // try/catch so a stale or malformed report doesn't strand the CRE DON's tx —
        // mirrors the narrow try/catch pattern already used inside MatrixKeeper itself.
        try IMatrixKeeperPerform(matrixKeeper).performUpkeep(report) {
            emit ReportRelayed(report);
        } catch (bytes memory reason) {
            emit PerformUpkeepFailed(report, reason);
        }
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}

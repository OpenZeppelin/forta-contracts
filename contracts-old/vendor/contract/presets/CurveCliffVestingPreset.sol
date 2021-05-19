// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../extensions/CurveVesting.sol";
import "../extensions/DeadlineVesting.sol";
import "../extensions/RevokableVesting.sol";

contract CurveCliffVestingPreset is CurveVesting, DeadlineVesting, RevokableVesting {
    constructor(address beneficiary_, uint256 start_, uint256 duration_, uint8 curvature_, uint256 deadline_)
    TokenVesting(beneficiary_)
    CurveVesting(start_, duration_, curvature_)
    DeadlineVesting(deadline_)
    RevokableVesting(msg.sender)
    {}

    function vestedAmount(address token, uint256 timestamp) public virtual override(TokenVesting, RevokableVesting) view returns (uint256) {
        return super.vestedAmount(token, timestamp);
    }

    function _vestedAmount(address token, uint256 timestamp) internal virtual override(TokenVesting, CurveVesting, DeadlineVesting) view returns (uint256) {
        return super._vestedAmount(token, timestamp);
    }

    function _releasableAmount(address token, uint256 timestamp) internal virtual override(TokenVesting, RevokableVesting) view returns (uint256) {
        return super._releasableAmount(token, timestamp);
    }
}
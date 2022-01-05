// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IRootChainManager {
    function tokenToType(address) external view returns (bytes32);
    function typeToPredicate(bytes32) external view returns (address);
    function depositFor(address, address, bytes calldata) external;
    function exit(bytes calldata) external;
}
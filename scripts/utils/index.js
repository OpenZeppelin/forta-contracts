const { ethers, upgrades, network, defender } = require('hardhat');
const { NonceManager } = require('@ethersproject/experimental');
const DEBUG = require('debug')('forta:utils');
const EthDater = require('block-by-date-ethers');
const process = require('process');
const { kebabize } = require('./stringUtils');

// override process.env with dotenv
Object.assign(process.env, require('dotenv').config().parsed);

const DEFAULT_FEE_DATA = {
    maxFeePerGas: ethers.utils.parseUnits('400', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('20', 'gwei'),
};

const getDefaultProvider = async (baseProvider = ethers.provider, feeData = {}) => {
    const provider = new ethers.providers.FallbackProvider([baseProvider], 1);
    provider.getFeeData = () => Promise.resolve(Object.assign(DEFAULT_FEE_DATA, feeData));
    return provider;
};

const getDefaultDeployer = async (provider, baseDeployer) => {
    baseDeployer =
        baseDeployer ?? ethers.Wallet.fromMnemonic(process.env[`${network.name.toUpperCase()}_MNEMONIC`] || 'test test test test test test test test test test test junk');
    const deployer = new NonceManager(baseDeployer).connect(provider);
    await deployer.getTransactionCount().then((nonce) => deployer.setTransactionCount(nonce));
    deployer.address = await deployer.getAddress();
    return deployer;
};

/*********************************************************************************************************************
 *                                                Blockchain helpers                                                 *
 *********************************************************************************************************************/

function getFactory(name) {
    return ethers.getContractFactory(name);
}

function attach(factory, address) {
    return (typeof factory === 'string' ? getFactory(factory) : Promise.resolve(factory)).then((contract) => contract.attach(address));
}

function deploy(factory, params = []) {
    return (typeof factory === 'string' ? getFactory(factory) : Promise.resolve(factory)).then((contract) => contract.deploy(...params)).then((f) => f.deployed());
}

function deployUpgradeable(factory, kind, params = [], opts = {}) {
    return (typeof factory === 'string' ? getFactory(factory) : Promise.resolve(factory))
        .then((contract) => upgrades.deployProxy(contract, params, { kind, ...opts }))
        .then((f) => f.deployed());
}

async function performUpgrade(proxy, contractName, opts = {}) {
    let contract = await getFactory(contractName);
    const afterUpgradeContract = await upgrades.upgradeProxy(proxy.address, contract, opts);
    return afterUpgradeContract;
}

async function proposeUpgrade(contractName, opts = {}, cache) {
    const proxyAddress = await cache.get(`${kebabize(contractName)}.address`);
    const proposal = await defender.proposeUpgrade(proxyAddress, contractName, opts);
    return proposal.url;
}

async function tryFetchContract(contractName, args = [], cache) {
    const contract = await ethers.getContractFactory(contractName);
    const key = kebabize(contractName);
    const deployed = await resumeOrDeploy(cache, key, () => contract.deploy(...args)).then((address) => contract.attach(address));
    return deployed;
}

async function tryFetchProxy(contractName, kind = 'uups', args = [], opts = {}, cache) {
    let contract = await ethers.getContractFactory(contractName);
    const key = kebabize(contractName);
    const deployed = await resumeOrDeploy(cache, key, () => upgrades.deployProxy(contract, args, { kind, ...opts })).then((address) => contract.attach(address));
    return deployed;
}

async function getContractVersion(contract, deployParams = {}) {
    if (contract) {
        try {
            return contract['version'] ? await contract.version() : '0.0.0';
        } catch (e) {
            // Version not introduced in deployed contract yet
            return '0.0.0';
        }
    } else if (deployParams.address && deployParams.provider) {
        try {
            const abi = `[{"inputs": [],"name": "version","outputs": [{"internalType": "string","name": "","type": "string"}],"stateMutability": "view","type": "function"}]`;
            const versioned = new ethers.Contract(deployParams.address, JSON.parse(abi), deployParams.provider);
            return await versioned.version();
        } catch (e) {
            console.log(e);
            // Version not introduced in source code yet
            return '0.0.0';
        }
    }
    throw new Error(`Cannot get contract version for ${contract} or ${deployParams}. Provide contract object or deployParams`);
}

async function resumeOrDeploy(cache, key, deploy) {
    let txHash = await cache?.get(`${key}-pending`);
    let address = await cache?.get(`${key}.address`);
    DEBUG('resumeOrDeploy', key, txHash, address);

    if (!txHash && !address) {
        const contract = await deploy();
        txHash = contract.deployTransaction.hash;
        await cache?.set(`${key}-pending`, txHash);
        await contract.deployed();
        address = contract.address;
    } else if (!address) {
        address = await ethers.provider
            .getTransaction(txHash)
            .then((tx) => tx.wait())
            .then((receipt) => receipt.contractAddress);
    }
    await cache?.set(`${key}.address`, address);
    return address;
}

async function getEventsFromContractCreation(cache, key, eventName, contract, filterParams = []) {
    let txHash = await cache.get(`${key}-pending`);
    if (!txHash) {
        throw new Error(`${key} deployment transaction not saved`);
    }
    return getEventsFromTx(txHash, eventName, contract, filterParams);
}

async function getEventsFromTx(txHash, eventName, contract, filterParams = [], aProvider) {
    let provider = aProvider ?? contract.provider ?? contract.signer.provider;
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt === null) {
        return [];
    }
    const filters = contract.filters[eventName](...filterParams);
    return contract.queryFilter(filters, receipt.blockNumber, 'latest');
}

async function getLogsForBlockInterval(initialBlock, endBlock, contract, filters) {
    let logs = {};
    const blockInterval = 8000;
    for (let i = initialBlock.block; i <= endBlock.block; i += blockInterval) {
        const fromBlock = i;
        const toBlock = Math.min(endBlock.block, i + blockInterval);
        DEBUG(fromBlock, '-', toBlock);
        const filterNames = Object.keys(filters);
        for (let filterName of filterNames) {
            const result = await contract.queryFilter(filters[filterName], fromBlock, toBlock);
            logs[filterName] = [...(logs[filterName] ?? []), ...result];
        }
    }
    return logs;
}

async function getEventsForTimeInterval(provider, initialDate, endDate, contract, filters) {
    const dater = new EthDater(provider);
    const initialBlock = await dater.getDate(initialDate, true);
    DEBUG(initialBlock);
    const endBlock = await dater.getDate(endDate, true);
    DEBUG(endBlock);

    return getLogsForBlockInterval(initialBlock, endBlock, contract, filters);
}

const assertNotUsingHardhatKeys = (chainId, deployer) => {
    if (chainId !== 31337 && deployer.address === '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') {
        DEBUG(deployer.address, chainId);

        throw new Error('using hardhat key for other network');
    }
};

const getBlockExplorerDomain = (hre) => {
    const network = hre.network.name;
    switch (network) {
        case 'mainnet':
            return 'etherscan.io';
        case 'goerli':
            return `${network}.etherscan.io`;
        case 'polygon':
        case 'matic':
            return 'polygonscan.com';
        case 'mumbai':
            return 'mumbai.polygonscan.com';
    }
};

/*********************************************************************************************************************
 *                                                        Arrays                                                     *
 *********************************************************************************************************************/
Array.range = function (start, stop = undefined, step = 1) {
    if (!stop) {
        stop = start;
        start = 0;
    }
    return start < stop
        ? Array(Math.ceil((stop - start) / step))
              .fill()
              .map((_, i) => start + i * step)
        : [];
};

Array.prototype.chunk = function (size) {
    return Array.range(Math.ceil(this.length / size)).map((i) => this.slice(i * size, i * size + size));
};

/*********************************************************************************************************************
 *                                                        Time                                                       *
 *********************************************************************************************************************/

function dateToTimestamp(...params) {
    return Math.floor(new Date(...params).getTime() / 1000);
}

function durationToSeconds(duration) {
    const durationPattern = /^(\d+) +(second|minute|hour|day|week|month|year)s?$/;
    const match = duration.match(durationPattern);

    if (!match) {
        throw new Error(`Bad duration format (${durationPattern.source})`);
    }

    const second = 1;
    const minute = 60 * second;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;
    const month = 30 * day;
    const year = 365 * day;
    const seconds = { second, minute, hour, day, week, month, year };

    const value = parseFloat(match[1]);
    return value * seconds[match[2]];
}

module.exports = {
    getDefaultProvider,
    getDefaultDeployer,
    getFactory,
    attach,
    deploy,
    deployUpgradeable,
    performUpgrade,
    proposeUpgrade,
    tryFetchContract,
    tryFetchProxy,
    dateToTimestamp,
    durationToSeconds,
    getContractVersion,
    getEventsFromTx,
    getEventsFromContractCreation,
    getEventsForTimeInterval,
    getLogsForBlockInterval,
    assertNotUsingHardhatKeys,
    getBlockExplorerDomain,
};
